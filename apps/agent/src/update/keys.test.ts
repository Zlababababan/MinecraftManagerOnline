/** Phase 12 : en dev/test les deux clés (release + développement) sont acceptées ; la release n'embarque que la clé de release (`MMO_RELEASE_BUILD=1`, esbuild `define`). */
import { describe, expect, it } from 'vitest';

import { AGENT_UPDATE_PUBLIC_KEYS } from './keys.js';

describe('clés de mise à jour', () => {
  it('build de développement : clé de release en premier, clé de dev acceptée', () => {
    expect(process.env.MMO_RELEASE_BUILD).not.toBe('1');
    expect(AGENT_UPDATE_PUBLIC_KEYS).toHaveLength(2);
    expect(AGENT_UPDATE_PUBLIC_KEYS[0]).toBe(
      'MCowBQYDK2VwAyEAiUDWJLKR+sl8iyPeWm3DEVze+zj+an5PAoQVviUh/Sc=',
    );
    expect(AGENT_UPDATE_PUBLIC_KEYS[1]).toBe(
      'MCowBQYDK2VwAyEAR5uDa6jNinbjRtOdBPBDA7gQ1nvDOEXecSBWQfG9Cnk=',
    );
    for (const k of AGENT_UPDATE_PUBLIC_KEYS) expect(Buffer.from(k, 'base64')).toHaveLength(44);
  });
});
