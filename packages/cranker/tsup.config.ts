import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
    vaa: 'src/vaa.ts',
    wormholescan: 'src/wormholescan.ts',
  },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  // Note: shebang is preserved from src/bin.ts; no banner needed.
  sourcemap: true,
  clean: true,
  // Only the library entries get .d.ts — bin is a binary, no one
  // imports types from it. Keeps ./dist lean.
  dts: { entry: { vaa: 'src/vaa.ts', wormholescan: 'src/wormholescan.ts' } },
  // Bundle the SDK + @anchor-lang/core (same rationale as packages/cli):
  // their ESM builds are CJS source under .js extensions, so letting Node
  // resolve them at runtime triggers the dynamic-require / named-export
  // landmines. Bundling resolves everything at build time.
  //
  // @wormhole-foundation/sdk-solana-ntt is bundled because its ESM
  // `index.js` does `import "./side-effects"` (extensionless) which Node's
  // strict ESM resolver rejects via `ERR_MODULE_NOT_FOUND`. The package's
  // `exports` field also blocks deep imports as a workaround. esbuild
  // resolves extensionless paths against the filesystem, so bundling
  // sidesteps both issues at build time.
  noExternal: ['@fogo-onre/sdk', '@anchor-lang/core', '@wormhole-foundation/sdk-solana-ntt'],
  esbuildOptions(options) {
    options.mainFields = ['main', 'module']
  },
})
