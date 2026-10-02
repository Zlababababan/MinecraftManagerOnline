/**
 * Télémétrie UI : clics identifiés, navigations, envoi par lots, échec silencieux — et rien du
 * tout depuis une page de statut publique (lot 8).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installUiTelemetry } from './ui-telemetry.js';

function lastBatch(fetchMock: ReturnType<typeof vi.fn>): {
  events: { kind: string; page: string; target?: string; data?: Record<string, unknown> }[];
} {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(call[1].body as string) as {
    events: { kind: string; page: string; target?: string; data?: Record<string, unknown> }[];
  };
}

describe('installUiTelemetry', () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));

  // Une seule installation : les écouteurs sont posés sur le `document` partagé du fichier.
  beforeAll(() => {
    installUiTelemetry();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    fetchMock.mockClear();
  });

  it('capture les clics (data-testid prioritaire) et envoie par lots après 5 s', () => {
    document.body.innerHTML = `
      <button data-testid="action-start"><span>Démarrer</span></button>
      <button aria-label="Fermer"></button>
      <div id="inerte">texte</div>`;
    document.querySelector('span')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document
      .querySelector('[aria-label]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.getElementById('inerte')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fetchMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { events } = lastBatch(fetchMock);
    // Depuis le 02/10, le div sans rôle interactif est capturé aussi, comme « clic dans le vide ».
    expect(events.map((e) => e.target)).toEqual(['action-start', 'Fermer', undefined]);
    expect(events[0]).toMatchObject({ kind: 'click', page: '/' });
    expect(events[0]?.data).not.toHaveProperty('void');
    expect(events[2]).toMatchObject({ kind: 'click', data: { void: true, tag: 'div' } });
  });

  it('capture les navigations pushState et popstate, onglet (?tab=) compris', () => {
    history.pushState({}, '', '/servers/s1');
    history.pushState({}, '', '/servers/s1'); // même adresse : ignoré
    history.pushState({}, '', '/servers/s1?tab=config&focus=server-port');
    vi.advanceTimersByTime(5000);
    const { events } = lastBatch(fetchMock);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'nav', page: '/servers/s1' });
    expect(events[0]).not.toHaveProperty('data');
    expect(events[1]).toMatchObject({
      kind: 'nav',
      page: '/servers/s1',
      data: { search: '?tab=config&focus=server-port' },
    });
  });

  it('champ modifié, touche hors saisie, message affiché ; une frappe dans un champ n’est pas une touche', async () => {
    document.body.innerHTML =
      '<input data-testid="prop-query.port" value="25570"><input type="password" id="pw" value="hunter2">';
    const field = document.querySelector<HTMLInputElement>('[data-testid="prop-query.port"]');
    field?.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('pw')?.dispatchEvent(new Event('change', { bubbles: true }));
    field?.dispatchEvent(new KeyboardEvent('keydown', { key: '7', bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const toast = document.createElement('div');
    toast.className = 'mantine-Notification-root';
    toast.textContent = 'Le port 25565 est déjà utilisé.';
    document.body.append(toast);
    await Promise.resolve(); // l'observateur de mutations rend la main en micro-tâche
    vi.advanceTimersByTime(5000);
    const { events } = lastBatch(fetchMock);
    expect(events.map((e) => e.kind)).toEqual(['input', 'input', 'key', 'toast']);
    expect(events[0]).toMatchObject({ target: 'prop-query.port', data: { value: '25570' } });
    expect(events[1]?.data).toEqual({ secret: true, length: 7 });
    expect(events[2]?.data).toEqual({ key: 'Escape' });
    expect(events[3]?.data).toEqual({ text: 'Le port 25565 est déjà utilisé.' });
    expect(JSON.stringify(events)).not.toContain('hunter2');
  });

  // Lot 8 : une page de statut publique est visitée par des inconnus, sans compte — rien de leur
  // passage ne remonte au panel, ni la navigation, ni les clics.
  it('n’enregistre rien depuis une page de statut publique', () => {
    history.pushState({}, '', '/s/aaaaaaaaaaaaaaaaaaaaaa');
    document.body.innerHTML = '<button data-testid="copier"></button>';
    document.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    vi.advanceTimersByTime(60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    // De retour sur une page du panel, l'enregistrement reprend : c'est une garde par chemin,
    // pas un interrupteur global (et la file repart vide pour les tests suivants).
    history.pushState({}, '', '/');
    vi.advanceTimersByTime(5000);
    expect(lastBatch(fetchMock).events).toEqual([
      expect.objectContaining({ kind: 'nav', page: '/' }),
    ]);
  });

  it("l'échec d'envoi est silencieux", async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    document.body.innerHTML = '<button data-testid="x"></button>';
    document.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
