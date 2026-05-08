import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    server: {
      deps: {
        // @wormhole-foundation/sdk-solana-ntt's `index.js` does
        // `import "./side-effects"` (extensionless), which Node's strict
        // ESM resolver rejects. Inline it so vite resolves at bundle-time.
        // Production tsup build does the same via `noExternal`.
        inline: ['@wormhole-foundation/sdk-solana-ntt'],
      },
    },
  },
})

//
// import tsconfigPaths from 'vite-tsconfig-paths';
//
// export default defineConfig({
//   plugins: [tsconfigPaths()],
//   test: {
//     environment: 'node',
//     testTimeout: 30000,
//     hookTimeout: 30000,
//     // Run tests sequentially to avoid bankrun conflicts
//     pool: 'forks',
//     poolOptions: {
//       forks: {
//         singleFork: false,
//         maxForks: 2, // Reduced for Docker/VM environments with limited memory
//       },
//     },
//     // Include test files
//     include: ['tests/**/*.spec.ts', 'tests/**/*.test.ts'],
//     // Globals for Jest-like API (optional, but makes migration easier)
//     globals: true,
//   },
// });
