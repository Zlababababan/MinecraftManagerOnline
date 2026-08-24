/** Rechargement après déploiement : détection des échecs de chunk, garde anti-boucle 30 s. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isChunkLoadError, reloadForNewVersion } from './chunk-reload.js';

describe('isChunkLoadError', () => {
  it('reconnaît les libellés des navigateurs', () => {
    expect(
      isChunkLoadError(
        new Error('Failed to fetch dynamically imported module: http://x/assets/BackupsPanel.js'),
      ),
    ).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('E_AGENT_OFFLINE'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('reloadForNewVersion', () => {
  const reload = vi.fn();

  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal('location', { reload });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    reload.mockClear();
  });

  it('recharge une fois, puis refuse pendant la fenêtre de garde', () => {
    expect(reloadForNewVersion()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadForNewVersion()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
