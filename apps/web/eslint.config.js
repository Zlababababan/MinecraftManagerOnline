import { mmoEslint } from '@mmo/config/eslint';

export default mmoEslint({
  tsconfigRootDir: import.meta.dirname,
  kind: 'web',
  extra: [
    {
      ignores: [
        'scripts/**',
        'dev-dist/**',
        'playwright-report/**',
        'test-results/**',
        'public/**',
      ],
    },
    // Scripts e2e : Node (process, console) + Playwright.
    {
      files: ['e2e/**/*.ts', 'playwright.config.ts'],
      languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
      rules: { 'no-console': 'off' },
    },
    // TanStack Router : `throw redirect(...)` est l'API officielle (objet Redirect, pas une Error).
    {
      files: ['src/router.tsx'],
      rules: { '@typescript-eslint/only-throw-error': 'off' },
    },
  ],
});
