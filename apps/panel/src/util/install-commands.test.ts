import { describe, expect, it } from 'vitest';

import { installChoices, installCommands } from './install-commands.js';

describe('adresse du panel dans les commandes d’installation', () => {
  it('commande simple, avec code d’appairage, avec adresse explicite', () => {
    expect(installCommands('https://p.example')).toEqual({
      url: 'https://p.example',
      windows: '& ([scriptblock]::Create((irm https://p.example/install.ps1)))',
      unix: 'curl -fsSL https://p.example/install.sh | sh',
    });
    expect(
      installCommands('http://127.0.0.1:3000', { pairCode: 'ABCD-1234', explicit: true }),
    ).toEqual({
      url: 'http://127.0.0.1:3000',
      windows:
        '& ([scriptblock]::Create((irm http://127.0.0.1:3000/install.ps1))) -Panel http://127.0.0.1:3000 -PairCode ABCD-1234',
      unix: 'curl -fsSL http://127.0.0.1:3000/install.sh | sh -s -- --panel http://127.0.0.1:3000 --pair-code ABCD-1234',
    });
  });

  it('adresse enregistrée ≠ adresse consultée : les deux sont proposées, « ici » en explicite', () => {
    const c = installChoices({ saved: 'https://pc.tail.ts.net', current: 'http://127.0.0.1:3000' });
    expect(c.install?.url).toBe('https://pc.tail.ts.net');
    expect(c.installHere?.windows).toContain('-Panel http://127.0.0.1:3000');
    expect(c.installHere?.unix).toContain('--panel http://127.0.0.1:3000');
  });

  it('même adresse : une seule commande, pas de doublon « ici »', () => {
    const c = installChoices({ saved: 'https://p.example', current: 'https://p.example' });
    expect(c.install?.url).toBe('https://p.example');
    expect(c.installHere).toBeUndefined();
  });

  it('rien d’enregistré : l’adresse consultée devient la commande ; rien du tout : aucune', () => {
    expect(installChoices({ saved: undefined, current: 'http://127.0.0.1:3000' })).toEqual({
      install: installCommands('http://127.0.0.1:3000'),
    });
    expect(installChoices({ saved: undefined, current: undefined })).toEqual({});
  });
});
