/**
 * Aide contextuelle : la table langue → chemin est verrouillée contre les guides réels du dépôt
 * (fichier présent, ancre présente) — un renommage de section dans docs/guide casse ce test au
 * lieu de produire un lien mort en production.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { i18n } from '../i18n/index.js';
import { HELP_TOPICS, HelpLink, helpUrl } from './HelpLink.js';

// Vitest s'exécute depuis apps/web (jsdom : `import.meta.url` n'est pas un file://).
const GUIDE_DIR = path.resolve(process.cwd(), '../../docs/guide');

/** Slug GitHub d'un titre markdown : minuscules, ponctuation retirée, chaque espace → tiret. */
function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/ /g, '-');
}

describe('HELP_TOPICS', () => {
  it('chaque entrée pointe vers un fichier existant et une ancre existante', () => {
    for (const [topic, links] of Object.entries(HELP_TOPICS)) {
      for (const [locale, link] of Object.entries(links)) {
        const [file = link, anchor] = link.split('#');
        const markdown = readFileSync(path.join(GUIDE_DIR, file), 'utf8');
        if (anchor !== undefined) {
          const slugs = markdown
            .split('\n')
            .filter((line) => /^#{1,4} /.test(line))
            .map((line) => githubSlug(line.replace(/^#+ /, '')));
          expect(slugs, `${topic}/${locale} → ${link}`).toContain(anchor);
        }
      }
    }
  });

  it('helpUrl : langue courante, repli anglais', () => {
    expect(helpUrl('pairing', 'fr')).toBe(
      'https://github.com/Zlababababan/MinecraftManagerOnline/blob/main/docs/guide/fr/ajouter-une-machine.md#1-créer-la-machine-et-obtenir-la-commande',
    );
    expect(helpUrl('pairing', 'en')).toContain('/docs/guide/add-a-machine.md#1-create');
  });
});

describe('HelpLink', () => {
  it('rend un lien externe dans la langue de l’interface', async () => {
    await i18n.changeLanguage('fr');
    render(
      <MantineProvider>
        <HelpLink topic="backups" />
      </MantineProvider>,
    );
    const link = screen.getByTestId('help-backups');
    expect(link).toHaveAttribute('href', expect.stringContaining('fr/ajouter-une-machine.md'));
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAccessibleName('Ouvrir le guide');
  });

  it('variante inline : ancre texte', async () => {
    await i18n.changeLanguage('en');
    render(
      <MantineProvider>
        <HelpLink topic="publicUrl" inline />
      </MantineProvider>,
    );
    const link = screen.getByTestId('help-publicUrl');
    expect(link).toHaveAttribute('href', expect.stringContaining('#3-remote-access-summary'));
    expect(link).toHaveTextContent('Open the guide');
  });
});
