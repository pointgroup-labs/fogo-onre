import antfu from '@antfu/eslint-config'

export default antfu(
  {
    gitignore: true,
    stylistic: true,
    typescript: true,
    formatters: {
      css: true,
      html: true,
      markdown: 'dprint',
    },
    yaml: true,
    react: true,
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      // Anchor-generated IDL types — copied verbatim from `target/types/`
      // by the SDK regen step. Linting them is pointless: they get
      // overwritten on every `anchor build`.
      'packages/sdk/src/types/**',
      'packages/sdk/src/idl/**',
      // Next.js auto-regenerates this file on every `next build` /
      // `next dev`, in a format (double-quoted, semicolon-terminated)
      // that doesn't match the project's antfu/single-quote style.
      // The file itself says "should not be edited" — so we ignore it
      // rather than fight the regenerator.
      'packages/webapp/next-env.d.ts',
    ],
  },
  {
    rules: {
      'antfu/consistent-list-newline': 'off',
      'style/brace-style': ['error', '1tbs', { allowSingleLine: true }],

      'toml/padding-line-between-pairs': 'off',
      'toml/array-element-newline': 'off',
      'toml/array-bracket-spacing': ['error', 'never'],

      // 'ts/consistent-type-definitions': ['error', 'type'],
      'ts/consistent-type-definitions': 'off',
      'ts/consistent-type-imports': 'off',

      'curly': ['error', 'all'],

      'node/prefer-global/process': 'off',
      'node/prefer-global/buffer': 'off',
      'node/no-path-concat': 'off',

      'no-console': 'off',
    },
  },
  {
    // Next.js App Router files export `metadata`, `viewport`, etc.
    // alongside the default component — that's the framework convention,
    // not a Fast Refresh hazard.
    files: ['packages/webapp/src/app/**/{layout,page,loading,error,not-found,template}.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // shadcn/ui primitives are vendored as-is from the upstream registry.
    // They co-export variant helpers (`buttonVariants`, `useFormField`)
    // alongside components by design, and use forward-declared contexts.
    // Linting them surfaces upstream patterns we don't own; relax the
    // most opinionated rules so updates from `pnpm dlx shadcn add` apply
    // cleanly without local diff noise.
    files: ['packages/webapp/src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
      'react/no-context-provider': 'off',
      'react/no-use-context': 'off',
      'react/no-forward-ref': 'off',
      'ts/no-use-before-define': 'off',
    },
  },
)
