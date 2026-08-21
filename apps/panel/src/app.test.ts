import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

describe('panel', () => {
  it('répond sur /api/health', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; name: string; protocolVersion: number; time: number }>();
    expect(body.ok).toBe(true);
    expect(body.name).toBe('MinecraftManagerOnline');
    expect(body.protocolVersion).toBe(1);
    expect(Number.isInteger(body.time)).toBe(true);
    await app.close();
  });
});
