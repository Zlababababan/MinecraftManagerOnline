#!/usr/bin/env node
/**
 * Génère une paire de clés Ed25519 pour signer les bundles agent (doc 03 §3).
 *   node tools/signing/keygen.mjs <dossier-sortie>
 * Produit `<dossier>/mmo-release.private.pem` (à garder HORS du panel et hors du dépôt) et
 * `<dossier>/mmo-release.public.txt` (SPKI DER base64, à ajouter dans `apps/agent/src/update/keys.ts`).
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
if (!out) {
  console.error('usage: keygen.mjs <output-dir>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const priv = path.join(out, 'mmo-release.private.pem');
const pub = path.join(out, 'mmo-release.public.txt');
writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
writeFileSync(pub, spki + '\n');
console.log(`private key: ${priv}\npublic key (embed in agent): ${spki}`);
