/**
 * Limiteur de débit : la fenêtre glissante, et surtout la NORMALISATION de la clé d'adresse.
 * Compter par adresse IPv6 complète revient à ne pas limiter du tout — un abonné résidentiel
 * dispose d'un /64, soit 2^64 clés (doc 03 §6).
 */
import { describe, expect, it } from 'vitest';

import { RateLimiter, clientKey } from './rate-limit.js';

describe('clientKey', () => {
  it('laisse une adresse IPv4 intacte', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('traite la forme mixte de Node comme de l’IPv4', () => {
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('ramène une IPv6 à son préfixe /64', () => {
    const a = clientKey('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd');
    const b = clientKey('2001:db8:1234:5678:1111:2222:3333:4444');
    expect(a).toBe(b);
    expect(a).toBe('2001:db8:1234:5678::/64');
    // Un autre /64 reste une clé distincte.
    expect(clientKey('2001:db8:1234:9999::1')).not.toBe(a);
  });

  it('ignore l’identifiant de zone et gère l’adresse absente', () => {
    expect(clientKey('fe80::1%eth0')).toBe(clientKey('fe80::1'));
    expect(clientKey(undefined)).toBe('unknown');
    expect(clientKey('')).toBe('unknown');
  });
});

describe('RateLimiter', () => {
  it('autorise jusqu’au maximum puis refuse, et oublie après la fenêtre', () => {
    let now = 0;
    const limiter = new RateLimiter({ max: 3, windowMs: 1000, now: () => now });
    expect([limiter.hit('a'), limiter.hit('a'), limiter.hit('a')]).toEqual([true, true, true]);
    expect(limiter.hit('a')).toBe(false);
    // Une autre clé n'est pas affectée.
    expect(limiter.hit('b')).toBe(true);
    now = 1001;
    expect(limiter.hit('a')).toBe(true);
  });

  it('reset oublie une clé (succès de connexion)', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000, now: () => 0 });
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(false);
    limiter.reset('a');
    expect(limiter.hit('a')).toBe(true);
  });

  // Deux adresses du même /64 partagent leur quota : c'est tout l'intérêt de la normalisation.
  it('deux adresses d’un même /64 partagent le quota', () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 1000, now: () => 0 });
    expect(limiter.hit(clientKey('2001:db8:0:1::1'))).toBe(true);
    expect(limiter.hit(clientKey('2001:db8:0:1::2'))).toBe(true);
    expect(limiter.hit(clientKey('2001:db8:0:1::3'))).toBe(false);
  });
});
