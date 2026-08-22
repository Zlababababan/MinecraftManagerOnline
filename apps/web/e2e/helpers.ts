import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const ADMIN = { username: 'admin', password: 'correct horse battery' };

/** Libellés attendus par langue (les tests vérifient la traduction, pas seulement la mécanique). */
export const TEXT = {
  fr: {
    dashboard: 'Tableau de bord',
    login: 'Connexion',
    running: 'En marche',
    stopped: 'Arrêté',
    start: 'Démarrer',
    stop: 'Arrêter',
    console: 'Console',
  },
  en: {
    dashboard: 'Dashboard',
    login: 'Sign in',
    running: 'Running',
    stopped: 'Stopped',
    start: 'Start',
    stop: 'Stop',
    console: 'Console',
  },
} as const;

export type Lang = keyof typeof TEXT;

export function langOf(locale: string | undefined): Lang {
  return (locale ?? 'fr').toLowerCase().startsWith('en') ? 'en' : 'fr';
}

export async function login(page: Page, lang: Lang): Promise<void> {
  await page.goto('/login');
  await expect(page.getByTestId('login')).toBeVisible();
  await expect(page.getByRole('heading', { name: TEXT[lang].login })).toBeVisible();
  await page.getByTestId('login-username').fill(ADMIN.username);
  await page.getByTestId('login-password').fill(ADMIN.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  // La langue du compte (préférence serveur) prime sur celle du navigateur : on l'aligne sur le
  // projet Playwright courant pour vérifier chaque langue de bout en bout.
  const res = await page.request.patch('/api/auth/me', { data: { locale: lang } });
  expect(res.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole('heading', { name: TEXT[lang].dashboard })).toBeVisible();
}

export async function apiLogin(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  expect(res.ok()).toBeTruthy();
}

export async function waitForServerState(
  request: APIRequestContext,
  serverId: string,
  state: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request.get(`/api/servers/${serverId}`);
    if (res.ok()) {
      const { server } = (await res.json()) as { server: { runState: string } };
      if (server.runState === state) return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server ${serverId} did not reach ${state}`);
}
