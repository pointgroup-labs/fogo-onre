/**
 * SDK guard for the intent-based ONyc redeem builder.
 *
 * Redeem (withdraw) is a hard mirror of deposit: it routes ONyc
 * FOGO→Solana through the OnRe `intent_transfer` fork's
 * `bridge_ntt_tokens`, with the signed-intent `recipient_address` pinned
 * to the per-user inbox PDA so the relayer's `unlock_onyc` can sweep the
 * ONyc into custody and bind the originating wallet (Task 11 shape).
 */

import type { BuildBridgeNttIxParams, NttBridgeSubAccounts } from '@fogo-onre/sdk'
import {
  buildFogoRedeemIntentIx,
  findUserInboxAuthorityPda,
  INTENT_TRANSFER_PROGRAM_ID,
  ONRE_INTENT_PROGRAM_ID,
} from '@fogo-onre/sdk'
import { Ed25519Program, Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'

function dummyNtt(): NttBridgeSubAccounts {
  return {
    nttManager: PublicKey.unique(),
    nttConfig: PublicKey.unique(),
    nttInboxRateLimit: PublicKey.unique(),
    nttSessionAuthority: PublicKey.unique(),
    nttTokenAuthority: PublicKey.unique(),
    wormholeMessage: PublicKey.unique(),
    transceiver: PublicKey.unique(),
    emitter: PublicKey.unique(),
    wormholeBridge: PublicKey.unique(),
    wormholeFeeCollector: PublicKey.unique(),
    wormholeSequence: PublicKey.unique(),
    wormholeProgram: PublicKey.unique(),
    nttWithExecutorProgram: PublicKey.unique(),
    executorProgram: PublicKey.unique(),
    nttPeer: PublicKey.unique(),
    nttOutboxItem: PublicKey.unique(),
    nttOutboxRateLimit: PublicKey.unique(),
    nttCustody: PublicKey.unique(),
    payeeNttWithExecutor: PublicKey.unique(),
  }
}

function dummyBridge(): Omit<BuildBridgeNttIxParams, 'intentTransferProgramId'> {
  return {
    fromChainId: PublicKey.unique(),
    intentTransferSetter: PublicKey.unique(),
    source: PublicKey.unique(),
    intermediateTokenAccount: PublicKey.unique(),
    mint: PublicKey.unique(),
    metadata: null,
    expectedNttConfig: PublicKey.unique(),
    nonce: PublicKey.unique(),
    sponsor: PublicKey.unique(),
    feeSource: PublicKey.unique(),
    feeDestination: PublicKey.unique(),
    feeMint: PublicKey.unique(),
    feeMetadata: null,
    feeConfig: PublicKey.unique(),
    ntt: dummyNtt(),
    signedQuoteBytes: new Uint8Array(165),
    payDestinationAtaRent: false,
  }
}

function dummyIntent() {
  return {
    fromChainId: 'fogo',
    toChainId: 'solana',
    tokenSymbolOrMint: 'ONyc',
    amount: '12.500000000',
    feeTokenSymbolOrMint: 'ONyc',
    feeAmount: '0.010000000',
    nonce: 7n,
  }
}

describe('buildFogoRedeemIntentIx', () => {
  const userWallet = Keypair.generate().publicKey
  const signMessage = async () => new Uint8Array(64)

  it('targets the OnRe fork program id by default', async () => {
    const { bridgeIx } = await buildFogoRedeemIntentIx({
      userWallet,
      signMessage,
      intent: dummyIntent(),
      bridge: dummyBridge(),
    })
    expect(bridgeIx.programId.equals(ONRE_INTENT_PROGRAM_ID)).toBe(true)
    expect(ONRE_INTENT_PROGRAM_ID.equals(INTENT_TRANSFER_PROGRAM_ID)).toBe(false)
  })

  it('pins the recipient to the per-user inbox PDA (Task 11 shape)', async () => {
    const [expectedInbox] = findUserInboxAuthorityPda(userWallet)
    const { recipientAddress, message } = await buildFogoRedeemIntentIx({
      userWallet,
      signMessage,
      intent: dummyIntent(),
      bridge: dummyBridge(),
    })
    expect(recipientAddress.equals(expectedInbox)).toBe(true)
    const text = new TextDecoder().decode(message)
    expect(text).toContain(`recipient_address: ${expectedInbox.toBase58()}`)
  })

  it('prepends the Ed25519 verifier ix over the signed message', async () => {
    const { ixs, verifierIx } = await buildFogoRedeemIntentIx({
      userWallet,
      signMessage,
      intent: dummyIntent(),
      bridge: dummyBridge(),
    })
    expect(verifierIx.programId.equals(Ed25519Program.programId)).toBe(true)
    expect(ixs[0]).toBe(verifierIx)
    expect(ixs).toHaveLength(2)
  })

  it('honors an explicit program-id override (switch-back)', async () => {
    const { bridgeIx } = await buildFogoRedeemIntentIx({
      userWallet,
      signMessage,
      intent: dummyIntent(),
      bridge: dummyBridge(),
      intentTransferProgramId: INTENT_TRANSFER_PROGRAM_ID,
    })
    expect(bridgeIx.programId.equals(INTENT_TRANSFER_PROGRAM_ID)).toBe(true)
  })
})
