import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import security from 'eslint-plugin-security';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      'client/public/**',
      'server/public/**',
      'projects/**',
      'git-repos/**',
      '**/*.min.js',
      '**/coverage/**',
    ],
  },

  js.configs.recommended,

  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Client: React + JSX, browser globals
  {
    files: ['client/src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2024 },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Server: Node ESM. eslint-plugin-security flags the high-risk node
  // patterns (eval, child_process with concatenation, RegExp from
  // variables, fs.read with non-literal paths). Most rules are kept as
  // warnings so they show up in CI lint without failing the build —
  // false-positive rate is non-trivial, but the genuine catches justify
  // the noise. Critical-class checks (detect-eval-with-expression,
  // detect-child-process) are escalated to error.
  {
    files: ['server/**/*.js', 'server/**/*.mjs'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2024 },
    },
    rules: {
      ...security.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // High-signal rules: kept as errors. These catch the patterns that
      // actually become exploits (eval-on-user-input, shell injection).
      'security/detect-eval-with-expression': 'error',
      'security/detect-child-process': 'error',
      // Lower-signal rules muted for FlowTex:
      // - non-literal-fs-filename fires on every fs call with a dynamic
      //   path (which is most of them); we use safePath() and
      //   res.sendFile({ root }) as the actual path-traversal defences.
      // - possible-timing-attacks is for credential comparisons; our
      //   triggering site is a content-hash cache equality, not auth.
      //   We use bcrypt.compare for passwords (constant-time by design).
      // - object-injection is defeated by Postgres parameterised queries.
      // - non-literal-regexp is too common to ban (legitimate regex
      //   compilation from sanitised inputs); kept as warn.
      // - unsafe-regex: kept as warn — safe-regex has a high false-
      //   positive rate, but worth surfacing for periodic ReDoS triage.
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-possible-timing-attacks': 'off',
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-unsafe-regex': 'warn',
    },
  },

  // Vite/Vitest configs and other top-level scripts
  {
    files: ['*.{js,mjs}', 'client/*.{js,mjs}', 'server/*.{js,mjs}', 'scripts/**/*.{js,mjs}', 'e2e/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2024 },
    },
  },

  // Tests use Vitest globals
  {
    files: ['**/*.{test,spec}.{js,jsx}', '**/tests/**/*.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, describe: 'readonly', it: 'readonly', test: 'readonly', expect: 'readonly', vi: 'readonly', beforeAll: 'readonly', afterAll: 'readonly', beforeEach: 'readonly', afterEach: 'readonly' },
    },
  },
];
