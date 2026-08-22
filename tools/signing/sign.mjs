#!/usr/bin/env node
/**
 * Signe un bundle agent (Ed25519) et imprime le manifeste à fournir au panel
 * (`PUT /api/admin/agent-releases`) : sha256, signature base64, taille.
 *   node tools/signing/sign.mjs <bundle.js> [--key <private.pem>] [--json]
 * Clé : `--key`, sinon `MMO_SIGNING_KEY` (chemin), sinon la clé de développement `dev.private.pem`
 * (à remplacer avant toute release publique — phase 11).
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: sign.mjs <bundle.js> [--key <private.pem>] [--json]');
  process.exit(2);
}
const keyIdx = args.indexOf('--key');
const keyPath =
  keyIdx !== -1
    ? args[keyIdx + 1]
    : (process.env.MMO_SIGNING_KEY ?? path.join(import.meta.dirname, 'dev.private.pem'));
const key = createPrivateKey(readFileSync(keyPath));
const data = readFileSync(file);
const sha256 = createHash('sha256').update(data).digest('hex');
const signature = sign(null, data, key).toString('base64');
const size = statSync(file).size;
if (args.includes('--json')) {
  console.log(JSON.stringify({ file, size, sha256, signature }, null, 2));
} else {
  console.log(
    `file:      ${file}\nsize:      ${size}\nsha256:    ${sha256}\nsignature: ${signature}`,
  );
}
