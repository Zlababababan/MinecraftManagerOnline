import { mmoEslint } from '@mmo/config/eslint';

export default mmoEslint({
  tsconfigRootDir: import.meta.dirname,
  kind: 'node',
  // Fixtures : dossiers serveurs copiés + collecteur autonome (script Node hors projet TS).
  extra: [{ ignores: ['test/fixtures/**'] }],
});
