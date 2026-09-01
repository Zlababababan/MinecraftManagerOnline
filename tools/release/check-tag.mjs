/**
 * Garde-fou de release : le tag poussé, les deux constantes de version et le CHANGELOG doivent
 * dire la même chose — sinon on publie une archive `1.0.6` sous un tag `v1.0.7`, et personne ne
 * s'en aperçoit avant qu'un utilisateur ne compare.
 *
 * Sert aussi à extraire les notes : `--notes <fichier>` écrit la section du CHANGELOG correspondant
 * au tag. La release échoue donc si la section manque, ce qui est exactement ce qui rend la
 * discipline tenable — les notes générées automatiquement étaient une liste de sujets de commits de
 * plomberie CI, illisible pour qui vient télécharger.
 *
 *   node tools/release/check-tag.mjs v1.0.6
 *   node tools/release/check-tag.mjs v1.0.6 --notes notes.md
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** La valeur d'une constante `export const NOM = '…';` dans un fichier TypeScript. */
export function constantOf(file, name) {
  const source = readFileSync(path.join(ROOT, file), 'utf8');
  const match = new RegExp(`export const ${name} = '([^']+)'`).exec(source);
  if (match === null) throw new Error(`${name} introuvable dans ${file}`);
  return match[1];
}

/**
 * La section `## <version>` du CHANGELOG, titre compris, jusqu'au titre suivant. `undefined` si la
 * version n'y figure pas — c'est un échec de release, pas un détail de mise en forme.
 */
export function changelogSection(markdown, version) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) =>
    new RegExp(`^## ${version.replaceAll('.', '\\.')}\\b`).test(l),
  );
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n').trim();
}

function main(argv) {
  const tag = argv[0];
  if (tag === undefined || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    console.error('usage: check-tag.mjs v<X.Y.Z> [--notes <fichier>]');
    return 2;
  }
  const version = tag.slice(1);
  const panel = constantOf('apps/panel/src/version.ts', 'PANEL_VERSION');
  const agent = constantOf('apps/agent/src/agent.ts', 'AGENT_VERSION');

  const problems = [];
  if (panel !== version) problems.push(`PANEL_VERSION = ${panel}, tag = ${version}`);
  if (agent !== version) problems.push(`AGENT_VERSION = ${agent}, tag = ${version}`);

  const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const section = changelogSection(changelog, version);
  if (section === undefined) problems.push(`CHANGELOG.md n'a pas de section "## ${version}"`);

  if (problems.length > 0) {
    console.error(`release refusée pour ${tag} :`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('\nCorrigez la version (ou le tag) avant de publier.');
    return 1;
  }

  const notesIndex = argv.indexOf('--notes');
  if (notesIndex >= 0) {
    const target = argv[notesIndex + 1];
    if (target === undefined) {
      console.error('--notes attend un chemin de fichier');
      return 2;
    }
    writeFileSync(target, `${section}\n`);
    console.log(`notes de ${version} écrites dans ${target}`);
  }
  console.log(
    `ok : tag ${tag}, PANEL_VERSION et AGENT_VERSION ${version}, section CHANGELOG présente`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
