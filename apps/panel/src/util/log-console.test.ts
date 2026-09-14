/**
 * Rendu lisible du journal sur la console : ce qu'un humain lit dans une fenêtre, sans rien perdre
 * de ce que le fichier NDJSON contient. Les entrées de test sont de vraies lignes produites par le
 * panel (copiées d'un journal de production).
 */
import { describe, expect, it } from 'vitest';

import { formatConsoleLine } from './log-console.js';

const AT = Date.UTC(2026, 8, 4, 20, 49, 9, 588);

describe('formatConsoleLine', () => {
  it('remplace le NDJSON par l’heure, le niveau et le message', () => {
    const line = JSON.stringify({
      level: 30,
      time: AT,
      pid: 18028,
      hostname: 'DESKTOP-TD36MUO',
      msg: 'Server listening at http://127.0.0.1:3000',
    });
    const out = formatConsoleLine(line, { timeZone: 'UTC' });
    expect(out).toBe('20:49:09 INFO  Server listening at http://127.0.0.1:3000');
    // Ni le pid, ni le nom de machine : ils n'apprennent rien à qui regarde une fenêtre.
    expect(out).not.toContain('18028');
    expect(out).not.toContain('DESKTOP');
  });

  it('garde le reste de l’entrée en clé=valeur, dans l’ordre du journal', () => {
    const line = JSON.stringify({
      level: 30,
      time: AT,
      pid: 1,
      hostname: 'h',
      users: 1,
      dataDir: 'E:\\mmo-panel\\data',
      msg: 'panel ready',
    });
    expect(formatConsoleLine(line, { timeZone: 'UTC' })).toBe(
      '20:49:09 INFO  panel ready users=1 dataDir=E:\\mmo-panel\\data',
    );
  });

  it('cite ce qui contient une espace, pour qu’on voie où la valeur s’arrête', () => {
    const line = JSON.stringify({
      level: 40,
      time: AT,
      msg: 'agent offline',
      name: 'Poste de recette',
    });
    expect(formatConsoleLine(line, { timeZone: 'UTC' })).toBe(
      '20:49:09 WARN  agent offline name="Poste de recette"',
    );
  });

  it('réduit une erreur à son message : une stack sur une ligne noie ce qu’on cherche', () => {
    const line = JSON.stringify({
      level: 50,
      time: AT,
      msg: 'request failed',
      err: { type: 'Error', message: 'connect ECONNREFUSED', stack: 'Error: connect...\n at x' },
    });
    const out = formatConsoleLine(line, { timeZone: 'UTC' });
    expect(out).toBe('20:49:09 ERROR request failed err="connect ECONNREFUSED"');
    expect(out).not.toContain('stack');
  });

  it('nomme chaque niveau de pino', () => {
    const of = (level: number) =>
      formatConsoleLine(JSON.stringify({ level, time: AT, msg: 'x' }), { timeZone: 'UTC' });
    expect(of(10)).toContain('TRACE');
    expect(of(20)).toContain('DEBUG');
    expect(of(30)).toContain('INFO');
    expect(of(40)).toContain('WARN');
    expect(of(50)).toContain('ERROR');
    expect(of(60)).toContain('FATAL');
  });

  it('rend undefined sur ce qui n’est pas une ligne de journal — l’appelant l’affiche brute', () => {
    // Une trace, un avertissement de Node, une ligne d'un outil tiers : la perdre serait pire.
    expect(formatConsoleLine('(node:123) Warning: something')).toBeUndefined();
    expect(formatConsoleLine('{ pas du json')).toBeUndefined();
    expect(formatConsoleLine('[1, 2, 3]')).toBeUndefined();
    expect(formatConsoleLine('{"level":30,"time":1}')).toBeUndefined(); // sans msg
    expect(formatConsoleLine('')).toBeUndefined();
  });

  it('quiet : le journal d’accès reste au fichier — il noyait la console (398 lignes sur 410)', () => {
    const request = JSON.stringify({
      level: 30,
      time: AT,
      requestId: '01M1RY4FMMCTQSTEYZ234QR8R8',
      method: 'GET',
      route: '/api/auth/me',
      status: 200,
      durationMs: 15,
      user: 'admin',
      ip: '127.0.0.1',
      msg: 'request',
    });
    expect(formatConsoleLine(request, { quiet: true })).toBeNull();
    // Sans l'option, la ligne est rendue comme n'importe quelle autre.
    expect(formatConsoleLine(request, { timeZone: 'UTC' })).toContain(
      'method=GET route=/api/auth/me status=200',
    );
  });

  it('quiet : un avertissement du journal d’accès (500, réponse lente) reste affiché', () => {
    const slow = JSON.stringify({
      level: 40,
      time: AT,
      method: 'GET',
      route: '/api/events',
      status: 200,
      durationMs: 1500,
      msg: 'request',
    });
    expect(formatConsoleLine(slow, { quiet: true, timeZone: 'UTC' })).toBe(
      '20:49:09 WARN  request method=GET route=/api/events status=200 durationMs=1500',
    );
    // Et le reste du journal n'est pas concerné par l'option.
    const ready = JSON.stringify({ level: 30, time: AT, msg: 'panel ready', users: 1 });
    expect(formatConsoleLine(ready, { quiet: true, timeZone: 'UTC' })).toBe(
      '20:49:09 INFO  panel ready users=1',
    );
  });

  it('colore seulement quand on le demande', () => {
    const line = JSON.stringify({ level: 50, time: AT, msg: 'boom' });
    expect(formatConsoleLine(line, { timeZone: 'UTC' })).not.toContain('\u001b[');
    expect(formatConsoleLine(line, { timeZone: 'UTC', color: true })).toContain('\u001b[31m');
  });
});
