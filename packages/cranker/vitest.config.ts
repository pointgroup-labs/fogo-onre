import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    server: {
      deps: {
        // @wormhole-foundation/sdk-solana-ntt's `index.js` does
        // `import "./side-effects"` (extensionless), which Node's strict
        // ESM resolver rejects. Inline it so vite resolves the import at
        // bundle-time rather than handing it to Node. Production tsup
        // build does the same via `noExternal` in tsup.config.ts.
        inline: ['@wormhole-foundation/sdk-solana-ntt'],
      },
    },
  },
})
