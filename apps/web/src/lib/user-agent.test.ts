import { describe, expect, it } from 'vitest';

import { summarizeUserAgent } from './user-agent.js';

describe('summarizeUserAgent', () => {
  it('reconnaît navigateur et système sans confondre Chrome, Edge et Safari', () => {
    expect(
      summarizeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
      ),
    ).toBe('Edge · Windows');
    expect(
      summarizeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome · Windows');
    expect(
      summarizeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari · iPhone');
    expect(
      summarizeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'),
    ).toBe('Firefox · Linux');
    expect(summarizeUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/128.0 Mobile')).toBe(
      'Chrome · Android',
    );
  });

  it('rend undefined quand rien n’est reconnaissable', () => {
    expect(summarizeUserAgent(null)).toBeUndefined();
    expect(summarizeUserAgent('')).toBeUndefined();
    expect(summarizeUserAgent('curl/8.4.0')).toBeUndefined();
  });
});
