import {
  buildUpdateFeeConfigIx,
  findFeeConfigPda,
  FOGO_ONYC_MINT,
  ONRE_INTENT_PROGRAM_ID,
} from '@fogo-yield/sdk'
import { getMint } from '@solana/spl-token'
import { PublicKey, Transaction } from '@solana/web3.js'
import chalk from 'chalk'
import { Command } from 'commander'
import { runTx, useContext } from '../context'

interface FeeConfigState {
  intrachainTransferFee: bigint
  bridgeTransferFee: bigint
  feeRecipient: PublicKey
}

// 8-byte Anchor disc, u64 LE intrachain (8), u64 LE bridge (16), Pubkey (24).
function decodeFeeConfig(data: Buffer): FeeConfigState {
  if (data.length < 8 + 8 + 8 + 32) {
    throw new Error(
      `FeeConfig account is ${data.length} bytes, expected >= 56 — un-migrated (old layout)? run the migration before editing fees`,
    )
  }
  return {
    intrachainTransferFee: data.readBigUInt64LE(8),
    bridgeTransferFee: data.readBigUInt64LE(16),
    feeRecipient: new PublicKey(data.subarray(24, 56)),
  }
}

// UpgradeableLoaderState::ProgramData = u32 variant(4) + slot u64(8) + Option<Pubkey>(1 + 32).
function readUpgradeAuthority(programData: Buffer): PublicKey | null {
  if (programData.length < 45 || programData[12] !== 1) {
    return null
  }
  return new PublicKey(programData.subarray(13, 45))
}

// Exact decimal-string → base units; rejects floats and over-precision.
function tokensToBaseUnits(amount: string, decimals: number): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(amount)) {
    throw new Error(`invalid amount "${amount}" — expected a non-negative decimal`)
  }
  const [whole, frac = ''] = amount.split('.')
  if (frac.length > decimals) {
    throw new Error(`amount "${amount}" exceeds ${decimals} fractional digits`)
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
}

function formatBaseUnits(units: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals)
  const frac = (units % d).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${units / d}.${frac}` : `${units / d}`
}

async function mintDecimals(connection: ReturnType<typeof useContext>['connection'], mint: PublicKey): Promise<number> {
  const info = await getMint(connection, mint).catch(() => {
    throw new Error(`mint ${mint.toBase58()} not found on ${connection.rpcEndpoint}`)
  })
  return info.decimals
}

export function intentCommands(): Command {
  const intent = new Command('intent')
    .description('intent_transfer fork admin commands (FOGO) — pass --url https://mainnet.fogo.io')

  intent
    .command('show')
    .description('Show the per-mint FeeConfig (fees + fee_recipient)')
    .option('--mint <pubkey>', `Mint whose FeeConfig to read (default FOGO ONyc ${FOGO_ONYC_MINT.toBase58()})`)
    .action(async (opts: { mint?: string }) => {
      const { connection } = useContext()
      const mint = opts.mint ? new PublicKey(opts.mint) : FOGO_ONYC_MINT
      const pda = findFeeConfigPda(ONRE_INTENT_PROGRAM_ID, mint)

      console.log(chalk.cyan('FeeConfig'))
      console.log(chalk.dim(`  programId: ${ONRE_INTENT_PROGRAM_ID.toBase58()}`))
      console.log(chalk.dim(`  mint:      ${mint.toBase58()}`))
      console.log(chalk.dim(`  pda:       ${pda.toBase58()}`))

      const acct = await connection.getAccountInfo(pda, 'confirmed')
      if (!acct) {
        console.log(chalk.yellow('\nFeeConfig not found — not registered for this mint'))
        return
      }
      const fc = decodeFeeConfig(acct.data)
      const dec = await mintDecimals(connection, mint)
      console.log(chalk.dim(`  intrachainTransferFee: ${fc.intrachainTransferFee}  (${formatBaseUnits(fc.intrachainTransferFee, dec)})`))
      console.log(chalk.dim(`  bridgeTransferFee:     ${fc.bridgeTransferFee}  (${formatBaseUnits(fc.bridgeTransferFee, dec)})`))
      console.log(chalk.dim(`  feeRecipient:          ${fc.feeRecipient.toBase58()}`))
    })

  intent
    .command('update-fee')
    .description('Update a per-mint FeeConfig (upgrade-authority-gated; overwrites all fields)')
    .option('--mint <pubkey>', `Mint whose FeeConfig to edit (default FOGO ONyc ${FOGO_ONYC_MINT.toBase58()})`)
    .option('--bridge-fee <tokens>', 'New bridge (redeem) fee, whole tokens, e.g. 1 = 1 ONyc')
    .option('--intrachain-fee <tokens>', 'New intrachain fee, whole tokens (default: preserve)')
    .option('--fee-recipient <pubkey>', 'New fee recipient (default: preserve)')
    .option('--confirm', 'Actually broadcast the transaction (default: dry-run)')
    .action(async (opts: {
      mint?: string
      bridgeFee?: string
      intrachainFee?: string
      feeRecipient?: string
      confirm?: boolean
    }) => {
      const { connection, keypair, provider } = useContext()
      const mint = opts.mint ? new PublicKey(opts.mint) : FOGO_ONYC_MINT
      const pda = findFeeConfigPda(ONRE_INTENT_PROGRAM_ID, mint)

      // Pre-flight 1: fork program deployed + executable.
      const programAcct = await connection.getAccountInfo(ONRE_INTENT_PROGRAM_ID)
      if (!programAcct) {
        throw new Error(`intent_transfer program ${ONRE_INTENT_PROGRAM_ID.toBase58()} not found on ${connection.rpcEndpoint} — wrong cluster? intent commands need a FOGO RPC, e.g. --url https://mainnet.fogo.io`)
      }
      if (!programAcct.executable) {
        throw new Error(`account at ${ONRE_INTENT_PROGRAM_ID.toBase58()} is not executable`)
      }

      // Pre-flight 2: FeeConfig must already exist — this updates, never creates.
      const acct = await connection.getAccountInfo(pda, 'confirmed')
      if (!acct) {
        throw new Error(`FeeConfig ${pda.toBase58()} not found for mint ${mint.toBase58()} — register it first`)
      }
      const current = decodeFeeConfig(acct.data)

      // Pre-flight 3: signer must be the program's upgrade authority (what the ix checks on-chain).
      const programDataAddr = new PublicKey(programAcct.data.subarray(4, 36))
      const programData = await connection.getAccountInfo(programDataAddr)
      if (!programData) {
        throw new Error(`programData ${programDataAddr.toBase58()} not found`)
      }
      const upgradeAuthority = readUpgradeAuthority(programData.data)
      if (!upgradeAuthority) {
        throw new Error('program is immutable (no upgrade authority) — update_fee_config cannot be signed')
      }
      if (!upgradeAuthority.equals(keypair.publicKey)) {
        throw new Error(`signer ${keypair.publicKey.toBase58()} is not the upgrade authority (${upgradeAuthority.toBase58()})`)
      }

      const dec = await mintDecimals(connection, mint)
      const bridgeTransferFee = opts.bridgeFee !== undefined
        ? tokensToBaseUnits(opts.bridgeFee, dec)
        : current.bridgeTransferFee
      const intrachainTransferFee = opts.intrachainFee !== undefined
        ? tokensToBaseUnits(opts.intrachainFee, dec)
        : current.intrachainTransferFee
      const feeRecipient = opts.feeRecipient ? new PublicKey(opts.feeRecipient) : current.feeRecipient

      const noChange = bridgeTransferFee === current.bridgeTransferFee
        && intrachainTransferFee === current.intrachainTransferFee
        && feeRecipient.equals(current.feeRecipient)
      if (noChange) {
        throw new Error('no fields to change — pass at least one of --bridge-fee / --intrachain-fee / --fee-recipient')
      }

      const arrow = (a: string, b: string): string => a === b ? `${a}  (unchanged)` : `${a} → ${b}`
      console.log(chalk.cyan('Update FeeConfig plan'))
      console.log(chalk.dim(`  signer (upgrade authority): ${keypair.publicKey.toBase58()}`))
      console.log(chalk.dim(`  mint:                  ${mint.toBase58()}  (decimals=${dec})`))
      console.log(chalk.dim(`  feeConfigPda:          ${pda.toBase58()}`))
      console.log(chalk.dim(`  intrachainTransferFee: ${arrow(formatBaseUnits(current.intrachainTransferFee, dec), formatBaseUnits(intrachainTransferFee, dec))}`))
      console.log(chalk.dim(`  bridgeTransferFee:     ${arrow(formatBaseUnits(current.bridgeTransferFee, dec), formatBaseUnits(bridgeTransferFee, dec))}`))
      console.log(chalk.dim(`  feeRecipient:          ${arrow(current.feeRecipient.toBase58(), feeRecipient.toBase58())}`))

      if (!opts.confirm) {
        console.log()
        console.log(chalk.yellow('dry-run only. Re-run with --confirm to broadcast.'))
        return
      }

      const ix = buildUpdateFeeConfigIx({
        intentTransferProgramId: ONRE_INTENT_PROGRAM_ID,
        upgradeAuthority: keypair.publicKey,
        mint,
        feeRecipient,
        intrachainTransferFee,
        bridgeTransferFee,
      })

      console.log()
      const sig = await runTx(() => provider.sendAndConfirm(new Transaction().add(ix)))

      console.log(chalk.green('FeeConfig updated'))
      console.log(chalk.dim(`  tx: ${sig}`))
    })

  return intent
}
