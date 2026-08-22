/** Téléchargement avec cache local (`tools/release/.cache/`, ignoré par git) et vérification sha256. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const CACHE_DIR = path.join(import.meta.dirname, '.cache');

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function download(url, expectedSha256, { name = path.basename(url) } = {}) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cached = path.join(CACHE_DIR, name);
  if (existsSync(cached)) {
    const data = readFileSync(cached);
    if (sha256(data) === expectedSha256) return data;
    console.warn(`[release] cache invalide pour ${name}, retéléchargement`);
  }
  console.log(`[release] téléchargement ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const actual = sha256(data);
  if (actual !== expectedSha256) {
    throw new Error(`${name}: sha256 ${actual} ≠ attendu ${expectedSha256}`);
  }
  writeFileSync(cached, data);
  return data;
}
