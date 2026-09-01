/**
 * Phase 12 — passe d'accessibilité de base (axe-core via Playwright) sur les pages principales,
 * en clair et en sombre : aucune violation `serious`/`critical` (WCAG 2.1 A/AA). Les règles
 * `moderate`/`minor` sont listées dans le rapport de test mais ne bloquent pas.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { langOf, login } from './helpers.js';

const failures: string[] = [];

async function audit(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const describe = (v: (typeof results.violations)[number]) =>
    `${v.id} (${v.impact ?? '?'}) — ${v.help} : ${v.nodes
      .slice(0, 3)
      .map(
        (n) =>
          n.target.join(' ') +
          // Le sélecteur seul est un identifiant Mantine généré : il ne dit pas QUEL champ est en
          // cause, et retrouver le coupable demande alors de rejouer la page à la main. Le fragment
          // de HTML, lui, le nomme.
          ' ' +
          JSON.stringify(n.any[0]?.data ?? n.html.slice(0, 200)),
      )
      .join(' | ')}`;
  const others = results.violations.filter((v) => !blocking.includes(v));
  if (others.length > 0) {
    test.info().annotations.push({
      type: `a11y:${label}`,
      description: others.map(describe).join('\n'),
    });
  }
  failures.push(...blocking.map((v) => `[${label}] ${describe(v)}`));
}

test('accessibilité : login, tableau de bord, serveur, machines, machine, compte, réglages — clair et sombre', async ({
  page,
}, testInfo) => {
  const lang = langOf(testInfo.project.use.locale);
  await page.goto('/login');
  await expect(page.getByTestId('login')).toBeVisible();
  await audit(page, 'login');
  await login(page, lang);

  const card = page.getByTestId('server-card').first();
  await expect(card).toBeVisible();
  const serverHref = await card.getByTestId('server-link').getAttribute('href');
  const machinesRes = await page.request.get('/api/machines');
  const { machines } = (await machinesRes.json()) as { machines: { id: string }[] };

  for (const scheme of ['light', 'dark'] as const) {
    // Thème explicite via le gestionnaire Mantine (localStorage) : clair puis sombre.
    await page.evaluate((value) => {
      localStorage.setItem('mmo.theme', value);
    }, scheme);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await audit(page, `dashboard-${scheme}`);

    await page.goto(serverHref ?? '/');
    await expect(page.getByTestId('server-page')).toBeVisible();
    await audit(page, `server-${scheme}`);

    await page.goto('/machines');
    await expect(page.getByTestId('machines-page')).toBeVisible();
    await audit(page, `machines-${scheme}`);

    if (machines[0]) {
      await page.goto(`/machines/${machines[0].id}`);
      await expect(page.getByTestId('machine-page')).toBeVisible();
      await audit(page, `machine-${scheme}`);
    }

    await page.goto('/account');
    await expect(page.getByTestId('account-page')).toBeVisible();
    await audit(page, `account-${scheme}`);

    await page.goto('/settings');
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await audit(page, `settings-${scheme}`);
  }
  expect(failures).toEqual([]);
});
