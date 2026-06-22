import type { Provider } from '@anchor-lang/core'
import type { AccountMeta, PublicKey } from '@solana/web3.js'
import type { NttRedeemContext } from './builders'
import type { FogoNttRelayer } from './types/fogo_ntt_relayer'
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
  NTT_TRANSFER_LOCK_ACCOUNT_COUNT,
} from './builders'
import {
  FOGO_WORMHOLE_CHAIN_ID,
  INTENT_TRANSFER_PROGRAM_ID,
  NTT_ONYC_PROGRAM_ID,
  NTT_USDC_PROGRAM_ID,
  ONRE_INTENT_PROGRAM_ID,
} from './constants'
import IDL from './idl/fogo_ntt_relayer.json' with { type: 'json' }
import {
  findAuthorityPda,
  findConfigPda,
  findGlobalConfigPda,
  findInflightFlowPda,
  findOutflightFlowPda,
  findUserInboxWithMinPda,
} from './pda'

/** Coerce a BN | bigint amount into a bigint without losing precision. */
function toBigInt(value: BN | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value.toString())
}

/** Anchor enum shape for the flow direction: exactly one variant key present. */
export type FlowDirection = { deposit: Record<string, never> } | { withdraw: Record<string, never> }

export class RelayerClient {
  readonly program: Program<FogoNttRelayer>
  readonly baseMint: PublicKey
  readonly assetMint: PublicKey
  readonly configPda: PublicKey
  readonly globalConfigPda: PublicKey
  readonly authorityPda: PublicKey

  /**
   * Bound to a single token pair. `configPda` is the pair-seeded
   * `[CONFIG_SEED, base, asset]` PDA; `authorityPda` is the global
   * `[RELAYER_SEED]` custody signer (shared across pairs).
   */
  constructor(provider: Provider, pair: { baseMint: PublicKey, assetMint: PublicKey }) {
    this.program = new Program<FogoNttRelayer>(IDL as unknown as FogoNttRelayer, provider)
    this.baseMint = pair.baseMint
    this.assetMint = pair.assetMint
    ;[this.configPda] = findConfigPda(pair.baseMint, pair.assetMint, this.program.programId)
    ;[this.globalConfigPda] = findGlobalConfigPda(this.program.programId)
    ;[this.authorityPda] = findAuthorityPda(this.program.programId)
  }

  /**
   * Create the global config singleton. `admin` (defaults to the provider
   * wallet) becomes the only key allowed to call `initialize`. Run once.
   */
  bootstrap(params: { admin?: PublicKey } = {}) {
    const admin = params.admin ?? this.providerPublicKey()
    if (!admin) {
      throw new Error('bootstrap: no admin provided and provider has no wallet')
    }
    return this.program.methods
      .bootstrap()
      .accountsPartial({
        admin,
        globalConfig: this.globalConfigPda,
        systemProgram: SystemProgram.programId,
      })
  }

  /**
   * Create a pair's config PDA + relayer-authority-owned ATAs. Admin-gated:
   * `authority` must equal the global config admin. `feeVault` must hold the
   * asset mint and must not alias the relayer asset ATA.
   */
  initialize(params: {
    authority: PublicKey
    baseMint?: PublicKey
    assetMint?: PublicKey
    feeVault: PublicKey
    depositFeeBps: number
    withdrawFeeBps: number
    /** Init-only NTT manager pins for the base and asset tokens. */
    nttBaseProgram?: PublicKey
    nttAssetProgram?: PublicKey
    /** Init-only inbound VAA originators for this pair. */
    intentPrograms?: [PublicKey, PublicKey]
  }) {
    const baseMint = params.baseMint ?? this.baseMint
    const assetMint = params.assetMint ?? this.assetMint
    // Derive the config PDA from the mints actually used — an override pair
    // (e.g. an admin client initializing several pairs) must not pin the
    // constructor's `this.configPda`, which would mismatch the on-chain seeds.
    const [configPda] = findConfigPda(baseMint, assetMint, this.program.programId)
    return this.program.methods
      .initialize(
        params.depositFeeBps,
        params.withdrawFeeBps,
        params.nttBaseProgram ?? NTT_USDC_PROGRAM_ID,
        params.nttAssetProgram ?? NTT_ONYC_PROGRAM_ID,
        params.intentPrograms ?? [INTENT_TRANSFER_PROGRAM_ID, ONRE_INTENT_PROGRAM_ID],
      )
      .accountsPartial({
        authority: params.authority,
        globalConfig: this.globalConfigPda,
        pairConfig: configPda,
        relayerAuthority: this.authorityPda,
        baseMint,
        assetMint,
        baseAta: this.relayerAta(baseMint),
        assetAta: this.relayerAta(assetMint),
        feeVault: params.feeVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
  }

  /** Update admin-mutable config. All fields optional. Authority-only. */
  configure(params: {
    authority?: PublicKey
    feeVault?: PublicKey | null
    depositFeeBps?: number | null
    withdrawFeeBps?: number | null
    newAuthority?: PublicKey | null
  } = {}) {
    const authority = params.authority ?? this.providerPublicKey()
    if (!authority) {
      throw new Error('configure: no authority provided and provider has no wallet')
    }

    return this.program.methods
      .configure(
        params.depositFeeBps ?? null,
        params.withdrawFeeBps ?? null,
        params.newAuthority ?? null,
      )
      .accountsPartial({
        authority,
        pairConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        assetMint: this.assetMint,
        assetAta: this.relayerAta(this.assetMint),
        feeVault: params.feeVault ?? null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
  }

  acceptAuthority(params: {
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
        pairConfig: this.configPda,
      })
  }

  /**
   * Propose a new global admin (step 1 of two-step rotation). `admin`
   * (defaults to the provider wallet) must equal the current global admin.
   */
  setAdmin(params: { newAdmin: PublicKey, admin?: PublicKey }) {
    const admin = params.admin ?? this.providerPublicKey()
    if (!admin) {
      throw new Error('setAdmin: no admin provided and provider has no wallet')
    }
    return this.program.methods
      .setAdmin(params.newAdmin)
      .accountsPartial({
        admin,
        globalConfig: this.globalConfigPda,
      })
  }

  /**
   * Claim the global admin role (step 2). `pendingAdmin` (defaults to the
   * provider wallet) must equal the staged `pending_admin`.
   */
  acceptAdmin(params: { pendingAdmin?: PublicKey } = {}) {
    const pendingAdmin = params.pendingAdmin ?? this.providerPublicKey()
    if (!pendingAdmin) {
      throw new Error('acceptAdmin: no pendingAdmin provided and provider has no wallet')
    }
    return this.program.methods
      .acceptAdmin()
      .accountsPartial({
        pendingAdmin,
        globalConfig: this.globalConfigPda,
      })
  }

  /**
   * Bare outbound-send builder: named accounts only, no auto-assembled
   * `remainingAccounts` (for negative tests that supply their own list).
   * Production uses `send`, which appends the transfer_lock + release accounts.
   */
  sendBase(params: {
    payer: PublicKey
    direction: FlowDirection
    baseMint: PublicKey
    assetMint: PublicKey
    nttInboxItem: PublicKey
    rentDestination: PublicKey
  }) {
    const isDeposit = 'deposit' in params.direction
    const { inflightFlow, outflightFlow } = this.flowPdas(params.nttInboxItem)
    const flow = isDeposit ? inflightFlow : outflightFlow

    return this.program.methods
      .send(NTT_TRANSFER_LOCK_ACCOUNT_COUNT)
      .accountsPartial({
        payer: params.payer,
        pairConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        baseMint: params.baseMint,
        assetMint: params.assetMint,
        baseAta: this.relayerAta(params.baseMint),
        assetAta: this.relayerAta(params.assetMint),
        nttInboxItem: params.nttInboxItem,
        flow,
        rentDestination: params.rentDestination,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
  }

  /**
   * Route-agnostic outbound send (deposit pushes asset, withdraw pushes base);
   * each leg CPIs `transfer_lock` + `release_wormhole_outbound` atomically. All
   * flow + release fields are required — there is no lock-only path.
   */
  send(params: {
    payer: PublicKey
    direction: FlowDirection
    baseMint: PublicKey
    assetMint: PublicKey
    nttInboxItem: PublicKey
    rentDestination: PublicKey
    flowAmount: BN | bigint
    flowRecipient: Uint8Array
    outboxItem: PublicKey
    /** Pair NTT managers (from `PairConfig`); default to the OnRe USDC/ONyc managers. */
    nttBaseProgram?: PublicKey
    nttAssetProgram?: PublicKey
    /** NTT v3 release-publish accounts. */
    release: {
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
    const isDeposit = 'deposit' in params.direction
    // send pushes out: deposit→asset manager, withdraw→base manager.
    const baseManager = params.nttBaseProgram ?? NTT_USDC_PROGRAM_ID
    const assetManager = params.nttAssetProgram ?? NTT_ONYC_PROGRAM_ID
    const nttProgramId = isDeposit ? assetManager : baseManager
    const outboundMint = isDeposit ? params.assetMint : params.baseMint

    const builder = this.sendBase(params)

    const transferLock = this.transferLockAccounts({
      mint: outboundMint,
      nttProgramId,
      outboxItem: params.outboxItem,
      recipientAddress: params.flowRecipient,
      amount: toBigInt(params.flowAmount),
    })

    const releaseAccts = buildNttReleaseWormholeOutboundAccountList({
      payer: params.payer,
      nttProgramId,
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
   * Permissionless timeout refund. Returns the original received token to
   * `flowRecipient` via NTT, then closes the stale `Received` flow.
   */
  refund(params: {
    payer: PublicKey
    direction: FlowDirection
    baseMint: PublicKey
    assetMint: PublicKey
    nttInboxItem: PublicKey
    rentDestination: PublicKey
    flowAmount: BN | bigint
    flowRecipient: Uint8Array
    outboxItem: PublicKey
    /** Pair NTT managers (from `PairConfig`); default to the OnRe USDC/ONyc managers. */
    nttBaseProgram?: PublicKey
    nttAssetProgram?: PublicKey
    /** NTT v3 release-publish accounts. */
    release: {
      wormholeProgram: PublicKey
      wormholeBridge: PublicKey
      wormholeFeeCollector: PublicKey
      wormholeSequence: PublicKey
      outboxItemSigner: PublicKey
      wormholeMessage?: PublicKey
      emitter?: PublicKey
    }
  }) {
    const isDeposit = 'deposit' in params.direction
    // Original received token: deposit→base manager, withdraw→asset manager.
    const baseManager = params.nttBaseProgram ?? NTT_USDC_PROGRAM_ID
    const assetManager = params.nttAssetProgram ?? NTT_ONYC_PROGRAM_ID
    const nttProgramId = isDeposit ? baseManager : assetManager
    const originalMint = isDeposit ? params.baseMint : params.assetMint

    const builder = this.refundBase(params)

    const transferLock = this.transferLockAccounts({
      mint: originalMint,
      nttProgramId,
      outboxItem: params.outboxItem,
      recipientAddress: params.flowRecipient,
      amount: toBigInt(params.flowAmount),
    })

    const releaseAccts = buildNttReleaseWormholeOutboundAccountList({
      payer: params.payer,
      nttProgramId,
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

  /** Named-accounts-only refund builder (no auto-assembled `remainingAccounts`). */
  refundBase(params: {
    payer: PublicKey
    direction: FlowDirection
    baseMint: PublicKey
    assetMint: PublicKey
    nttInboxItem: PublicKey
    rentDestination: PublicKey
  }) {
    const isDeposit = 'deposit' in params.direction
    const { inflightFlow, outflightFlow } = this.flowPdas(params.nttInboxItem)
    const flow = isDeposit ? inflightFlow : outflightFlow

    return this.program.methods
      .refund(NTT_TRANSFER_LOCK_ACCOUNT_COUNT)
      .accountsPartial({
        payer: params.payer,
        pairConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        baseMint: params.baseMint,
        assetMint: params.assetMint,
        baseAta: this.relayerAta(params.baseMint),
        assetAta: this.relayerAta(params.assetMint),
        nttInboxItem: params.nttInboxItem,
        flow,
        rentDestination: params.rentDestination,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
  }

  /**
   * Permissionless swap for an in-flight flow. Routes on persisted
   * `Flow.direction` (no direction arg): deposit swaps base→asset, withdraw
   * swaps asset→base.
   */
  swap(params: {
    flowPda: PublicKey
    baseMint: PublicKey
    assetMint: PublicKey
    feeVault: PublicKey
    nttInboxItem: PublicKey
    swapProgram: PublicKey
    swapDelegate: PublicKey
    swapIxData: Uint8Array
    swapAccounts: AccountMeta[]
  }) {
    return this.program.methods
      .swap(Buffer.from(params.swapIxData))
      .accountsPartial({
        pairConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        baseMint: params.baseMint,
        assetMint: params.assetMint,
        baseAta: this.relayerAta(params.baseMint),
        assetAta: this.relayerAta(params.assetMint),
        feeVault: params.feeVault,
        nttInboxItem: params.nttInboxItem,
        flow: params.flowPda,
        swapProgram: params.swapProgram,
        swapDelegate: params.swapDelegate,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(params.swapAccounts)
  }

  /**
   * Permissionless inbound NTT receive. Routes on `direction` to select the
   * NTT manager and flow seed.
   * Sweeps the recorded amount from the per-user inbox ATA into custody and
   * creates the Flow receipt.
   */
  receive(params: {
    payer: PublicKey
    direction: FlowDirection
    userWallet: PublicKey
    recvMint: PublicKey
    /** User-signed swap floor (output-token atomic units); committed in the inbox PDA. */
    minSwapOut: BN | bigint
    nttInboxItem: PublicKey
    nttTransceiverMessage: PublicKey
    ntt?: NttRedeemContext
    redeemAccountsLen?: number
    /** Pair NTT managers (from `PairConfig`); default to the OnRe USDC/ONyc managers. */
    nttBaseProgram?: PublicKey
    nttAssetProgram?: PublicKey
  }) {
    const isDeposit = 'deposit' in params.direction
    // receive pulls in the received token: deposit→base manager, withdraw→asset manager.
    const baseManager = params.nttBaseProgram ?? NTT_USDC_PROGRAM_ID
    const assetManager = params.nttAssetProgram ?? NTT_ONYC_PROGRAM_ID
    const nttProgramId = isDeposit ? baseManager : assetManager
    const minSwapOut = toBigInt(params.minSwapOut)
    const [flow] = isDeposit
      ? findInflightFlowPda(this.configPda, params.nttInboxItem, this.program.programId)
      : findOutflightFlowPda(this.configPda, params.nttInboxItem, this.program.programId)
    const { userInboxAuthority, userInboxAta } = this.userInboxBindings(
      params.userWallet,
      minSwapOut,
      params.recvMint,
    )
    const built = params.ntt
      ? buildNttRedeemReleaseAccounts({
          mint: params.recvMint,
          nttInboxItem: params.nttInboxItem,
          nttTransceiverMessage: params.nttTransceiverMessage,
          ntt: params.ntt,
          programId: nttProgramId,
          authority: this.authorityPda,
          // Release lands in the per-user inbox ATA, not relayer custody;
          // the handler sweeps the recorded amount into custody after release.
          recipientAta: userInboxAta,
        })
      : null

    const builder = this.program.methods
      .receive(
        params.direction,
        built ? built.redeemAccountsLen : (params.redeemAccountsLen ?? 0),
        new BN(minSwapOut.toString()),
      )
      .accountsPartial({
        payer: params.payer,
        pairConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        recvMint: params.recvMint,
        recvAta: this.relayerAta(params.recvMint),
        userWallet: params.userWallet,
        userInboxAuthority,
        userInboxAta,
        nttInboxItem: params.nttInboxItem,
        nttTransceiverMessage: params.nttTransceiverMessage,
        nttProgram: nttProgramId,
        flow,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })

    return built ? builder.remainingAccounts(built.remainingAccounts) : builder
  }

  async fetchConfig() {
    return this.program.account.pairConfig.fetch(this.configPda)
  }

  /** Decode a `Flow` account at any PDA (inflight or outflight). */
  async fetchFlow(pda: PublicKey) {
    return this.program.account.flow.fetch(pda)
  }

  async fetchInflightFlow(nttInboxItem: PublicKey) {
    const [pda] = findInflightFlowPda(this.configPda, nttInboxItem, this.program.programId)
    return this.program.account.flow.fetch(pda)
  }

  async fetchOutflightFlow(nttInboxItem: PublicKey) {
    const [pda] = findOutflightFlowPda(this.configPda, nttInboxItem, this.program.programId)
    return this.program.account.flow.fetch(pda)
  }

  private relayerAta(mint: PublicKey) {
    return getAssociatedTokenAddressSync(mint, this.authorityPda, true)
  }

  /** Shape the 14-account NTT `transfer_lock` list; both send legs differ only in `mint` + NTT program id. */
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
    const [inflightFlow] = findInflightFlowPda(this.configPda, nttInboxItem, this.program.programId)
    const [outflightFlow] = findOutflightFlowPda(this.configPda, nttInboxItem, this.program.programId)
    return { inflightFlow, outflightFlow }
  }

  /** Min-bearing inbox-authority PDA + the ATA it owns for `mint`. */
  private userInboxBindings(
    userWallet: PublicKey,
    minSwapOut: bigint,
    mint: PublicKey,
  ): {
    userInboxAuthority: PublicKey
    userInboxAta: PublicKey
  } {
    const [userInboxAuthority] = findUserInboxWithMinPda(
      userWallet,
      minSwapOut,
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
