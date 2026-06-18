// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'dist-web/**', '**/dist-web/**', 'coverage/**', '**/*.d.ts'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Project-wide correctness + hygiene. These are syntactic (no type info
  // required) so they apply to every file, including plain `.mjs` config/tooling.
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // `allowSeparateTypeImports` keeps the repo's deliberate `import {value}`
      // + `import type {T}` style legal while still catching genuine duplicates.
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      'no-unreachable': 'error',
      'no-debugger': 'error',
      'consistent-return': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // Type-aware linting. typescript-eslint's flagship `strictTypeChecked` +
  // `stylisticTypeChecked` presets are the state-of-the-art baseline for real
  // type safety: they pull in the full `no-unsafe-*`, `no-base-to-string`,
  // `restrict-*`, `no-misused-promises`, `no-floating-promises`,
  // `use-unknown-in-catch-callback-variable`, … families instead of a
  // hand-picked subset. Scoped to the TS files that belong to a tsconfig project
  // (the standalone Vite config stays outside the type-checking projects).
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    ignores: ['apps/web/vite.config.ts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      // Numbers/booleans stringify predictably and meaningfully in templates;
      // the rule's real value (kept) is catching object/`any`/nullish
      // interpolation that silently becomes "[object Object]"/"undefined".
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],

      // --- Deliberately relaxed. These are NOT type-safety rules; enabling them
      // would force behavior changes or pure churn. Every genuine type-safety
      // rule from the presets above stays at `error`.

      // Dropping `async` from a function that returns a Promise without awaiting
      // changes its throw semantics (a synchronous throw becomes a rejected
      // promise) and breaks the uniform async shape of our injected dependency
      // interfaces. Not a typing concern.
      '@typescript-eslint/require-await': 'off',
      // Empty functions are intentional no-ops here (default deps, the EPIPE
      // swallow in env.ts, test stubs); flagging them adds noise, not safety.
      '@typescript-eslint/no-empty-function': 'off',
      // Almost all hits are React `() => handler()` shorthand / `void`
      // expressions — stylistic, behaviour-irrelevant.
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // Our types are intentionally optimistic at runtime boundaries (registry /
      // Docker / exec / JSON). The "provably true" checks this flags are real
      // defensive and SECURITY guards (e.g. verifyReleaseSignature re-validating
      // signature/keyId), so removing them is not behavior-preserving.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // `!` here marks reviewed invariants (own map-key access, sort
      // comparators, RegExp captures); replacing each with a runtime guard adds
      // untested branches. The escape hatch we actually ban is `any` (enforced
      // by the `no-unsafe-*` family + `no-explicit-any`).
      '@typescript-eslint/no-non-null-assertion': 'off',
      // The codebase deliberately uses `||` / `a ? a : b` for *falsy* fallbacks
      // (empty-string → default label/domain, boolean-flag OR). Rewriting those
      // to `??` only coalesces nullish and would silently change behaviour for
      // `''`/`false`. Choosing `??` vs `||` is a runtime decision, not a typing
      // one, so this stylistic rule is off.
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
    },
  },

  // Library code must not write to the console; CLI/BFF/web entrypoints and
  // tooling do so intentionally and keep the allowance below.
  {
    files: ['packages/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-console': 'error' },
  },

  // Tests, e2e harness/scripts, build scripts and config files: relax the
  // noisiest type-driven rules. Fixing these would force type churn in
  // non-production code without improving the shipped product.
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      'e2e/**/*.ts',
      'scripts/**/*.{ts,mts}',
      'apps/web/src/ui/test/**/*.{ts,tsx}',
      'vitest.config.ts',
      'vitest.coverage-gate.config.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // Non-shipped code: a few pedantic type-style rules add churn here without
      // improving the product (test fakes mutate local records, harness helpers
      // re-throw fixtures as-is, scripts/tests stringify defensively).
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
    },
  },

  // Commander CLI boundary: the `.action((opts) => …)` callbacks receive
  // Commander's `OptionValues` (a `Record<string, any>`), so every `opts.foo`
  // read is inherently "unsafe" to the type checker. These thin adapter files
  // already guard that boundary with explicit `as` casts; the `no-unsafe-*`
  // family only flags the library's loose typing here, not real unsafe logic.
  // It stays enforced for all other production code (packages + apps/web).
  {
    files: ['apps/cli/src/bin.ts', 'apps/cli/src/commands/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },

  // React Hooks correctness for the web admin UI (apps/web is the only React
  // surface in this otherwise Node/CLI repo). Only `rules-of-hooks` is enabled:
  // it catches genuinely broken hook usage (conditional/loop calls) and is
  // behaviour-preserving to satisfy. `exhaustive-deps` is intentionally NOT
  // enabled — changing dependency arrays alters effect re-run timing, which is a
  // behavioural change out of scope for a lint pass (tracked as a follow-up).
  // The v7 `recommended` preset (React-Compiler rules) is deliberately not
  // used here for the same reason. `eslint-plugin-react-hooks` is NOT added to
  // the pure Node/CLI packages.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
  },

  // Plain JS tooling/config files have no type information; turn off the
  // type-checked rule set there so the parser is never asked for a program.
  {
    files: ['**/*.{js,mjs,cjs}', 'apps/web/vite.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
