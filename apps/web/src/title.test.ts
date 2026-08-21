import { describe, expect, it } from 'vitest';

import { pageTitle } from './title.js';

describe('pageTitle', () => {
  it('compose le titre', () => {
    expect(pageTitle('MMO')).toBe('MMO');
    expect(pageTitle('MMO', 'Serveurs')).toBe('Serveurs — MMO');
    expect(pageTitle('MMO', '')).toBe('MMO');
  });
});
