import { INTENT_TRANSFER_PROGRAM_ID, MAX_FEE_BPS, ONRE_INTENT_PROGRAM_ID, ONYC_DECIMALS, RELAYER_PROGRAM_ID, USDC_DECIMALS } from '@fogo-onre/sdk'
import { AccountLayout, getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import chalk from 'chalk'
import { Command } from 'commander'
import { runTx, useContext } from '../context'

export function relayerCommands(): Command {
  const relayer = new Command('relayer').description('Relayer program admin commands')

  relayer
    .command('show')
    .description('Show on-chain GlobalConfig + PairConfig + relayer authority PDA')
    .action(async () => {
      const { connection, client } = useContext()

      console.log(chalk.cyan('Relayer'))
      console.log(chalk.dim(`  programId:       ${RELAYER_PROGRAM_ID.toBase58()}`))
      console.log(chalk.dim(`  globalConfigPda: ${client.globalConfigPda.toBase58()}`))
      console.log(chalk.dim(`  configPda:       ${client.configPda.toBase58()}`))
      console.log(chalk.dim(`  authorityPda:    ${client.authorityPda.toBase58()}`))

      const globalAcct = await connection.getAccountInfo(client.globalConfigPda)
      if (!globalAcct) {
        console.log(chalk.yellow('\nGlobalConfig not found — run `relayer bootstrap` first'))
      } else {
        const g = await client.program.account.globalConfig.fetch(client.globalConfigPda)
        console.log(chalk.cyan('\nGlobalConfig'))
        console.log(chalk.dim(`  admin:        ${g.admin.toBase58()}`))
        console.log(chalk.dim(`  pendingAdmin: ${g.pendingAdmin?.toBase58() ?? '<none>'}`))
      }

      const pairAcct = await connection.getAccountInfo(client.configPda)
      if (!pairAcct) {
        console.log(chalk.yellow('\nPairConfig not found — this pair is not initialized'))
        return
      }
      const config = await client.fetchConfig()
      console.log(chalk.cyan('\nPairConfig'))
      console.log(chalk.dim(`  authority:        ${config.authority.toBase58()}`))
      console.log(chalk.dim(`  pendingAuthority: ${config.pendingAuthority?.toBase58() ?? '<none>'}`))
      console.log(chalk.dim(`  baseMint:         ${config.baseMint.toBase58()}`))
      console.log(chalk.dim(`  assetMint:        ${config.assetMint.toBase58()}`))
      console.log(chalk.dim(`  feeVault:         ${config.feeVault.toBase58()}`))
      console.log(chalk.dim(`  nttBaseProgram:   ${config.nttBaseProgram.toBase58()}`))
      console.log(chalk.dim(`  nttAssetProgram:  ${config.nttAssetProgram.toBase58()}`))
      console.log(chalk.dim(`  intentPrograms:   [${config.intentPrograms[0].toBase58()}, ${config.intentPrograms[1].toBase58()}]`))
      console.log(chalk.dim(`  depositFeeBps:    ${config.depositFeeBps}`))
      console.log(chalk.dim(`  withdrawFeeBps:   ${config.withdrawFeeBps}`))
    })

  relayer
    .command('bootstrap')
    .description('One-time global init: create the admin-gated GlobalConfig singleton')
    .option('--admin <pubkey>', 'Admin pubkey allowed to create pairs (default: signer)')
    .option('--confirm', 'Actually broadcast the transaction (default: dry-run)')
    .action(async (opts: { admin?: string, confirm?: boolean }) => {
      const { connection, keypair, client } = useContext()

      const admin = opts.admin ? new PublicKey(opts.admin) : keypair.publicKey

      const programAcct = await connection.getAccountInfo(RELAYER_PROGRAM_ID)
      if (!programAcct?.executable) {
        throw new Error(`relayer program ${RELAYER_PROGRAM_ID.toBase58()} not found or not executable on ${connection.rpcEndpoint}`)
      }
      const existing = await connection.getAccountInfo(client.globalConfigPda)
      if (existing) {
        throw new Error(`GlobalConfig already exists at ${client.globalConfigPda.toBase58()}`)
      }

      console.log(chalk.cyan('Initialize plan'))
      console.log(chalk.dim(`  globalConfigPda: ${client.globalConfigPda.toBase58()}  (will be created)`))
      console.log(chalk.dim(`  admin:            ${admin.toBase58()}`))

      if (!opts.confirm) {
        console.log()
        console.log(chalk.yellow('dry-run only. Re-run with --confirm to broadcast.'))
        return
      }

      console.log()
      const sig = await runTx(() => client.bootstrap({ admin }).rpc())
      console.log(chalk.green('GlobalConfig initialized'))
      console.log(chalk.dim(`  tx: ${sig}`))
    })

  relayer
    .command('initialize')
    .description('Create a pair PairConfig + relayer-owned ATAs (admin-only)')
    .option('--usdc-mint <pubkey>', 'Pair base mint on Solana (default: --base-mint)')
    .option('--onyc-mint <pubkey>', 'Pair asset mint on Solana (default: --asset-mint)')
    .option('--fee-vault <pubkey>', 'External ONyc token account for protocol fees (default: signer\'s ONyc ATA)')
    .requiredOption('--deposit-fee-bps <bps>', 'Deposit fee in basis points')
    .requiredOption('--withdraw-fee-bps <bps>', 'Withdraw fee in basis points')
    .option('--intent-programs <pubkeys>', 'Comma-separated pair of inbound VAA originators (default: [intent_transfer, onre_fork])')
    .option('--confirm', 'Actually broadcast the transaction (default: dry-run)')
    .action(async (opts: {
      usdcMint?: string
      onycMint?: string
      feeVault?: string
      depositFeeBps: string
      withdrawFeeBps: string
      intentPrograms?: string
      confirm?: boolean
    }) => {
      const { connection, keypair, client } = useContext()

      const usdcMint = opts.usdcMint ? new PublicKey(opts.usdcMint) : client.baseMint
      const onycMint = opts.onycMint ? new PublicKey(opts.onycMint) : client.assetMint
      const feeVault = opts.feeVault
        ? new PublicKey(opts.feeVault)
        : getAssociatedTokenAddressSync(onycMint, keypair.publicKey)
      const depositFeeBps = Number(opts.depositFeeBps)
      const withdrawFeeBps = Number(opts.withdrawFeeBps)
      const authority = keypair.publicKey
      const intentPrograms = parseIntentPrograms(opts.intentPrograms)

      // Pre-flight 1: program deployed.
      const programAcct = await connection.getAccountInfo(RELAYER_PROGRAM_ID)
      if (!programAcct) {
        throw new Error(
          `relayer program ${RELAYER_PROGRAM_ID.toBase58()} not found on ${connection.rpcEndpoint}`,
        )
      }
      if (!programAcct.executable) {
        throw new Error(`account at ${RELAYER_PROGRAM_ID.toBase58()} is not executable`)
      }

      // Pre-flight 2: PairConfig must NOT exist.
      const existing = await connection.getAccountInfo(client.configPda)
      if (existing) {
        throw new Error(`PairConfig already exists at ${client.configPda.toBase58()}`)
      }

      // Pre-flight 3: mints exist with expected decimals.
      const usdc = await getMint(connection, usdcMint).catch(() => {
        throw new Error(`USDC mint ${usdcMint.toBase58()} not found on ${connection.rpcEndpoint}`)
      })
      if (usdc.decimals !== USDC_DECIMALS) {
        throw new Error(`USDC mint decimals = ${usdc.decimals}, expected ${USDC_DECIMALS}`)
      }
      const onyc = await getMint(connection, onycMint).catch(() => {
        throw new Error(`ONyc mint ${onycMint.toBase58()} not found on ${connection.rpcEndpoint}`)
      })
      if (onyc.decimals !== ONYC_DECIMALS) {
        throw new Error(`ONyc mint decimals = ${onyc.decimals}, expected ${ONYC_DECIMALS}`)
      }

      // Pre-flight 4: feeVault is an ONyc SPL token account, not the relayer's own ATA.
      const feeVaultAcct = await connection.getAccountInfo(feeVault)
      if (!feeVaultAcct) {
        throw new Error(`feeVault ${feeVault.toBase58()} does not exist`)
      }
      if (!feeVaultAcct.owner.equals(TOKEN_PROGRAM_ID)) {
        throw new Error(`feeVault ${feeVault.toBase58()} is not owned by SPL Token program`)
      }
      const tokenAcct = AccountLayout.decode(feeVaultAcct.data)
      const fvMint = new PublicKey(tokenAcct.mint)
      const fvOwner = new PublicKey(tokenAcct.owner)
      if (!fvMint.equals(onycMint)) {
        throw new Error(`feeVault holds mint ${fvMint.toBase58()}, expected ${onycMint.toBase58()}`)
      }
      if (fvOwner.equals(client.authorityPda)) {
        throw new Error(
          `feeVault is owned by relayer authority PDA — would alias the operating ATA. Use a separately-owned ONyc account.`,
        )
      }

      // Pre-flight 5: fee bps within bounds.
      for (const [name, bps] of [
        ['deposit-fee-bps', depositFeeBps],
        ['withdraw-fee-bps', withdrawFeeBps],
      ] as const) {
        if (!Number.isInteger(bps) || bps < 0 || bps > MAX_FEE_BPS) {
          throw new Error(`${name} = ${bps} out of range [0, ${MAX_FEE_BPS}]`)
        }
      }

      console.log(chalk.cyan('Initialize plan'))
      console.log(chalk.dim(`  configPda:        ${client.configPda.toBase58()}  (will be created)`))
      console.log(chalk.dim(`  authorityPda:     ${client.authorityPda.toBase58()}`))
      console.log(chalk.dim(`  authority field:  ${authority.toBase58()}`))
      console.log(chalk.dim(`  usdcMint:         ${usdcMint.toBase58()}  (decimals=${usdc.decimals})`))
      console.log(chalk.dim(`  onycMint:         ${onycMint.toBase58()}  (decimals=${onyc.decimals})`))
      console.log(chalk.dim(`  feeVault:         ${feeVault.toBase58()}  (owner=${fvOwner.toBase58()})`))
      console.log(chalk.dim(`  depositFeeBps:    ${depositFeeBps}`))
      console.log(chalk.dim(`  withdrawFeeBps:   ${withdrawFeeBps}`))
      console.log(chalk.dim(`  intentPrograms:   [${intentPrograms[0].toBase58()}, ${intentPrograms[1].toBase58()}]`))

      if (!opts.confirm) {
        console.log()
        console.log(chalk.yellow('dry-run only. Re-run with --confirm to broadcast.'))
        return
      }

      console.log()
      const sig = await runTx(() =>
        client
          .initialize({
            authority,
            baseMint: usdcMint,
            assetMint: onycMint,
            feeVault,
            depositFeeBps,
            withdrawFeeBps,
            intentPrograms,
          })
          .rpc(),
      )

      console.log(chalk.green('Pair initialized'))
      console.log(chalk.dim(`  tx: ${sig}`))
    })

  relayer
    .command('configure')
    .description('Update mutable GlobalConfig fields (authority-only)')
    .option('--fee-vault <pubkey>', 'New ONyc fee vault (must hold ONyc, not be relayer ATA)')
    .option('--deposit-fee-bps <bps>', 'New deposit fee bps (subject to timelock for increases)')
    .option('--withdraw-fee-bps <bps>', 'New withdraw fee bps (subject to timelock for increases)')
    .option('--new-authority <pubkey>', 'Set pendingAuthority (claimed via accept-authority)')
    .option('--clear-pending-authority', 'Cancel a pending authority handover')
    .option('--confirm', 'Actually broadcast the transaction (default: dry-run)')
    .action(async (opts: {
      feeVault?: string
      depositFeeBps?: string
      withdrawFeeBps?: string
      newAuthority?: string
      clearPendingAuthority?: boolean
      confirm?: boolean
    }) => {
      const { keypair, client } = useContext()

      const config = await client.fetchConfig()
      if (!config.authority.equals(keypair.publicKey)) {
        throw new Error(
          `signer ${keypair.publicKey.toBase58()} is not the current authority (${config.authority.toBase58()})`,
        )
      }

      const feeVault = opts.feeVault ? new PublicKey(opts.feeVault) : undefined
      const depositFeeBps = opts.depositFeeBps !== undefined ? Number(opts.depositFeeBps) : undefined
      const withdrawFeeBps = opts.withdrawFeeBps !== undefined ? Number(opts.withdrawFeeBps) : undefined
      const newAuthority = opts.clearPendingAuthority
        ? null
        : opts.newAuthority
          ? new PublicKey(opts.newAuthority)
          : undefined

      // Validate fee bounds locally; on-chain is the source of truth.
      for (const [name, bps] of [
        ['deposit-fee-bps', depositFeeBps],
        ['withdraw-fee-bps', withdrawFeeBps],
      ] as const) {
        if (bps !== undefined && (!Number.isInteger(bps) || bps < 0 || bps > MAX_FEE_BPS)) {
          throw new Error(`${name} = ${bps} out of range [0, ${MAX_FEE_BPS}]`)
        }
      }
      const noChange
        = feeVault === undefined
          && depositFeeBps === undefined
          && withdrawFeeBps === undefined
          && newAuthority === undefined
      if (noChange) {
        throw new Error('no fields to update — pass at least one --fee-vault / --*-fee-bps / --new-authority / --clear-pending-authority')
      }

      console.log(chalk.cyan('Configure plan'))
      console.log(chalk.dim(`  signer (current authority): ${keypair.publicKey.toBase58()}`))
      if (feeVault) {
        console.log(chalk.dim(`  feeVault:        ${config.feeVault.toBase58()} → ${feeVault.toBase58()}`))
      }
      if (depositFeeBps !== undefined) {
        console.log(chalk.dim(`  depositFeeBps:   ${config.depositFeeBps} → ${depositFeeBps}`))
      }
      if (withdrawFeeBps !== undefined) {
        console.log(chalk.dim(`  withdrawFeeBps:  ${config.withdrawFeeBps} → ${withdrawFeeBps}`))
      }
      if (newAuthority === null) {
        console.log(chalk.dim(`  pendingAuthority: <cleared>`))
      } else if (newAuthority) {
        console.log(chalk.dim(`  pendingAuthority: ${newAuthority.toBase58()}  (must call accept-authority from this key)`))
      }

      if (!opts.confirm) {
        console.log()
        console.log(chalk.yellow('dry-run only. Re-run with --confirm to broadcast.'))
        return
      }

      console.log()
      const sig = await runTx(async () => {
        const builder = await client.configure({
          feeVault: feeVault ?? undefined,
          depositFeeBps: depositFeeBps ?? null,
          withdrawFeeBps: withdrawFeeBps ?? null,
          newAuthority: newAuthority ?? null,
        })
        return builder.rpc()
      })

      console.log(chalk.green('Relayer configured'))
      console.log(chalk.dim(`  tx: ${sig}`))
    })

  relayer
    .command('set-admin')
    .description('Propose a new GlobalConfig admin (step 1 of two-step rotation, admin-only)')
    .requiredOption('--new-admin <pubkey>', 'Pubkey to stage as pending admin')
    .option('--confirm', 'Actually broadcast the transaction (default: dry-run)')
    .action(async (opts: { newAdmin: string, confirm?: boolean }) => {
      const { keypair, client } = useContext()

      const newAdmin = new PublicKey(opts.newAdmin)
      const config = await client.program.account.globalConfig.fetch(client.globalConfigPda)
      if (!config.admin.equals(keypair.publicKey)) {
        throw new Error(
          `signer ${keypair.publicKey.toBase58()} is not the current admin (${config.admin.toBase58()})`,
        )
      }
      if (newAdmin.equals(config.admin)) {
        throw new Error('--new-admin equals the current admin — self-rotate is rejected')
      }

      console.log(chalk.cyan('Set-admin plan'))
      console.log(chalk.dim(`  signer (current admin): ${keypair.publicKey.toBase58()}`))
      console.log(chalk.dim(`  pendingAdmin:           ${newAdmin.toBase58()}  (must call accept-admin from this key)`))

      if (!opts.confirm) {
        console.log()
        console.log(chalk.yellow('dry-run only. Re-run with --confirm to broadcast.'))
        return
      }

      console.log()
      const sig = await runTx(() => client.setAdmin({ newAdmin }).rpc())
      console.log(chalk.green('Pending admin staged'))
      console.log(chalk.dim(`  tx: ${sig}`))
    })

  relayer
    .command('accept-admin')
    .description('Claim the GlobalConfig admin role (step 2, must be signed by the pending admin)')
    .option('--confirm', 'Actually broadcast the transaction (default: dry-run)')
    .action(async (opts: { confirm?: boolean }) => {
      const { keypair, client } = useContext()

      const config = await client.program.account.globalConfig.fetch(client.globalConfigPda)
      if (!config.pendingAdmin) {
        throw new Error('no pending admin to accept')
      }
      if (!config.pendingAdmin.equals(keypair.publicKey)) {
        throw new Error(
          `signer ${keypair.publicKey.toBase58()} is not the pending admin (${config.pendingAdmin.toBase58()})`,
        )
      }

      console.log(chalk.cyan('Accept-admin plan'))
      console.log(chalk.dim(`  current admin: ${config.admin.toBase58()}`))
      console.log(chalk.dim(`  signer (pending admin): ${keypair.publicKey.toBase58()}  (becomes admin)`))

      if (!opts.confirm) {
        console.log()
        console.log(chalk.yellow('dry-run only. Re-run with --confirm to broadcast.'))
        return
      }

      console.log()
      const sig = await runTx(() => client.acceptAdmin().rpc())
      console.log(chalk.green('Admin role accepted'))
      console.log(chalk.dim(`  tx: ${sig}`))
    })

  return relayer
}

/** Parse a comma-separated pair of pubkeys; defaults to the OnRe originators. */
function parseIntentPrograms(raw?: string): [PublicKey, PublicKey] {
  if (!raw) {
    return [INTENT_TRANSFER_PROGRAM_ID, ONRE_INTENT_PROGRAM_ID]
  }
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length !== 2) {
    throw new Error(`--intent-programs expects exactly 2 comma-separated pubkeys, got ${parts.length}`)
  }
  return [new PublicKey(parts[0]), new PublicKey(parts[1])]
}
