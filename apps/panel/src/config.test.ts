/**
 * Adresse d'écoute : jamais toutes les interfaces (doc 05 §12), sauf opt-in explicite
 * `MMO_ALLOW_ANY_INTERFACE` (conteneurs — la publication de port y est la couche d'accès).
 */
import { describe, expect, it } from 'vitest';

import { assertListenHost, configFromEnv, defaultConfig } from './config.js';

describe('config : adresse d’écoute', () => {
  it('refuse 0.0.0.0, :: et [::]', () => {
    for (const host of ['0.0.0.0', '::', '[::]']) {
      expect(() => {
        assertListenHost(host);
      }).toThrow(/never binds all interfaces/);
      expect(() => defaultConfig({ host })).toThrow(/never binds all interfaces/);
    }
    expect(() => defaultConfig({ host: '127.0.0.1' })).not.toThrow();
  });

  it('MMO_ALLOW_ANY_INTERFACE=1 lève l’interdiction (et seulement elle)', () => {
    expect(() => defaultConfig({ host: '0.0.0.0', allowAnyInterface: true })).not.toThrow();
    expect(() => configFromEnv({ MMO_HOST: '0.0.0.0' })).toThrow(/never binds all interfaces/);
    const config = configFromEnv({ MMO_HOST: '0.0.0.0', MMO_ALLOW_ANY_INTERFACE: '1' });
    expect(config.host).toBe('0.0.0.0');
    expect(config.allowAnyInterface).toBe(true);
    expect(configFromEnv({ MMO_ALLOW_ANY_INTERFACE: 'yes' }).allowAnyInterface).toBe(false);
  });
});
