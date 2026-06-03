import { MAX_FEE_BPS, MAX_SLIPPAGE_BPS, ONYC_DECIMALS, ONYC_MINT, RELAYER_PROGRAM_ID, USDC_DECIMALS, USDC_MINT } from '@fogo-onre/sdk'
import { AccountLayout, getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import chalk from 'chalk'
import { Command } from 'commander'
import { runTx, useContext } from '../context'

export function relayerCommands(): Command {
  const relayer = new Command('relayer').description('Relayer program admin commands')

  relayer
    .command('show')
    .description('Show on-chain RelayerConfig + relayer authority PDA')
    .action(async () => {
      const { connection, client } = useContext()

      console.log(chalk.cyan('Relayer'))
      console.log(chalk.dim(`  programId:    ${RELAYER_PROGRAM_ID.toBase58()}`))
      console.log(chalk.dim(`  configPda:    ${client.configPda.toBase58()}`))
      console.log(chalk.dim(`  authorityPda: ${client.authorityPda.toBase58()}`))

      const acct = await connection.getAccountInfo(client.configPda)
      if (!acct) {
        console.log(chalk.yellow('\nRelayerConfig not found — relayer is not initialized'))
        return
      }
      const config = await client.fetchConfig()
      console.log(chalk.cyan('\nRelayerConfig'))
      console.log(chalk.dim(`  authority:        ${config.authority.toBase58()}`))
      console.log(chalk.dim(`  pendingAuthority: ${config.pendingAuthority?.toBase58() ?? '<none>'}`))
      console.log(chalk.dim(`  baseMint:         ${config.baseMint.toBase58()}`))
      console.log(chalk.dim(`  assetMint:        ${config.assetMint.toBase58()}`))
      console.log(chalk.dim(`  feeVault:         ${config.feeVault.toBase58()}`))
      console.log(chalk.dim(`  depositFeeBps:    ${config.depositFeeBps}`))
      console.log(chalk.dim(`  withdrawFeeBps:   ${config.withdrawFeeBps}`))
      console.log(chalk.dim(`  maxSlippageBps:   ${config.maxSlippageBps}  (cap ${MAX_SLIPPAGE_BPS})`))
    })

  relayer
    .command('initialize')
    .description('One-time initialize: create RelayerConfig + relayer-owned ATAs')
    .option('--usdc-mint <pubkey>', `USDC mint on Solana (default: ${USDC_MINT.toBase58()})`)
    .option('--onyc-mint <pubkey>', `ONyc mint on Solana (default: ${ONYC_MINT.toBase58()})`)
    .option('--fee-vault <pubkey>', 'External ONyc token account for protocol fees (default: signer\'s ONyc ATA)')
    .requiredOption('--deposit-fee-bps <bps>', 'Deposit fee in basis points')
    .requiredOption('--withdraw-fee-bps <bps>', 'Withdraw fee in basis points')
    .option('--authority <pubkey>', 'Authority pubkey to write into RelayerConfig (default: signer)')
    .option('--confirm', 'Actually broadcast the transaction (default: dry-run)')
    .action(async (opts: {
      usdcMint?: string
      onycMint?: string
      feeVault?: string
      depositFeeBps: string
      withdrawFeeBps: string
      authority?: string
      confirm?: boolean
    }) => {
      const { connection, keypair, client } = useContext()

      const usdcMint = opts.usdcMint ? new PublicKey(opts.usdcMint) : USDC_MINT
      const onycMint = opts.onycMint ? new PublicKey(opts.onycMint) : ONYC_MINT
      const feeVault = opts.feeVault
        ? new PublicKey(opts.feeVault)
        : getAssociatedTokenAddressSync(onycMint, keypair.publicKey)
      const depositFeeBps = Number(opts.depositFeeBps)
      const withdrawFeeBps = Number(opts.withdrawFeeBps)
      const authority = opts.authority ? new PublicKey(opts.authority) : keypair.publicKey

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

      // Pre-flight 2: RelayerConfig must NOT exist.
      const existing = await connection.getAccountInfo(client.configPda)
      if (existing) {
        throw new Error(`RelayerConfig already exists at ${client.configPda.toBase58()}`)
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
          })
          .rpc(),
      )

      console.log(chalk.green('Relayer initialized'))
      console.log(chalk.dim(`  tx: ${sig}`))
    })

  relayer
    .command('configure')
    .description('Update mutable RelayerConfig fields (authority-only)')
    .option('--fee-vault <pubkey>', 'New ONyc fee vault (must hold ONyc, not be relayer ATA)')
    .option('--deposit-fee-bps <bps>', 'New deposit fee bps (subject to timelock for increases)')
    .option('--withdraw-fee-bps <bps>', 'New withdraw fee bps (subject to timelock for increases)')
    .option('--max-slippage-bps <bps>', `New NAV slippage floor + Jupiter quote slippage, bps [0, ${MAX_SLIPPAGE_BPS}] (no timelock)`)
    .option('--new-authority <pubkey>', 'Set pendingAuthority (claimed via accept-authority)')
    .option('--clear-pending-authority', 'Cancel a pending authority handover')
    .option('--confirm', 'Actually broadcast the transaction (default: dry-run)')
    .action(async (opts: {
      feeVault?: string
      depositFeeBps?: string
      withdrawFeeBps?: string
      maxSlippageBps?: string
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
      const maxSlippageBps = opts.maxSlippageBps !== undefined ? Number(opts.maxSlippageBps) : undefined
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
      if (maxSlippageBps !== undefined && (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > MAX_SLIPPAGE_BPS)) {
        throw new Error(`max-slippage-bps = ${maxSlippageBps} out of range [0, ${MAX_SLIPPAGE_BPS}]`)
      }

      const noChange
        = feeVault === undefined
          && depositFeeBps === undefined
          && withdrawFeeBps === undefined
          && maxSlippageBps === undefined
          && newAuthority === undefined
      if (noChange) {
        throw new Error('no fields to update — pass at least one --fee-vault / --*-fee-bps / --max-slippage-bps / --new-authority / --clear-pending-authority')
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
      if (maxSlippageBps !== undefined) {
        console.log(chalk.dim(`  maxSlippageBps:  ${config.maxSlippageBps} → ${maxSlippageBps}`))
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
          maxSlippageBps: maxSlippageBps ?? null,
          newAuthority: newAuthority ?? null,
        })
        return builder.rpc()
      })

      console.log(chalk.green('Relayer configured'))
      console.log(chalk.dim(`  tx: ${sig}`))
    })

  return relayer
}
