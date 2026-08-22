// Configuration ESLint partagée (flat config, ESLint ≥ 9).
// Usage dans un package :  export default mmoEslint({ tsconfigRootDir: import.meta.dirname, kind: 'node' })
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * @param {object} options
 * @param {string} options.tsconfigRootDir  Dossier du package (import.meta.dirname)
 * @param {'node' | 'web' | 'protocol' | 'agent'} [options.kind]  Profil de règles additionnelles
 * @param {import('eslint').Linter.Config[]} [options.extra]  Blocs supplémentaires propres au package
 */
export function mmoEslint({ tsconfigRootDir, kind = 'node', extra = [] }) {
  return tseslint.config(
    { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '*.config.*', 'build.mjs'] },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
        globals: kind === 'web' ? globals.browser : globals.node,
      },
      rules: {
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        'no-console': kind === 'web' ? 'error' : 'off',
        eqeqeq: ['error', 'always'],
      },
    },
    // Fichiers de test : règles assouplies sur les assertions non nulles.
    {
      files: ['**/*.test.ts', '**/*.test.tsx'],
      rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
    },
    ...(kind === 'protocol' ? [protocolRules] : []),
    ...(kind === 'agent' ? [agentRules] : []),
    ...(kind === 'node' ? [zstdRules] : []),
    ...extra,
    prettier,
  );
}

/** Protocole : jamais `.strict()` sur un schéma Zod — le protocole évolue par ajout, un pair N-1/N+1 doit ignorer les champs inconnus. */
const protocolRules = {
  files: ['src/**/*.ts'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "CallExpression[callee.property.name='strict']",
        message:
          'Interdit dans packages/protocol : `.strict()` casse la compatibilité N/N-1 (le protocole évolue par ajout). Utiliser le comportement par défaut (champs inconnus ignorés).',
      },
    ],
  },
};

/** Jamais `ZSTD_c_nbWorkers` : perte silencieuse de données constatée (spike n°3, docs/spikes/03-zstd-node24.md). */
const zstdSelectors = [
  {
    selector: "MemberExpression[property.name='ZSTD_c_nbWorkers']",
    message: 'Interdit : ZSTD_c_nbWorkers perd silencieusement des données (spike n°3).',
  },
  {
    selector: "Literal[value='ZSTD_c_nbWorkers']",
    message: 'Interdit : ZSTD_c_nbWorkers (spike n°3).',
  },
];
const zstdRules = {
  files: ['src/**/*.ts'],
  rules: { 'no-restricted-syntax': ['error', ...zstdSelectors] },
};

/** Agent : aucun module natif (bundle esbuild universel) ; jamais `ZSTD_c_nbWorkers` (spike n°3). */
const agentRules = {
  files: ['src/**/*.ts'],
  rules: {
    'no-restricted-syntax': ['error', ...zstdSelectors],
    'no-restricted-imports': [
      'error',
      {
        paths: [
          { name: 'better-sqlite3', message: 'Module natif interdit dans l’agent (doc 03 §1).' },
          { name: '@node-rs/argon2', message: 'Module natif interdit dans l’agent (doc 03 §1).' },
          { name: 'bindings', message: 'Chargeur de modules natifs interdit dans l’agent.' },
          { name: 'node-gyp-build', message: 'Chargeur de modules natifs interdit dans l’agent.' },
        ],
        patterns: [{ group: ['**/*.node'], message: 'Module natif interdit dans l’agent.' }],
      },
    ],
  },
};
