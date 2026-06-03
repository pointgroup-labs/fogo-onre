import type { Provider } from '@anchor-lang/core'
import type { AccountMeta, PublicKey } from '@solana/web3.js'
import type { NttRedeemContext } from './builders'
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
  NTT_TRANSFER_LOCK_ACCOUNT_COUNT,
} from './builders'
import { FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID, NTT_USDC_PROGRAM_ID } from './constants'
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
    baseMint: PublicKey
    assetMint: PublicKey
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
        baseMint: params.baseMint,
        assetMint: params.assetMint,
        baseAta: this.relayerAta(params.baseMint),
        assetAta: this.relayerAta(params.assetMint),
        feeVault: params.feeVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
  }

  /** Update admin-mutable config. All fields optional. Authority-only. */
  async configure(params: {
    authority?: PublicKey
    assetMint?: PublicKey
    feeVault?: PublicKey | null
    depositFeeBps?: number | null
    withdrawFeeBps?: number | null
    newAuthority?: PublicKey | null
    maxSlippageBps?: number | null
    priceOracle?: PublicKey | null
  } = {}) {
    const authority = params.authority ?? this.providerPublicKey()
    if (!authority) {
      throw new Error('configure: no authority provided and provider has no wallet')
    }

    const assetMint = params.assetMint ?? ((await this.fetchConfig()).assetMint as PublicKey)

    return this.program.methods
      .configure(
        params.depositFeeBps ?? null,
        params.withdrawFeeBps ?? null,
        params.newAuthority ?? null,
        params.maxSlippageBps ?? null,
        params.priceOracle ?? null,
      )
      .accountsPartial({
        authority,
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        assetMint,
        assetAta: this.relayerAta(assetMint),
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
   * Route-agnostic outbound send (deposit pushes ONyc, withdraw pushes
   * USDC); each leg CPIs `transfer_lock` + `release_wormhole_outbound`
   * atomically.
   *
   * Negative-test callers (deliberately broken `remainingAccounts`) MUST
   * omit `flowAmount` / `flowRecipient` / `outboxItem` to get the bare
   * builder back.
   */
  send(params: {
    payer: PublicKey
    direction: { deposit: Record<string, never> } | { withdraw: Record<string, never> }
    baseMint: PublicKey
    assetMint: PublicKey
    nttInboxItem: PublicKey
    rentDestination: PublicKey
    flowAmount?: BN | bigint
    flowRecipient?: Uint8Array
    outboxItem?: PublicKey
    /**
     * NTT v3 release-publish accounts. REQUIRED whenever `flowAmount` /
     * `flowRecipient` / `outboxItem` are all supplied — there is no
     * "lock-only" code path.
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
    const isDeposit = 'deposit' in params.direction
    const nttProgramId = isDeposit ? NTT_ONYC_PROGRAM_ID : NTT_USDC_PROGRAM_ID
    const outboundMint = isDeposit ? params.assetMint : params.baseMint
    const { inflightFlow, outflightFlow } = this.flowPdas(params.nttInboxItem)
    const flow = isDeposit ? inflightFlow : outflightFlow

    const builder = this.program.methods
      .send(NTT_TRANSFER_LOCK_ACCOUNT_COUNT)
      .accountsPartial({
        payer: params.payer,
        relayerConfig: this.configPda,
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

    if (!params.flowAmount || !params.flowRecipient || !params.outboxItem) {
      return builder
    }

    if (!params.release) {
      throw new Error(
        'send: `release` is required whenever flowAmount/flowRecipient/outboxItem '
        + 'are supplied. The on-chain handler now CPIs into NTT release_wormhole_outbound '
        + 'in the same ix as transfer_lock — there is no lock-only path.',
      )
    }

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
    onreOffer: PublicKey
    swapProgram: PublicKey
    swapDelegate: PublicKey
    swapIxData: Uint8Array
    swapAccounts: AccountMeta[]
  }) {
    return this.program.methods
      .swap(Buffer.from(params.swapIxData))
      .accountsPartial({
        relayerConfig: this.configPda,
        relayerAuthority: this.authorityPda,
        baseMint: params.baseMint,
        assetMint: params.assetMint,
        baseAta: this.relayerAta(params.baseMint),
        assetAta: this.relayerAta(params.assetMint),
        feeVault: params.feeVault,
        nttInboxItem: params.nttInboxItem,
        flow: params.flowPda,
        onreOffer: params.onreOffer,
        swapProgram: params.swapProgram,
        swapDelegate: params.swapDelegate,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(params.swapAccounts)
  }

  /**
   * Permissionless inbound NTT receive. Routes on `direction` (deposit:
   * USDC manager + inflight flow; withdraw: ONyc manager + outflight flow).
   * Sweeps the recorded amount from the per-user inbox ATA into custody and
   * creates the Flow receipt.
   */
  receive(params: {
    payer: PublicKey
    direction: { deposit: Record<string, never> } | { withdraw: Record<string, never> }
    userWallet: PublicKey
    recvMint: PublicKey
    nttInboxItem: PublicKey
    nttTransceiverMessage: PublicKey
    ntt?: NttRedeemContext
    redeemAccountsLen?: number
  }) {
    const isDeposit = 'deposit' in params.direction
    const nttProgramId = isDeposit ? NTT_USDC_PROGRAM_ID : NTT_ONYC_PROGRAM_ID
    const [flow] = isDeposit
      ? findInflightFlowPda(params.nttInboxItem, this.program.programId)
      : findOutflightFlowPda(params.nttInboxItem, this.program.programId)
    const { userInboxAuthority, userInboxAta } = this.userInboxBindings(
      params.userWallet,
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
      .receive(params.direction, built ? built.redeemAccountsLen : (params.redeemAccountsLen ?? 0))
      .accountsPartial({
        payer: params.payer,
        relayerConfig: this.configPda,
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
    return this.program.account.relayerConfig.fetch(this.configPda)
  }

  /** Decode a `Flow` account at any PDA (inflight or outflight). */
  async fetchFlow(pda: PublicKey) {
    return this.program.account.flow.fetch(pda)
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
    const [inflightFlow] = findInflightFlowPda(nttInboxItem, this.program.programId)
    const [outflightFlow] = findOutflightFlowPda(nttInboxItem, this.program.programId)
    return { inflightFlow, outflightFlow }
  }

  /** Per-user inbox-authority PDA + the ATA it owns for `mint`. */
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
