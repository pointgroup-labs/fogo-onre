import {
  findCoreBridgeConfigPda,
  findCoreBridgeFeeCollectorPda,
  findCoreBridgeSequencePda,
  findTokenBridgeAuthoritySignerPda,
  findTokenBridgeConfigPda,
  findTokenBridgeCustodySignerPda,
  findTokenBridgeEmitterPda,
  findTokenBridgeMintAuthorityPda,
  findTokenBridgeRedeemerPda,
  findTokenBridgeSenderPda,
  RELAYER_PROGRAM_ID,
} from '@fogo-onre/sdk'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'

// Canonical mainnet PDA addresses, pinned so a seed-string edit shows up in a
// diff. Bridge-program-verified entries are exercised through real CPIs:
//   - Inbound — tests/deposit-flow-e2e.test.ts
//   - Outbound — tests/send-usdc-to-user-e2e.test.ts
const BRIDGE_VERIFIED = {
  TB_CONFIG: 'DapiQYH3BGonhN8cngWcXQ6SrqSm3cwysoznoHr6Sbsx',
  TB_MINT_AUTHORITY: 'BCD75RNBHrJJpW4dXVagL5mPjzRLnVZq4YirJdjEYMV7',
  TB_AUTHORITY_SIGNER: '7oPa2PHQdZmjSPqvpZN7MQxnC7Dcf3uL4oLqknGLk2S3',
  TB_EMITTER: 'Gv1KWf8DT1jKv5pKBmGaTmVszqa56Xn8YGx2Pg7i7qAk',
  // seeds=["sender"] under the relayer program (NOT under TB).
  TB_SENDER_RELAYER: 'RKnWJ9vqsPHEqvX3j5gc5kQvVZ9SyGXmbrZLQifoRZF',
  CB_CONFIG: '2yVjuQwpsvdsrywzsJJVs9Ueh4zayyo5DYJbBNc3DDpn',
  CB_FEE_COLLECTOR: '9bFNrXNb2WTx8fMHXCheaZqkLZ3YCCaiqTftHxeintHy',
  CB_SEQUENCE_TB_EMITTER: 'GF2ghkjwsR9CHkGk1RvuZrApPZGBZynxMm817VNi51Nf',
  // seeds=["redeemer"] under the relayer program; TB enforces
  // `redeemer.key == to.owner` in CompleteWrappedWithPayload.
  TB_REDEEMER_RELAYER: '8VY4EBzMzGkTeMTNohpZevNZyFGyQsasSNMJfvnTKA1r',
} as const

// `custody_signer` is only used by TB's NATIVE outbound path
// (`TransferNativeWithPayload`), which the relayer never invokes — no real
// CPI proves the role binding, so we can only seed-tripwire it.
const TRIPWIRE_ONLY = {
  TB_CUSTODY_SIGNER: 'GugU1tP7doLeTw9hQP51xRJyS8Da1fWxuiy2rVrnMD2m',
} as const

describe('gateway PDA helpers — bridge-verified', () => {
  it('token Bridge config PDA pins to DapiQYH3...', () => {
    const [pda] = findTokenBridgeConfigPda()
    expect(pda.toBase58()).toBe(BRIDGE_VERIFIED.TB_CONFIG)
  })

  it('token Bridge mint_authority (mint_signer) PDA pins to BCD75RNB...', () => {
    const [pda] = findTokenBridgeMintAuthorityPda()
    expect(pda.toBase58()).toBe(BRIDGE_VERIFIED.TB_MINT_AUTHORITY)
  })

  it('token Bridge redeemer PDA (under relayer program) pins to 8VY4EBzM...', () => {
    const [pda] = findTokenBridgeRedeemerPda(RELAYER_PROGRAM_ID)
    expect(pda.toBase58()).toBe(BRIDGE_VERIFIED.TB_REDEEMER_RELAYER)
  })

  it('token Bridge authority_signer PDA pins to 7oPa2PHQ...', () => {
    const [pda] = findTokenBridgeAuthoritySignerPda()
    expect(pda.toBase58()).toBe(BRIDGE_VERIFIED.TB_AUTHORITY_SIGNER)
  })

  it('token Bridge emitter PDA pins to Gv1KWf8D...', () => {
    const [pda] = findTokenBridgeEmitterPda()
    expect(pda.toBase58()).toBe(BRIDGE_VERIFIED.TB_EMITTER)
  })

  it('token Bridge sender PDA (caller=relayer) pins to RKnWJ9vq...', () => {
    const [pda] = findTokenBridgeSenderPda(RELAYER_PROGRAM_ID)
    expect(pda.toBase58()).toBe(BRIDGE_VERIFIED.TB_SENDER_RELAYER)
  })

  it('core Bridge config PDA pins to 2yVjuQwp...', () => {
    const [pda] = findCoreBridgeConfigPda()
    expect(pda.toBase58()).toBe(BRIDGE_VERIFIED.CB_CONFIG)
  })

  it('core Bridge fee_collector PDA pins to 9bFNrXNb...', () => {
    const [pda] = findCoreBridgeFeeCollectorPda()
    expect(pda.toBase58()).toBe(BRIDGE_VERIFIED.CB_FEE_COLLECTOR)
  })

  it('core Bridge sequence PDA off TB emitter pins to GF2ghkjw...', () => {
    // Capital S in "Sequence" is intentional — Core Bridge uses MixedCase
    // seed strings for legacy Solitaire layouts.
    const [tbEmitter] = findTokenBridgeEmitterPda()
    const [seq] = findCoreBridgeSequencePda(tbEmitter)
    expect(seq.toBase58()).toBe(BRIDGE_VERIFIED.CB_SEQUENCE_TB_EMITTER)
  })
})

describe('gateway PDA helpers — tripwire only (NOT bridge-verified)', () => {
  it('token Bridge custody_signer PDA derives to GugU1tP7...', () => {
    const [pda] = findTokenBridgeCustodySignerPda()
    expect(pda.toBase58()).toBe(TRIPWIRE_ONLY.TB_CUSTODY_SIGNER)
  })

  it('all bridge-verified PDAs are also self-consistent on independent re-derivation', () => {
    // Catches a hardcoded-pubkey regression in the helpers — re-derive each
    // with raw `findProgramAddressSync` and assert equality.
    const TB = new PublicKey('wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb')
    const CB = new PublicKey('worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth')

    const cases: Array<[ReturnType<typeof findTokenBridgeAuthoritySignerPda>, [Buffer[], PublicKey]]> = [
      [findTokenBridgeAuthoritySignerPda(), [[Buffer.from('authority_signer')], TB]],
      [findTokenBridgeCustodySignerPda(), [[Buffer.from('custody_signer')], TB]],
      [findTokenBridgeEmitterPda(), [[Buffer.from('emitter')], TB]],
      [findTokenBridgeSenderPda(RELAYER_PROGRAM_ID), [[Buffer.from('sender')], RELAYER_PROGRAM_ID]],
      [findCoreBridgeConfigPda(), [[Buffer.from('Bridge')], CB]],
      [findCoreBridgeFeeCollectorPda(), [[Buffer.from('fee_collector')], CB]],
    ]
    for (const [[helperPda], [seeds, programId]] of cases) {
      const [reDerived] = PublicKey.findProgramAddressSync(seeds, programId)
      expect(helperPda.toBase58()).toBe(reDerived.toBase58())
    }
  })
})
