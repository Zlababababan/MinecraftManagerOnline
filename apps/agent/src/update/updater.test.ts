/**
 * `AgentUpdater` : téléchargement depuis le panel (URL relative résolue), sha256, **signature Ed25519**
 * (clé embarquée injectée), `versions/<v>/agent.js` + `next.json`, sortie 75 ; signature invalide ⇒
 * `E_SIGNATURE_INVALID` et rien d'écrit ; sans launcher ⇒ refus ; `runtime.update` ⇒ `runtime/<v>/`
 * + `runtime-next.json` ; `update-result.json` consommé une seule fois.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Logger } from '../log.js';
import { buildZip, freePort, tmpDir, waitFor } from '../test/helpers.js';
import { AgentUpdater, UPDATE_EXIT_CODE } from './updater.js';

const logger = new Logger('test', { stderr: false });

describe('AgentUpdater', () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let server: http.Server;
  let origin: string;
  let files: Map<string, Buffer>;
  let hits: string[];

  beforeEach(async () => {
    ({ dir: home, cleanup } = await tmpDir('mmo-upd-'));
    files = new Map();
    hits = [];
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      const data = files.get(req.url ?? '');
      if (!data) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Length': String(data.byteLength) }).end(data);
    });
    const port = await freePort();
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    origin = `http://127.0.0.1:${String(port)}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => {
      server.close(() => {
        r();
      });
    });
    await cleanup();
  });

  function keys() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
      pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      signOf: (data: Buffer) => sign(null, data, privateKey).toString('base64'),
    };
  }
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
  const plainUpdater = () =>
    new AgentUpdater({
      home,
      currentVersion: '0.10.0',
      logger,
      panelOrigin: () => origin,
      restart: () => undefined,
    });

  it('bundle signé → versions/<v>/agent.js, next.json, sortie 75', async () => {
    const k = keys();
    const bundle = Buffer.from('console.log("agent 0.9.1")');
    files.set('/api/relay/tok', bundle);
    const exits: number[] = [];
    const updater = new AgentUpdater({
      home,
      currentVersion: '0.10.0',
      logger,
      publicKeys: [k.pub],
      panelOrigin: () => origin,
      restart: (code) => {
        exits.push(code);
      },
      exitDelayMs: 10,
    });
    const res = await updater.update({
      version: '0.9.1',
      url: '/api/relay/tok',
      sha256: sha(bundle),
      signature: k.signOf(bundle),
    });
    expect(res).toEqual({ accepted: true, currentVersion: '0.10.0', alreadyCurrent: false });
    expect(await readFile(path.join(home, 'versions', '0.9.1', 'agent.js'))).toEqual(bundle);
    expect(
      JSON.parse(await readFile(path.join(home, 'versions', '0.9.1', 'package.json'), 'utf8')),
    ).toEqual({
      type: 'commonjs',
    });
    expect(JSON.parse(await readFile(path.join(home, 'next.json'), 'utf8'))).toEqual({
      version: '0.9.1',
      previous: '0.10.0',
    });
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual([UPDATE_EXIT_CODE]);
    expect(hits).toEqual(['/api/relay/tok']);

    // Même version que la courante : rien à faire.
    const same = await updater.update({
      version: '0.10.0',
      url: '/x',
      sha256: 'a'.repeat(64),
      signature: 'AAAA',
    });
    expect(same.alreadyCurrent).toBe(true);
  });

  it('signature invalide (autre clé) ⇒ E_SIGNATURE_INVALID, rien n’est gardé', async () => {
    const k = keys();
    const other = keys();
    const bundle = Buffer.from('evil');
    files.set('/b', bundle);
    const updater = new AgentUpdater({
      home,
      currentVersion: '0.10.0',
      logger,
      publicKeys: [k.pub],
      panelOrigin: () => origin,
      restart: () => undefined,
    });
    await expect(
      updater.update({
        version: '0.9.2',
        url: `${origin}/b`,
        sha256: sha(bundle),
        signature: other.signOf(bundle),
      }),
    ).rejects.toMatchObject({ code: 'E_SIGNATURE_INVALID' });
    await expect(stat(path.join(home, 'versions', '0.9.2', 'agent.js'))).rejects.toThrow();
    await expect(stat(path.join(home, 'next.json'))).rejects.toThrow();
    // sha256 faux ⇒ E_CHECKSUM_MISMATCH avant même la signature.
    await expect(
      updater.update({
        version: '0.9.3',
        url: `${origin}/b`,
        sha256: 'f'.repeat(64),
        signature: k.signOf(bundle),
      }),
    ).rejects.toMatchObject({ code: 'E_CHECKSUM_MISMATCH' });
  });

  it('sans launcher : refus ; update-result consommé une fois', async () => {
    const noHome = new AgentUpdater({
      home: undefined,
      currentVersion: '0.10.0',
      logger,
      panelOrigin: () => origin,
      restart: () => undefined,
    });
    await expect(
      noHome.update({ version: '1.0.0', url: '/x', sha256: 'a'.repeat(64), signature: 'AA' }),
    ).rejects.toMatchObject({ code: 'E_CONFLICT', details: { reason: 'no_launcher' } });
    expect(await noHome.consumeUpdateResult()).toBeUndefined();

    const updater = new AgentUpdater({
      home,
      currentVersion: '0.10.0',
      logger,
      panelOrigin: () => origin,
      restart: () => undefined,
    });
    await writeFile(
      path.join(home, 'update-result.json'),
      JSON.stringify({
        kind: 'agent',
        status: 'rolled_back',
        version: '0.10.0',
        otherVersion: '0.9.1',
        reason: 'crash_loop',
        ts: 5,
      }),
    );
    expect(await updater.consumeUpdateResult()).toEqual({
      ts: 5,
      kind: 'agent',
      status: 'rolled_back',
      version: '0.10.0',
      otherVersion: '0.9.1',
      reason: 'crash_loop',
    });
    expect(await updater.consumeUpdateResult()).toBeUndefined();

    // Résultats successifs (ex. applied écrit par le launcher après notre healthy) : chacun est
    // revendiqué par rename puis lu — jamais supprimé sans lecture — sans résidu `*.consumed`.
    await writeFile(
      path.join(home, 'update-result.json'),
      JSON.stringify({ kind: 'runtime', status: 'applied', version: '24.18.0', ts: 6 }),
    );
    expect(await updater.consumeUpdateResult()).toMatchObject({
      kind: 'runtime',
      status: 'applied',
      version: '24.18.0',
    });
    expect((await readdir(home)).filter((f) => f.includes('claimed'))).toEqual([]);
  });

  // Régression du bug masqué par la tolérance [flaky-ci] de phase9 : le fichier était supprimé
  // dans un finally, donc AVANT le parse et avant toute émission. Une mort du processus dans
  // cette fenêtre perdait l'issue pour toujours — rien ne relisait jamais le fichier revendiqué.
  it('la revendication ne détruit rien, et une revendication orpheline est reprise', async () => {
    const updater = plainUpdater();
    await writeFile(
      path.join(home, 'update-result.json'),
      JSON.stringify({ kind: 'agent', status: 'applied', version: '1.0.1', ts: 7 }),
    );

    const claim = await updater.claimUpdateResult();
    expect(claim?.payload).toMatchObject({ kind: 'agent', status: 'applied', version: '1.0.1' });
    // Le fichier revendiqué existe TOUJOURS : c'est ce qui permet de rejouer après un arrêt brutal.
    expect(existsSync(claim!.claimedPath)).toBe(true);
    expect(existsSync(path.join(home, 'update-result.json'))).toBe(false);

    // Le processus meurt ici (aucun release). Au redémarrage, l'orpheline est reprise.
    const again = await updater.claimUpdateResult();
    expect(again?.payload).toMatchObject({ version: '1.0.1' });

    await updater.releaseUpdateResult(again!.claimedPath);
    expect(existsSync(again!.claimedPath)).toBe(false);
    expect(await updater.claimUpdateResult()).toBeUndefined();
  });

  it('un contenu invalide est écarté tout de suite, pas rejoué indéfiniment', async () => {
    const updater = plainUpdater();
    await writeFile(path.join(home, 'update-result.json'), '{ pas du json');
    expect(await updater.claimUpdateResult()).toBeUndefined();
    expect((await readdir(home)).filter((f) => f.startsWith('update-result'))).toEqual([]);

    await writeFile(
      path.join(home, 'update-result.json'),
      JSON.stringify({ kind: 'agent', status: 'inconnu', version: '1.0.1' }),
    );
    expect(await updater.claimUpdateResult()).toBeUndefined();
    expect((await readdir(home)).filter((f) => f.startsWith('update-result'))).toEqual([]);
  });

  it('runtime.update : archive zip vérifiée, extraite, runtime-next.json', async () => {
    const zip = buildZip([
      { name: 'node-v99.0.0-win-x64/', data: Buffer.alloc(0) },
      { name: 'node-v99.0.0-win-x64/node.exe', data: Buffer.from('fake node'), deflate: true },
      { name: 'node-v99.0.0-win-x64/node', data: Buffer.from('fake node') },
      { name: 'node-v99.0.0-win-x64/LICENSE', data: Buffer.from('MIT') },
    ]);
    files.set('/node.zip', zip);
    const updater = new AgentUpdater({
      home,
      currentVersion: '0.10.0',
      logger,
      panelOrigin: () => origin,
      restart: () => undefined,
    });
    const res = await updater.updateRuntime({
      version: '99.0.0',
      os: 'windows',
      arch: 'x64',
      url: '/node.zip',
      sha256: sha(zip),
      archive: 'zip',
    });
    expect(res).toEqual({
      accepted: true,
      currentVersion: process.version.replace(/^v/, ''),
      pending: true,
    });
    expect(await readFile(path.join(home, 'runtime', '99.0.0', 'node.exe'), 'utf8')).toBe(
      'fake node',
    );
    expect(await readFile(path.join(home, 'runtime', '99.0.0', 'LICENSE'), 'utf8')).toBe('MIT');
    expect(JSON.parse(await readFile(path.join(home, 'runtime-next.json'), 'utf8'))).toMatchObject({
      version: '99.0.0',
    });
  });
});
