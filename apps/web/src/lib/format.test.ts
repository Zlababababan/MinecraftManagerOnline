import { describe, expect, it } from 'vitest';

import { ago, formatDuration, formatGb, formatMb, formatPct, hasRole } from './format.js';

describe('format', () => {
  it('rôles', () => {
    expect(hasRole('admin', 'viewer')).toBe(true);
    expect(hasRole('viewer', 'operator')).toBe(false);
    expect(hasRole('operator', 'operator')).toBe(true);
  });
  it('tailles', () => {
    expect(formatMb(512)).toBe('512 MB');
    expect(formatMb(4096)).toBe('4.0 GB');
    expect(formatMb(16384)).toBe('16 GB');
    expect(formatMb(null)).toBe('—');
    expect(formatGb(12.34)).toBe('12.3 GB');
    expect(formatGb(1500)).toBe('1.50 TB');
    expect(formatPct(42.6)).toBe('43 %');
  });
  it('durées', () => {
    expect(formatDuration(5_000)).toBe('5 s');
    expect(formatDuration(120_000)).toBe('2 min');
    expect(formatDuration(7_200_000)).toBe('2 h');
    expect(formatDuration(3 * 86_400_000)).toBe('3 d');
    expect(ago(null, 0)).toBeUndefined();
    expect(ago(1_000, 61_000)).toBe('1 min');
  });
});
