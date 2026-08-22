import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tmpDir } from '../test/helpers.js';
import { listLogFiles, searchLogs } from './logs.js';

describe('logs.listFiles / logs.search (doc 05 §6)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir, cleanup } = await tmpDir());
    await mkdir(path.join(dir, 'logs'));
    await writeFile(
      path.join(dir, 'logs', 'latest.log'),
      "[10:00:00] [Server thread/INFO]: Alice joined the game\n[10:00:01] [Server thread/WARN]: Can't keep up!\n",
    );
    await writeFile(
      path.join(dir, 'logs', '2026-08-20-1.log.gz'),
      gzipSync(
        '[09:00:00] [Server thread/INFO]: alice left the game\n[09:00:01] [Server thread/INFO]: Done (1.0s)!\n',
      ),
    );
    await writeFile(path.join(dir, 'logs', 'debug.txt'), 'ignored');
    await writeFile(path.join(dir, 'logs', 'broken.log.gz'), 'not gzip');
  });
  afterEach(() => cleanup());

  it('liste latest.log d’abord puis les archives, sans les fichiers étrangers', async () => {
    const files = await listLogFiles(dir);
    expect(files[0]?.name).toBe('latest.log');
    expect(files.map((f) => f.name)).toContain('2026-08-20-1.log.gz');
    expect(files.map((f) => f.name)).not.toContain('debug.txt');
    expect(await listLogFiles(path.join(dir, 'nope'))).toEqual([]);
  });

  it('recherche insensible à la casse, .gz décompressés, archive corrompue ignorée', async () => {
    const r = await searchLogs(dir, { query: 'alice' });
    expect(r.truncated).toBe(false);
    expect(r.matches.map((m) => `${m.file}:${String(m.line)}`)).toEqual([
      'latest.log:1',
      '2026-08-20-1.log.gz:1',
    ]);
    const cs = await searchLogs(dir, { query: 'alice', caseSensitive: true });
    expect(cs.matches).toHaveLength(1);
    const re = await searchLogs(dir, { query: '^\\[09:.*Done', regex: true });
    expect(re.matches[0]?.text).toContain('Done');
    await expect(searchLogs(dir, { query: '[', regex: true })).rejects.toMatchObject({
      code: 'E_INVALID_PAYLOAD',
    });
  });

  it('borne par `limit` et restreint à `files`', async () => {
    const r = await searchLogs(dir, { query: 'the game', limit: 1 });
    expect(r.matches).toHaveLength(1);
    expect(r.truncated).toBe(true);
    const only = await searchLogs(dir, { query: 'the game', files: ['2026-08-20-1.log.gz'] });
    expect(only.matches.map((m) => m.file)).toEqual(['2026-08-20-1.log.gz']);
  });
});
