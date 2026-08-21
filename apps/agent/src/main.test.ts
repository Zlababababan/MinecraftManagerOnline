import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { describeAgent } from './main.js';

const bundle = resolve(import.meta.dirname, '../dist/agent.js');

describe('agent', () => {
  it('se décrit', () => {
    expect(describeAgent()).toContain('MinecraftManagerOnline agent');
  });

  it('le bundle existe et s’exécute seul', () => {
    expect(existsSync(bundle)).toBe(true);
    const out = execFileSync(process.execPath, [bundle, '--version'], { encoding: 'utf8' });
    expect(out).toContain('protocole v1');
  });

  it('le bundle ne charge aucun module natif (doc 03 §1)', () => {
    const source = readFileSync(bundle, 'utf8');
    expect(source).not.toMatch(/\.node["'`]/);
    expect(source).not.toMatch(/process\.dlopen/);
    expect(source).not.toMatch(/node-gyp-build|require\(["']bindings["']\)/);
  });
});
