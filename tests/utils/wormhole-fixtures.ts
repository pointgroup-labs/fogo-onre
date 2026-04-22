/**
 * Synthesize Wormhole Token Bridge state accounts for an end-to-end
 * `claim_usdc` invocation in LiteSVM.
 *
 * We bypass the Core Bridge guardian-signature verification (the same
 * shortcut `mock-vaa.ts` uses by writing the post-verification PostedVAA
 * directly). Everything below is the *Token Bridge* state the
 * `CompleteWrappedWithPayload` instruction needs:
 *
 *   - TB Config            (PDA seeds=["config"]) — REUSED from real mainnet
 *                          fixture; layout = `wormhole_bridge: Pubkey` (32 B).
 *   - ForeignEndpoint      (PDA seeds=[chain_be, emitter]) — synthesized;
 *                          layout = `chain: u16 LE + contract: [u8;32]` (34 B).
 *   - Wrapped Mint         (PDA seeds=["wrapped", chain_be, token_addr]) —
 *                          synthesized SPL Mint with mint_authority = TB
 *                          MintSigner PDA. Returns the mint pubkey.
 *   - WrappedMeta          (PDA seeds=["meta", mint]) — synthesized; layout =
 *                          `chain: u16 LE + token_address: [u8;32] +
 *                          original_decimals: u8` (35 B).
 *   - MintAuthority/MintSigner — REUSED from real mainnet fixture
 *                          (PDA seeds=["mint_signer"], 0-byte sysvar-shaped).
 *
 * Borsh layouts confirmed against
 * https://github.com/wormhole-foundation/wormhole/blob/main/solana/modules/token_bridge/program/src/types.rs
 *
 * No Solitaire account-type prefix bytes — the structs above are plain Borsh.
 */

import type { LiteSVM } from 'litesvm'
import {
  findTokenBridgeForeignEndpointPda,
  findTokenBridgeMintAuthorityPda,
  findTokenBridgeWrappedMetaPda,
  findTokenBridgeWrappedMintPda,
  GATEWAY_PROGRAM_ID,
} from '@fogo-onre/sdk'
import { MINT_SIZE, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { loadFixture } from './fixture-loader'

// Mainnet capture identities (verified by deriving the matching PDA).
const TB_CONFIG_FIXTURE = 'DapiQYH3BGonhN8cngWcXQ6SrqSm3cwysoznoHr6Sbsx'
const TB_MINT_SIGNER_FIXTURE = 'BCD75RNBHrJJpW4dXVagL5mPjzRLnVZq4YirJdjEYMV7'

const RENT_EXEMPT_MIN = 1_000_000n // generous floor; rent calculation not strict in LiteSVM

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chainIdLeBuf(chainId: number): Uint8Array {
  const buf = new Uint8Array(2)
  new DataView(buf.buffer).setUint16(0, chainId, true) // little-endian
  return buf
}

/** Mainnet TB Config PDA — `wormhole_bridge: Pubkey` (32 B). */
export function setupTokenBridgeConfig(svm: LiteSVM): void {
  loadFixture(svm, TB_CONFIG_FIXTURE)
}

/**
 * Mainnet TB MintSigner PDA — empty system-owned PDA. The TB CPI uses
 * `invoke_seeded` to sign mint_to with this PDA; it just needs to exist as
 * an `AccountInfo` (lamports + owner = system program).
 */
export function setupMintAuthority(svm: LiteSVM): void {
  loadFixture(svm, TB_MINT_SIGNER_FIXTURE)
}

/**
 * Foreign endpoint registration for (chainId, emitter). Borsh layout:
 *   chain: u16 LE (2) + contract: [u8;32] (32) = 34 B
 */
export function setupForeignEndpoint(
  svm: LiteSVM,
  chainId: number,
  emitterAddress: Uint8Array,
): PublicKey {
  if (emitterAddress.length !== 32) {
    throw new Error(`emitterAddress must be 32 bytes, got ${emitterAddress.length}`)
  }
  const [pda] = findTokenBridgeForeignEndpointPda(chainId, emitterAddress)
  const data = new Uint8Array(2 + 32)
  new DataView(data.buffer).setUint16(0, chainId, true)
  data.set(emitterAddress, 2)
  svm.setAccount(pda, {
    executable: false,
    owner: GATEWAY_PROGRAM_ID,
    lamports: Number(RENT_EXEMPT_MIN),
    data,
    rentEpoch: 0,
  })
  return pda
}

/**
 * WrappedMeta for `wrappedMint`. Borsh layout:
 *   chain: u16 LE (2) + token_address: [u8;32] (32) + original_decimals: u8 (1) = 35 B
 *
 * TB validates `wrapped_meta.token_address == vaa.token_address` and
 * `wrapped_meta.chain == vaa.token_chain` — these MUST match the values used
 * to derive the wrapped mint and the values in the PostedVAA payload.
 */
export function setupWrappedMeta(
  svm: LiteSVM,
  wrappedMint: PublicKey,
  sourceChain: number,
  sourceTokenAddress: Uint8Array,
  originalDecimals: number,
): PublicKey {
  if (sourceTokenAddress.length !== 32) {
    throw new Error(`sourceTokenAddress must be 32 bytes, got ${sourceTokenAddress.length}`)
  }
  const [pda] = findTokenBridgeWrappedMetaPda(wrappedMint)
  const data = new Uint8Array(2 + 32 + 1)
  new DataView(data.buffer).setUint16(0, sourceChain, true)
  data.set(sourceTokenAddress, 2)
  data[34] = originalDecimals & 0xFF
  svm.setAccount(pda, {
    executable: false,
    owner: GATEWAY_PROGRAM_ID,
    lamports: Number(RENT_EXEMPT_MIN),
    data,
    rentEpoch: 0,
  })
  return pda
}

/**
 * Synthesize the wrapped SPL Mint at the PDA derived from
 * `["wrapped", chain_be, token_addr]`, owned by SPL Token program with
 * `mint_authority = TB MintSigner PDA` so the TB CPI's `mint_to` succeeds.
 *
 * Returns `{ publicKey }` (not a Keypair — PDAs have no private key) so it's
 * a drop-in replacement for `createMint(svm, payer, decimals)` call sites
 * that read `.publicKey`.
 *
 * SPL Mint layout (82 B):
 *   [0..4]   mint_authority option (u32 LE; 1 = Some)
 *   [4..36]  mint_authority pubkey
 *   [36..44] supply (u64 LE)
 *   [44]     decimals
 *   [45]     is_initialized (1)
 *   [46..50] freeze_authority option (0)
 *   [50..82] freeze_authority pubkey (zeros)
 */
export function createWrappedMint(
  svm: LiteSVM,
  sourceChain: number,
  sourceTokenAddress: Uint8Array,
  decimals: number,
): { publicKey: PublicKey } {
  if (sourceTokenAddress.length !== 32) {
    throw new Error(`sourceTokenAddress must be 32 bytes, got ${sourceTokenAddress.length}`)
  }
  const [mintPda] = findTokenBridgeWrappedMintPda(sourceChain, sourceTokenAddress)
  const [mintAuthority] = findTokenBridgeMintAuthorityPda()

  const data = new Uint8Array(MINT_SIZE) // 82 bytes
  const view = new DataView(data.buffer)
  view.setUint32(0, 1, true) // mint_authority option = Some
  data.set(mintAuthority.toBytes(), 4)
  // supply (offset 36..44) stays 0
  data[44] = decimals & 0xFF
  data[45] = 1 // is_initialized
  // freeze_authority option (46..50) stays 0; pubkey (50..82) stays zeros

  svm.setAccount(mintPda, {
    executable: false,
    owner: TOKEN_PROGRAM_ID,
    lamports: 1_461_600, // SPL Mint rent-exempt minimum
    data,
    rentEpoch: 0,
  })
  // Suppress chainId-unused warning while keeping the param in the signature.
  void chainIdLeBuf(sourceChain)
  return { publicKey: mintPda }
}
