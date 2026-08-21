import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EVENTS,
  EVENT_TYPES,
  REQUESTS,
  REQUEST_TYPES,
  isEventType,
  isRequestType,
} from './catalog.js';
import { envelopeSchema, requestEnvelopeSchema } from './envelope.js';
import { ERROR_CODES, ProtocolError, protocolErrorSchema } from './errors.js';
import { PANEL_VERSION_RANGE, PROTOCOL_VERSION, negotiateProtocolVersion } from './version.js';

interface Fixtures {
  requests: { type: string; request: unknown; response: unknown }[];
  events: { type: string; payload: unknown }[];
}

const fixtures = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '..', 'test', 'fixtures', 'v1', 'messages.json'),
    'utf8',
  ),
) as Fixtures;

describe('catalogue v1 — tests de contrat sur fixtures', () => {
  it('chaque requête du catalogue a une fixture valide (requête + réponse)', () => {
    const covered = new Set(fixtures.requests.map((f) => f.type));
    expect(REQUEST_TYPES.filter((t) => !covered.has(t))).toEqual([]);
    for (const f of fixtures.requests) {
      expect(isRequestType(f.type), f.type).toBe(true);
      if (!isRequestType(f.type)) continue;
      const def = REQUESTS[f.type];
      const req = def.request.safeParse(f.request);
      expect(req.success, `${f.type} request: ${JSON.stringify(req.error?.issues)}`).toBe(true);
      const res = def.response.safeParse(f.response);
      expect(res.success, `${f.type} response: ${JSON.stringify(res.error?.issues)}`).toBe(true);
    }
  });

  it('chaque événement du catalogue a une fixture valide', () => {
    const covered = new Set(fixtures.events.map((f) => f.type));
    expect(EVENT_TYPES.filter((t) => !covered.has(t))).toEqual([]);
    for (const f of fixtures.events) {
      expect(isEventType(f.type), f.type).toBe(true);
      if (!isEventType(f.type)) continue;
      const parsed = EVENTS[f.type].payload.safeParse(f.payload);
      expect(parsed.success, `${f.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('tolère les champs inconnus (compatibilité N/N-1 : jamais `.strict()`)', () => {
    for (const f of fixtures.requests) {
      if (!isRequestType(f.type)) continue;
      const def = REQUESTS[f.type];
      const extra = { ...(f.request as object), futureField: { nested: true }, anotherOne: 42 };
      expect(def.request.safeParse(extra).success, f.type).toBe(true);
      const extraRes = { ...(f.response as object), futureField: 'x' };
      expect(def.response.safeParse(extraRes).success, f.type).toBe(true);
    }
    for (const f of fixtures.events) {
      if (!isEventType(f.type)) continue;
      const extra = { ...(f.payload as object), futureField: [1, 2, 3] };
      expect(EVENTS[f.type].payload.safeParse(extra).success, f.type).toBe(true);
    }
  });

  it('les événements critiques portent un eventId acquittable', () => {
    for (const f of fixtures.events) {
      if (!isEventType(f.type)) continue;
      if (EVENTS[f.type].critical) {
        expect((f.payload as { eventId?: unknown }).eventId, f.type).toMatch(
          /^[0-9A-HJKMNP-TV-Z]{26}$/,
        );
      }
    }
  });

  it('une requête P→A/A→P a une direction déclarée', () => {
    for (const t of REQUEST_TYPES) expect(['p2a', 'a2p']).toContain(REQUESTS[t].dir);
    for (const t of EVENT_TYPES) expect(['p2a', 'a2p']).toContain(EVENTS[t].dir);
  });

  it('un type inconnu n’est ni une requête ni un événement', () => {
    expect(isRequestType('backup.create')).toBe(false);
    expect(isEventType('task.progress')).toBe(false);
    expect(isRequestType('__proto__')).toBe(false);
  });
});

describe('enveloppe', () => {
  const id = '01J5X8ZK3Q9WYE2R7M4T6B8N1C';

  it('valide une requête conforme au doc 05 §2', () => {
    const env = {
      v: 1,
      kind: 'req',
      id,
      type: 'server.start',
      ts: 1787330455000,
      deadlineMs: 30000,
      payload: {},
    };
    expect(requestEnvelopeSchema.safeParse(env).success).toBe(true);
    expect(envelopeSchema.safeParse({ ...env, extra: 'ignored' }).success).toBe(true);
  });

  it('refuse un id non ULID, un ts non entier, un genre inconnu', () => {
    expect(
      requestEnvelopeSchema.safeParse({
        v: 1,
        kind: 'req',
        id: 'abc',
        type: 'x',
        ts: 1,
        payload: {},
      }).success,
    ).toBe(false);
    expect(
      requestEnvelopeSchema.safeParse({ v: 1, kind: 'req', id, type: 'x', ts: 1.5, payload: {} })
        .success,
    ).toBe(false);
    expect(
      envelopeSchema.safeParse({ v: 1, kind: 'push', id, type: 'x', ts: 1, payload: {} }).success,
    ).toBe(false);
  });

  it('valide une réponse ok et une réponse en erreur', () => {
    expect(
      envelopeSchema.safeParse({
        v: 1,
        kind: 'res',
        re: id,
        type: 'server.start',
        ts: 1,
        ok: true,
        payload: {},
      }).success,
    ).toBe(true);
    const err = {
      code: 'E_RAM_GUARD',
      message: 'not enough free memory',
      retryable: false,
      details: { needMb: 8192, freeMb: 2048 },
    };
    expect(
      envelopeSchema.safeParse({
        v: 1,
        kind: 'res',
        re: id,
        type: 'server.start',
        ts: 1,
        ok: false,
        error: err,
      }).success,
    ).toBe(true);
    expect(protocolErrorSchema.safeParse({ ...err, code: 'E_UNKNOWN_CODE' }).success).toBe(false);
  });
});

describe('erreurs', () => {
  it('ProtocolError ↔ payload, retryable par défaut selon le code', () => {
    const e = new ProtocolError('E_TIMEOUT', 'too slow', { details: { ms: 30000 } });
    expect(e.retryable).toBe(true);
    expect(e.toPayload()).toEqual({
      code: 'E_TIMEOUT',
      message: 'too slow',
      retryable: true,
      details: { ms: 30000 },
    });
    const back = ProtocolError.fromPayload({
      code: 'E_NOT_FOUND',
      message: 'nope',
      retryable: false,
    });
    expect(back).toBeInstanceOf(ProtocolError);
    expect(back.code).toBe('E_NOT_FOUND');
    expect(back.details).toBeUndefined();
    expect(ERROR_CODES).toContain('E_INVALID_PAYLOAD');
  });
});

describe('négociation de version (N / N-1)', () => {
  it('retient min(panelMax, agentMax) quand les plages se recouvrent', () => {
    expect(negotiateProtocolVersion({ protoMin: 1, protoMax: 1 })).toEqual({
      ok: true,
      version: PROTOCOL_VERSION,
    });
    expect(
      negotiateProtocolVersion({ protoMin: 1, protoMax: 3 }, { protoMin: 1, protoMax: 2 }),
    ).toEqual({ ok: true, version: 2 });
    expect(
      negotiateProtocolVersion({ protoMin: 1, protoMax: 1 }, { protoMin: 1, protoMax: 2 }),
    ).toEqual({ ok: true, version: 1 });
  });

  it('échoue proprement : agent trop vieux, trop récent, plage invalide', () => {
    expect(
      negotiateProtocolVersion({ protoMin: 1, protoMax: 1 }, { protoMin: 2, protoMax: 3 }),
    ).toEqual({ ok: false, reason: 'agent_too_old' });
    expect(
      negotiateProtocolVersion({ protoMin: 4, protoMax: 5 }, { protoMin: 2, protoMax: 3 }),
    ).toEqual({ ok: false, reason: 'agent_too_new' });
    expect(negotiateProtocolVersion({ protoMin: 2, protoMax: 1 })).toEqual({
      ok: false,
      reason: 'invalid_range',
    });
    expect(negotiateProtocolVersion({ protoMin: 0, protoMax: 1 })).toEqual({
      ok: false,
      reason: 'invalid_range',
    });
  });

  it('le panel supporte au plus N et N-1', () => {
    expect(PANEL_VERSION_RANGE.protoMax).toBe(PROTOCOL_VERSION);
    expect(PANEL_VERSION_RANGE.protoMin).toBeGreaterThanOrEqual(Math.max(1, PROTOCOL_VERSION - 1));
  });
});
