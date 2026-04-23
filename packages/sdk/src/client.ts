import type { Provider } from '@anchor-lang/core'
import type { PublicKey } from '@solana/web3.js'
import type { TokenBridgeClaimContext, TokenBridgeTransferContext } from './gateway'
import type { NttRedeemContext, NttTransferLockContext } from './ntt'
import type { OnreSwapContext } from './onre'
import type { Relayer } from './types/fogo_onre_relayer'
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
import IDL from './idl/fogo_onre_relayer.json'
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
import { buildOnreCancelRedemptionRequestRemainingAccounts, buildOnreCreateRedemptionRequestRemainingAccounts, buildOnreSwapRemainingAccounts } from './onre'
import {
  findAuthorityPda,
  findConfigPda,
  findInflightFlowPda,
  findOutflightFlowPda,
  findRedeemerAuthorityPda,
  findRedemptionTrackerPda,
} from './pda'

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

  /**
   * One-time setup: create config PDA + ATAs.
   *
   * `feeVault` MUST be a pre-existing token account holding the ONyc mint
   * AND MUST NOT alias the relayer-owned ONyc ATA — otherwise every fee
   * transfer becomes a no-op self-transfer (commingling user funds with
   * fees in the operating ATA, which is the bug the segregated vault
   * exists to prevent). The relayer program enforces both checks at init.
   */
  initialize(params: {
    authority: PublicKey
    usdcMint: PublicKey
    onycMint: PublicKey
    feeVault: PublicKey
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
        feeVault: params.feeVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
  }

  /**
   * Update admin-mutable config. All fields are optional:
   *
   * - `depositFeeBps` / `withdrawFeeBps`: omit or pass `null` to leave
   *    unchanged.
   * - `feeVault`: omit or pass `null` to leave the stored vault unchanged.
   *    When provided, the on-chain mint check + handler-side anti-aliasing
   *    check (`fee_vault != onyc_ata`) re-validate the new vault.
   * - `newAuthority`: two-step authority rotation (propose step).
   *    `undefined`/`null` leaves the proposal slot unchanged. A
   *    `PublicKey` proposes that key as the next authority — current
   *    authority is unchanged until the proposed key signs
   *    `acceptAuthority` in a separate transaction. Pass
   *    `PublicKey.default` to cancel any in-flight proposal. A typo
   *    is harmless: until acceptance, the current authority retains
   *    full control and can overwrite or cancel.
   * - `authority`: defaults to the provider's wallet pubkey.
   * - `onycMint`: lazily fetched from `relayer_config` when omitted.
   *    Pass it explicitly to avoid the network round-trip when you
   *    already have it cached.
   *
   * Authority-only. Returns a builder; chain `.rpc()` to send.
   */
  async configure(params: {
    authority?: PublicKey
    onycMint?: PublicKey
    feeVault?: PublicKey | null
    depositFeeBps?: number | null
    withdrawFeeBps?: number | null
    newAuthority?: PublicKey | null
  } = {}) {
    const authority = params.authority
      ?? (this.program.provider as any).wallet?.publicKey
      ?? (this.program.provider as any).publicKey
    if (!authority) {
      throw new Error('configure: no authority provided and provider has no wallet')
    }

    // `onyc_mint` is still mandatory on-chain (`has_one = onyc_mint` on
    // relayer_config runs unconditionally). Lazy-fetch from config when
    // the caller didn't pass it.
    const onycMint = params.onycMint ?? ((await this.fetchConfig()).onycMint as PublicKey)

    return this.program.methods
      .configure(
        params.depositFeeBps ?? null,
        params.withdrawFeeBps ?? null,
        params.newAuthority ?? null,
      )
      .accounts({
        authority,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        onycMint,
        onycAta: this.ata(onycMint),
        feeVault: params.feeVault ?? null,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
  }

  /**
   * Step two of authority rotation. The signer must equal
   * `relayer_config.pending_authority` (proposed via a prior
   * `configure({ newAuthority })` call). On success, the pending key
   * atomically becomes the new `authority` and the pending slot
   * clears. The current authority does not need to participate.
   *
   * @param params.pendingAuthority - defaults to provider wallet pubkey
   */
  async acceptAuthority(params: {
    pendingAuthority?: PublicKey
  } = {}) {
    const pending = params.pendingAuthority
      ?? (this.program.provider as any).wallet?.publicKey
      ?? (this.program.provider as any).publicKey
    if (!pending) {
      throw new Error('acceptAuthority: no pendingAuthority provided and provider has no wallet')
    }
    return this.program.methods
      .acceptAuthority()
      .accounts({
        pendingAuthority: pending,
        relayerConfig: this.configPda,
      } as any)
  }

  /**
   * Authority-only escape hatch to recover stranded balances from the
   * relayer-PDA-owned USDC/ONyc ATAs. Operational flows always move the
   * exact `Flow.amount` recorded by the inbound bridge step, so anything
   * credited outside a tracked flow (pre-upgrade commingled fees, dust,
   * accidental direct transfers, slippage gains) would otherwise be
   * locked behind the PDA signature.
   */
  sweep(params: {
    authority: PublicKey
    mint: PublicKey
    to: PublicKey
    amount: BN
  }) {
    return this.program.methods
      .sweep(params.amount)
      .accounts({
        authority: params.authority,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        mint: params.mint,
        from: this.ata(params.mint),
        to: params.to,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
  }

  /**
   * Claim bridged USDC and create an inflight flow PDA. The SDK builds the
   * full Token Bridge `CompleteWrappedWithPayload` account list from
   * `tokenBridge` (named-fields). Bridge-program-verified — see `gateway.ts`.
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
    const builder = this.program.methods
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

  /**
   * Swap USDC to ONyc via OnRe (deposit leg). The SDK assembles OnRe's
   * 22-entry `remainingAccounts` list when `onre` is supplied. Omit it for
   * failure-path tests that exercise relayer-side validation before the CPI.
   */
  swapUsdcToOnyc(params: {
    usdcMint: PublicKey
    onycMint: PublicKey
    gatewayClaim: PublicKey
    /**
     * OnRe context overrides. Pass an empty object `{}` to use mainnet
     * defaults (state PDA, boss pubkey, derived ATAs). Omit entirely to
     * leave `remainingAccounts` empty for callers that need to chain
     * their own.
     */
    onre?: OnreSwapContext
  }) {
    const [inflightFlow] = findInflightFlowPda(params.gatewayClaim, this.program.programId)
    const builder = this.program.methods
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

    if (!params.onre) {
      return builder
    }
    return builder.remainingAccounts(
      buildOnreSwapRemainingAccounts({
        tokenInMint: params.usdcMint,
        tokenOutMint: params.onycMint,
        userTokenInAccount: this.ata(params.usdcMint),
        userTokenOutAccount: this.ata(params.onycMint),
        user: this.authorityPda,
        ctx: params.onre,
      }),
    )
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
    const builder = this.program.methods
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

    const builder = this.program.methods
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

  /**
   * Send USDC back to the FOGO user. Consumes the flow PDA. SDK builds the
   * Token Bridge `TransferWrappedWithPayload` account list. Bridge-program-verified — see `gateway.ts`.
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
    const [redemptionTracker] = findRedemptionTrackerPda(this.program.programId)
    const builder = this.program.methods
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
        redemptionTracker,
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

  /**
   * Withdraw chain, leg 2: take the withdraw fee on ONyc, snapshot the
   * relayer's USDC ATA pre-balance, and CPI into OnRe's
   * `create_redemption_request` to enqueue the ONyc-for-USDC redemption.
   *
   * Permissionless. Pre: outflight `flow.status == Claimed`. Post:
   * `flow.status == RedemptionPending`, singleton `RedemptionTracker`
   * initialized at `[REDEMPTION_TRACKER_SEED]` with the live
   * `RedemptionRequest` PDA OnRe just created (cached for leg 3's
   * closed-PDA poll).
   *
   * Caller MUST pass the OnRe `RedemptionRequest` PDA derived from the
   * `request_counter` value read off the live `RedemptionOffer` BEFORE
   * the CPI fires (OnRe increments the counter inside the handler). When
   * `onre` is omitted, `remainingAccounts` stays empty for failure-path
   * tests that exercise relayer-side validation before the CPI.
   */
  requestRedemptionOnyc(params: {
    payer: PublicKey
    usdcMint: PublicKey
    onycMint: PublicKey
    nttInboxItem: PublicKey
    /**
     * OnRe-side context. When supplied, the SDK builds the 11-account
     * remainingAccounts list. Required field is `redemptionRequest` —
     * the caller-derived OnRe `RedemptionRequest` PDA.
     */
    onre?: {
      redemptionRequest: PublicKey
      tokenProgram?: PublicKey
      programId?: PublicKey
      state?: PublicKey
    }
  }) {
    const [outflightFlow] = findOutflightFlowPda(params.nttInboxItem, this.program.programId)
    const [redemptionTracker] = findRedemptionTrackerPda(this.program.programId)
    const builder = this.program.methods
      .requestRedemptionOnyc()
      .accounts({
        payer: params.payer,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        usdcMint: params.usdcMint,
        onycMint: params.onycMint,
        usdcAta: this.ata(params.usdcMint),
        onycAta: this.ata(params.onycMint),
        nttInboxItem: params.nttInboxItem,
        outflightFlow,
        redemptionTracker,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)

    if (!params.onre) {
      return builder
    }
    return builder.remainingAccounts(
      buildOnreCreateRedemptionRequestRemainingAccounts({
        tokenInMint: params.onycMint,
        tokenOutMint: params.usdcMint,
        redeemer: this.authorityPda,
        redeemerTokenAccount: this.ata(params.onycMint),
        redemptionRequest: params.onre.redemptionRequest,
        tokenProgram: params.onre.tokenProgram,
        programId: params.onre.programId,
        state: params.onre.state,
      }),
    )
  }

  /**
   * Withdraw chain, leg 3: book the OnRe redemption fulfillment onto the
   * outflight Flow and close the singleton tracker.
   *
   * Permissionless. Pre: `flow.status == RedemptionPending`, the
   * `redemption_request` PDA the relayer recorded at request-time has been
   * closed by OnRe's `fulfill_redemption_request` (zero lamports, empty
   * data, system-owned), and the resulting USDC delta is sitting on the
   * relayer USDC ATA.
   *
   * The relayer instruction issues NO CPI — it just verifies the closed
   * request, computes the ATA delta against `tracker.usdc_ata_pre_balance`,
   * advances the flow to `Swapped`, and closes the tracker (rent →
   * `tracker.payer`).
   */
  claimRedemptionUsdc(params: {
    cranker: PublicKey
    usdcMint: PublicKey
    nttInboxItem: PublicKey
    /** Same `RedemptionRequest` PDA recorded on `tracker.redemption_request`. */
    redemptionRequest: PublicKey
    /** Original `request_redemption_onyc` payer; receives tracker rent. */
    payerForClose: PublicKey
  }) {
    const [outflightFlow] = findOutflightFlowPda(params.nttInboxItem, this.program.programId)
    const [redemptionTracker] = findRedemptionTrackerPda(this.program.programId)
    return this.program.methods
      .claimRedemptionUsdc()
      .accounts({
        cranker: params.cranker,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        usdcMint: params.usdcMint,
        usdcAta: this.ata(params.usdcMint),
        nttInboxItem: params.nttInboxItem,
        outflightFlow,
        redemptionTracker,
        payerForClose: params.payerForClose,
        redemptionRequest: params.redemptionRequest,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
  }

  /**
   * Withdraw chain, recovery hatch: cancel an in-flight OnRe redemption.
   * Authority-only. Pre: outflight `flow.status == RedemptionPending`.
   * Post: ONyc returned to `onyc_ata`, `flow.status == Claimed` with
   * `flow.amount == tracker.onyc_amount_in`, singleton tracker closed.
   *
   * Caller MUST pass the same `RedemptionRequest` PDA recorded on
   * `tracker.redemption_request` AND the OnRe `state.redemption_admin`
   * pubkey (rent destination on the OnRe-owned PDA close). When `onre`
   * is omitted, `remainingAccounts` stays empty for failure-path tests.
   */
  cancelRedemptionOnyc(params: {
    authority: PublicKey
    onycMint: PublicKey
    nttInboxItem: PublicKey
    /** Original `request_redemption_onyc` payer; receives tracker rent. */
    payerForClose: PublicKey
    /**
     * OnRe-side context. When supplied, the SDK builds the 13-account
     * `cancel_redemption_request` remainingAccounts list.
     */
    onre?: {
      redemptionRequest: PublicKey
      redemptionAdmin: PublicKey
      usdcMint: PublicKey
      tokenProgram?: PublicKey
      programId?: PublicKey
      state?: PublicKey
    }
  }) {
    const [outflightFlow] = findOutflightFlowPda(params.nttInboxItem, this.program.programId)
    const [redemptionTracker] = findRedemptionTrackerPda(this.program.programId)
    const builder = this.program.methods
      .cancelRedemptionOnyc()
      .accounts({
        authority: params.authority,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        onycMint: params.onycMint,
        onycAta: this.ata(params.onycMint),
        nttInboxItem: params.nttInboxItem,
        outflightFlow,
        redemptionTracker,
        payerForClose: params.payerForClose,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)

    if (!params.onre) {
      return builder
    }
    return builder.remainingAccounts(
      buildOnreCancelRedemptionRequestRemainingAccounts({
        tokenInMint: params.onycMint,
        tokenOutMint: params.onre.usdcMint,
        signer: this.authorityPda,
        redeemer: this.authorityPda,
        redeemerTokenAccount: this.ata(params.onycMint),
        redemptionAdmin: params.onre.redemptionAdmin,
        redemptionRequest: params.onre.redemptionRequest,
        tokenProgram: params.onre.tokenProgram,
        programId: params.onre.programId,
        state: params.onre.state,
      }),
    )
  }

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

  // Helpers

  private ata(mint: PublicKey, owner: PublicKey = this.authorityPda) {
    return getAssociatedTokenAddressSync(mint, owner, true)
  }
}
