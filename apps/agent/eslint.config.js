import { mmoEslint } from '@mmo/config/eslint';

export default mmoEslint({
  tsconfigRootDir: import.meta.dirname,
  kind: 'agent',
  // Le fake Java server est un script Node autonome (harnais de test), hors projet TypeScript.
  extra: [{ ignores: ['test/**'] }],
});
