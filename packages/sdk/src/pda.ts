import { PublicKey } from '@solana/web3.js'
import {
  CONFIG_SEED,
  FLOW_INBOUND_SEED,
  FLOW_OUTBOUND_SEED,
  GLOBAL_CONFIG_SEED,
  INTENT_TRANSFER_PROGRAM_ID,
  INTENT_TRANSFER_SETTER_SEED,
  PROGRAM_SIGNER_SEED,
  RELAYER_PROGRAM_ID,
  RELAYER_SEED,
  USER_INBOX_SEED,
} from './constants'

/** Pair-seeded config PDA `[CONFIG_SEED, base_mint, asset_mint]`. */
export function findConfigPda(
  baseMint: PublicKey,
  assetMint: PublicKey,
  programId: PublicKey = RELAYER_PROGRAM_ID,
) {
  return PublicKey.findProgramAddressSync(
    [CONFIG_SEED, baseMint.toBuffer(), assetMint.toBuffer()],
    programId,
  )
}

/** Global config singleton PDA `[GLOBAL_CONFIG_SEED]` — the admin gate for pair creation. */
export function findGlobalConfigPda(programId: PublicKey = RELAYER_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([GLOBAL_CONFIG_SEED], programId)
}

export function findAuthorityPda(programId: PublicKey = RELAYER_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([RELAYER_SEED], programId)
}

/**
 * Canonical flow-PDA derivation. `deposit` uses the inbound seed
 * namespace, `withdraw` the outbound one. Config-bound: the pair's config
 * PDA is part of the seed so flows of different pairs never collide.
 */
export function findFlowPda(
  direction: 'deposit' | 'withdraw',
  configPda: PublicKey,
  nttInboxItem: PublicKey,
  programId: PublicKey = RELAYER_PROGRAM_ID,
) {
  const seed = direction === 'deposit' ? FLOW_INBOUND_SEED : FLOW_OUTBOUND_SEED
  return PublicKey.findProgramAddressSync(
    [seed, configPda.toBuffer(), nttInboxItem.toBuffer()],
    programId,
  )
}

export function findInflightFlowPda(
  configPda: PublicKey,
  nttInboxItem: PublicKey,
  programId: PublicKey = RELAYER_PROGRAM_ID,
) {
  return findFlowPda('deposit', configPda, nttInboxItem, programId)
}

export function findOutflightFlowPda(
  configPda: PublicKey,
  nttInboxItem: PublicKey,
  programId: PublicKey = RELAYER_PROGRAM_ID,
) {
  return findFlowPda('withdraw', configPda, nttInboxItem, programId)
}

/**
 * Min-bearing inbox authority PDA
 * `[USER_INBOX_SEED, wallet, minOut.to_le_bytes()]` — the NTT
 * `recipient_address` the intent commits the floor into; `receive` re-derives
 * it and PDA-signs the sweep. Direction stays bound via NTT manager + recv_mint.
 */
export function findUserInboxWithMinPda(
  wallet: PublicKey,
  minOut: bigint,
  programId: PublicKey = RELAYER_PROGRAM_ID,
) {
  // DataView.setBigUint64 (native everywhere) — not Buffer.writeBigUInt64LE,
  // which is absent from the webapp's method-less Buffer polyfill.
  const minLe = new Uint8Array(8)
  new DataView(minLe.buffer).setBigUint64(0, minOut, true)
  return PublicKey.findProgramAddressSync(
    [USER_INBOX_SEED, wallet.toBuffer(), minLe],
    programId,
  )
}

/**
 * `intent_transfer`'s singleton setter PDA — the `NttManagerMessage.sender` the
 * relayer pins for inbound flows. Defaults to Fogo's program; pass
 * `ONRE_INTENT_PROGRAM_ID` for the fork (relayer allowlists both).
 */
export function findIntentTransferSetterPda(
  programId: PublicKey = INTENT_TRANSFER_PROGRAM_ID,
) {
  return PublicKey.findProgramAddressSync(
    [INTENT_TRANSFER_SETTER_SEED],
    programId,
  )
}

/**
 * `intent_transfer`'s per-program signer PDA — the FOGO patched token program
 * requires it present-as-signer to prove session auth. Pass the same
 * `intent_transfer` program targeted by the bridge ix.
 */
export function findProgramSignerPda(
  programId: PublicKey = INTENT_TRANSFER_PROGRAM_ID,
) {
  return PublicKey.findProgramAddressSync([PROGRAM_SIGNER_SEED], programId)
}
