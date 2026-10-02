/**
 * Parcours UI : tout ce que fait la personne dans le panel, pour pouvoir rejouer exactement ses
 * gestes avant un écart (demande de Yassin, 02/10 : « il faut vraiment tout enregistrer tant que
 * c'est possible. La position de la souris, les clics dans le vide… Tout »).
 *
 * Capturé, puis envoyé par lots à `POST /api/ui-events` : clics (y compris dans le vide, avec leurs
 * coordonnées), navigations (onglet et filtres compris), position de la souris et défilement
 * (échantillonnés), touches hors champ de saisie, champs modifiés, messages affichés, erreurs
 * JavaScript, fenêtre masquée ou redimensionnée.
 *
 * Jamais enregistré : le contenu d'un champ secret (mot de passe, jeton, clé) — on note qu'il a
 * changé et sa longueur, pas sa valeur — ni ce qui se passe sur une page de statut publique.
 * Installé depuis `main.tsx` (jamais dans les tests) ; toute erreur d'envoi est silencieuse.
 */
import { STATUS_PAGE_PREFIX, type UiEventInput } from '@mmo/protocol/client';

const FLUSH_INTERVAL_MS = 5000;
const FLUSH_BATCH_SIZE = 100;
const MAX_QUEUE = 600;
const MAX_TARGET_LENGTH = 200;
const MAX_VALUE_LENGTH = 200;
const MAX_TEXT_LENGTH = 300;
/** Souris et défilement : une position par seconde au plus, et seulement si elle a changé. */
const SAMPLE_MS = 1000;

type Data = NonNullable<UiEventInput['data']>;

const INTERACTIVE =
  '[data-testid], button, a, [role="button"], [role="tab"], [role="menuitem"], input, select, textarea, label';
const SECRET = /pass(word)?|secret|token|api.?key|pair.?code/i;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Identifiant lisible d'un élément interactif, du plus stable au moins stable. */
export function targetLabel(element: Element): string | undefined {
  const interactive = element.closest(INTERACTIVE);
  if (interactive === null) return undefined;
  const testId = interactive.closest('[data-testid]')?.getAttribute('data-testid');
  if (testId !== null && testId !== undefined && testId !== '') return testId;
  const aria = interactive.getAttribute('aria-label');
  if (aria !== null && aria !== '') return aria;
  const text = interactive.textContent.trim().replace(/\s+/g, ' ');
  if (text !== '')
    return `${interactive.tagName.toLowerCase()}:${text}`.slice(0, MAX_TARGET_LENGTH);
  return interactive.tagName.toLowerCase();
}

/** Un clic : où, sur quoi — et s'il n'a touché aucun élément interactif (`void`). */
export function clickData(element: Element, x: number, y: number): Data {
  const hit = targetLabel(element) !== undefined;
  // Repère le plus proche, pour situer un clic dans le vide (« à côté de la carte serveur »).
  const near = element.closest('[data-testid]')?.getAttribute('data-testid');
  return {
    x: Math.round(x),
    y: Math.round(y),
    vw: window.innerWidth,
    vh: window.innerHeight,
    tag: element.tagName.toLowerCase(),
    ...(hit ? {} : { void: true }),
    ...(!hit && near !== null && near !== undefined && near !== '' ? { near } : {}),
  };
}

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export function isField(target: EventTarget | null): target is Field {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  );
}

/** Un champ secret ne livre jamais sa valeur : mot de passe, jeton, clé, code d'appairage. */
export function isSecretField(field: Field): boolean {
  if (field instanceof HTMLInputElement && field.type === 'password') return true;
  const hints = [
    field.getAttribute('name'),
    field.id,
    field.getAttribute('autocomplete'),
    field.closest('[data-testid]')?.getAttribute('data-testid'),
    field.getAttribute('aria-label'),
  ];
  return hints.some((h) => h !== null && h !== undefined && SECRET.test(h));
}

/** Un champ modifié : sa valeur, ou seulement sa longueur s'il est secret. */
export function inputData(field: Field): Data {
  if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) {
    return { checked: field.checked };
  }
  if (isSecretField(field)) return { secret: true, length: field.value.length };
  return { value: clip(field.value, MAX_VALUE_LENGTH) };
}

export function installUiTelemetry(): void {
  let queue: UiEventInput[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const send = (events: UiEventInput[], beacon: boolean): void => {
    const body = JSON.stringify({ events });
    if (beacon && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/api/ui-events', new Blob([body], { type: 'application/json' }));
      return;
    }
    // Échec silencieux (déconnecté, panel arrêté…) : le parcours UI n'est jamais bloquant.
    void fetch('/api/ui-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  };

  const flush = (beacon = false): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (queue.length === 0) return;
    const events = queue;
    queue = [];
    send(events, beacon);
  };

  const push = (kind: UiEventInput['kind'], extra: { target?: string; data?: Data } = {}): void => {
    // Lot 8 : une page de statut publique n'est parcourue par personne d'identifiable — on n'y
    // enregistre donc rien du tout (et la route d'envoi exigerait de toute façon une session).
    if (location.pathname.startsWith(STATUS_PAGE_PREFIX)) return;
    if (queue.length >= MAX_QUEUE) return;
    queue.push({
      ts: Date.now(),
      kind,
      page: location.pathname.slice(0, 200),
      ...(extra.target === undefined ? {} : { target: extra.target }),
      ...(extra.data === undefined ? {} : { data: extra.data }),
    });
    if (queue.length >= FLUSH_BATCH_SIZE) {
      flush();
      return;
    }
    timer ??= setTimeout(() => {
      flush();
    }, FLUSH_INTERVAL_MS);
  };

  // --- Clics : sur un élément, ou dans le vide ----------------------------------------------------
  document.addEventListener(
    'click',
    (e) => {
      if (!(e.target instanceof Element)) return;
      const target = targetLabel(e.target);
      push('click', {
        ...(target === undefined ? {} : { target }),
        data: clickData(e.target, e.clientX, e.clientY),
      });
    },
    { capture: true },
  );

  // --- Souris et défilement : échantillonnés --------------------------------------------------------
  let mouse: { x: number; y: number } | undefined;
  let lastMouse = '';
  let scrolled = false;
  document.addEventListener(
    'mousemove',
    (e) => {
      mouse = { x: Math.round(e.clientX), y: Math.round(e.clientY) };
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    'scroll',
    () => {
      scrolled = true;
    },
    { capture: true, passive: true },
  );
  setInterval(() => {
    if (mouse !== undefined && `${String(mouse.x)},${String(mouse.y)}` !== lastMouse) {
      lastMouse = `${String(mouse.x)},${String(mouse.y)}`;
      push('move', { data: mouse });
    }
    if (scrolled) {
      scrolled = false;
      push('scroll', { data: { y: Math.round(window.scrollY), x: Math.round(window.scrollX) } });
    }
  }, SAMPLE_MS);

  // --- Clavier : les touches hors saisie ; dans un champ, seulement celles qui valident ou quittent
  document.addEventListener(
    'keydown',
    (e) => {
      const typing =
        isField(e.target) || (e.target instanceof HTMLElement && e.target.isContentEditable);
      if (typing && !['Enter', 'Escape', 'Tab'].includes(e.key)) return;
      const target = e.target instanceof Element ? targetLabel(e.target) : undefined;
      push('key', {
        ...(target === undefined ? {} : { target }),
        data: {
          key: e.key.length === 1 && typing ? '·' : e.key,
          ...(e.ctrlKey ? { ctrl: true } : {}),
          ...(e.altKey ? { alt: true } : {}),
          ...(e.shiftKey ? { shift: true } : {}),
          ...(e.metaKey ? { meta: true } : {}),
        },
      });
    },
    { capture: true },
  );

  // --- Champs modifiés (à la validation du champ : sortie, Entrée, choix dans une liste) ----------
  document.addEventListener(
    'change',
    (e) => {
      if (!isField(e.target)) return;
      const target = targetLabel(e.target);
      push('input', { ...(target === undefined ? {} : { target }), data: inputData(e.target) });
    },
    { capture: true },
  );

  // --- Messages affichés (notifications Mantine) : ce que la personne a LU, refus compris -----------
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const toasts = node.matches('.mantine-Notification-root')
          ? [node]
          : [...node.querySelectorAll<HTMLElement>('.mantine-Notification-root')];
        for (const toast of toasts) {
          const text = toast.textContent.trim().replace(/\s+/g, ' ');
          if (text !== '') push('toast', { data: { text: clip(text, MAX_TEXT_LENGTH) } });
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // --- Erreurs JavaScript ----------------------------------------------------------------------------
  window.addEventListener('error', (e) => {
    push('error', {
      data: {
        text: clip(e.message, MAX_TEXT_LENGTH),
        at: clip(`${e.filename}:${String(e.lineno)}`, MAX_VALUE_LENGTH),
      },
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason: unknown = e.reason;
    push('error', {
      data: {
        text: clip(reason instanceof Error ? reason.message : String(reason), MAX_TEXT_LENGTH),
      },
    });
  });

  // --- Navigations : chemin ET recherche (l'onglet d'un serveur vit dans `?tab=`) -----------------
  // TanStack Router passe par pushState/replaceState ; popstate couvre back/forward.
  let lastUrl = location.pathname + location.search;
  const onNav = (): void => {
    const url = location.pathname + location.search;
    if (url === lastUrl) return;
    lastUrl = url;
    push('nav', location.search === '' ? {} : { data: { search: clip(location.search, 200) } });
  };
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method].bind(history);
    history[method] = (...args: Parameters<History['pushState']>) => {
      original(...args);
      onNav();
    };
  }
  window.addEventListener('popstate', onNav);

  // --- Fenêtre : redimensionnée, masquée, revenue ----------------------------------------------------
  let resize: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    if (resize !== undefined) clearTimeout(resize);
    resize = setTimeout(() => {
      push('view', { data: { vw: window.innerWidth, vh: window.innerHeight } });
    }, 500);
  });
  document.addEventListener('visibilitychange', () => {
    push('view', { data: { state: document.visibilityState } });
    // Fin de session de page : on envoie ce qui reste via sendBeacon (fiable pendant l'unload).
    if (document.visibilityState === 'hidden') flush(true);
  });
}
