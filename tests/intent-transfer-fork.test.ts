/**
 * SDK-level guard for the OnRe `intent_transfer` fork routing.
 *
 * The deposit builder must emit a `bridge_ntt_tokens` instruction against
 * whichever program ID the caller selects. The relayer pins the matching
 * setter PDA, so this is the single switch that moves deposit traffic from
 * Fogo's audited program onto the OnRe fork (and back).
 *
 * `intentTransferProgramId` is required with no default: a caller can never
 * silently route to the dormant Fogo program by forgetting to pass it.
 */

import type { BuildBridgeNttIxParams, NttBridgeSubAccounts } from '@fogo-onre/sdk'
import {
  buildBridgeNttTokensIx,
  INTENT_TRANSFER_PROGRAM_ID,
  ONRE_INTENT_PROGRAM_ID,
} from '@fogo-onre/sdk'
import { PublicKey } from '@solana/web3.js'
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

function dummyParams(): BuildBridgeNttIxParams {
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
    intentTransferProgramId: ONRE_INTENT_PROGRAM_ID,
    ntt: dummyNtt(),
    signedQuoteBytes: new Uint8Array(165),
    payDestinationAtaRent: false,
  }
}

describe('intent_transfer fork routing', () => {
  it('routes to the OnRe fork program id it is given', () => {
    const ix = buildBridgeNttTokensIx(dummyParams())
    expect(ix.programId.equals(ONRE_INTENT_PROGRAM_ID)).toBe(true)
  })

  it('routes to the Fogo program id it is given', () => {
    const ix = buildBridgeNttTokensIx({
      ...dummyParams(),
      intentTransferProgramId: INTENT_TRANSFER_PROGRAM_ID,
    })
    expect(ix.programId.equals(INTENT_TRANSFER_PROGRAM_ID)).toBe(true)
  })

  it('the fork and Fogo program ids are distinct', () => {
    expect(ONRE_INTENT_PROGRAM_ID.equals(INTENT_TRANSFER_PROGRAM_ID)).toBe(false)
  })
})
