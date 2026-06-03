import { PublicKey } from '@solana/web3.js'
import {
  CONFIG_SEED,
  FLOW_INBOUND_SEED,
  FLOW_OUTBOUND_SEED,
  INTENT_TRANSFER_PROGRAM_ID,
  INTENT_TRANSFER_SETTER_SEED,
  PROGRAM_SIGNER_SEED,
  RELAYER_PROGRAM_ID,
  RELAYER_SEED,
  USER_INBOX_SEED,
} from './constants'

export function findConfigPda(programId: PublicKey = RELAYER_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId)
}

export function findAuthorityPda(programId: PublicKey = RELAYER_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([RELAYER_SEED], programId)
}

/**
 * Canonical flow-PDA derivation. `deposit` uses the inbound seed
 * namespace, `withdraw` the outbound one.
 */
export function findFlowPda(
  direction: 'deposit' | 'withdraw',
  nttInboxItem: PublicKey,
  programId: PublicKey = RELAYER_PROGRAM_ID,
) {
  const seed = direction === 'deposit' ? FLOW_INBOUND_SEED : FLOW_OUTBOUND_SEED
  return PublicKey.findProgramAddressSync(
    [seed, nttInboxItem.toBuffer()],
    programId,
  )
}

export function findInflightFlowPda(
  nttInboxItem: PublicKey,
  programId: PublicKey = RELAYER_PROGRAM_ID,
) {
  return findFlowPda('deposit', nttInboxItem, programId)
}

export function findOutflightFlowPda(
  nttInboxItem: PublicKey,
  programId: PublicKey = RELAYER_PROGRAM_ID,
) {
  return findFlowPda('withdraw', nttInboxItem, programId)
}

/**
 * Per-user inbox authority PDA `[USER_INBOX_SEED, wallet]`. Used as the
 * intent `recipient_address` so NTT release deposits into this PDA's ATA;
 * `receive` re-derives it and PDA-signs a sweep into relayer custody.
 */
export function findUserInboxAuthorityPda(
  wallet: PublicKey,
  programId: PublicKey = RELAYER_PROGRAM_ID,
) {
  return PublicKey.findProgramAddressSync(
    [USER_INBOX_SEED, wallet.toBuffer()],
    programId,
  )
}

/**
 * `intent_transfer`'s singleton setter PDA — the `NttManagerMessage.sender`
 * the relayer pins for inbound flows. Defaults to Fogo's program; pass
 * `ONRE_INTENT_PROGRAM_ID` for the fork. The relayer allowlists both.
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
 * `intent_transfer`'s per-program signer PDA. The FOGO patched token
 * program requires it present-as-signer to prove session authorization.
 * Pass the same `intent_transfer` program targeted by the bridge ix.
 */
export function findProgramSignerPda(
  programId: PublicKey = INTENT_TRANSFER_PROGRAM_ID,
) {
  return PublicKey.findProgramAddressSync([PROGRAM_SIGNER_SEED], programId)
}
