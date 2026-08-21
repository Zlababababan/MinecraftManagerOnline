import { describe, expect, it } from 'vitest';

import { Backoff, backoffDelay } from './backoff.js';

describe('backoff (doc 05 §13 : 1 s → 60 s, jitter ±20 %)', () => {
  it('double à chaque tentative et plafonne à 60 s (sans jitter)', () => {
    const fixed = { random: () => 0.5 };
    expect(backoffDelay(0, fixed)).toBe(1000);
    expect(backoffDelay(1, fixed)).toBe(2000);
    expect(backoffDelay(5, fixed)).toBe(32_000);
    expect(backoffDelay(6, fixed)).toBe(60_000);
    expect(backoffDelay(40, fixed)).toBe(60_000);
  });

  it('applique un jitter de ±20 %', () => {
    expect(backoffDelay(0, { random: () => 0 })).toBe(800);
    expect(backoffDelay(0, { random: () => 1 })).toBe(1200);
    expect(backoffDelay(10, { random: () => 1 })).toBe(72_000);
  });

  it('se réinitialise', () => {
    const b = new Backoff({ random: () => 0.5 });
    expect(b.next()).toBe(1000);
    expect(b.next()).toBe(2000);
    b.reset();
    expect(b.next()).toBe(1000);
  });
});
