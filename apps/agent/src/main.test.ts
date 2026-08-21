import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path, { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { describeAgent, main, parseArgs } from './main.js';
import { tmpDir } from './test/helpers.js';

const bundle = resolve(import.meta.dirname, '../dist/agent.js');

describe('CLI', () => {
  it('se décrit', () => {
    expect(describeAgent()).toContain('MinecraftManagerOnline agent');
    expect(describeAgent()).toContain('protocole v1');
  });

  it('parse les arguments (commande, positionnels, options --k v et --k=v)', () => {
    expect(parseArgs(['--version'])).toMatchObject({ command: 'run' });
    expect(parseArgs([])).toMatchObject({ command: 'run', positional: [] });
    const cli = parseArgs(['dev', 'C:/srv', '--xmx', '4096', '--java=/bin/java', '--verbose']);
    expect(cli.command).toBe('dev');
    expect(cli.positional).toEqual(['C:/srv']);
    expect(cli.flags.get('xmx')).toBe('4096');
    expect(cli.flags.get('java')).toBe('/bin/java');
    expect(cli.flags.get('verbose')).toBe(true);
  });

  it('scan <dir> : détecte et imprime du JSON', async () => {
    const { dir, cleanup } = await tmpDir('mmo-cli-');
    try {
      const srv = path.join(dir, 'Vanilla');
      await mkdir(srv, { recursive: true });
      await writeFile(path.join(srv, 'server.properties'), 'server-port=25565\n');
      await writeFile(path.join(srv, 'eula.txt'), 'eula=true\n');
      await writeFile(path.join(srv, 'server.jar'), '');
      const chunks: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s: string | Uint8Array): boolean => {
        chunks.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
        return true;
      };
      let code: number;
      try {
        code = await main(['scan', dir]);
      } finally {
        process.stdout.write = original;
      }
      expect(code).toBe(0);
      const parsed = JSON.parse(chunks.join('')) as { name: string }[];
      expect(parsed.map((s) => s.name)).toContain('Vanilla');
    } finally {
      await cleanup();
    }
  });

  it('commande inconnue → code 2', async () => {
    expect(await main(['frobnicate'])).toBe(2);
  });
});

describe('bundle (doc 03 §1 : aucun module natif)', () => {
  it('existe et s’exécute seul', () => {
    expect(existsSync(bundle)).toBe(true);
    const out = execFileSync(process.execPath, [bundle, '--version'], { encoding: 'utf8' });
    expect(out).toContain('protocole v1');
  });

  it('ne charge aucun module natif', () => {
    const source = readFileSync(bundle, 'utf8');
    expect(source).not.toMatch(/\.node["'`]/);
    expect(source).not.toMatch(/process\.dlopen/);
    expect(source).not.toMatch(/node-gyp-build|require\(["']bindings["']\)/);
  });

  it('n’embarque pas `ws` (dépendance de test uniquement)', () => {
    const source = readFileSync(bundle, 'utf8');
    expect(source).not.toContain('WebSocketServer');
  });
});
