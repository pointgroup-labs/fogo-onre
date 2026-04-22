import type { Provider } from '@anchor-lang/core'
import type { PublicKey } from '@solana/web3.js'
import type { TokenBridgeClaimContext, TokenBridgeTransferContext } from './gateway'
import type { NttRedeemContext, NttTransferLockContext } from './ntt'
import type { Relayer } from './types/fogo_relayer'
import { BN, Program } from '@anchor-lang/core'

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  SystemProgram,
} from '@solana/web3.js'
import { FOGO_WORMHOLE_CHAIN_ID, NTT_PROGRAM_ID } from './constants'
import {
  buildClaimWrappedRemainingAccounts,
  buildTransferWrappedRemainingAccounts,

} from './gateway'
import IDL from './idl/fogo_relayer.json'
import {
  findInboxRateLimitPda,
  findNttConfigPda,
  findNttPeerPda,
  findOutboxRateLimitPda,
  findRegisteredTransceiverPda,
  findSessionAuthorityPda,
  findTokenAuthorityPda,

  nttTransferArgsHash,
} from './ntt'
import { findAuthorityPda, findConfigPda, findInflightFlowPda, findOutflightFlowPda, findRedeemerAuthorityPda } from './pda'

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * High-level wrapper around the relayer Anchor program.
 *
 * NOTE: `@anchor-lang/core@1.0.0` converts IDL account names from snake_case
 * to camelCase at runtime, but the generated TypeScript types still reference
 * the original snake_case names. We cast `.accounts()` args to `any` to bridge
 * this mismatch.
 *
 * Each CPI-heavy method (`claimUsdc`, `lockOnyc`, `unlockOnyc`,
 * `sendUsdcToUser`) builds its full `remainingAccounts` array internally —
 * callers pass high-level inputs and named-field context objects rather than
 * positional `AccountMeta[]` lists. The two NTT methods are exercised by
 * `tests/{lock,unlock}-onyc-e2e.test.ts` against the real NTT binary; the
 * two Gateway methods rely on Wormhole-published PDA seeds and are NOT
 * yet covered by an e2e test (see `gateway.ts` `@unverified` notes).
 */
export class RelayerClient {
  readonly program: Program<Relayer>
  readonly configPda: PublicKey
  readonly authorityPda: PublicKey
  readonly redeemerAuthorityPda: PublicKey

  constructor(provider: Provider) {
    this.program = new Program<Relayer>(IDL as unknown as Relayer, provider)
    ;[this.configPda] = findConfigPda(this.program.programId)
    ;[this.authorityPda] = findAuthorityPda(this.program.programId)
    ;[this.redeemerAuthorityPda] = findRedeemerAuthorityPda(this.program.programId)
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private ata(mint: PublicKey, owner: PublicKey = this.authorityPda) {
    return getAssociatedTokenAddressSync(mint, owner, true)
  }

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  /** One-time setup: create config PDA + ATAs. */
  initialize(params: {
    authority: PublicKey
    usdcMint: PublicKey
    onycMint: PublicKey
    depositFeeBps: number
    withdrawFeeBps: number
  }) {
    return this.program.methods
      .initialize(params.depositFeeBps, params.withdrawFeeBps)
      .accounts({
        authority: params.authority,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        redeemerAuthority: this.redeemerAuthorityPda,
        usdcMint: params.usdcMint,
        onycMint: params.onycMint,
        usdcAta: this.ata(params.usdcMint),
        onycAta: this.ata(params.onycMint),
        redeemerUsdcAta: this.ata(params.usdcMint, this.redeemerAuthorityPda),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
  }

  /** Update fee basis points. Authority-only. */
  updateFees(params: {
    authority: PublicKey
    depositFeeBps: number
    withdrawFeeBps: number
  }) {
    return (this.program.methods as any)
      .updateFees(params.depositFeeBps, params.withdrawFeeBps)
      .accounts({
        authority: params.authority,
        relayerConfig: this.configPda,
      } as any)
  }

  /** Withdraw accumulated fees to a destination ATA. Authority-only. */
  withdrawFees(params: {
    authority: PublicKey
    mint: PublicKey
    toAta: PublicKey
    amount: BN
  }) {
    return (this.program.methods as any)
      .withdrawFees(params.amount)
      .accounts({
        authority: params.authority,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        mint: params.mint,
        fromAta: this.ata(params.mint),
        toAta: params.toAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
  }

  // -------------------------------------------------------------------------
  // Deposit flow (USDC → ONyc → bONyc back to FOGO)
  // -------------------------------------------------------------------------

  /**
   * Claim bridged USDC and create an inflight flow PDA. The SDK builds the
   * full Token Bridge `CompleteWrappedWithPayload` account list from
   * `tokenBridge` (named-fields). @unverified — see `gateway.ts`.
   */
  claimUsdc(params: {
    payer: PublicKey
    usdcMint: PublicKey
    postedVaa: PublicKey
    gatewayClaim: PublicKey
    /**
     * Token Bridge wrapped-token context. Optional only for tests that
     *  exercise relayer-side validation before the CPI is reached.
     */
    tokenBridge?: TokenBridgeClaimContext
  }) {
    const [inflightFlow] = findInflightFlowPda(params.gatewayClaim, this.program.programId)
    const redeemerUsdcAta = this.ata(params.usdcMint, this.redeemerAuthorityPda)
    const builder = (this.program.methods as any)
      .claimUsdc()
      .accounts({
        payer: params.payer,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        redeemerAuthority: this.redeemerAuthorityPda,
        usdcMint: params.usdcMint,
        usdcAta: this.ata(params.usdcMint),
        redeemerUsdcAta,
        postedVaa: params.postedVaa,
        gatewayClaim: params.gatewayClaim,
        inflightFlow,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)

    if (!params.tokenBridge) {
      return builder
    }

    return builder.remainingAccounts(
      buildClaimWrappedRemainingAccounts({
        payer: params.payer,
        vaa: params.postedVaa,
        gatewayClaim: params.gatewayClaim,
        // TB mints into the redeemer-owned intake ATA (TB enforces
        // `redeemer.key == to.owner`). `claim_usdc` then sweeps it into
        // the authority-owned `usdcAta` in the same instruction.
        toTokenAccount: redeemerUsdcAta,
        relayerAuthority: this.authorityPda,
        ctx: params.tokenBridge,
        callerProgramId: this.program.programId,
      }),
    )
  }

  /** Swap USDC to ONyc via OnRe. */
  swapUsdcToOnyc(params: {
    usdcMint: PublicKey
    onycMint: PublicKey
    gatewayClaim: PublicKey
  }) {
    const [inflightFlow] = findInflightFlowPda(params.gatewayClaim, this.program.programId)
    return (this.program.methods as any)
      .swapUsdcToOnyc()
      .accounts({
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        usdcMint: params.usdcMint,
        onycMint: params.onycMint,
        usdcAta: this.ata(params.usdcMint),
        onycAta: this.ata(params.onycMint),
        gatewayClaim: params.gatewayClaim,
        inflightFlow,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
  }

  /**
   * Lock ONyc via NTT, sending bONyc to the FOGO user. Consumes the flow PDA.
   *
   * The SDK builds the full NTT `transfer_lock` account list (13 accounts +
   * the NTT program). The caller MUST:
   *   1. Fetch the inflight Flow first (`fetchInflightFlow`) to get the
   *      `flowAmount` and `flowFogoSender` needed to derive `session_authority`.
   *   2. Pass an `outboxItem: PublicKey` (a fresh keypair's pubkey).
   *   3. Add the same `outboxItem` Keypair via `.signers([outboxItem])` —
   *      it's an init account in the NTT CPI.
   */
  lockOnyc(params: {
    payer: PublicKey
    onycMint: PublicKey
    gatewayClaim: PublicKey
    rentDestination: PublicKey
    /** ONyc amount stored on the inflight Flow (post-swap). */
    flowAmount?: BN | bigint
    /** Recipient FOGO wallet stored on the inflight Flow. 32 bytes. */
    flowFogoSender?: Uint8Array
    /** Fresh keypair for the NTT outbox item. Must also be in `.signers([])`. */
    outboxItem?: PublicKey
    /**
     * NTT transfer-lock context (custody account from NTT config). When
     * omitted (failure-path / diagnostic tests) the SDK leaves
     * `remainingAccounts` empty and the caller chains their own.
     */
    ntt?: NttTransferLockContext
  }) {
    const builder = (this.program.methods as any)
      .lockOnyc()
      .accounts({
        payer: params.payer,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        onycMint: params.onycMint,
        onycAta: this.ata(params.onycMint),
        gatewayClaim: params.gatewayClaim,
        inflightFlow: findInflightFlowPda(params.gatewayClaim, this.program.programId)[0],
        rentDestination: params.rentDestination,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)

    if (!params.ntt) {
      return builder
    }
    if (!params.flowAmount || !params.flowFogoSender || !params.outboxItem) {
      throw new Error('lockOnyc: when `ntt` is provided, `flowAmount`, `flowFogoSender`, and `outboxItem` are also required')
    }

    return builder.remainingAccounts(
      this.buildNttTransferLockAccounts({
        payer: params.payer,
        onycMint: params.onycMint,
        flowAmount: typeof params.flowAmount === 'bigint'
          ? params.flowAmount
          : BigInt(params.flowAmount.toString()),
        flowFogoSender: params.flowFogoSender,
        outboxItem: params.outboxItem,
        ntt: params.ntt,
      }),
    )
  }

  // -------------------------------------------------------------------------
  // Withdrawal flow (bONyc → ONyc → USDC back to FOGO)
  // -------------------------------------------------------------------------

  /**
   * Unlock ONyc from NTT (redeem + release_inbound_unlock) and create an
   * outflight flow PDA. The SDK builds the 18-account
   * `redeem ‖ release ‖ NTT_PROGRAM_ID` array internally.
   */
  unlockOnyc(params: {
    payer: PublicKey
    onycMint: PublicKey
    nttInboxItem: PublicKey
    nttTransceiverMessage: PublicKey
    /**
     * NTT redeem+release context. When omitted (failure-path / diagnostic
     * tests) the caller MUST supply both `redeemAccountsLen` and chain
     * `.remainingAccounts(...)` themselves.
     */
    ntt?: NttRedeemContext
    /** Override `redeemAccountsLen` IX arg when `ntt` is omitted. */
    redeemAccountsLen?: number
  }) {
    const [outflightFlow] = findOutflightFlowPda(params.nttInboxItem, this.program.programId)
    const built = params.ntt
      ? this.buildNttRedeemReleaseAccounts({
          payer: params.payer,
          onycMint: params.onycMint,
          nttInboxItem: params.nttInboxItem,
          nttTransceiverMessage: params.nttTransceiverMessage,
          ntt: params.ntt,
        })
      : null

    const builder = (this.program.methods as any)
      .unlockOnyc(built ? built.redeemAccountsLen : (params.redeemAccountsLen ?? 0))
      .accounts({
        payer: params.payer,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        onycMint: params.onycMint,
        onycAta: this.ata(params.onycMint),
        nttInboxItem: params.nttInboxItem,
        nttTransceiverMessage: params.nttTransceiverMessage,
        outflightFlow,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)

    return built ? builder.remainingAccounts(built.remainingAccounts) : builder
  }

  /** Swap ONyc to USDC via OnRe. */
  swapOnycToUsdc(params: {
    usdcMint: PublicKey
    onycMint: PublicKey
    nttInboxItem: PublicKey
  }) {
    const [outflightFlow] = findOutflightFlowPda(params.nttInboxItem, this.program.programId)
    return (this.program.methods as any)
      .swapOnycToUsdc()
      .accounts({
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        usdcMint: params.usdcMint,
        onycMint: params.onycMint,
        usdcAta: this.ata(params.usdcMint),
        onycAta: this.ata(params.onycMint),
        nttInboxItem: params.nttInboxItem,
        outflightFlow,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
  }

  /**
   * Send USDC back to the FOGO user. Consumes the flow PDA. SDK builds the
   * Token Bridge `TransferWrappedWithPayload` account list. @unverified.
   *
   * Caller must pass a fresh `message: PublicKey` (and its Keypair via
   * `.signers([...])`) — the message account is initialized inside the CPI.
   */
  sendUsdcToUser(params: {
    payer: PublicKey
    usdcMint: PublicKey
    nttInboxItem: PublicKey
    rentDestination: PublicKey
    /**
     * Token Bridge transfer context. Optional for tests that only need to
     *  trigger relayer-side validation before the CPI.
     */
    tokenBridge?: TokenBridgeTransferContext
    /** Fresh message keypair pubkey. Required when `tokenBridge` is set. */
    message?: PublicKey
  }) {
    const [outflightFlow] = findOutflightFlowPda(params.nttInboxItem, this.program.programId)
    const builder = (this.program.methods as any)
      .sendUsdcToUser()
      .accounts({
        payer: params.payer,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        usdcMint: params.usdcMint,
        usdcAta: this.ata(params.usdcMint),
        nttInboxItem: params.nttInboxItem,
        outflightFlow,
        rentDestination: params.rentDestination,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)

    if (!params.tokenBridge) {
      return builder
    }

    if (!params.message) {
      throw new Error('sendUsdcToUser: `message` is required when `tokenBridge` is provided')
    }

    return builder.remainingAccounts(
      buildTransferWrappedRemainingAccounts({
        payer: params.payer,
        fromTokenAccount: this.ata(params.usdcMint),
        fromOwner: this.authorityPda,
        message: params.message,
        ctx: params.tokenBridge,
        callerProgramId: this.program.programId,
      }),
    )
  }

  // -------------------------------------------------------------------------
  // Internal NTT account builders (proven layouts — see lock/unlock e2e tests)
  // -------------------------------------------------------------------------

  /**
   * Build the concatenated `redeem ‖ release ‖ NTT_PROGRAM_ID` account list
   * for `unlock_onyc`. Layout (proven against NTT mainnet binary):
   *
   *   Redeem (10):  payer, config, peer, validatedMsg, registeredTransceiver,
   *                 mint, inboxItem(mut), inboxRateLimit(mut),
   *                 outboxRateLimit(mut), systemProgram
   *   Release (8):  payer, config, inboxItem(mut), recipientAta(mut),
   *                 tokenAuthority, mint(mut), tokenProgram, custody(mut)
   *   + NTT program appended last (for invoke_signed account resolution)
   */
  private buildNttRedeemReleaseAccounts(params: {
    payer: PublicKey
    onycMint: PublicKey
    nttInboxItem: PublicKey
    nttTransceiverMessage: PublicKey
    ntt: NttRedeemContext
  }) {
    const fromChain = FOGO_WORMHOLE_CHAIN_ID
    const onycAta = this.ata(params.onycMint)
    const [configPda] = findNttConfigPda()
    const [peerPda] = findNttPeerPda(fromChain)
    const [registeredTransceiverPda] = findRegisteredTransceiverPda(params.ntt.transceiverAddress)
    const [inboxRateLimitPda] = findInboxRateLimitPda(fromChain)
    const [outboxRateLimitPda] = findOutboxRateLimitPda()
    const [tokenAuthorityPda] = findTokenAuthorityPda()

    const redeem = [
      { pubkey: this.authorityPda, isSigner: false, isWritable: true }, // payer = relayer authority PDA
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: peerPda, isSigner: false, isWritable: false },
      { pubkey: params.nttTransceiverMessage, isSigner: false, isWritable: false },
      { pubkey: registeredTransceiverPda, isSigner: false, isWritable: false },
      { pubkey: params.onycMint, isSigner: false, isWritable: false },
      { pubkey: params.nttInboxItem, isSigner: false, isWritable: true },
      { pubkey: inboxRateLimitPda, isSigner: false, isWritable: true },
      { pubkey: outboxRateLimitPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]

    const release = [
      { pubkey: this.authorityPda, isSigner: false, isWritable: true }, // payer
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: params.nttInboxItem, isSigner: false, isWritable: true },
      { pubkey: onycAta, isSigner: false, isWritable: true },
      { pubkey: tokenAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: params.onycMint, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: params.ntt.custody, isSigner: false, isWritable: true },
    ]

    // Each NTT CPI's account_infos slice must contain the NTT program's
    // own AccountInfo so the Solana runtime can resolve the invoke target
    // on strict-mode validators (litesvm is permissive without it; mainnet
    // Agave is not). Append NTT_PROGRAM_ID to BOTH the redeem slice and
    // the release slice so each `invoke_signed` call sees it after the
    // handler's `split_at(redeemAccountsLen)`.
    const nttProgramMeta = { pubkey: NTT_PROGRAM_ID, isSigner: false, isWritable: false }
    return {
      remainingAccounts: [
        ...redeem,
        nttProgramMeta,
        ...release,
        nttProgramMeta,
      ],
      redeemAccountsLen: redeem.length + 1,
    }
  }

  /**
   * Build the NTT `transfer_lock` account list for `lock_onyc`. Layout
   * (proven against NTT mainnet binary):
   *
   *   1. relayer_authority (mut, PDA)    8.  custody (mut)
   *   2. config                          9.  system_program
   *   3. mint (mut)                      10. inbox_rate_limit (mut)
   *   4. from_ata (mut)                  11. peer
   *   5. token_program                   12. session_authority
   *   6. outbox_item (signer, mut)       13. token_authority
   *   7. outbox_rate_limit (mut)
   *   + NTT program appended last
   */
  private buildNttTransferLockAccounts(params: {
    payer: PublicKey
    onycMint: PublicKey
    flowAmount: bigint
    flowFogoSender: Uint8Array
    outboxItem: PublicKey
    ntt: NttTransferLockContext
  }) {
    const recipientChain = FOGO_WORMHOLE_CHAIN_ID
    const onycAta = this.ata(params.onycMint)
    const [configPda] = findNttConfigPda()
    const [peerPda] = findNttPeerPda(recipientChain)
    const [outboxRateLimitPda] = findOutboxRateLimitPda()
    const [inboxRateLimitPda] = findInboxRateLimitPda(recipientChain)
    const [tokenAuthorityPda] = findTokenAuthorityPda()

    const argsHash = nttTransferArgsHash({
      amount: params.flowAmount,
      recipientChain,
      recipientAddress: params.flowFogoSender,
      shouldQueue: false,
    })
    const [sessionAuthorityPda] = findSessionAuthorityPda(this.authorityPda, argsHash)

    return [
      { pubkey: this.authorityPda, isSigner: false, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: params.onycMint, isSigner: false, isWritable: true },
      { pubkey: onycAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: params.outboxItem, isSigner: true, isWritable: true },
      { pubkey: outboxRateLimitPda, isSigner: false, isWritable: true },
      { pubkey: params.ntt.custody, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: inboxRateLimitPda, isSigner: false, isWritable: true },
      { pubkey: peerPda, isSigner: false, isWritable: false },
      { pubkey: sessionAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: tokenAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: NTT_PROGRAM_ID, isSigner: false, isWritable: false },
    ]
  }

  // -------------------------------------------------------------------------
  // Account fetchers
  // -------------------------------------------------------------------------

  /** Fetch the relayer config account. */
  async fetchConfig() {
    return (this.program.account as any).relayerConfig.fetch(this.configPda)
  }

  /** Fetch an inflight (deposit) flow PDA. */
  async fetchInflightFlow(gatewayClaim: PublicKey) {
    const [pda] = findInflightFlowPda(gatewayClaim, this.program.programId)
    return (this.program.account as any).flow.fetch(pda)
  }

  /** Fetch an outflight (withdrawal) flow PDA. */
  async fetchOutflightFlow(nttInboxItem: PublicKey) {
    const [pda] = findOutflightFlowPda(nttInboxItem, this.program.programId)
    return (this.program.account as any).flow.fetch(pda)
  }
}
