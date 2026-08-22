import { mmoEslint } from '@mmo/config/eslint';

export default mmoEslint({
  tsconfigRootDir: import.meta.dirname,
  kind: 'agent',
  // Le fake Java server est un script Node autonome (harnais de test), hors projet TypeScript.
  // Le launcher est du JS CommonJS figé, hors projet TypeScript (doc 03 §3).
  extra: [{ ignores: ['test/**', 'launcher/**'] }],
});
