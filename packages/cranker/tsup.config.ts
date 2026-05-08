import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  // Note: shebang is preserved from src/bin.ts; no banner needed.
  sourcemap: true,
  clean: true,
  // Inject `require` via createRequire so bundled CJS deps
  // (@anchor-lang/core, NTT SDK) can `require()` Node built-ins like
  // "buffer" at runtime. Without this, esbuild's default ESM `__require`
  // helper finds no global `require` and throws "Dynamic require of X
  // is not supported". Shebang in src/bin.ts is preserved.
  banner: {
    js: `import { createRequire as __cR } from 'module'; var require = __cR(import.meta.url);`,
  },
  // bin is a binary — no one imports types from it, so no .d.ts.
  dts: false,
  // Bundle the SDK + @anchor-lang/core: their "ESM" builds are CJS source
  // under .js extensions, so letting Node resolve them at runtime triggers
  // dynamic-require / named-export landmines. Bundling resolves everything
  // at build time; esbuild injects a `createRequire(import.meta.url)` shim
  // so bundled CJS dependencies' runtime `require()` calls keep working.
  //
  // @wormhole-foundation/sdk-solana-ntt is bundled because its ESM
  // `index.js` does `import "./side-effects"` (extensionless) which Node's
  // strict ESM resolver rejects via `ERR_MODULE_NOT_FOUND`. esbuild
  // resolves extensionless paths against the filesystem, so bundling
  // sidesteps the issue at build time.
  noExternal: ['@fogo-onre/sdk', '@anchor-lang/core', '@wormhole-foundation/sdk-solana-ntt'],
  esbuildOptions(options) {
    options.mainFields = ['main', 'module']
  },
})
