import { describe, expect, it } from 'vitest';

import { ConsoleBuffer } from './console-buffer.js';

function line(seq: number, text = `l${String(seq)}`) {
  return { seq, ts: 0, level: 'INFO' as const, text };
}

describe('ring buffer console (doc 05 §13 : 5 000 lignes / 2 Mo)', () => {
  it('expulse les plus anciennes au-delà du nombre de lignes', () => {
    const b = new ConsoleBuffer({ maxLines: 3 });
    for (let i = 1; i <= 5; i++) b.push(line(i));
    expect(b.size).toBe(3);
    expect(b.oldestSeq).toBe(3);
    expect(b.latestSeq).toBe(5);
  });

  it('expulse au-delà de la taille en octets', () => {
    const b = new ConsoleBuffer({ maxBytes: 10 });
    b.push(line(1, 'aaaa'));
    b.push(line(2, 'bbbb'));
    b.push(line(3, 'cccc'));
    expect(b.size).toBe(2);
    expect(b.oldestSeq).toBe(2);
  });

  it('since(seq) : rattrapage et signal de troncature', () => {
    const b = new ConsoleBuffer({ maxLines: 4 });
    for (let i = 1; i <= 10; i++) b.push(line(i));
    expect(b.since(8).lines.map((l) => l.seq)).toEqual([9, 10]);
    expect(b.since(8).truncated).toBe(false);
    expect(b.since(6).truncated).toBe(false);
    expect(b.since(3).truncated).toBe(true);
    expect(b.since(undefined).lines).toHaveLength(4);
  });

  it('compacte sans perdre de lignes sur de grands volumes', () => {
    const b = new ConsoleBuffer({ maxLines: 100 });
    for (let i = 1; i <= 10_000; i++) b.push(line(i));
    expect(b.size).toBe(100);
    expect(b.oldestSeq).toBe(9901);
    expect(b.since(9990).lines).toHaveLength(10);
  });
});
