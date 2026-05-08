import { defineConfig } from 'tsup'

// esbuild's ESM output replaces `require()` with a `__require` helper
// that throws unless a real `require` is in scope. Bundled CJS deps
// (@anchor-lang/core, NTT SDK) call `require("buffer")` at runtime, so
// we re-create one from `import.meta.url`. tsup's `shims: true` only
// covers __dirname/__filename — not require — so this banner is required.
const requireShim = `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  banner: { js: `#!/usr/bin/env node\n${requireShim}` },
  // Bundle deps whose "ESM" is actually CJS source under .js extensions
  // (named-export + dynamic-require landmines) or whose ESM index does
  // extensionless imports Node's strict resolver rejects (NTT SDK's
  // `import "./side-effects"`). esbuild resolves both at build time.
  noExternal: ['@fogo-onre/sdk', '@fogo-onre/cranker', '@anchor-lang/core', '@wormhole-foundation/sdk-solana-ntt', 'chalk'],
  esbuildOptions(options) {
    options.mainFields = ['main', 'module']
  },
})
