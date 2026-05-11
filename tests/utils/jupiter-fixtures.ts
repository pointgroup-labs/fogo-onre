import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PublicKey } from '@solana/web3.js'

export const JUPITER_V6_PROGRAM_ID = new PublicKey(
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
)

/**
 * Sha256 of the Jupiter v6 mainnet binary as captured for these tests.
 * Drift fails fast: a test asserting against this constant catches an
 * upstream binary update before the e2e silently runs against a different
 * AMM/router topology than we audited.
 */
export const JUPITER_V6_SHA256
  = '6fda2c70abda5c28b19450e8d8e7a8da2af4b605e758da8e8eb59310e92998a1'

const JUPITER_SO = path.resolve(
  __dirname,
  '../fixtures/programs/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4.so',
)

/** Path-only export for tests that load programs via LiteSVM's `add_program_from_file`. */
export const JUPITER_V6_SO_PATH = JUPITER_SO

/** Read + sha256 the on-disk Jupiter binary. Use to assert the pin in setup. */
export function jupiterBinarySha256(): string {
  const bytes = fs.readFileSync(JUPITER_SO)
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/**
 * Optional explicit loader for an SVM-like rig that exposes
 * `addProgram(programId, bytes)`. Most tests don't need this — `svm.ts`
 * auto-loads everything in `tests/fixtures/programs/`. Use this only
 * when constructing a bare LiteSVM without going through `createSvm()`.
 */
export function loadJupiterIntoSvm(svm: { addProgram: (id: PublicKey, bytes: Uint8Array) => void }): void {
  const bytes = fs.readFileSync(JUPITER_SO)
  svm.addProgram(JUPITER_V6_PROGRAM_ID, bytes)
}
