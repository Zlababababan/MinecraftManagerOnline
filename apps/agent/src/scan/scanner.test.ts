import { describe, expect, it } from 'vitest';

import { MemoryDetectFs, type MemoryTree } from '@mmo/shared';

import { Logger } from '../log.js';
import { Scanner } from './scanner.js';

const logger = new Logger('test', { stderr: false });

function vanilla(port = 25565): MemoryTree {
  return {
    'server.properties': `server-port=${String(port)}\n`,
    'eula.txt': 'eula=true\n',
    'server.jar': '',
    logs: { 'latest.log': '[10:00:00] [main/INFO]: Starting minecraft server version 1.20.1\n' },
  };
}

describe('scan des répertoires surveillés (doc 06 §2)', () => {
  it('détecte, puis signale ajouts, mises à jour (serveur connu) et disparitions', async () => {
    const root: MemoryTree = { A: vanilla(), B: vanilla(25566) };
    const fs = new MemoryDetectFs({ '/srv': root });
    const ids = new Map<string, string>([['/srv/A', 'srv_a']]);
    const scanner = new Scanner({
      logger,
      os: 'linux',
      fs,
      serverIdForPath: (p) => ids.get(p),
    });
    const first = await scanner.scan([{ id: 'd1', path: '/srv' }]);
    expect(first.servers.map((s) => s.name).sort()).toEqual(['A', 'B']);
    expect(first.added).toHaveLength(2);
    expect(first.added[0]?.directoryId).toBe('d1');
    expect(first.removed).toEqual([]);

    // Même contenu : aucun changement
    const second = await scanner.scan([{ id: 'd1', path: '/srv' }]);
    expect(second.added).toEqual([]);
    expect(second.updated).toEqual([]);

    // A change de port (serveur connu du panel) ; B disparaît
    root.A = vanilla(25600);
    delete root.B;
    const third = await scanner.scan([{ id: 'd1', path: '/srv' }]);
    expect(third.updated.map((u) => u.serverId)).toEqual(['srv_a']);
    expect(third.updated[0]?.server.gamePort).toBe(25600);
    expect(third.removed.map((r) => r.path)).toEqual(['/srv/B']);
  });

  it('ne déclare pas disparus les dossiers d’une racine non rescannée', async () => {
    const fs = new MemoryDetectFs({ '/one': { S: vanilla() }, '/two': { T: vanilla() } });
    const scanner = new Scanner({ logger, os: 'linux', fs });
    await scanner.scan([
      { id: '1', path: '/one' },
      { id: '2', path: '/two' },
    ]);
    const partial = await scanner.scan([{ id: '1', path: '/one' }]);
    expect(partial.removed).toEqual([]);
    expect(scanner.knownServers).toHaveLength(2);
  });
});
