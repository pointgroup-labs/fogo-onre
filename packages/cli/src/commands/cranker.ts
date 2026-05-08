/**
 * Manual cranker commands. Deposit-leg scope (steps 1-3):
 *
 *   - `cranker status   --fogo-tx <SIG>`    — read on-chain Flow PDA, tell
 *                                              operator which step is next.
 *   - `cranker claim-usdc       --fogo-tx <SIG>` — step 1: NTT redeem +
 *                                                 per-user inbox sweep.
 *                                                 Writes inflight Flow.
 *   - `cranker swap-usdc-to-onyc --fogo-tx <SIG>` — step 2: OnRe `take_offer`
 *                                                  CPI swaps USDC → ONyc into
 *                                                  the relayer's ONyc ATA.
 *                                                  Advances Flow to Swapped.
 *   - `cranker lock-onyc        --fogo-tx <SIG>` — step 3: NTT `transfer_lock`
 *                                                 ONyc back to FOGO as ONyc,
 *                                                 closes the inflight Flow.
 *
 * Withdraw-leg commands (`unlock-onyc`, `request-redemption`,
 * `claim-redemption`, `send-usdc-to-user`) are still deferred — they
 * mirror the deposit pattern but on the ONyc-redeem side and only
 * matter once a user actually withdraws.
 *
 * `--fogo-tx <SIG>` is the universal handle: every command resolves it to
 * the same VAA (and therefore the same `nttInboxItem`), so the operator
 * uses one signature across all three deposit steps. `--vaa <HEX>` is
 * the deterministic fallback for the first command (claim-usdc) when
 * Wormholescan is degraded; later steps don't need it because they
 * key on the on-chain Flow PDA, not the VAA bytes.
 *
 * Pre-flight philosophy mirrors `relayer initialize` / `configure`:
 * dry-run by default, `--confirm` to broadcast, every plan-line keyed on
 * an explicit pubkey/value the operator can cross-check before signing.
 * Each step also gates on the prior Flow status, so re-running a
 * landed step is a hard error rather than wasted gas.
 */

import type { FlowAccount } from '@fogo-onre/sdk'
import type { TransactionInstruction } from '@solana/web3.js'
import { AnchorProvider, Wallet } from '@anchor-lang/core'
import { describeStatus, findAuthorityPda, findInboxRateLimitPda, findInflightFlowPda, findNttPeerPda, findSessionAuthorityPda, findUserInboxAuthorityPda, FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID, NTT_USDC_PROGRAM_ID, nttTransferArgsHash, ONYC_MINT, resolveNttVaa, USDC_MINT, WormholescanClient } from '@fogo-onre/sdk'
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js'
import { deserialize } from '@wormhole-foundation/sdk-definitions'
// Auto-registration on import is deprecated in sdk 4.x; call `register()`
// explicitly so `deserialize('Ntt:WormholeTransfer', bytes)` resolves.
import { register as registerNttPayloads } from '@wormhole-foundation/sdk-definitions-ntt'
import { SolanaNtt } from '@wormhole-foundation/sdk-solana-ntt'
import chalk from 'chalk'
import { Command } from 'commander'
import { runTx, useContext } from '../context'

registerNttPayloads()

// Wormhole Core Bridge program ID (Solana mainnet). Stable on-chain
// identifier; testnet/devnet would need a different value but this CLI
// is mainnet-targeted by default (see context.ts:resolveRpcUrl).
const WORMHOLE_CORE_MAINNET = 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'

// Default NTT IDL version for SolanaNtt. The on-chain ONyc NTT manager
// version determines whether `release_wormhole_outbound` needs the
// extra `manager` + `outboxItemSigner` accounts (v3+) or not (v2).
// Override with `--ntt-version` if a future deploy bumps the manager.
const DEFAULT_NTT_VERSION = '3.0.0'

const DEFAULT_WORMHOLESCAN_URL = 'https://api.wormholescan.io'

// FOGO-side constants for the cross-chain redeem step. The ONyc NTT
// manager and mint are mirrored from the webapp (`packages/webapp/src/constants.ts`).
// FOGO mainnet Wormhole core program id is published in
// `@wormhole-foundation/sdk-base` (constants/contracts/core.js).
const FOGO_ONYC_NTT_MANAGER_ID = 'nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd'
const FOGO_ONYC_MINT = 'oNyCm1QsAatj3ckaEwZjtAPWvstPn3Zm5MAYPtkjEfa'
const FOGO_WORMHOLE_CORE_MAINNET = 'worm2mrQkG1B1KTz37erMfWN8anHkSK24nzca7UD8BB'
// First-party Fogo Labs RPC, matching the webapp default in
// `packages/webapp/src/store/settings.ts`.
const FOGO_RPC_DEFAULT = 'https://mainnet.fogo.io'

export function crankerCommands(): Command {
  const cranker = new Command('cranker').description(
    'Permissionless flow-driving instructions. Anyone can run these — '
    + 'they just move funds along the relayer\'s state machine.',
  )

  cranker
    .command('status')
    .description('Read on-chain Flow state for a FOGO bridge tx; print the next crank step')
    .requiredOption('--fogo-tx <signature>', 'FOGO tx signature that emitted the bridge VAA')
    .option('--vaa <hex>', 'Override Wormholescan lookup with raw signed VAA bytes (hex)')
    .option('--ntt-program <pubkey>', `NTT manager program id (default USDC.s: ${NTT_USDC_PROGRAM_ID.toBase58()})`)
    .option('--wormholescan-url <url>', `Wormholescan REST base URL [default: ${DEFAULT_WORMHOLESCAN_URL}]`)
    .action(async (opts: {
      fogoTx: string
      vaa?: string
      nttProgram?: string
      wormholescanUrl?: string
    }) => {
      const { client } = useContext()
      const nttProgram = opts.nttProgram ? new PublicKey(opts.nttProgram) : NTT_USDC_PROGRAM_ID
      const vaaBytes = await fetchVaaBytes({
        fogoTx: opts.fogoTx,
        vaaHex: opts.vaa,
        wormholescanUrl: opts.wormholescanUrl,
      })
      const resolved = resolveNttVaa({ vaaBytes, nttProgramId: nttProgram })

      console.log(chalk.cyan('VAA'))
      console.log(chalk.dim(`  emitterChain:           ${resolved.fromChain}`))
      console.log(chalk.dim(`  sequence:               ${resolved.vaa.sequence}`))
      console.log(chalk.dim(`  sender (source chain):  ${resolved.senderOnSource.toBase58()}`))
      console.log(chalk.dim(`  recipient (Solana):     ${resolved.recipientOnSolana.toBase58()}`))
      console.log(chalk.dim(`  trimmedAmount:          ${resolved.manager.trimmedAmount} (decimals=${resolved.manager.trimmedDecimals})`))
      console.log(chalk.dim(`  nttInboxItem:           ${resolved.nttInboxItem.toBase58()}`))
      console.log(chalk.dim(`  nttTransceiverMessage:  ${resolved.nttTransceiverMessage.toBase58()}`))

      const inflight = await client.fetchInflightFlow(resolved.nttInboxItem).catch(() => null)
      const outflight = await client.fetchOutflightFlow(resolved.nttInboxItem).catch(() => null)

      console.log(chalk.cyan('\nFlow state'))
      if (!inflight && !outflight) {
        console.log(chalk.yellow('  no Flow PDA exists yet'))
        console.log(chalk.green('\nNext step:  cranker claim-usdc --fogo-tx <SIG>  (deposit leg)'))
        console.log(chalk.dim('             cranker unlock-onyc --fogo-tx <SIG> (withdraw leg, once implemented)'))
        return
      }
      if (inflight) {
        printFlow('inflight (deposit chain)', inflight)
        const next = nextDepositStep(inflight.status, opts.fogoTx)
        console.log(chalk.green(`\nNext step:  ${next}`))
      }
      if (outflight) {
        printFlow('outflight (withdraw chain)', outflight)
        const next = nextWithdrawStep(outflight.status, opts.fogoTx)
        console.log(chalk.green(`\nNext step:  ${next}`))
      }
    })

  cranker
    .command('claim-usdc')
    .description('Claim a bridged USDC.s VAA into the per-user inbox ATA (deposit leg, step 1)')
    .requiredOption('--fogo-tx <signature>', 'FOGO tx signature that emitted the bridge VAA')
    .option('--vaa <hex>', 'Override Wormholescan lookup with raw signed VAA bytes (hex)')
    .option('--user-wallet <pubkey>', 'Override wallet attribution (default: VAA sender field)')
    .option('--usdc-mint <pubkey>', `USDC mint on Solana (default: ${USDC_MINT.toBase58()})`)
    .option('--ntt-program <pubkey>', `NTT USDC.s manager program id (default: ${NTT_USDC_PROGRAM_ID.toBase58()})`)
    .option('--wormholescan-url <url>', `Wormholescan REST base URL [default: ${DEFAULT_WORMHOLESCAN_URL}]`)
    .option('--confirm', 'Actually broadcast the transaction (default: dry-run)')
    .action(async (opts: {
      fogoTx: string
      vaa?: string
      userWallet?: string
      usdcMint?: string
      nttProgram?: string
      wormholescanUrl?: string
      confirm?: boolean
    }) => {
      const { connection, keypair, client } = useContext()
      const usdcMint = opts.usdcMint ? new PublicKey(opts.usdcMint) : USDC_MINT
      const nttProgram = opts.nttProgram ? new PublicKey(opts.nttProgram) : NTT_USDC_PROGRAM_ID

      const vaaBytes = await fetchVaaBytes({
        fogoTx: opts.fogoTx,
        vaaHex: opts.vaa,
        wormholescanUrl: opts.wormholescanUrl,
      })
      const resolved = resolveNttVaa({ vaaBytes, nttProgramId: nttProgram })

      // The VAA's NTT-message `sender` field is the source-chain
      // originator. For a non-Session FOGO wallet that's also the
      // wallet seed for the per-user inbox PDA. For a Fogo *Session*
      // deposit, the `sender` is the **session keypair** (whatever
      // signed the bridge ix), NOT the user's main wallet — and the
      // per-user inbox PDA is seeded on the main wallet (see
      // `useFogoNttTransfer.ts:269` deriving from
      // `sessionState.walletPublicKey`).
      //
      // Auto-detection strategy when `--user-wallet` is unset: probe
      // [signer.publicKey, senderOnSource] and pick whichever derives
      // the inbox-authority PDA matching the VAA's recipient. The
      // signer is checked first because the common operator pattern is
      // "I deposited from this same wallet, and now I'm cranking my
      // own deposit." The VAA-sender fallback covers the
      // non-Session direct-deposit case. If both miss, the
      // mismatch pre-flight (Pre-flight 4 below) bails with a
      // diagnostic naming the recipient PDA the operator must derive
      // from elsewhere.
      function deriveInboxAuthority(wallet: PublicKey): PublicKey {
        const [pda] = findUserInboxAuthorityPda(wallet, client.program.programId)
        return pda
      }
      let userWallet: PublicKey
      let userWalletSource: 'flag' | 'signer-auto' | 'sender-auto' | 'sender-fallback'
      if (opts.userWallet) {
        userWallet = new PublicKey(opts.userWallet)
        userWalletSource = 'flag'
      } else if (deriveInboxAuthority(keypair.publicKey).equals(resolved.recipientOnSolana)) {
        userWallet = keypair.publicKey
        userWalletSource = 'signer-auto'
      } else if (deriveInboxAuthority(resolved.senderOnSource).equals(resolved.recipientOnSolana)) {
        userWallet = resolved.senderOnSource
        userWalletSource = 'sender-auto'
      } else {
        // Neither candidate matches — fall through to senderOnSource so
        // Pre-flight 4 can throw with the standard mismatch diagnostic.
        userWallet = resolved.senderOnSource
        userWalletSource = 'sender-fallback'
      }
      const defaultedUserWallet = userWalletSource !== 'flag'

      // Pre-flight 1: RelayerConfig must exist (otherwise `claim_usdc`'s
      // `has_one` validation panics with a confusing Anchor error).
      const cfg = await connection.getAccountInfo(client.configPda).catch(() => null)
      if (!cfg) {
        throw new Error(`RelayerConfig not found at ${client.configPda.toBase58()} — relayer not initialized on this RPC`)
      }

      // Pre-flight 2: refuse to crank if a Flow PDA already exists.
      // claim_usdc would silently fail with `init_if_needed`-on-existing,
      // and re-attempting wastes the operator's gas — better to bail
      // with a clear "already cranked" message.
      const existing = await client.fetchInflightFlow(resolved.nttInboxItem).catch(() => null)
      if (existing) {
        throw new Error(
          `Inflight Flow already exists for inbox-item ${resolved.nttInboxItem.toBase58()} — `
          + `claim_usdc has already run (status=${describeStatus(existing.status)}).`,
        )
      }

      // Pre-flight 3: the per-user inbox ATA must exist when
      // `claim_usdc` runs — the relayer's account constraint refuses
      // `init_if_needed`. The contract's design hands ATA creation to
      // the FOGO `bridge_ntt_tokens` arg `pay_destination_ata_rent: true`
      // (Wormhole executor pays rent on first delivery). When the
      // executor doesn't run — i.e. the operator is in this manual
      // crank path — we have to create it ourselves before the CPI.
      // Idempotent variant: no-ops if the ATA already exists, so we
      // unconditionally prepend it and skip the existence-probe RPC.
      // ATA creation is permissionless; the cranker fronts ~0.002 SOL
      // of rent that the executor would normally have paid (only on the
      // genuinely-new branch).
      const [userInboxAuthority] = findUserInboxAuthorityPda(
        userWallet,
        client.program.programId,
      )
      const userInboxAta = getAssociatedTokenAddressSync(
        usdcMint,
        userInboxAuthority,
        true, // PDA owner
      )

      // Pre-flight 4: the derived inbox-authority PDA must equal the
      // recipient pinned into the VAA's NTT inbox-item. If they
      // disagree, `claim_usdc.rs:271` will trip `UserInboxAuthorityMismatch`
      // mid-tx and burn the operator's gas. Catch it client-side with
      // a precise message that names the recovery action.
      if (!userInboxAuthority.equals(resolved.recipientOnSolana)) {
        const hint = defaultedUserWallet
          ? ` The CLI defaulted --user-wallet to the VAA sender (${resolved.senderOnSource.toBase58()}), which is correct for a non-Session deposit but wrong for a Fogo Sessions deposit (sender = session keypair, not the main wallet that seeds the inbox PDA).`
          : ''
        throw new Error(
          `derived inbox-authority PDA (${userInboxAuthority.toBase58()}) does not match the VAA's recorded recipient (${resolved.recipientOnSolana.toBase58()}).${hint} Re-run with --user-wallet=<main_fogo_wallet> matching the wallet that initiated the deposit on FOGO.`,
        )
      }
      const ensureUserInboxAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        keypair.publicKey,
        userInboxAta,
        userInboxAuthority,
        usdcMint,
      )

      console.log(chalk.cyan('claim-usdc plan'))
      console.log(chalk.dim(`  payer (signer):         ${keypair.publicKey.toBase58()}`))
      console.log(chalk.dim(`  userWallet:             ${userWallet.toBase58()}${userWalletSource === 'flag' ? '' : chalk.dim(` (auto: ${userWalletSource})`)}`))
      console.log(chalk.dim(`  usdcMint:               ${usdcMint.toBase58()}`))
      console.log(chalk.dim(`  nttProgram:             ${nttProgram.toBase58()}`))
      console.log(chalk.dim(`  userInboxAuthority:     ${userInboxAuthority.toBase58()}`))
      console.log(chalk.dim(`  userInboxAta:           ${userInboxAta.toBase58()} (ensure-idempotent)`))
      console.log(chalk.dim(`  nttInboxItem:           ${resolved.nttInboxItem.toBase58()}`))
      console.log(chalk.dim(`  nttTransceiverMessage:  ${resolved.nttTransceiverMessage.toBase58()}`))
      console.log(chalk.dim(`  trimmedAmount:          ${resolved.manager.trimmedAmount} (decimals=${resolved.manager.trimmedDecimals})`))

      if (!opts.confirm) {
        console.log()
        console.log(chalk.yellow('dry-run only. Re-run with --confirm to broadcast.'))
        return
      }

      console.log()
      const sig = await runTx(() =>
        client
          .claimUsdc({
            payer: keypair.publicKey,
            userWallet,
            usdcMint,
            nttInboxItem: resolved.nttInboxItem,
            nttTransceiverMessage: resolved.nttTransceiverMessage,
            // For OnRe's NTT deployment the registered transceiver IS the
            // NTT manager program itself — the transceiver is compiled
            // into the manager binary. See `tests/utils/withdraw-scaffolding.ts:212`
            // for the same wiring on the ONyc side.
            ntt: { transceiverAddress: nttProgram },
          })
          .preInstructions([ensureUserInboxAtaIx])
          .rpc(),
      )

      console.log(chalk.green('claim-usdc landed'))
      console.log(chalk.dim(`  tx: ${sig}`))
    })

  cranker
    .command('swap-usdc-to-onyc')
    .description('Swap claimed USDC into ONyc via OnRe (deposit leg, step 2)')
    .requiredOption('--fogo-tx <signature>', 'FOGO tx signature that emitted the bridge VAA')
    .option('--vaa <hex>', 'Override Wormholescan lookup with raw signed VAA bytes (hex)')
    .option('--usdc-mint <pubkey>', `USDC mint on Solana (default: ${USDC_MINT.toBase58()})`)
    .option('--onyc-mint <pubkey>', `ONyc mint (default from on-chain RelayerConfig, fallback ${ONYC_MINT.toBase58()})`)
    .option('--ntt-program <pubkey>', `NTT USDC.s manager program id (default: ${NTT_USDC_PROGRAM_ID.toBase58()})`)
    .option('--wormholescan-url <url>', `Wormholescan REST base URL [default: ${DEFAULT_WORMHOLESCAN_URL}]`)
    .option('--confirm', 'Actually broadcast the transaction (default: dry-run)')
    .action(async (opts: {
      fogoTx: string
      vaa?: string
      usdcMint?: string
      onycMint?: string
      nttProgram?: string
      wormholescanUrl?: string
      confirm?: boolean
    }) => {
      const { keypair, client } = useContext()
      const usdcMint = opts.usdcMint ? new PublicKey(opts.usdcMint) : USDC_MINT
      const nttProgram = opts.nttProgram ? new PublicKey(opts.nttProgram) : NTT_USDC_PROGRAM_ID
      const vaaBytes = await fetchVaaBytes({
        fogoTx: opts.fogoTx,
        vaaHex: opts.vaa,
        wormholescanUrl: opts.wormholescanUrl,
      })
      const resolved = resolveNttVaa({ vaaBytes, nttProgramId: nttProgram })

      // Pre-flight: Flow must exist with status=Claimed. Anything else
      // means the prior step hasn't run, or this step already did.
      const flow = await client.fetchInflightFlow(resolved.nttInboxItem).catch(() => null)
      if (!flow) {
        throw new Error(
          `No inflight Flow PDA for inbox-item ${resolved.nttInboxItem.toBase58()} — `
          + `run 'cranker claim-usdc' first.`,
        )
      }
      const flowStatus = describeStatus(flow.status)
      if (flowStatus !== 'Claimed') {
        throw new Error(
          `Flow status is ${flowStatus}, expected Claimed. swap-usdc-to-onyc has either already run or the chain is in an unexpected state.`,
        )
      }

      // ONyc mint and feeVault both come from on-chain RelayerConfig
      // unless explicitly overridden — single source of truth so we
      // can't drift from a `relayer configure` rotation.
      const cfg = await client.fetchConfig()
      const onycMint = opts.onycMint
        ? new PublicKey(opts.onycMint)
        : (cfg.onycMint as PublicKey)
      const feeVault = cfg.feeVault as PublicKey

      console.log(chalk.cyan('swap-usdc-to-onyc plan'))
      console.log(chalk.dim(`  payer (signer):         ${keypair.publicKey.toBase58()}`))
      console.log(chalk.dim(`  usdcMint:               ${usdcMint.toBase58()}`))
      console.log(chalk.dim(`  onycMint:               ${onycMint.toBase58()}`))
      console.log(chalk.dim(`  feeVault:               ${feeVault.toBase58()}`))
      console.log(chalk.dim(`  nttInboxItem:           ${resolved.nttInboxItem.toBase58()}`))
      console.log(chalk.dim(`  flow.amount:            ${flow.amount.toString()}`))
      console.log(chalk.dim(`  flow.status:            ${flowStatus}`))

      if (!opts.confirm) {
        console.log()
        console.log(chalk.yellow('dry-run only. Re-run with --confirm to broadcast.'))
        return
      }

      console.log()
      const sig = await runTx(() =>
        client
          .swapUsdcToOnyc({
            usdcMint,
            onycMint,
            nttInboxItem: resolved.nttInboxItem,
            feeVault,
            // Empty `onre` context defaults to ONRE_MAINNET_DEPLOYMENT;
            // the SDK derives the offer PDA from
            // `(usdcMint, onycMint, ONRE_PROGRAM_ID)` and assembles the
            // 22-entry remaining-accounts list automatically.
            onre: {},
          })
          .rpc(),
      )

      console.log(chalk.green('swap-usdc-to-onyc landed'))
      console.log(chalk.dim(`  tx: ${sig}`))
    })

  cranker
    .command('lock-onyc')
    .description('Lock ONyc via NTT, sending ONyc back to FOGO sender (deposit leg, step 3)')
    .requiredOption('--fogo-tx <signature>', 'FOGO tx signature that emitted the bridge VAA')
    .option('--vaa <hex>', 'Override Wormholescan lookup with raw signed VAA bytes (hex)')
    .option('--onyc-mint <pubkey>', `ONyc mint (default from on-chain RelayerConfig, fallback ${ONYC_MINT.toBase58()})`)
    .option('--ntt-program <pubkey>', `NTT USDC.s manager program id used to resolve VAA (default: ${NTT_USDC_PROGRAM_ID.toBase58()})`)
    .option('--rent-destination <pubkey>', 'Destination for closed Flow PDA rent (default: signer)')
    .option('--wormholescan-url <url>', `Wormholescan REST base URL [default: ${DEFAULT_WORMHOLESCAN_URL}]`)
    .option('--ntt-version <ver>', `NTT IDL version for the ONyc manager (release leg) [default: ${DEFAULT_NTT_VERSION}]`)
    .option('--wormhole-core <pubkey>', `Wormhole Core program id (release leg) [default: ${WORMHOLE_CORE_MAINNET}]`)
    .option('--confirm', 'Actually broadcast the transaction (default: dry-run)')
    .action(async (opts: {
      fogoTx: string
      vaa?: string
      onycMint?: string
      nttProgram?: string
      rentDestination?: string
      wormholescanUrl?: string
      nttVersion?: string
      wormholeCore?: string
      confirm?: boolean
    }) => {
      const { connection, keypair, client } = useContext()
      const nttProgram = opts.nttProgram ? new PublicKey(opts.nttProgram) : NTT_USDC_PROGRAM_ID
      const rentDestination = opts.rentDestination
        ? new PublicKey(opts.rentDestination)
        : keypair.publicKey
      const vaaBytes = await fetchVaaBytes({
        fogoTx: opts.fogoTx,
        vaaHex: opts.vaa,
        wormholescanUrl: opts.wormholescanUrl,
      })
      const resolved = resolveNttVaa({ vaaBytes, nttProgramId: nttProgram })

      // Pre-flight: Flow must exist with status=Swapped.
      const flow = await client.fetchInflightFlow(resolved.nttInboxItem).catch(() => null)
      if (!flow) {
        throw new Error(
          `No inflight Flow PDA for inbox-item ${resolved.nttInboxItem.toBase58()} — `
          + `prior steps haven't run.`,
        )
      }
      const flowStatus = describeStatus(flow.status)
      if (flowStatus !== 'Swapped') {
        throw new Error(
          `Flow status is ${flowStatus}, expected Swapped. Run 'cranker swap-usdc-to-onyc' first, or this step has already landed (Flow would have been closed).`,
        )
      }

      const cfg = await client.fetchConfig()
      const onycMint = opts.onycMint
        ? new PublicKey(opts.onycMint)
        : (cfg.onycMint as PublicKey)

      // The FOGO destination for the ONyc mint comes from the Flow
      // PDA, set by `claim_usdc` from the VAA's NTT-message `sender`
      // field. lock_onyc uses it as the recipient on FOGO.
      const flowFogoSender = Uint8Array.from(flow.fogoSender as ArrayLike<number>)
      const flowAmount = BigInt(flow.amount.toString())

      // NTT `transfer_lock` requires a fresh outbox-item account each
      // call (unique per outbound message). It's a one-shot keypair
      // signed alongside the cranker — Anchor's `.signers([...])`
      // attaches it. The account is initialized inside the CPI and
      // owned by the NTT program afterward.
      const outboxItem = Keypair.generate()

      // Pre-flight: NTT `transfer_lock` requires the destination chain
      // to have a registered `peer` PDA AND a corresponding
      // `inbox_rate_limit` PDA on the source-side NTT manager. If
      // either is missing, the CPI reverts with bare `Custom(1)` — no
      // helpful logs — and the cranker loses gas + a fresh outbox
      // keypair. Probe both client-side and bail early with a clear
      // diagnostic. This is the documented ONyc-deploy gate from
      // CLAUDE.md ("FOGO ONyc NTT manager not yet published"); the
      // gate applies to the deposit leg too because both legs traverse
      // the same ONyc↔ONyc corridor.
      const [fogoPeerPda] = findNttPeerPda(FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID)
      const [fogoInboxRateLimitPda] = findInboxRateLimitPda(FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID)
      const [peerInfo, inboxRateLimitInfo] = await Promise.all([
        client.program.provider.connection.getAccountInfo(fogoPeerPda).catch(() => null),
        client.program.provider.connection.getAccountInfo(fogoInboxRateLimitPda).catch(() => null),
      ])
      if (!peerInfo || !inboxRateLimitInfo) {
        const missing: string[] = []
        if (!peerInfo) {
          missing.push(`peer (${fogoPeerPda.toBase58()})`)
        }
        if (!inboxRateLimitInfo) {
          missing.push(`inbox_rate_limit (${fogoInboxRateLimitPda.toBase58()})`)
        }
        throw new Error(
          `FOGO chain (id=${FOGO_WORMHOLE_CHAIN_ID}) is not registered on the ONyc NTT manager `
          + `(${NTT_ONYC_PROGRAM_ID.toBase58()}): missing ${missing.join(' and ')}. `
          + `lock_onyc cannot dispatch until the FOGO ONyc NTT manager is deployed and the `
          + `relayer authority calls 'set_peer' on the Solana ONyc NTT manager. Your Flow PDA `
          + `is safe in status=Swapped — re-run this command once the peer is registered.`,
        )
      }

      const flowFogoSenderPk = new PublicKey(flowFogoSender)

      // Pre-flight: NTT charges the rent for the outbox-item account
      // (~1.86M lamports for the ~256-byte OutboxItem) to the
      // `relayer_authority` PDA — it's at position 0 of NTT's
      // remaining-accounts list and is treated as a signer via
      // `invoke_signed` from inside `lock_onyc`. The per-transfer
      // `session_authority` PDA also needs lamports because NTT
      // reads/writes through it during the SPL `Approve` delegate
      // path. Both PDAs start at 0 lamports on mainnet — the test
      // rig airdrops 5 SOL and 1 SOL respectively
      // (`lock-onyc-e2e.test.ts:116,155`); no airdrop here, so the
      // cranker prepends two `SystemProgram.transfer` ixs.
      //
      // Lamports aren't lost: relayer_authority's 2M lands on the
      // freshly-created outbox-item as rent (recoverable on close);
      // session_authority's 2M lands on the same outbox-item or
      // returns at end-of-tx if NTT didn't draw from it.
      // session_authority drains to 0 each call (matching the per-
      // transfer derivation), so re-topping every invocation is
      // expected behavior. relayer_authority also drains because it
      // has no data and isn't rent-exempt, so the System Program
      // permits the full debit.
      // NTT `transfer_lock` debits OutboxItem rent (~1,858,320 lamports for the current
      // ~256-byte OutboxItem layout) from `relayer_authority` via invoke_signed. After the
      // debit, the PDA must end with either 0 lamports (purged) or ≥ rent-exempt for a
      // 0-byte System-owned account (890,880 lamports). Topping up to exactly the debit
      // amount would land us at 0 — fine, but fragile if the OutboxItem grows by even 1
      // byte. So we target debit + rent-exempt + headroom = 3,000,000.
      const RELAYER_AUTH_TOPUP = 3_000_000n
      // session_authority is signer-only and not debited; 2M leaves it well above the
      // 890,880-lamport rent-exempt floor.
      const SESSION_AUTH_TOPUP = 2_000_000n
      const argsHash = nttTransferArgsHash({
        amount: flowAmount,
        recipientChain: FOGO_WORMHOLE_CHAIN_ID,
        recipientAddress: flowFogoSender,
        shouldQueue: false,
      })
      const [relayerAuthorityPda] = findAuthorityPda(client.program.programId)
      const [sessionAuthorityPda] = findSessionAuthorityPda(
        relayerAuthorityPda,
        argsHash,
        NTT_ONYC_PROGRAM_ID,
      )
      const conn = client.program.provider.connection
      const [relayerAuthInfo, sessionAuthInfo] = await Promise.all([
        conn.getAccountInfo(relayerAuthorityPda).catch(() => null),
        conn.getAccountInfo(sessionAuthorityPda).catch(() => null),
      ])
      const computeTopUp = (existing: number | undefined, target: bigint): bigint => {
        const e = BigInt(existing ?? 0)
        return e >= target ? 0n : target - e
      }
      const relayerTopUp = computeTopUp(relayerAuthInfo?.lamports, RELAYER_AUTH_TOPUP)
      const sessionTopUp = computeTopUp(sessionAuthInfo?.lamports, SESSION_AUTH_TOPUP)
      const fundSessionAuthorityIxs: ReturnType<typeof SystemProgram.transfer>[] = []
      if (relayerTopUp > 0n) {
        fundSessionAuthorityIxs.push(SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: relayerAuthorityPda,
          lamports: Number(relayerTopUp),
        }))
      }
      if (sessionTopUp > 0n) {
        fundSessionAuthorityIxs.push(SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: sessionAuthorityPda,
          lamports: Number(sessionTopUp),
        }))
      }
      console.log(chalk.cyan('lock-onyc plan'))
      console.log(chalk.dim(`  payer (signer):         ${keypair.publicKey.toBase58()}`))
      console.log(chalk.dim(`  onycMint:               ${onycMint.toBase58()}`))
      console.log(chalk.dim(`  nttInboxItem:           ${resolved.nttInboxItem.toBase58()}`))
      console.log(chalk.dim(`  inflightFlow:           ${findInflightFlowPda(resolved.nttInboxItem, client.program.programId)[0].toBase58()}`))
      console.log(chalk.dim(`  rentDestination:        ${rentDestination.toBase58()}`))
      console.log(chalk.dim(`  flow.amount:            ${flowAmount.toString()}`))
      console.log(chalk.dim(`  flow.fogoSender:        ${flowFogoSenderPk.toBase58()}`))
      console.log(chalk.dim(`  outboxItem (new):       ${outboxItem.publicKey.toBase58()}`))
      console.log(chalk.dim(`  relayerAuthority:       ${relayerAuthorityPda.toBase58()}${relayerTopUp > 0n ? chalk.yellow(` (top-up ${relayerTopUp.toString()} lamports for outbox-item rent)`) : chalk.dim(' (already funded)')}`))
      console.log(chalk.dim(`  sessionAuthority:       ${sessionAuthorityPda.toBase58()}${sessionTopUp > 0n ? chalk.yellow(` (top-up ${sessionTopUp.toString()} lamports)`) : chalk.dim(' (already funded)')}`))

      if (!opts.confirm) {
        console.log()
        console.log(chalk.yellow('dry-run only. Re-run with --confirm to broadcast.'))
        return
      }

      console.log()
      const wormholeCore = opts.wormholeCore ?? WORMHOLE_CORE_MAINNET
      const nttVersion = opts.nttVersion ?? DEFAULT_NTT_VERSION
      const onycNtt = makeSolanaNtt({
        connection,
        manager: NTT_ONYC_PROGRAM_ID,
        token: onycMint,
        wormholeCore,
        version: nttVersion,
      })
      const release = await deriveLockOnycReleaseAccounts(
        onycNtt,
        keypair.publicKey,
        outboxItem.publicKey,
      )

      const sig = await runTx(() =>
        client
          .lockOnyc({
            payer: keypair.publicKey,
            onycMint,
            nttInboxItem: resolved.nttInboxItem,
            rentDestination,
            flowAmount,
            flowFogoSender,
            outboxItem: outboxItem.publicKey,
            release,
          })
          .preInstructions(fundSessionAuthorityIxs)
          .signers([outboxItem])
          .rpc(),
      )

      console.log(chalk.green('lock-onyc landed — ONyc en route to FOGO'))
      console.log(chalk.dim(`  tx: ${sig}`))
      console.log(chalk.dim(`  outbox: ${outboxItem.publicKey.toBase58()}`))
    })

  cranker
    .command('release-outbound')
    .description(
      'Release a queued NTT OutboxItem so the Wormhole VAA is emitted '
      + '(deposit leg, step 4 — runs after lock_onyc).',
    )
    .requiredOption('--outbox-item <pubkey>', 'OutboxItem account written by lock_onyc (printed by `cranker lock-onyc`)')
    .option('--onyc-mint <pubkey>', `ONyc mint (default from on-chain RelayerConfig, fallback ${ONYC_MINT.toBase58()})`)
    .option('--ntt-program <pubkey>', `ONyc NTT manager program id (default: ${NTT_ONYC_PROGRAM_ID.toBase58()})`)
    .option('--ntt-version <ver>', `NTT IDL version for the on-chain manager [default: ${DEFAULT_NTT_VERSION}]`)
    .option('--wormhole-core <pubkey>', `Wormhole Core program id [default: ${WORMHOLE_CORE_MAINNET}]`)
    .option('--revert-on-delay', 'Pass revertOnDelay=true to NTT (default: false)')
    .option('--confirm', 'Actually broadcast the transaction (default: dry-run)')
    .action(async (opts: {
      outboxItem: string
      onycMint?: string
      nttProgram?: string
      nttVersion?: string
      wormholeCore?: string
      revertOnDelay?: boolean
      confirm?: boolean
    }) => {
      const { connection, keypair, client } = useContext()
      const outboxItem = new PublicKey(opts.outboxItem)
      const nttProgramId = opts.nttProgram ? new PublicKey(opts.nttProgram) : NTT_ONYC_PROGRAM_ID
      const wormholeCore = opts.wormholeCore ?? WORMHOLE_CORE_MAINNET
      const nttVersion = opts.nttVersion ?? DEFAULT_NTT_VERSION
      const cfg = await client.fetchConfig()
      const onycMint = opts.onycMint ? new PublicKey(opts.onycMint) : (cfg.onycMint as PublicKey)

      const ntt = makeSolanaNtt({
        connection,
        manager: nttProgramId,
        token: onycMint,
        wormholeCore,
        version: nttVersion,
      })

      // Idempotency: read the OutboxItem and check the wormhole transceiver
      // bit (bit 0) on the released bitmap. If already set, exit clean —
      // re-running is wasted gas.
      const outboxAccount = await ntt.program.account.outboxItem.fetchNullable(outboxItem)
      if (!outboxAccount) {
        throw new Error(
          `OutboxItem ${outboxItem.toBase58()} not found on chain. `
          + 'Either lock_onyc never ran, the OutboxItem pubkey is wrong, or the NTT program id is wrong '
          + `(checked under ${nttProgramId.toBase58()}).`,
        )
      }
      // `released.map` is a u128 (Bitmap.map field per IDL). The wormhole
      // xcvr is at bit 0 because SolanaNtt registers it first.
      const releasedMap = (outboxAccount as { released?: { map: { toString: () => string } } }).released?.map
      const releasedMask = releasedMap ? BigInt(releasedMap.toString()) : 0n
      const wormholeBit = 1n
      if ((releasedMask & wormholeBit) === wormholeBit) {
        console.log(chalk.green('OutboxItem already released for the wormhole transceiver — nothing to do.'))
        console.log(chalk.dim(`  outboxItem:     ${outboxItem.toBase58()}`))
        console.log(chalk.dim(`  released.map:   0x${releasedMask.toString(16)}`))
        return
      }

      const xcvr = await ntt.getWormholeTransceiver()
      if (!xcvr) {
        throw new Error('Failed to construct SolanaNttWormholeTransceiver — manager/transceiver wiring mismatch.')
      }
      const releaseIx = await xcvr.createReleaseWormholeOutboundIx(
        keypair.publicKey,
        outboxItem,
        opts.revertOnDelay ?? false,
      )

      // Useful diagnostics: emitter is the Wormhole sender of this VAA;
      // the redeemer on FOGO will need it (alongside sequence) to look
      // up the signed VAA. The OutboxItem already carries
      // recipient_chain / recipient_address that we surface for sanity.
      const emitter = (await xcvr.getAddress()).address.toString()
      const recipientChain = (outboxAccount as { recipientChain?: { id?: number } | number }).recipientChain
      const recipientChainId = typeof recipientChain === 'object' && recipientChain !== null && 'id' in recipientChain
        ? recipientChain.id
        : (recipientChain as number | undefined)
      const recipientAddrBytes = (outboxAccount as { recipientAddress?: number[] | Uint8Array }).recipientAddress
      const recipientAddrPk = recipientAddrBytes
        ? new PublicKey(Uint8Array.from(recipientAddrBytes as ArrayLike<number>)).toBase58()
        : '(unknown)'

      console.log(chalk.cyan('release-outbound plan'))
      console.log(chalk.dim(`  payer (signer):         ${keypair.publicKey.toBase58()}`))
      console.log(chalk.dim(`  nttProgram:             ${nttProgramId.toBase58()}`))
      console.log(chalk.dim(`  nttVersion:             ${nttVersion}`))
      console.log(chalk.dim(`  wormholeCore:           ${wormholeCore}`))
      console.log(chalk.dim(`  outboxItem:             ${outboxItem.toBase58()}`))
      console.log(chalk.dim(`  emitter (wormhole):     ${emitter}`))
      console.log(chalk.dim(`  recipientChain:         ${recipientChainId ?? '(unknown)'}`))
      console.log(chalk.dim(`  recipientAddress:       ${recipientAddrPk}`))
      console.log(chalk.dim(`  released.map (before):  0x${releasedMask.toString(16)}`))

      if (!opts.confirm) {
        console.log()
        console.log(chalk.yellow('dry-run only. Re-run with --confirm to broadcast.'))
        return
      }

      const tx = new Transaction().add(releaseIx)
      tx.feePayer = keypair.publicKey
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      tx.recentBlockhash = blockhash
      tx.sign(keypair)

      const sig = await runTx(async () => {
        const s = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
        await connection.confirmTransaction({ signature: s, blockhash, lastValidBlockHeight }, 'confirmed')
        return s
      })

      console.log(chalk.green('release-outbound landed — Wormhole VAA emitted'))
      console.log(chalk.dim(`  tx:        ${sig}`))
      console.log(chalk.dim(`  emitter:   ${emitter}`))
      console.log(chalk.yellow('Next: fetch the signed VAA from Wormholescan/guardian RPC and submit FOGO redeem.'))
    })

  // The "do everything" subcommand. Reads on-chain state to determine
  // remaining steps, bundles them into one Solana transaction, and
  // exits clean. Idempotent: re-running after partial completion
  // detects what's already done and only does the rest.
  //
  // Stateless by design: no `~/.fogo-onre-cranker/state.json`. The chain
  // (Flow PDA + status, OutboxItem PDA existence) is the source of
  // truth. A second `advance` run picks up exactly where the first left
  // off because both runs start by re-reading state.
  //
  // CURRENT SCOPE: bundles the three Solana ixs we already have
  // builders for — claim_usdc, swap_usdc_to_onyc, lock_onyc — into one
  // atomic tx. After lock_onyc lands, the OutboxItem is queued but no
  // VAA is emitted yet (NTT v1 splits queue from attestation). The
  // operator must still run a `release-outbound` step (TODO: not yet
  // implemented in CLI v1) to emit the Wormhole message, and then a
  // FOGO-side redeem (TODO) to mint ONyc. Both deferred steps will
  // slot into this orchestrator behind the same `--no-wait-vaa` /
  // `--vaa-timeout` flags once their builders exist.
  //
  // Per codex review (gpt-5.5):
  //   - Pre-flight `simulateTransaction` to surface failures with full
  //     logs before paying gas.
  //   - Distinct exit codes: 0 = fully complete, 1 = real failure,
  //     2 = stopped because more work remains but we can't do it yet
  //     (--no-wait-vaa or release_outbound TODO).
  //   - Concurrency safety (when a 2nd cranker races us): catch the
  //     "step already done" send-error patterns, re-read state,
  //     continue. NOT YET IMPLEMENTED — for now, a race-loss surfaces
  //     as a normal failure; re-running `advance` recovers because
  //     state-detection picks up the new chain state.
  cranker
    .command('advance')
    .description('Drive a deposit through every available step in one tx (deposit leg, all-in-one)')
    .requiredOption('--fogo-tx <signature>', 'FOGO tx signature that emitted the bridge VAA')
    .option('--vaa <hex>', 'Override Wormholescan lookup with raw signed VAA bytes (hex)')
    .option('--user-wallet <pubkey>', 'Override wallet attribution (default: VAA sender, with auto-detection)')
    .option('--usdc-mint <pubkey>', `USDC mint on Solana (default: ${USDC_MINT.toBase58()})`)
    .option('--onyc-mint <pubkey>', `ONyc mint (default from on-chain RelayerConfig, fallback ${ONYC_MINT.toBase58()})`)
    .option('--ntt-program <pubkey>', `NTT USDC.s manager program id (default: ${NTT_USDC_PROGRAM_ID.toBase58()})`)
    .option('--rent-destination <pubkey>', 'Destination for closed Flow PDA rent (default: signer)')
    .option('--outbox-item <pubkey>', 'OutboxItem from a prior `lock-onyc` run; required to chain release_outbound when relayer side is already done')
    .option('--ntt-version <ver>', `NTT IDL version for the ONyc manager (release_outbound only) [default: ${DEFAULT_NTT_VERSION}]`)
    .option('--wormhole-core <pubkey>', `Wormhole Core program id (release_outbound only) [default: ${WORMHOLE_CORE_MAINNET}]`)
    .option('--wormholescan-url <url>', `Wormholescan REST base URL [default: ${DEFAULT_WORMHOLESCAN_URL}]`)
    .option('--confirm', 'Actually broadcast the transaction (default: dry-run)')
    .action(async (opts: {
      fogoTx: string
      vaa?: string
      userWallet?: string
      usdcMint?: string
      onycMint?: string
      nttProgram?: string
      rentDestination?: string
      outboxItem?: string
      nttVersion?: string
      wormholeCore?: string
      wormholescanUrl?: string
      confirm?: boolean
    }) => {
      const { connection, keypair, client } = useContext()
      const usdcMint = opts.usdcMint ? new PublicKey(opts.usdcMint) : USDC_MINT
      const nttProgram = opts.nttProgram ? new PublicKey(opts.nttProgram) : NTT_USDC_PROGRAM_ID
      const rentDestination = opts.rentDestination
        ? new PublicKey(opts.rentDestination)
        : keypair.publicKey

      const vaaBytes = await fetchVaaBytes({
        fogoTx: opts.fogoTx,
        vaaHex: opts.vaa,
        wormholescanUrl: opts.wormholescanUrl,
      })
      const resolved = resolveNttVaa({ vaaBytes, nttProgramId: nttProgram })

      // 1. State detection. Two signals are needed because lock_onyc
      // CLOSES the Flow PDA (rent refunded), so `flow == null` is
      // ambiguous: it means either "fresh deposit, never claimed" OR
      // "fully done, lock closed it." Disambiguate via NTT's inbox_item
      // PDA, which is created by NTT's redeem (called inside
      // claim_usdc) and persists forever after.
      //
      //   inbox_item missing + no Flow  → fresh deposit, do claim+swap, then lock
      //   inbox_item exists  + Flow.Claimed → swap pending, do swap, then lock
      //   inbox_item exists  + Flow.Swapped → lock pending, do lock alone
      //   inbox_item exists  + no Flow  → relayer side fully done; release_outbound + FOGO redeem pending (TODO)
      const cfg = await client.fetchConfig()
      const onycMint = opts.onycMint
        ? new PublicKey(opts.onycMint)
        : (cfg.onycMint as PublicKey)
      const feeVault = cfg.feeVault as PublicKey
      const [flow, inboxItemInfo] = await Promise.all([
        client.fetchInflightFlow(resolved.nttInboxItem).catch(() => null),
        connection.getAccountInfo(resolved.nttInboxItem).catch(() => null),
      ])
      const flowStatus = flow ? describeStatus(flow.status) : '(none)'
      const claimDone = inboxItemInfo !== null
      const needClaim = !claimDone
      const needSwap = !flow && !claimDone || (flow !== null && flowStatus === 'Claimed')
      const needLock = (flow !== null && (flowStatus === 'Claimed' || flowStatus === 'Swapped'))
        || (!flow && !claimDone) // brand-new path: lock is needed but in a 2nd tx after claim+swap

      console.log(chalk.cyan('VAA'))
      console.log(chalk.dim(`  emitterChain:           ${resolved.fromChain}`))
      console.log(chalk.dim(`  sequence:               ${resolved.vaa.sequence}`))
      console.log(chalk.dim(`  recipient (Solana):     ${resolved.recipientOnSolana.toBase58()}`))
      console.log(chalk.dim(`  trimmedAmount:          ${resolved.manager.trimmedAmount} (decimals=${resolved.manager.trimmedDecimals})`))
      console.log(chalk.dim(`  nttInboxItem:           ${resolved.nttInboxItem.toBase58()}`))

      console.log(chalk.cyan('\nCurrent state'))
      console.log(chalk.dim(`  NTT inbox_item exists:  ${claimDone}  ${claimDone ? '(claim_usdc has consumed this VAA)' : '(claim_usdc not yet run)'}`))
      console.log(chalk.dim(`  Flow PDA:               ${flow ? 'exists' : '(none)'}`))
      console.log(chalk.dim(`  Flow status:            ${flowStatus}`))

      // 2. Decide which steps remain.
      // After the lock_onyc merge, lock_onyc emits the Wormhole VAA
      // atomically (transfer_lock + release_wormhole_outbound in one ix).
      // So `claimDone && !flow` now means "Solana side fully done, FOGO
      // redeem is the only remaining step" — no `release_outbound`
      // tx to chain. The standalone `cranker release-outbound` command
      // is preserved as a recovery escape hatch for any pre-merge
      // OutboxItems that were queued without a VAA.
      const solanaSideDone = claimDone && !flow
      const txQueue: { label: string, build: () => Promise<{ ixs: TransactionInstruction[], signers: Keypair[] }> }[] = []

      // userWallet auto-detection — only relevant for claim_usdc.
      let userWallet = keypair.publicKey
      let userWalletNote = '(default: signer)'
      if (needClaim) {
        function deriveInboxAuthority(wallet: PublicKey): PublicKey {
          const [pda] = findUserInboxAuthorityPda(wallet, client.program.programId)
          return pda
        }
        if (opts.userWallet) {
          userWallet = new PublicKey(opts.userWallet)
          userWalletNote = '(from --user-wallet)'
        } else if (deriveInboxAuthority(keypair.publicKey).equals(resolved.recipientOnSolana)) {
          userWallet = keypair.publicKey
          userWalletNote = '(auto: signer matches recipient PDA)'
        } else if (deriveInboxAuthority(resolved.senderOnSource).equals(resolved.recipientOnSolana)) {
          userWallet = resolved.senderOnSource
          userWalletNote = '(auto: VAA sender matches recipient PDA)'
        } else {
          throw new Error(
            `Cannot auto-detect userWallet — neither signer (${keypair.publicKey.toBase58()}) `
            + `nor VAA sender (${resolved.senderOnSource.toBase58()}) derives an inbox-authority PDA `
            + `matching the VAA recipient (${resolved.recipientOnSolana.toBase58()}). `
            + `Pass --user-wallet explicitly. Common cause: Fogo Sessions wallet — the VAA sender is `
            + `the session keypair, not the main wallet that seeds the inbox PDA.`,
          )
        }
      }

      // TX 1: claim and/or swap. These can be safely bundled because
      // swap reads Flow.amount that claim writes within the same tx.
      // Lock is deferred to TX 2 because its off-chain args_hash
      // depends on Flow.amount AFTER swap rewrites it (post-swap ONyc
      // amount, not the pre-swap USDC amount).
      if (needClaim || needSwap) {
        const label = needClaim && needSwap ? 'claim_usdc + swap_usdc_to_onyc' : (needClaim ? 'claim_usdc' : 'swap_usdc_to_onyc')
        txQueue.push({
          label,
          build: async () => {
            const ixs: TransactionInstruction[] = []
            if (needClaim) {
              const [userInboxAuthority] = findUserInboxAuthorityPda(userWallet, client.program.programId)
              const userInboxAta = getAssociatedTokenAddressSync(usdcMint, userInboxAuthority, true)
              ixs.push(
                createAssociatedTokenAccountIdempotentInstruction(
                  keypair.publicKey,
                  userInboxAta,
                  userInboxAuthority,
                  usdcMint,
                ),
              )
              const claimIx = await client
                .claimUsdc({
                  payer: keypair.publicKey,
                  userWallet,
                  usdcMint,
                  nttInboxItem: resolved.nttInboxItem,
                  nttTransceiverMessage: resolved.nttTransceiverMessage,
                  ntt: { transceiverAddress: nttProgram },
                })
                .instruction()
              ixs.push(claimIx)
            }
            if (needSwap) {
              const swapIx = await client
                .swapUsdcToOnyc({
                  usdcMint,
                  onycMint,
                  nttInboxItem: resolved.nttInboxItem,
                  feeVault,
                  onre: {},
                })
                .instruction()
              ixs.push(swapIx)
            }
            return { ixs, signers: [] }
          },
        })
      }

      // TX 2: lock_onyc. Always its own tx so we can read post-swap
      // Flow.amount from chain and compute args_hash correctly.
      if (needLock) {
        txQueue.push({
          label: 'lock_onyc',
          build: async () => {
            // Re-fetch Flow — TX 1 may have just landed.
            const refetched = await client.fetchInflightFlow(resolved.nttInboxItem)
            if (!refetched) {
              throw new Error(
                'Flow PDA missing at lock-build time — TX 1 (claim/swap) may have failed silently. '
                + 'Re-run `cranker advance` to inspect chain state.',
              )
            }
            const refStatus = describeStatus(refetched.status)
            if (refStatus !== 'Swapped') {
              throw new Error(
                `Expected Flow.status=Swapped before lock_onyc, got ${refStatus}. `
                + 'TX 1 (swap) may have been skipped — re-run `cranker advance`.',
              )
            }
            const flowAmount = BigInt(refetched.amount.toString())
            const flowFogoSender = Uint8Array.from(refetched.fogoSender as ArrayLike<number>)
            const outboxItem = Keypair.generate()

            // FOGO peer pre-flight.
            const [fogoPeerPda] = findNttPeerPda(FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID)
            const [fogoInboxRateLimitPda] = findInboxRateLimitPda(FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID)
            const [peerInfo, inboxRateLimitInfo] = await Promise.all([
              connection.getAccountInfo(fogoPeerPda).catch(() => null),
              connection.getAccountInfo(fogoInboxRateLimitPda).catch(() => null),
            ])
            if (!peerInfo || !inboxRateLimitInfo) {
              throw new Error(
                `FOGO chain (id=${FOGO_WORMHOLE_CHAIN_ID}) is not registered on the ONyc NTT manager — `
                + `peer or inbox_rate_limit missing.`,
              )
            }

            // Lamport top-ups for relayer_authority + session_authority.
            const RELAYER_AUTH_TOPUP = 3_000_000n
            const SESSION_AUTH_TOPUP = 2_000_000n
            const argsHash = nttTransferArgsHash({
              amount: flowAmount,
              recipientChain: FOGO_WORMHOLE_CHAIN_ID,
              recipientAddress: flowFogoSender,
              shouldQueue: false,
            })
            const [relayerAuthorityPda] = findAuthorityPda(client.program.programId)
            const [sessionAuthorityPda] = findSessionAuthorityPda(
              relayerAuthorityPda,
              argsHash,
              NTT_ONYC_PROGRAM_ID,
            )
            const [relayerAuthInfo, sessionAuthInfo] = await Promise.all([
              connection.getAccountInfo(relayerAuthorityPda).catch(() => null),
              connection.getAccountInfo(sessionAuthorityPda).catch(() => null),
            ])
            const computeTopUp = (existing: number | undefined, target: bigint): bigint => {
              const e = BigInt(existing ?? 0)
              return e >= target ? 0n : target - e
            }
            const relayerTopUp = computeTopUp(relayerAuthInfo?.lamports, RELAYER_AUTH_TOPUP)
            const sessionTopUp = computeTopUp(sessionAuthInfo?.lamports, SESSION_AUTH_TOPUP)

            const ixs: TransactionInstruction[] = []
            if (relayerTopUp > 0n) {
              ixs.push(SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey: relayerAuthorityPda,
                lamports: Number(relayerTopUp),
              }))
            }
            if (sessionTopUp > 0n) {
              ixs.push(SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey: sessionAuthorityPda,
                lamports: Number(sessionTopUp),
              }))
            }

            const lockIx = await client
              .lockOnyc({
                payer: keypair.publicKey,
                onycMint,
                nttInboxItem: resolved.nttInboxItem,
                rentDestination,
                flowAmount,
                flowFogoSender,
                outboxItem: outboxItem.publicKey,
                release: await deriveLockOnycReleaseAccounts(
                  makeSolanaNtt({
                    connection,
                    manager: NTT_ONYC_PROGRAM_ID,
                    token: onycMint,
                    wormholeCore: opts.wormholeCore ?? WORMHOLE_CORE_MAINNET,
                    version: opts.nttVersion ?? DEFAULT_NTT_VERSION,
                  }),
                  keypair.publicKey,
                  outboxItem.publicKey,
                ),
              })
              .instruction()
            ixs.push(lockIx)

            console.log(chalk.dim(`    outboxItem (new):       ${outboxItem.publicKey.toBase58()}`))
            return { ixs, signers: [outboxItem] }
          },
        })
      }

      // After the lock_onyc merge, the relayer's lock step emits the
      // Wormhole VAA atomically. Nothing to enqueue here on the deposit
      // happy path. `cranker release-outbound` remains for recovery of
      // any pre-merge OutboxItems queued without a VAA — invoke it
      // manually rather than auto-chaining via `advance`.
      if (opts.outboxItem) {
        console.log(chalk.dim('  --outbox-item ignored: lock_onyc now emits the VAA atomically.'))
        console.log(chalk.dim('  For pre-merge recovery use `cranker release-outbound --outbox-item <pubkey>`.'))
      }

      console.log(chalk.cyan('\nPlanned transactions'))
      for (let i = 0; i < txQueue.length; i++) {
        console.log(chalk.dim(`  ${i + 1}. ${txQueue[i].label}`))
      }
      console.log(chalk.dim(`  payer (signer): ${keypair.publicKey.toBase58()} ${userWalletNote}`))

      if (!opts.confirm) {
        console.log()
        console.log(chalk.yellow('dry-run only. Re-run with --confirm to broadcast.'))
        return
      }

      // 3. Execute the queue. Each tx: build → simulate → send.
      for (let i = 0; i < txQueue.length; i++) {
        const { label, build } = txQueue[i]
        console.log(chalk.cyan(`\nTX ${i + 1}: ${label}`))
        const { ixs, signers } = await build()
        if (ixs.length === 0) {
          console.log(chalk.dim('  no-op (already done) — skipping'))
          continue
        }

        const tx = new Transaction().add(...ixs)
        tx.feePayer = keypair.publicKey
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
        tx.recentBlockhash = blockhash
        tx.sign(keypair, ...signers)

        const sim = await connection.simulateTransaction(tx, undefined, [])
        if (sim.value.err) {
          const logTail = (sim.value.logs ?? []).slice(-25).map(l => `  ${l}`).join('\n')
          throw new Error(
            `TX ${i + 1} (${label}) simulation failed: ${JSON.stringify(sim.value.err)}\n`
            + `Program logs (last 25):\n${logTail}\n`
            + `(No gas spent on this tx.)`,
          )
        }
        const cuConsumed = sim.value.unitsConsumed ?? 0
        console.log(chalk.dim(`  simulate ok — ${cuConsumed.toLocaleString()} CU`))

        const sig = await runTx(async () => {
          const s = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
          await connection.confirmTransaction({ signature: s, blockhash, lastValidBlockHeight }, 'confirmed')
          return s
        })
        console.log(chalk.green(`  landed: ${sig}`))
      }

      const releaseDone = solanaSideDone || needLock
      if (releaseDone) {
        console.log(chalk.green('\nadvance complete — Wormhole VAA emitted (lock_onyc atomically published it).'))
        console.log()
        console.log(chalk.yellow('Next step (not yet automated):'))
        console.log(chalk.dim('  FOGO redeem — submit signed VAA to FOGO ONyc NTT manager once guardians sign it.'))
        process.exit(0)
      }
      console.log(chalk.green('\nadvance complete — Solana relayer side done for this VAA'))
      console.log()
      console.log(chalk.yellow('Next steps (not yet automated):'))
      console.log(chalk.dim('  FOGO redeem — submit signed VAA to FOGO ONyc NTT manager.'))
      // Exit 2: relayer-side done, but the cross-chain delivery isn't.
      process.exit(2)
    })

  cranker
    .command('redeem-fogo')
    .description(
      'Submit the NTT redeem on FOGO so ONyc is minted to the user '
      + '(deposit leg, step 5 — runs after release-outbound emits the VAA).',
    )
    .requiredOption('--vaa <hex>', 'Signed Wormhole VAA bytes (hex, optional 0x prefix)')
    .option('--fogo-rpc <url>', `FOGO RPC URL [env: FOGO_RPC_URL, default: ${FOGO_RPC_DEFAULT}]`)
    .option('--ntt-manager <pubkey>', `FOGO ONyc NTT manager program id [default: ${FOGO_ONYC_NTT_MANAGER_ID}]`)
    .option('--fogoOnyc-mint <pubkey>', `ONyc mint on FOGO [default: ${FOGO_ONYC_MINT}]`)
    .option('--wormhole-core <pubkey>', `FOGO Wormhole core program id [default: ${FOGO_WORMHOLE_CORE_MAINNET}]`)
    .option('--ntt-version <ver>', `NTT IDL version for the FOGO ONyc manager [default: ${DEFAULT_NTT_VERSION}]`)
    .option('--confirm', 'Actually broadcast the transaction(s) (default: dry-run)')
    .action(async (opts: {
      vaa: string
      fogoRpc?: string
      nttManager?: string
      fogoOnycMint?: string
      wormholeCore?: string
      nttVersion?: string
      confirm?: boolean
    }) => {
      // FOGO is a separate Solana-VM cluster; do NOT reuse the Solana
      // context's Connection/AnchorProvider — only the keypair carries
      // over (same Ed25519 format on both chains).
      const { keypair } = useContext()
      const fogoRpcUrl = opts.fogoRpc ?? process.env.FOGO_RPC_URL ?? FOGO_RPC_DEFAULT
      const fogoConnection = new Connection(fogoRpcUrl, 'confirmed')
      const fogoProvider = new AnchorProvider(
        fogoConnection,
        new Wallet(keypair),
        { commitment: 'confirmed' },
      )
      const nttManagerId = opts.nttManager ?? FOGO_ONYC_NTT_MANAGER_ID
      const fogoOnycMint = opts.fogoOnycMint ?? FOGO_ONYC_MINT
      const wormholeCore = opts.wormholeCore ?? FOGO_WORMHOLE_CORE_MAINNET
      const nttVersion = opts.nttVersion ?? DEFAULT_NTT_VERSION

      // Parse VAA hex → bytes → typed Wormhole NTT attestation. The
      // `Ntt:WormholeTransfer` payload literal is registered as a side
      // effect of importing `@wormhole-foundation/sdk-definitions-ntt`
      // at the top of this file.
      const hex = opts.vaa.startsWith('0x') ? opts.vaa.slice(2) : opts.vaa
      if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
        throw new Error('--vaa must be a hex string (optional 0x prefix)')
      }
      const vaaBytes = Uint8Array.from(Buffer.from(hex, 'hex'))
      const attestation = deserialize('Ntt:WormholeTransfer', vaaBytes)

      // Surface the same diagnostics our other subcommands print so the
      // operator can cross-check VAA → recipient before signing.
      const resolved = resolveNttVaa({
        vaaBytes,
        nttProgramId: new PublicKey(nttManagerId),
      })
      const recipientAta = getAssociatedTokenAddressSync(
        new PublicKey(fogoOnycMint),
        resolved.recipientOnSolana,
      )

      // 'Fogo' is a registered Wormhole chain in @wormhole-foundation/sdk-base
      // 4.18.x and is included in the Solana platform's chain set, so
      // SolanaNtt accepts it natively — no workaround needed.
      const ntt = new SolanaNtt(
        'Mainnet',
        'Fogo',
        fogoConnection,
        {
          coreBridge: wormholeCore,
          ntt: {
            manager: nttManagerId,
            token: fogoOnycMint,
            // Same compiled-in-the-manager pattern as the Solana side.
            transceiver: { wormhole: nttManagerId },
          },
        },
        nttVersion,
      )

      // Idempotency: if the inbox_item PDA already has the `released`
      // bit set, the redeem has already landed and re-running burns gas.
      // `getIsExecuted` reads that bit; `getIsApproved` distinguishes
      // "redeem partially run, release pending" from "fully missing".
      const isExecuted = await ntt.getIsExecuted(attestation).catch(() => false)
      if (isExecuted) {
        console.log(chalk.green('VAA already redeemed on FOGO — nothing to do.'))
        console.log(chalk.dim(`  emitterChain:    ${resolved.fromChain}`))
        console.log(chalk.dim(`  sequence:        ${resolved.vaa.sequence}`))
        console.log(chalk.dim(`  recipient:       ${resolved.recipientOnSolana.toBase58()}`))
        console.log(chalk.dim(`  recipientAta:    ${recipientAta.toBase58()}`))
        return
      }
      const isApproved = await ntt.getIsApproved(attestation).catch(() => false)

      console.log(chalk.cyan('redeem-fogo plan'))
      console.log(chalk.dim(`  fogoRpc:                ${fogoRpcUrl}`))
      console.log(chalk.dim(`  payer (signer):         ${keypair.publicKey.toBase58()}`))
      console.log(chalk.dim(`  nttManager (FOGO):      ${nttManagerId}`))
      console.log(chalk.dim(`  fogoOnycMint:              ${fogoOnycMint}`))
      console.log(chalk.dim(`  wormholeCore (FOGO):    ${wormholeCore}`))
      console.log(chalk.dim(`  nttVersion:             ${nttVersion}`))
      console.log(chalk.dim(`  emitterChain:           ${resolved.fromChain}`))
      console.log(chalk.dim(`  sequence:               ${resolved.vaa.sequence}`))
      console.log(chalk.dim(`  trimmedAmount:          ${resolved.manager.trimmedAmount} (decimals=${resolved.manager.trimmedDecimals})`))
      console.log(chalk.dim(`  recipient (FOGO):       ${resolved.recipientOnSolana.toBase58()}`))
      console.log(chalk.dim(`  recipientAta:           ${recipientAta.toBase58()}`))
      console.log(chalk.dim(`  inbox approved:         ${isApproved} ${isApproved ? '(redeem partially run; will resume)' : '(fresh)'}`))

      if (!opts.confirm) {
        console.log()
        console.log(chalk.yellow('dry-run only. Re-run with --confirm to broadcast.'))
        return
      }

      // SolanaNtt.redeem yields multiple unsigned txs in sequence:
      //   1. (verifyVaaShim path) post guardian signatures
      //   2. createAta(recipient) if missing
      //   3. receive_message + redeem + release_inbound_(unlock|mint)
      //      compiled into one v0 transaction with the manager's LUT.
      // The exact count depends on whether the manager uses the verify
      // VAA shim (3.x+) and whether the recipient ATA pre-exists.
      console.log()
      const signatures: string[] = []
      let txIndex = 0
      // SolanaNtt.redeem internally wraps `payer` with `new SolanaAddress(...)`,
      // which accepts a raw PublicKey. The TS signature wants an
      // `AccountAddress<'Fogo'>` so we cast — pulling in
      // `@wormhole-foundation/sdk-solana` just for the constructor would
      // duplicate a transitive dep.
      for await (const unsigned of ntt.redeem(
        [attestation],
        keypair.publicKey as unknown as Parameters<typeof ntt.redeem>[1],
      )) {
        txIndex += 1
        const tx = unsigned.transaction.transaction
        const signers = unsigned.transaction.signers ?? []
        const description = unsigned.description
        console.log(chalk.cyan(`TX ${txIndex}: ${description}`))

        const sig = await runTx(async () => {
          const { blockhash, lastValidBlockHeight } = await fogoConnection.getLatestBlockhash('confirmed')
          let raw: Uint8Array
          if (tx instanceof VersionedTransaction) {
            tx.message.recentBlockhash = blockhash
            tx.sign([keypair, ...signers])
            raw = tx.serialize()
          } else {
            tx.recentBlockhash = blockhash
            tx.feePayer = keypair.publicKey
            tx.sign(keypair, ...signers)
            raw = tx.serialize()
          }
          const s = await fogoConnection.sendRawTransaction(raw, { skipPreflight: false })
          await fogoConnection.confirmTransaction(
            { signature: s, blockhash, lastValidBlockHeight },
            'confirmed',
          )
          return s
        })
        console.log(chalk.dim(`  landed: ${sig}`))
        signatures.push(sig)
      }

      // Post-mint balance read. If the recipient ATA didn't exist
      // pre-redeem, the unlock/mint ix created it; either way it should
      // hold trimmedAmount * 10^(mintDecimals - trimmedDecimals) ONyc
      // by the time the last tx confirms. A failure here is informational
      // only — the redeem already landed.
      let mintedAmount: string | null = null
      try {
        const bal = await fogoConnection.getTokenAccountBalance(recipientAta, 'confirmed')
        mintedAmount = bal.value.amount
      } catch {
        // ATA read can race the unlock-mint commit on slow RPCs.
      }
      // Suppress unused-binding lint while keeping `provider` available
      // for future ix-builder helpers that take an AnchorProvider.
      void fogoProvider

      console.log()
      console.log(chalk.green('redeem-fogo landed — ONyc minted on FOGO'))
      console.log(chalk.dim(`  recipientAta:   ${recipientAta.toBase58()}`))
      if (mintedAmount !== null) {
        console.log(chalk.dim(`  ataBalance:     ${mintedAmount}`))
      }
      console.log(chalk.dim(`  txCount:        ${signatures.length}`))
      for (const [i, s] of signatures.entries()) {
        console.log(chalk.dim(`  tx[${i}]:        ${s}`))
      }
    })

  return cranker
}

interface FetchVaaArgs {
  fogoTx: string
  vaaHex?: string
  wormholescanUrl?: string
}

async function fetchVaaBytes(args: FetchVaaArgs): Promise<Uint8Array> {
  if (args.vaaHex) {
    const hex = args.vaaHex.startsWith('0x') ? args.vaaHex.slice(2) : args.vaaHex
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
      throw new Error('--vaa must be a hex string (optional 0x prefix)')
    }
    return Uint8Array.from(Buffer.from(hex, 'hex'))
  }
  const wh = new WormholescanClient({ baseUrl: args.wormholescanUrl })
  const bytes = await wh.resolveVaaByTxHash(args.fogoTx)
  if (!bytes) {
    throw new Error(
      `Wormholescan returned no VAA for tx ${args.fogoTx} — `
      + `guardians may not have observed it yet (typical lag: a few seconds), `
      + `or the tx didn't emit a Wormhole message.`,
    )
  }
  return bytes
}

function printFlow(label: string, flow: FlowAccount) {
  const sender = new PublicKey(Uint8Array.from(flow.fogoSender as ArrayLike<number>))
  console.log(chalk.cyan(`\nFlow (${label})`))
  console.log(chalk.dim(`  fogoSender: ${sender.toBase58()}`))
  console.log(chalk.dim(`  status:     ${describeStatus(flow.status)}`))
  console.log(chalk.dim(`  amount:     ${flow.amount.toString()}`))
  console.log(chalk.dim(`  payer:      ${flow.payer.toBase58()}`))
}

function nextDepositStep(status: FlowAccount['status'], fogoTx: string): string {
  // Deposit chain (set by relayer instructions, see programs/relayer/src/instructions/*.rs):
  //   claim_usdc          → Claimed
  //   swap_usdc_to_onyc   → Swapped
  //   lock_onyc           → Flow closed (no terminal status — handled by !inflight branch upstream)
  if ('claimed' in status) {
    return `cranker swap-usdc-to-onyc --fogo-tx ${fogoTx}`
  }
  if ('swapped' in status) {
    return `cranker lock-onyc --fogo-tx ${fogoTx}`
  }
  return `unknown — inflight Flow in unexpected state ${describeStatus(status)} for the deposit chain`
}

function nextWithdrawStep(status: FlowAccount['status'], fogoTx: string): string {
  // Withdraw chain:
  //   unlock_onyc             → Claimed
  //   request_redemption_onyc → RedemptionPending
  //   claim_redemption_usdc   → Swapped
  //   send_usdc_to_user       → Flow closed
  if ('claimed' in status) {
    return `cranker request-redemption --fogo-tx ${fogoTx}  (not yet implemented in CLI v1)`
  }
  if ('redemptionPending' in status) {
    return `cranker claim-redemption --fogo-tx ${fogoTx}    (not yet implemented in CLI v1)`
  }
  if ('swapped' in status) {
    return `cranker send-usdc-to-user --fogo-tx ${fogoTx}   (not yet implemented in CLI v1)`
  }
  return `unknown — outflight Flow in unexpected state ${describeStatus(status)} for the withdraw chain`
}

interface MakeSolanaNttArgs {
  connection: Connection
  manager: PublicKey
  token: PublicKey
  wormholeCore: string
  version: string
}

/**
 * Build a `SolanaNtt` instance configured for the OnRe ONyc deployment.
 * The transceiver is baked into the manager binary, so we wire
 * `transceiver.wormhole = manager`. Used both directly by
 * `release-outbound` and by the `advance` orchestrator step.
 */
function makeSolanaNtt(args: MakeSolanaNttArgs): SolanaNtt<'Mainnet', 'Solana'> {
  return new SolanaNtt(
    'Mainnet',
    'Solana',
    args.connection,
    {
      coreBridge: args.wormholeCore,
      ntt: {
        manager: args.manager.toBase58(),
        token: args.token.toBase58(),
        // Baked-in: transceiver program ID == manager program ID.
        transceiver: { wormhole: args.manager.toBase58() },
      },
    },
    args.version,
  )
}

/**
 * Derive the 7-pubkey `release` argument for `client.lockOnyc({...})` from
 * a `SolanaNtt` instance. Pulls the wormhole-core PDAs (bridge,
 * fee_collector, sequence) and the v3 `outbox_item_signer` PDA out of the
 * NTT SDK's own `createReleaseWormholeOutboundIx` so we don't have to
 * mirror those derivations here. Index positions match the mainnet tx
 * `3NR6EEbk…` ordering pinned in `sdk-ntt-release.test.ts`.
 */
async function deriveLockOnycReleaseAccounts(
  ntt: SolanaNtt<'Mainnet', 'Solana'>,
  payer: PublicKey,
  outboxItem: PublicKey,
): Promise<{
  wormholeProgram: PublicKey
  wormholeBridge: PublicKey
  wormholeFeeCollector: PublicKey
  wormholeSequence: PublicKey
  outboxItemSigner: PublicKey
  wormholeMessage: PublicKey
  emitter: PublicKey
}> {
  const xcvr = await ntt.getWormholeTransceiver()
  if (!xcvr) {
    throw new Error('SolanaNttWormholeTransceiver wiring failed.')
  }
  const releaseIx = await xcvr.createReleaseWormholeOutboundIx(payer, outboxItem, false)
  const k = releaseIx.keys
  return {
    wormholeMessage: k[3].pubkey,
    emitter: k[4].pubkey,
    wormholeBridge: k[6].pubkey,
    wormholeFeeCollector: k[7].pubkey,
    wormholeSequence: k[8].pubkey,
    wormholeProgram: k[9].pubkey,
    outboxItemSigner: k[14].pubkey,
  }
}
