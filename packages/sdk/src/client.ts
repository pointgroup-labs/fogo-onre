import type { Provider } from '@anchor-lang/core'
import type { PublicKey } from '@solana/web3.js'
import type { NttRedeemContext, OnreSwapContext } from './builders'
import type { FogoOnreRelayer } from './types/fogo_onre_relayer'
import { BN, Program } from '@anchor-lang/core'

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  SystemProgram,
} from '@solana/web3.js'
import { FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID, NTT_USDC_PROGRAM_ID } from './constants'
import IDL from './idl/fogo_onre_relayer.json' with { type: 'json' }
import {
  buildNttRedeemReleaseAccounts,
  buildNttReleaseWormholeOutboundAccountList,
  buildNttTransferLockAccountList,
  buildOnreCancelRedemptionRequestRemainingAccounts,
  buildOnreCreateRedemptionRequestRemainingAccounts,
  buildOnreSwapRemainingAccounts,
  NTT_TRANSFER_LOCK_ACCOUNT_COUNT,
  type OnreDeployment,
} from './builders'
import {
  findAuthorityPda,
  findConfigPda,
  findInflightFlowPda,
  findOutflightFlowPda,
  findRedemptionTrackerPda,
  findUserInboxAuthorityPda,
} from './pda'

/** Coerce a BN | bigint amount into a bigint without losing precision. */
function toBigInt(value: BN | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value.toString())
}

export class RelayerClient {
  readonly program: Program<FogoOnreRelayer>
  readonly configPda: PublicKey
  readonly authorityPda: PublicKey
  readonly redemptionTrackerPda: PublicKey

  constructor(provider: Provider) {
    this.program = new Program<FogoOnreRelayer>(IDL as unknown as FogoOnreRelayer, provider)
    ;[this.configPda] = findConfigPda(this.program.programId)
    ;[this.authorityPda] = findAuthorityPda(this.program.programId)
    ;[this.redemptionTrackerPda] = findRedemptionTrackerPda(this.program.programId)
  }

  /**
   * One-time setup: create config PDA + relayer-authority-owned ATAs.
   *
   * `feeVault` MUST be a pre-existing token account holding the ONyc mint
   * AND MUST NOT alias the relayer-owned ONyc ATA — every fee transfer
   * would otherwise become a no-op self-transfer, commingling user funds
   * with fees in the operating ATA. The relayer enforces both checks.
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
      .accountsPartial({
        authority: params.authority,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        usdcMint: params.usdcMint,
        onycMint: params.onycMint,
        usdcAta: this.relayerAta(params.usdcMint),
        onycAta: this.relayerAta(params.onycMint),
        feeVault: params.feeVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
  }

  /**
   * Update admin-mutable config. All fields are optional (see prior
   * docstring). Authority-only.
   */
  async configure(params: {
    authority?: PublicKey
    onycMint?: PublicKey
    feeVault?: PublicKey | null
    depositFeeBps?: number | null
    withdrawFeeBps?: number | null
    newAuthority?: PublicKey | null
  } = {}) {
    const authority = params.authority ?? this.providerPublicKey()
    if (!authority) {
      throw new Error('configure: no authority provided and provider has no wallet')
    }

    const onycMint = params.onycMint ?? ((await this.fetchConfig()).onycMint as PublicKey)

    return this.program.methods
      .configure(
        params.depositFeeBps ?? null,
        params.withdrawFeeBps ?? null,
        params.newAuthority ?? null,
      )
      .accountsPartial({
        authority,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        onycMint,
        onycAta: this.relayerAta(onycMint),
        feeVault: params.feeVault ?? null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
  }

  async acceptAuthority(params: {
    pendingAuthority?: PublicKey
  } = {}) {
    const pending = params.pendingAuthority ?? this.providerPublicKey()
    if (!pending) {
      throw new Error('acceptAuthority: no pendingAuthority provided and provider has no wallet')
    }
    return this.program.methods
      .acceptAuthority()
      .accountsPartial({
        pendingAuthority: pending,
        relayerConfig: this.configPda,
      })
  }

  /**
   * Claim bridged USDC.s via NTT (`redeem` + `release_inbound_unlock`) and
   * create an inflight Flow PDA bound to the per-VAA `ntt_inbox_item`.
   * Mirrors `unlockOnyc` but on the USDC mint.
   */
  claimUsdc(params: {
    payer: PublicKey
    /**
     * Originating FOGO wallet (= same pubkey on Solana). Drives the
     * `[user_inbox, user_wallet]` PDA derivation that scopes the
     * release_inbound destination ATA + sweep authority. Must match the
     * wallet that signed the FOGO bridge intent.
     */
    userWallet: PublicKey
    usdcMint: PublicKey
    nttInboxItem: PublicKey
    nttTransceiverMessage: PublicKey
    /**
     * NTT redeem+release context (custody account from NTT config, plus the
     * USDC.s transceiver address). When omitted (failure-path tests) the
     * caller MUST supply `redeemAccountsLen` and chain `.remainingAccounts`.
     */
    ntt?: NttRedeemContext
    redeemAccountsLen?: number
  }) {
    const { inflightFlow, redemptionTracker } = this.flowPdas(params.nttInboxItem)
    const { userInboxAuthority, userInboxAta } = this.userInboxBindings(
      params.userWallet,
      params.usdcMint,
    )
    const built = params.ntt
      ? buildNttRedeemReleaseAccounts({
          mint: params.usdcMint,
          nttInboxItem: params.nttInboxItem,
          nttTransceiverMessage: params.nttTransceiverMessage,
          ntt: params.ntt,
          programId: NTT_USDC_PROGRAM_ID,
          authority: this.authorityPda,
          // The release destination is the per-user inbox ATA, not the
          // long-lived relayer-authority ATA. The handler sweeps the
          // delta into custody after release.
          recipientAta: userInboxAta,
        })
      : null

    const builder = this.program.methods
      .claimUsdc(built ? built.redeemAccountsLen : (params.redeemAccountsLen ?? 0))
      .accountsPartial({
        payer: params.payer,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        usdcMint: params.usdcMint,
        usdcAta: this.relayerAta(params.usdcMint),
        userWallet: params.userWallet,
        userInboxAuthority,
        userInboxAta,
        nttInboxItem: params.nttInboxItem,
        nttTransceiverMessage: params.nttTransceiverMessage,
        inflightFlow,
        redemptionTracker,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })

    return built ? builder.remainingAccounts(built.remainingAccounts) : builder
  }

  /**
   * Swap USDC to ONyc via OnRe (deposit leg). The SDK assembles OnRe's
   * 22-entry `remainingAccounts` list when `onre` is supplied.
   *
   * `feeVault` and `redemptionTracker` are explicit even though Anchor's
   * relation resolver could derive them from `relayerConfig.has_one` and
   * the singleton tracker PDA respectively — silent resolution depends
   * on Anchor version + IDL metadata staying intact across regenerations.
   * Pass them in to make instruction construction stable across upgrades.
   */
  swapUsdcToOnyc(params: {
    usdcMint: PublicKey
    onycMint: PublicKey
    nttInboxItem: PublicKey
    feeVault: PublicKey
    onre?: OnreSwapContext
  }) {
    const { inflightFlow, redemptionTracker } = this.flowPdas(params.nttInboxItem)
    const builder = this.program.methods
      .swapUsdcToOnyc()
      .accountsPartial({
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        usdcMint: params.usdcMint,
        onycMint: params.onycMint,
        usdcAta: this.relayerAta(params.usdcMint),
        onycAta: this.relayerAta(params.onycMint),
        feeVault: params.feeVault,
        nttInboxItem: params.nttInboxItem,
        inflightFlow,
        redemptionTracker,
        tokenProgram: TOKEN_PROGRAM_ID,
      })

    if (!params.onre) {
      return builder
    }
    return builder.remainingAccounts(
      buildOnreSwapRemainingAccounts({
        tokenInMint: params.usdcMint,
        tokenOutMint: params.onycMint,
        userTokenInAccount: this.relayerAta(params.usdcMint),
        userTokenOutAccount: this.relayerAta(params.onycMint),
        user: this.authorityPda,
        ctx: params.onre,
      }),
    )
  }

  /**
   * Lock ONyc via NTT and atomically publish the outbound Wormhole VAA
   * (transfer_lock + release_wormhole_outbound, both PDA-signed). Sends
   * ONyc to `flow.fogo_sender`. Closes the inflight Flow PDA.
   *
   * Caller MUST fetch the flow first to obtain `flowAmount` /
   * `flowFogoSender` (needed for the NTT `session_authority` derivation),
   * supply a fresh `outboxItem` keypair (also via `.signers([])`), and
   * supply the NTT v3 `release` accounts. After this PR there is no
   * "lock without release" path — every successful `lock_onyc` emits the
   * Wormhole VAA atomically.
   *
   * The remaining-accounts layout is `[...transferLock(NTT_TRANSFER_LOCK_ACCOUNT_COUNT), ...release(15)]`
   * for a total of 29; the on-chain handler uses
   * `NTT_TRANSFER_LOCK_ACCOUNT_COUNT` to split.
   *
   * Failure-path callers (deliberately broken `remainingAccounts` for
   * negative tests) MUST omit `flowAmount` / `flowFogoSender` / `outboxItem`
   * — the SDK returns the bare builder so they can attach their own
   * `remainingAccounts` to exercise pre-CPI guards.
   */
  lockOnyc(params: {
    payer: PublicKey
    onycMint: PublicKey
    nttInboxItem: PublicKey
    rentDestination: PublicKey
    flowAmount?: BN | bigint
    flowFogoSender?: Uint8Array
    outboxItem?: PublicKey
    /**
     * NTT v3 release-publish accounts. REQUIRED whenever `flowAmount` /
     * `flowFogoSender` / `outboxItem` are all supplied — there is no
     * "lock-only" code path post-merge.
     */
    release?: {
      wormholeProgram: PublicKey
      wormholeBridge: PublicKey
      wormholeFeeCollector: PublicKey
      wormholeSequence: PublicKey
      outboxItemSigner: PublicKey
      /** Optional override; defaults to the manager-as-transceiver PDA. */
      wormholeMessage?: PublicKey
      emitter?: PublicKey
    }
  }) {
    const { inflightFlow } = this.flowPdas(params.nttInboxItem)
    const builder = this.program.methods
      .lockOnyc(NTT_TRANSFER_LOCK_ACCOUNT_COUNT)
      .accountsPartial({
        payer: params.payer,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        onycMint: params.onycMint,
        onycAta: this.relayerAta(params.onycMint),
        nttInboxItem: params.nttInboxItem,
        inflightFlow,
        rentDestination: params.rentDestination,
        tokenProgram: TOKEN_PROGRAM_ID,
      })

    if (!params.flowAmount || !params.flowFogoSender || !params.outboxItem) {
      return builder
    }

    if (!params.release) {
      throw new Error(
        'lockOnyc: `release` is required whenever flowAmount/flowFogoSender/outboxItem '
        + 'are supplied. The on-chain handler now CPIs into NTT release_wormhole_outbound '
        + 'in the same ix as transfer_lock — there is no lock-only path.',
      )
    }

    const transferLock = this.transferLockAccounts({
      mint: params.onycMint,
      nttProgramId: NTT_ONYC_PROGRAM_ID,
      outboxItem: params.outboxItem,
      recipientAddress: params.flowFogoSender,
      amount: toBigInt(params.flowAmount),
    })

    const releaseAccts = buildNttReleaseWormholeOutboundAccountList({
      payer: params.payer,
      nttProgramId: NTT_ONYC_PROGRAM_ID,
      outboxItem: params.outboxItem,
      wormholeProgram: params.release.wormholeProgram,
      wormholeBridge: params.release.wormholeBridge,
      wormholeFeeCollector: params.release.wormholeFeeCollector,
      wormholeSequence: params.release.wormholeSequence,
      outboxItemSigner: params.release.outboxItemSigner,
      wormholeMessage: params.release.wormholeMessage,
      emitter: params.release.emitter,
    })

    return builder.remainingAccounts([...transferLock, ...releaseAccts])
  }

  /**
   * Unlock ONyc from NTT (`redeem` + `release_inbound_unlock`) and create
   * an outflight Flow PDA bound to the per-VAA `ntt_inbox_item`.
   */
  unlockOnyc(params: {
    payer: PublicKey
    onycMint: PublicKey
    nttInboxItem: PublicKey
    nttTransceiverMessage: PublicKey
    ntt?: NttRedeemContext
    redeemAccountsLen?: number
  }) {
    const { outflightFlow } = this.flowPdas(params.nttInboxItem)
    const built = params.ntt
      ? buildNttRedeemReleaseAccounts({
          mint: params.onycMint,
          nttInboxItem: params.nttInboxItem,
          nttTransceiverMessage: params.nttTransceiverMessage,
          ntt: params.ntt,
          programId: NTT_ONYC_PROGRAM_ID,
          authority: this.authorityPda,
          // ONyc release: route to the long-lived relayer custody ATA
          // (the standard `unlock_onyc` path).
          recipientAta: this.relayerAta(params.onycMint),
        })
      : null

    const builder = this.program.methods
      .unlockOnyc(built ? built.redeemAccountsLen : (params.redeemAccountsLen ?? 0))
      .accountsPartial({
        payer: params.payer,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        onycMint: params.onycMint,
        onycAta: this.relayerAta(params.onycMint),
        nttInboxItem: params.nttInboxItem,
        nttTransceiverMessage: params.nttTransceiverMessage,
        outflightFlow,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })

    return built ? builder.remainingAccounts(built.remainingAccounts) : builder
  }

  /**
   * Send USDC.s back to `flow.fogo_sender` via NTT `transfer_lock`. Closes
   * the outflight Flow PDA. Mirrors `lockOnyc` on the USDC mint — the NTT
   * remaining-accounts list is appended automatically when `flowAmount`,
   * `flowFogoSender`, and `outboxItem` are all supplied.
   */
  sendUsdcToUser(params: {
    payer: PublicKey
    usdcMint: PublicKey
    nttInboxItem: PublicKey
    rentDestination: PublicKey
    flowAmount?: BN | bigint
    flowFogoSender?: Uint8Array
    outboxItem?: PublicKey
  }) {
    const { outflightFlow, redemptionTracker } = this.flowPdas(params.nttInboxItem)
    const builder = this.program.methods
      .sendUsdcToUser()
      .accountsPartial({
        payer: params.payer,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        usdcMint: params.usdcMint,
        usdcAta: this.relayerAta(params.usdcMint),
        nttInboxItem: params.nttInboxItem,
        outflightFlow,
        rentDestination: params.rentDestination,
        redemptionTracker,
        tokenProgram: TOKEN_PROGRAM_ID,
      })

    if (!params.flowAmount || !params.flowFogoSender || !params.outboxItem) {
      return builder
    }

    return builder.remainingAccounts(
      this.transferLockAccounts({
        mint: params.usdcMint,
        nttProgramId: NTT_USDC_PROGRAM_ID,
        outboxItem: params.outboxItem,
        recipientAddress: params.flowFogoSender,
        amount: toBigInt(params.flowAmount),
      }),
    )
  }

  requestRedemptionOnyc(params: {
    payer: PublicKey
    usdcMint: PublicKey
    onycMint: PublicKey
    nttInboxItem: PublicKey
    feeVault: PublicKey
    onre?: {
      redemptionRequest: PublicKey
      tokenProgram?: PublicKey
      deployment?: OnreDeployment
    }
  }) {
    const { outflightFlow, redemptionTracker } = this.flowPdas(params.nttInboxItem)
    const builder = this.program.methods
      .requestRedemptionOnyc()
      .accountsPartial({
        payer: params.payer,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        usdcMint: params.usdcMint,
        onycMint: params.onycMint,
        usdcAta: this.relayerAta(params.usdcMint),
        onycAta: this.relayerAta(params.onycMint),
        feeVault: params.feeVault,
        nttInboxItem: params.nttInboxItem,
        outflightFlow,
        redemptionTracker,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })

    if (!params.onre) {
      return builder
    }
    return builder.remainingAccounts(
      buildOnreCreateRedemptionRequestRemainingAccounts({
        tokenInMint: params.onycMint,
        tokenOutMint: params.usdcMint,
        redeemer: this.authorityPda,
        redeemerTokenAccount: this.relayerAta(params.onycMint),
        redemptionRequest: params.onre.redemptionRequest,
        tokenProgram: params.onre.tokenProgram,
        deployment: params.onre.deployment,
      }),
    )
  }

  claimRedemptionUsdc(params: {
    cranker: PublicKey
    usdcMint: PublicKey
    nttInboxItem: PublicKey
    redemptionRequest: PublicKey
    payerForClose: PublicKey
  }) {
    const { outflightFlow, redemptionTracker } = this.flowPdas(params.nttInboxItem)
    return this.program.methods
      .claimRedemptionUsdc()
      .accountsPartial({
        cranker: params.cranker,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        usdcMint: params.usdcMint,
        usdcAta: this.relayerAta(params.usdcMint),
        nttInboxItem: params.nttInboxItem,
        outflightFlow,
        redemptionTracker,
        payerForClose: params.payerForClose,
        redemptionRequest: params.redemptionRequest,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
  }

  cancelRedemptionOnyc(params: {
    authority: PublicKey
    onycMint: PublicKey
    nttInboxItem: PublicKey
    payerForClose: PublicKey
    onre?: {
      redemptionRequest: PublicKey
      redemptionAdmin: PublicKey
      usdcMint: PublicKey
      tokenProgram?: PublicKey
      deployment?: OnreDeployment
    }
  }) {
    const { outflightFlow, redemptionTracker } = this.flowPdas(params.nttInboxItem)
    const builder = this.program.methods
      .cancelRedemptionOnyc()
      .accountsPartial({
        authority: params.authority,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        onycMint: params.onycMint,
        onycAta: this.relayerAta(params.onycMint),
        nttInboxItem: params.nttInboxItem,
        outflightFlow,
        redemptionTracker,
        payerForClose: params.payerForClose,
        tokenProgram: TOKEN_PROGRAM_ID,
      })

    if (!params.onre) {
      return builder
    }
    return builder.remainingAccounts(
      buildOnreCancelRedemptionRequestRemainingAccounts({
        tokenInMint: params.onycMint,
        tokenOutMint: params.onre.usdcMint,
        signer: this.authorityPda,
        redeemer: this.authorityPda,
        redeemerTokenAccount: this.relayerAta(params.onycMint),
        redemptionAdmin: params.onre.redemptionAdmin,
        redemptionRequest: params.onre.redemptionRequest,
        tokenProgram: params.onre.tokenProgram,
        deployment: params.onre.deployment,
      }),
    )
  }

  async fetchConfig() {
    return this.program.account.relayerConfig.fetch(this.configPda)
  }

  async fetchInflightFlow(nttInboxItem: PublicKey) {
    const [pda] = findInflightFlowPda(nttInboxItem, this.program.programId)
    return this.program.account.flow.fetch(pda)
  }

  async fetchOutflightFlow(nttInboxItem: PublicKey) {
    const [pda] = findOutflightFlowPda(nttInboxItem, this.program.programId)
    return this.program.account.flow.fetch(pda)
  }

  private relayerAta(mint: PublicKey) {
    return getAssociatedTokenAddressSync(mint, this.authorityPda, true)
  }

  /**
   * Derive the three flow-tracking PDAs keyed off a single `nttInboxItem`.
   *
   * Every flow-driving instruction (claim/swap/request/claim-redemption/
   * cancel/lock/unlock/send) needs some subset of `{inflightFlow,
   * outflightFlow, redemptionTracker}`. Centralising the derivation
   * here keeps method bodies focused on which accounts an instruction
   * actually consumes — callers destructure only what they need.
   */
  /**
   * Shape the 14-account NTT `transfer_lock` argument list. Both
   * outbound legs (USDC.s on `sendUsdcToUser`, ONyc on `lockOnyc`)
   * pass an identical clump differing only in `mint` and the
   * NTT manager program id, so the relayer authority/from-token
   * derivation is centralised here.
   */
  private transferLockAccounts(args: {
    mint: PublicKey
    nttProgramId: PublicKey
    outboxItem: PublicKey
    recipientAddress: Uint8Array
    amount: bigint
  }) {
    return buildNttTransferLockAccountList({
      nttProgramId: args.nttProgramId,
      fromOwner: this.authorityPda,
      fromOwnerIsSigner: false,
      fromTokenAccount: this.relayerAta(args.mint),
      mint: args.mint,
      outboxItem: args.outboxItem,
      recipientChain: FOGO_WORMHOLE_CHAIN_ID,
      recipientAddress: args.recipientAddress,
      amount: args.amount,
    })
  }

  private flowPdas(nttInboxItem: PublicKey): {
    inflightFlow: PublicKey
    outflightFlow: PublicKey
    redemptionTracker: PublicKey
  } {
    const [inflightFlow] = findInflightFlowPda(nttInboxItem, this.program.programId)
    const [outflightFlow] = findOutflightFlowPda(nttInboxItem, this.program.programId)
    return { inflightFlow, outflightFlow, redemptionTracker: this.redemptionTrackerPda }
  }

  /**
   * Per-user inbox-authority PDA + the ATA owned by it for `mint`.
   *
   * `claimUsdc` is the only consumer today; extracted so that any future
   * inbox-aware instruction (e.g. send-back-to-sender) inherits the
   * canonical derivation without copy-paste drift.
   */
  private userInboxBindings(userWallet: PublicKey, mint: PublicKey): {
    userInboxAuthority: PublicKey
    userInboxAta: PublicKey
  } {
    const [userInboxAuthority] = findUserInboxAuthorityPda(
      userWallet,
      this.program.programId,
    )
    const userInboxAta = getAssociatedTokenAddressSync(
      mint,
      userInboxAuthority,
      true, // allow PDA-owner ATA
    )
    return { userInboxAuthority, userInboxAta }
  }

  /** Resolve the provider's wallet pubkey, supporting both anchor wallet and bare-key shapes. */
  private providerPublicKey(): PublicKey | undefined {
    const provider = this.program.provider as any
    return provider.wallet?.publicKey ?? provider.publicKey
  }
}
