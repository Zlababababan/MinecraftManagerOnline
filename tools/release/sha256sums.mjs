/**
 * `SHA256SUMS.txt` d'une release, au format que `sha256sum -c` comprend.
 *
 * Les manifestes `panel-<plateforme>.json` portent déjà l'empreinte de chaque archive de panel,
 * mais il faut les ouvrir un par un et comparer à la main. Un seul fichier, vérifiable d'une
 * commande, couvre en plus les archives d'agents et le bundle :
 *
 *   sha256sum -c SHA256SUMS.txt --ignore-missing     (Linux)
 *   shasum -a 256 -c SHA256SUMS.txt --ignore-missing (macOS)
 *   Get-FileHash <fichier>                            (Windows, à comparer à l'œil)
 *
 * Les noms écrits sont des noms de FICHIER, sans dossier : le fichier est utilisable tel quel dans
 * le répertoire de téléchargement, qui est le seul endroit où quelqu'un s'en servira.
 *
 *   node tools/release/sha256sums.mjs <dossier> [fichier de sortie]
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Ce qui est publié et vérifiable : archives, bundle d'agent, manifestes. */
export function isReleaseAsset(name) {
  return (
    /^mmo-(panel|agent)-.*\.(zip|tar\.gz)$/.test(name) ||
    /^agent-.*\.js$/.test(name) ||
    /^(manifest|panel-[a-z0-9-]+)\.json$/.test(name)
  );
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (isReleaseAsset(entry)) out.push(full);
  }
  return out;
}

export function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function main(argv) {
  const dir = argv[0];
  if (dir === undefined) {
    console.error('usage: sha256sums.mjs <dossier> [fichier de sortie]');
    return 2;
  }
  const files = walk(dir).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  if (files.length === 0) {
    console.error(`aucun fichier de release trouvé dans ${dir}`);
    return 1;
  }
  const seen = new Set();
  const lines = [];
  for (const file of files) {
    const name = path.basename(file);
    // Le même artefact peut avoir été téléchargé deux fois (bundle d'agent identique sur tous les
    // hôtes) : une ligne par nom, sinon `sha256sum -c` vérifie deux fois le même fichier.
    if (seen.has(name)) continue;
    seen.add(name);
    lines.push(`${sha256(file)}  ${name}`);
  }
  const content = `${lines.join('\n')}\n`;
  const target = argv[1];
  if (target === undefined) process.stdout.write(content);
  else {
    writeFileSync(target, content);
    console.log(`${String(lines.length)} empreintes écrites dans ${target}`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
