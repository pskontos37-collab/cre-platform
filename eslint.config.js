import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

// KI-4. The repo had no linter at all. This config is deliberately narrow: it
// adds only what the type-checker CANNOT see, because `tsc -b` already runs with
// strict + noUnusedLocals + noUnusedParameters + noFallthroughCasesInSwitch and
// BLOCKS in CI at a zero baseline. Re-reporting those as lint errors would double
// the noise for no extra coverage, so they are switched off below.
//
// What that leaves is the class of bug tsc is blind to: React hook rules
// (conditional hooks, stale/missing effect dependencies) and Fast Refresh
// correctness. Those are the rules worth having here.
//
// NO PRETTIER, on purpose. Reformatting 228 files / ~58k lines would produce a
// diff nobody can review, carries zero correctness benefit, and this checkout is
// worked by several sessions at once - a repo-wide reformat would collide with
// everything in flight. Formatting stays hand-maintained.

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      // Deno runtime with its own globals and import style - linting it with the
      // browser/node config produces only false positives.
      'supabase/functions/**',
      // Loader/utility scripts are PowerShell plus a few one-off JS files.
      'scripts/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // The reason this config exists. A conditional hook is a real defect; a
      // missing dependency is how a panel silently keeps showing last property's
      // numbers after the picker changes.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Fast Refresh only works if a module exports components and nothing else.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // Owned by tsc already (noUnusedLocals / noUnusedParameters), and tsc is
      // the blocking gate. Leaving this on would report every unused symbol twice.
      '@typescript-eslint/no-unused-vars': 'off',

      // This codebase deliberately uses `any` at the edges where Supabase returns
      // untyped jsonb (abstract payloads, field_confidence, terms). Flagging every
      // one as an error would bury the rules above; warn keeps it visible.
      '@typescript-eslint/no-explicit-any': 'warn',

      // `cond ? set.add(x) : set.delete(x)` is used consistently for Set toggles
      // across the admin/review/export surfaces. Both branches are side effects,
      // so it is correct - the rule only objects to discarding the ternary's
      // value. Allowing it keeps the rule useful for what it is actually for:
      // catching an accidental no-op statement like `foo == bar;`.
      '@typescript-eslint/no-unused-expressions': ['error', {
        allowShortCircuit: true,
        allowTernary: true,
      }],
    },
  },
)
