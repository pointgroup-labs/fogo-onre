import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  // Banner: shebang + createRequire shim. The shim is required because
  // bundled CJS deps (@anchor-lang/core, etc.) `require()` Node built-ins
  // at runtime; under ESM output, esbuild's default `__require` helper
  // throws unless a real `require` is in scope.
  banner: {
    js: `#!/usr/bin/env node\nimport { createRequire as __cR } from 'module'; var require = __cR(import.meta.url);`,
  },
  // SDK is a workspace dep that re-exports BN from a CJS-only package
  // (@anchor-lang/core whose "ESM" build is actually CJS source). Bundling
  // resolves the named exports at build time; esbuild injects a
  // `createRequire(import.meta.url)` shim so bundled CJS deps' runtime
  // `require()` calls keep working under ESM output.
  noExternal: ['@fogo-onre/sdk', '@fogo-onre/cranker', '@anchor-lang/core', '@wormhole-foundation/sdk-solana-ntt', 'chalk'],
  // @anchor-lang/core's "module" entry is fake ESM (CJS source with .js
  // ESM extension). Resolve via "main" so esbuild gets real CJS instead.
  esbuildOptions(options) {
    options.mainFields = ['main', 'module']
  },
})
