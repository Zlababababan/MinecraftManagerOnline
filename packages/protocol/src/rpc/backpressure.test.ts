import { describe, expect, it } from 'vitest';

import { BACKPRESSURE, backpressureAction } from './backpressure.js';

describe('backpressureAction', () => {
  it('laisse tout passer sous le premier seuil', () => {
    expect(backpressureAction(0, true)).toBe('send');
    expect(backpressureAction(BACKPRESSURE.dropAboveBytes, true)).toBe('send');
    expect(backpressureAction(BACKPRESSURE.dropAboveBytes, false)).toBe('send');
  });

  it('abandonne les messages de faible valeur seulement, entre les deux seuils', () => {
    const between = BACKPRESSURE.dropAboveBytes + 1;
    expect(backpressureAction(between, true)).toBe('drop');
    expect(backpressureAction(between, false)).toBe('send');
  });

  it('ferme au-delà du second seuil, quelle que soit la valeur du message', () => {
    const beyond = BACKPRESSURE.closeAboveBytes + 1;
    expect(backpressureAction(beyond, true)).toBe('close');
    expect(backpressureAction(beyond, false)).toBe('close');
  });

  it('accepte des seuils sur mesure (tests, transports lents)', () => {
    expect(backpressureAction(50, true, { dropAboveBytes: 10, closeAboveBytes: 100 })).toBe('drop');
    expect(backpressureAction(150, false, { dropAboveBytes: 10, closeAboveBytes: 100 })).toBe(
      'close',
    );
  });
});
