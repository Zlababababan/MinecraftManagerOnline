/** Télémétrie UI : clics identifiés, navigations, envoi par lots, échec silencieux. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installUiTelemetry } from './ui-telemetry.js';

function lastBatch(fetchMock: ReturnType<typeof vi.fn>): {
  events: { kind: string; page: string; target?: string }[];
} {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(call[1].body as string) as {
    events: { kind: string; page: string; target?: string }[];
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
    // Le div sans rôle interactif n'est pas capturé.
    expect(events.map((e) => e.target)).toEqual(['action-start', 'Fermer']);
    expect(events[0]).toMatchObject({ kind: 'click', page: '/' });
  });

  it('capture les navigations pushState et popstate', () => {
    history.pushState({}, '', '/servers/s1');
    history.pushState({}, '', '/servers/s1'); // même chemin : ignoré
    vi.advanceTimersByTime(5000);
    const { events } = lastBatch(fetchMock);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'nav', page: '/servers/s1' });
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
