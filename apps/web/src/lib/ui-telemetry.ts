/**
 * Parcours UI (maintenance) : capture les clics (identifiant `data-testid`, `aria-label` ou texte)
 * et les navigations, puis les envoie par lots à `POST /api/ui-events`. Jamais de query string ni
 * de contenu de champ : uniquement des identifiants d'éléments et des chemins de page.
 * Installé depuis `main.tsx` (jamais dans les tests) ; toute erreur d'envoi est silencieuse.
 */
import type { UiEventInput } from '@mmo/protocol/client';

const FLUSH_INTERVAL_MS = 5000;
const FLUSH_BATCH_SIZE = 25;
const MAX_QUEUE = 200;
const MAX_TARGET_LENGTH = 200;

/** Identifiant lisible de l'élément cliqué, du plus stable au moins stable. */
function targetLabel(element: Element): string | undefined {
  const interactive = element.closest('[data-testid], button, a, [role="button"], input, select');
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

  const push = (event: UiEventInput): void => {
    if (queue.length >= MAX_QUEUE) return;
    queue.push(event);
    if (queue.length >= FLUSH_BATCH_SIZE) {
      flush();
      return;
    }
    timer ??= setTimeout(() => {
      flush();
    }, FLUSH_INTERVAL_MS);
  };

  document.addEventListener(
    'click',
    (e) => {
      if (!(e.target instanceof Element)) return;
      const target = targetLabel(e.target);
      if (target === undefined) return;
      push({ ts: Date.now(), kind: 'click', page: location.pathname, target });
    },
    { capture: true },
  );

  // Navigations : TanStack Router passe par pushState/replaceState ; popstate couvre back/forward.
  let lastPath = location.pathname;
  const onNav = (): void => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    push({ ts: Date.now(), kind: 'nav', page: lastPath });
  };
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method].bind(history);
    history[method] = (...args: Parameters<History['pushState']>) => {
      original(...args);
      onNav();
    };
  }
  window.addEventListener('popstate', onNav);

  // Fin de session de page : on envoie ce qui reste via sendBeacon (fiable pendant l'unload).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
}
