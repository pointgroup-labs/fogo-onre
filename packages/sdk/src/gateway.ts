import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY } from '@solana/web3.js'
import {
  GATEWAY_PROGRAM_ID,
  RELAYER_PROGRAM_ID,
  WORMHOLE_CORE_BRIDGE_ID,
} from './constants.js'

// Token Bridge PDA seeds — from solana/modules/token_bridge/program/src
const TB_CONFIG_SEED = Buffer.from('config')
const TB_AUTHORITY_SIGNER_SEED = Buffer.from('authority_signer')
const TB_CUSTODY_SIGNER_SEED = Buffer.from('custody_signer')
// Upstream seed is "mint_signer" — confirmed against Wormhole source
// (`pub type MintSigner = Derive<Info, "mint_signer">;`) and the captured
// mainnet fixture in tests/fixtures/accounts/.
const TB_MINT_AUTHORITY_SEED = Buffer.from('mint_signer')
const TB_EMITTER_SEED = Buffer.from('emitter')
const TB_SENDER_SEED = Buffer.from('sender')
const TB_REDEEMER_SEED = Buffer.from('redeemer')
const TB_WRAPPED_SEED = Buffer.from('wrapped')
const TB_WRAPPED_META_SEED = Buffer.from('meta')

const CORE_SEQUENCE_SEED = Buffer.from('Sequence')

function chainIdBeBuf(chainId: number): Buffer {
  const buf = Buffer.alloc(2)
  buf.writeUInt16BE(chainId)
  return buf
}

export function findTokenBridgeConfigPda(programId: PublicKey = GATEWAY_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TB_CONFIG_SEED], programId)
}

/** Burn authority delegate for outbound wrapped transfers. */
export function findTokenBridgeAuthoritySignerPda(programId: PublicKey = GATEWAY_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TB_AUTHORITY_SIGNER_SEED], programId)
}

/**
 * Tripwire-only — see file header. The relayer never invokes the NATIVE
 * outbound path, so no production code path reaches this.
 */
export function findTokenBridgeCustodySignerPda(programId: PublicKey = GATEWAY_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TB_CUSTODY_SIGNER_SEED], programId)
}

/** Mint authority for wrapped tokens. */
export function findTokenBridgeMintAuthorityPda(programId: PublicKey = GATEWAY_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TB_MINT_AUTHORITY_SEED], programId)
}

/** Wormhole emitter address for outbound msgs. */
export function findTokenBridgeEmitterPda(programId: PublicKey = GATEWAY_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TB_EMITTER_SEED], programId)
}

/**
 * Caller-program-scoped `sender` PDA — seeds=["sender"] under the CALLER
 * program id (not Gateway). TB requires the caller to sign as this PDA via
 * `invoke_signed` and validates the binding against `cpi_program_id` in
 * `TransferWrappedWithPayloadData`. A PDA derived under Gateway's program ID
 * would be Gateway-owned and unsignable by the caller.
 */
export function findTokenBridgeSenderPda(
  callerProgramId: PublicKey = RELAYER_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TB_SENDER_SEED],
    callerProgramId,
  )
}

/**
 * Caller-program-scoped `redeemer` PDA — seeds=["redeemer"] under the CALLER
 * program id. TB requires the receiver program to sign as this PDA during
 * `CompleteWrappedWithPayload` as proof the payload reached its target.
 */
export function findTokenBridgeRedeemerPda(
  callerProgramId: PublicKey = RELAYER_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TB_REDEEMER_SEED],
    callerProgramId,
  )
}

/**
 * Wrapped mint PDA — seeds=["wrapped", chain_id_be, token_address[32]].
 * `chainId` is the canonical chain (FOGO = 51 for USDC.s); `tokenAddress` is
 * the 32-byte address on that chain.
 */
export function findTokenBridgeWrappedMintPda(
  chainId: number,
  tokenAddress: Uint8Array,
  programId: PublicKey = GATEWAY_PROGRAM_ID,
): [PublicKey, number] {
  if (tokenAddress.length !== 32) {
    throw new Error(`tokenAddress must be 32 bytes, got ${tokenAddress.length}`)
  }
  return PublicKey.findProgramAddressSync(
    [TB_WRAPPED_SEED, chainIdBeBuf(chainId), Buffer.from(tokenAddress)],
    programId,
  )
}

export function findTokenBridgeWrappedMetaPda(
  wrappedMint: PublicKey,
  programId: PublicKey = GATEWAY_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TB_WRAPPED_META_SEED, wrappedMint.toBuffer()],
    programId,
  )
}

/**
 * Foreign endpoint PDA — seeds=[chain_id_be, emitter_address[32]].
 * Per-source-chain registration of the canonical TB emitter on that chain.
 * Use the FOGO TB emitter address when claiming inbound USDC.s.
 */
export function findTokenBridgeForeignEndpointPda(
  chainId: number,
  emitterAddress: Uint8Array,
  programId: PublicKey = GATEWAY_PROGRAM_ID,
): [PublicKey, number] {
  if (emitterAddress.length !== 32) {
    throw new Error(`emitterAddress must be 32 bytes, got ${emitterAddress.length}`)
  }
  return PublicKey.findProgramAddressSync(
    [chainIdBeBuf(chainId), Buffer.from(emitterAddress)],
    programId,
  )
}

export function findCoreBridgeSequencePda(
  emitter: PublicKey,
  programId: PublicKey = WORMHOLE_CORE_BRIDGE_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CORE_SEQUENCE_SEED, emitter.toBuffer()],
    programId,
  )
}

export function findCoreBridgeConfigPda(
  programId: PublicKey = WORMHOLE_CORE_BRIDGE_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('Bridge')], programId)
}

export function findCoreBridgeFeeCollectorPda(
  programId: PublicKey = WORMHOLE_CORE_BRIDGE_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('fee_collector')], programId)
}

/**
 * Caller-supplied anchor points for `claimUsdc` — accounts the SDK can't
 * derive without knowing the wrapped token's source chain + address.
 */
export interface TokenBridgeClaimContext {
  wrappedMint: PublicKey
  /** TB emitter address on FOGO (32 bytes, used for foreign_endpoint PDA). */
  foreignEmitter: Uint8Array
  /** Source chain ID (FOGO = 51). */
  fromChain?: number
}

/**
 * Caller-supplied anchor points for `sendUsdcToUser`. The `message` keypair
 * is required because TB `transfer_*` creates a fresh message account inside
 * the CPI.
 */
export interface TokenBridgeTransferContext {
  wrappedMint: PublicKey
  /** Recipient chain ID (FOGO = 51). */
  recipientChain?: number
}

/**
 * `AccountMeta` list for `CompleteWrappedWithPayload`. Order mirrors upstream
 * `CompleteWrappedWithPayloadData` Solitaire account struct, with the Gateway
 * program appended last so `invoke_signed` can resolve it.
 *
 * `toTokenAccount` (mut) is a short-lived USDC intake ATA owned by the
 * **redeemer** PDA — TB enforces `redeemer.key == to.owner`, so this must NOT
 * be the authority-owned long-lived ATA. `claim_usdc` sweeps the balance into
 * the authority-owned ATA in the same ix.
 */
export function buildClaimWrappedRemainingAccounts(params: {
  payer: PublicKey
  vaa: PublicKey
  gatewayClaim: PublicKey
  toTokenAccount: PublicKey
  /**
   * Appended at the tail so `invoke_relayer_signed` can locate it and force
   * its signer flag before `invoke_signed` into TB. TB itself reads only the
   * first 14 entries and ignores extras.
   */
  relayerAuthority: PublicKey
  ctx: TokenBridgeClaimContext
  callerProgramId?: PublicKey
}) {
  const fromChain = params.ctx.fromChain ?? 51
  const callerId = params.callerProgramId ?? RELAYER_PROGRAM_ID
  const [config] = findTokenBridgeConfigPda()
  const [foreignEndpoint] = findTokenBridgeForeignEndpointPda(fromChain, params.ctx.foreignEmitter)
  const [redeemer] = findTokenBridgeRedeemerPda(callerId)
  const [wrappedMeta] = findTokenBridgeWrappedMetaPda(params.ctx.wrappedMint)
  const [mintAuthority] = findTokenBridgeMintAuthorityPda()

  return [
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: params.vaa, isSigner: false, isWritable: false },
    { pubkey: params.gatewayClaim, isSigner: false, isWritable: true },
    { pubkey: foreignEndpoint, isSigner: false, isWritable: false },
    { pubkey: params.toTokenAccount, isSigner: false, isWritable: true },
    // Outer tx leaves isSigner=false (PDAs can't sign the outer tx); the
    // relayer's `invoke_relayer_signed` flips it at CPI dispatch.
    { pubkey: redeemer, isSigner: false, isWritable: false },
    { pubkey: params.toTokenAccount, isSigner: false, isWritable: true }, // fee_recipient
    { pubkey: params.ctx.wrappedMint, isSigner: false, isWritable: true },
    { pubkey: wrappedMeta, isSigner: false, isWritable: false },
    { pubkey: mintAuthority, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: WORMHOLE_CORE_BRIDGE_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: GATEWAY_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: params.relayerAuthority, isSigner: false, isWritable: false },
  ]
}

/**
 * `AccountMeta` list for `TransferWrappedWithPayload`. Order mirrors upstream
 * `TransferWrappedWithPayloadData`. The `message` keypair must also be passed
 * to `.signers([...])` on the Anchor builder — the CPI initializes it inside
 * the Core Bridge call.
 */
export function buildTransferWrappedRemainingAccounts(params: {
  payer: PublicKey
  fromTokenAccount: PublicKey
  fromOwner: PublicKey
  message: PublicKey
  ctx: TokenBridgeTransferContext
  callerProgramId?: PublicKey
}) {
  const callerId = params.callerProgramId ?? RELAYER_PROGRAM_ID
  const [config] = findTokenBridgeConfigPda()
  const [authoritySigner] = findTokenBridgeAuthoritySignerPda()
  const [wrappedMeta] = findTokenBridgeWrappedMetaPda(params.ctx.wrappedMint)
  const [emitter] = findTokenBridgeEmitterPda()
  const [sender] = findTokenBridgeSenderPda(callerId)
  const [sequence] = findCoreBridgeSequencePda(emitter)
  const [coreBridge] = findCoreBridgeConfigPda()
  const [feeCollector] = findCoreBridgeFeeCollectorPda()

  return [
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: params.fromTokenAccount, isSigner: false, isWritable: true },
    { pubkey: params.fromOwner, isSigner: false, isWritable: false }, // delegate-via-PDA
    { pubkey: params.ctx.wrappedMint, isSigner: false, isWritable: true },
    { pubkey: wrappedMeta, isSigner: false, isWritable: false },
    { pubkey: authoritySigner, isSigner: false, isWritable: false },
    { pubkey: coreBridge, isSigner: false, isWritable: true },
    { pubkey: params.message, isSigner: true, isWritable: true },
    { pubkey: emitter, isSigner: false, isWritable: false },
    { pubkey: sequence, isSigner: false, isWritable: true },
    { pubkey: feeCollector, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: sender, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: WORMHOLE_CORE_BRIDGE_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: GATEWAY_PROGRAM_ID, isSigner: false, isWritable: false },
  ]
}
