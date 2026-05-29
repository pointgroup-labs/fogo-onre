import type { Provider } from '@anchor-lang/core'
import type { AccountMeta, PublicKey } from '@solana/web3.js'
import type { NttRedeemContext, OnreSwapContext } from './builders'
import type { FogoOnreRelayer } from './types/fogo_onre_relayer'
import { Buffer } from 'node:buffer'
import { BN, Program } from '@anchor-lang/core'

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { SystemProgram } from '@solana/web3.js'
import {
  buildNttRedeemReleaseAccounts,
  buildNttReleaseWormholeOutboundAccountList,
  buildNttTransferLockAccountList,
  buildOnreSwapRemainingAccounts,
  findOnreOfferPda,
  NTT_TRANSFER_LOCK_ACCOUNT_COUNT,
} from './builders'
import { FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID, NTT_USDC_PROGRAM_ID, ONRE_PROGRAM_ID } from './constants'
import IDL from './idl/fogo_onre_relayer.json' with { type: 'json' }
import {
  findAuthorityPda,
  findConfigPda,
  findInflightFlowPda,
  findOutflightFlowPda,
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

  constructor(provider: Provider) {
    this.program = new Program<FogoOnreRelayer>(IDL as unknown as FogoOnreRelayer, provider)
    ;[this.configPda] = findConfigPda(this.program.programId)
    ;[this.authorityPda] = findAuthorityPda(this.program.programId)
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
    slippageBps?: number | null
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
        params.slippageBps ?? null,
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
    const { inflightFlow } = this.flowPdas(params.nttInboxItem)
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
          // Release lands in the per-user inbox ATA, not relayer custody;
          // the handler sweeps the delta into custody after release.
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
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })

    return built ? builder.remainingAccounts(built.remainingAccounts) : builder
  }

  /**
   * Swap USDC to ONyc via OnRe (deposit leg). The SDK assembles OnRe's
   * 22-entry `remainingAccounts` list when `onre` is supplied.
   *
   * `feeVault` is explicit even though Anchor's relation resolver
   * could derive it from `relayerConfig.has_one` — silent resolution
   * depends on Anchor version + IDL metadata staying intact across
   * regenerations. Pass it in to make instruction construction stable
   * across upgrades.
   */
  swapUsdcToOnyc(params: {
    usdcMint: PublicKey
    onycMint: PublicKey
    nttInboxItem: PublicKey
    feeVault: PublicKey
    onre?: OnreSwapContext
  }) {
    const { inflightFlow } = this.flowPdas(params.nttInboxItem)
    const onreProgramId = params.onre?.deployment?.programId ?? ONRE_PROGRAM_ID
    const [onreOffer] = findOnreOfferPda(params.usdcMint, params.onycMint, onreProgramId)
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
        onreOffer,
        inflightFlow,
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
   * Send USDC.s back to `flow.fogo_sender` via NTT `transfer_lock` +
   * `release_wormhole_outbound` (atomic). Closes the outflight Flow PDA.
   * Mirrors `lockOnyc` on the USDC mint — the on-chain handler now CPIs
   * into both NTT ix's, so `release` is required whenever `flowAmount` /
   * `flowFogoSender` / `outboxItem` are supplied.
   */
  sendUsdcToUser(params: {
    payer: PublicKey
    usdcMint: PublicKey
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
    const { outflightFlow } = this.flowPdas(params.nttInboxItem)
    const builder = this.program.methods
      .sendUsdcToUser(NTT_TRANSFER_LOCK_ACCOUNT_COUNT)
      .accountsPartial({
        payer: params.payer,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        usdcMint: params.usdcMint,
        usdcAta: this.relayerAta(params.usdcMint),
        nttInboxItem: params.nttInboxItem,
        outflightFlow,
        rentDestination: params.rentDestination,
        tokenProgram: TOKEN_PROGRAM_ID,
      })

    if (!params.flowAmount || !params.flowFogoSender || !params.outboxItem) {
      return builder
    }

    if (!params.release) {
      throw new Error(
        'sendUsdcToUser: `release` is required whenever flowAmount/flowFogoSender/outboxItem '
        + 'are supplied. The on-chain handler now CPIs into NTT release_wormhole_outbound '
        + 'in the same ix as transfer_lock — there is no lock-only path.',
      )
    }

    const transferLock = this.transferLockAccounts({
      mint: params.usdcMint,
      nttProgramId: NTT_USDC_PROGRAM_ID,
      outboxItem: params.outboxItem,
      recipientAddress: params.flowFogoSender,
      amount: toBigInt(params.flowAmount),
    })

    const releaseAccts = buildNttReleaseWormholeOutboundAccountList({
      payer: params.payer,
      nttProgramId: NTT_USDC_PROGRAM_ID,
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
   * Permissionless ONyc → USDC swap for the outbound (withdraw) leg.
   * Cranker fetches a quote from any swap program and the on-chain
   * handler:
   *   1. deducts the withdraw fee in ONyc to `feeVault` directly (PDA-signed),
   *   2. derives the slippage floor from OnRe's deposit-side `Offer`
   *      pricing vector (no caller-supplied `minOut`),
   *   3. PDA-signs an SPL `Approve` granting `swapDelegate` exactly
   *      `flow.amount - fee` over `onycAta`,
   *   4. invokes the swap program under `invoke_signed` (relayer authority
   *      signs Jupiter's `userTransferAuthority` slot),
   *   5. asserts post-balances clear the floor, exactly consume the
   *      delegated amount, and that both relayer ATAs are left pristine
   *      (owner/delegate/close untouched — defeats PDA-signer hijack),
   *   6. transitions the flow `Claimed → Swapped` and writes the USDC
   *      received into `flow.amount` for `send_usdc_to_user` to consume.
   *
   * `feeVault` is the ONyc token account configured at `initialize` /
   * `configure` time (pinned via `has_one` on `relayer_config`) and
   * receives the fee transfer directly.
   *
   * `onreOffer`, `swapProgram`, `swapDelegate` semantics: `onreOffer` is
   * OnRe's deposit-side Offer PDA (its `token_in_mint == usdc_mint` and
   * `token_out_mint == onyc_mint` are re-validated on-chain).
   * `swapDelegate` is the SPL delegate the swap program spends from
   * `onyc_ata`. For Jupiter `shared_accounts_route` this is the
   * program-authority PDA (account index 1 of the route); other routers
   * differ. The SPL Approve auto-clears when `net_onyc` is consumed.
   */
  swapOnycToUsdc(params: {
    onycMint: PublicKey
    usdcMint: PublicKey
    nttInboxItem: PublicKey
    feeVault: PublicKey
    onreOffer: PublicKey
    swapProgram: PublicKey
    swapDelegate: PublicKey
    swapIxData: Uint8Array
    swapAccounts: AccountMeta[]
  }) {
    const { outflightFlow } = this.flowPdas(params.nttInboxItem)
    return this.program.methods
      .swapOnycToUsdc(Buffer.from(params.swapIxData))
      .accountsPartial({
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        onycMint: params.onycMint,
        usdcMint: params.usdcMint,
        onycAta: this.relayerAta(params.onycMint),
        usdcAta: this.relayerAta(params.usdcMint),
        feeVault: params.feeVault,
        nttInboxItem: params.nttInboxItem,
        outflightFlow,
        onreOffer: params.onreOffer,
        swapProgram: params.swapProgram,
        swapDelegate: params.swapDelegate,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(params.swapAccounts)
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
   * Derive the two flow-tracking PDAs keyed off a single `nttInboxItem`.
   *
   * Every flow-driving instruction (claim/swap/lock/unlock/send) needs
   * some subset of `{inflightFlow, outflightFlow}`. Centralising the
   * derivation here keeps method bodies focused on which accounts an
   * instruction actually consumes — callers destructure only what they
   * need.
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
  } {
    const [inflightFlow] = findInflightFlowPda(nttInboxItem, this.program.programId)
    const [outflightFlow] = findOutflightFlowPda(nttInboxItem, this.program.programId)
    return { inflightFlow, outflightFlow }
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
