import { describe, expect, it } from 'vitest';

import { epochMsSchema, PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from './index.js';

describe('@mmo/protocol', () => {
  it('déclare une version supportée', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(PROTOCOL_VERSION);
  });

  it('valide un timestamp epoch ms', () => {
    expect(epochMsSchema.safeParse(1_755_800_000_000).success).toBe(true);
    expect(epochMsSchema.safeParse(-1).success).toBe(false);
    expect(epochMsSchema.safeParse(1.5).success).toBe(false);
  });
});
