// One-off: correct the ONyc FeeConfig on FOGO. The ONyc leg's fees were set
// with the same raw values as the 6-decimal USDC leg, but ONyc has 9 decimals
// — under-charging by 1000x. This rescales both fees and preserves the
// already-migrated fee_recipient (tiaModT7).
//
//   bridge_transfer_fee:    2_000_000   (0.002 ONyc) -> 2_000_000_000   (2 ONyc)
//   intrachain_transfer_fee:   10_000 (0.00001 ONyc) ->    10_000_000 (0.01 ONyc)
//
// Upgrade-authority gated (tiaModT7 signs). Dry-run + simulate by default;
// pass --confirm to broadcast.
//
// Usage:
//   node scripts/fix-onyc-fee.mjs                 # dry-run + simulate
//   node scripts/fix-onyc-fee.mjs --confirm       # broadcast
//   node scripts/fix-onyc-fee.mjs --keypair /path/to/id.json --confirm

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'

const RPC = process.env.FOGO_RPC_URL ?? 'https://mainnet.fogo.io'
const INTENT_PROGRAM = new PublicKey('inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9')
const ONYC_MINT = new PublicKey('oNyCm1QsAatj3ckaEwZjtAPWvstPn3Zm5MAYPtkjEfa')
const EXPECTED_AUTHORITY = new PublicKey('tiaModT7KBWK1hNLFu94FogDGMs1haBZTupHujGzKLA')
const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const UPDATE_FEE_CONFIG_DISCRIMINATOR = 0x05

const NEW_INTRACHAIN_FEE = 10_000_000n // 0.01 ONyc
const NEW_BRIDGE_FEE = 2_000_000_000n // 2 ONyc

const args = process.argv.slice(2)
const confirm = args.includes('--confirm')
const kpFlag = args.indexOf('--keypair')
const kpPath = kpFlag >= 0 ? args[kpFlag + 1] : `${homedir()}/.config/solana/id.json`

const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(kpPath, 'utf8'))))
if (!keypair.publicKey.equals(EXPECTED_AUTHORITY)) {
  throw new Error(`signer ${keypair.publicKey.toBase58()} != upgrade authority ${EXPECTED_AUTHORITY.toBase58()}`)
}

const conn = new Connection(RPC, 'confirmed')
const [programData] = PublicKey.findProgramAddressSync([INTENT_PROGRAM.toBuffer()], BPF_LOADER_UPGRADEABLE)
const [feeConfig] = PublicKey.findProgramAddressSync([Buffer.from('fee_config'), ONYC_MINT.toBuffer()], INTENT_PROGRAM)

// Read + print current state (and reuse the live fee_recipient verbatim).
const before = (await conn.getAccountInfo(feeConfig))?.data
if (!before || before.length < 56) {
  throw new Error(`FeeConfig ${feeConfig.toBase58()} missing or un-migrated (len=${before?.length ?? 0})`)
}
const feeRecipient = new PublicKey(before.subarray(24, 56))
console.log('FeeConfig PDA :', feeConfig.toBase58())
console.log('  intrachain  :', before.readBigUInt64LE(8).toString(), '->', NEW_INTRACHAIN_FEE.toString())
console.log('  bridge      :', before.readBigUInt64LE(16).toString(), '->', NEW_BRIDGE_FEE.toString())
console.log('  recipient   :', feeRecipient.toBase58(), '(preserved)')

const data = Buffer.alloc(1 + 8 + 8 + 32)
data[0] = UPDATE_FEE_CONFIG_DISCRIMINATOR
data.writeBigUInt64LE(NEW_INTRACHAIN_FEE, 1)
data.writeBigUInt64LE(NEW_BRIDGE_FEE, 9)
data.set(feeRecipient.toBuffer(), 17)

const ix = new TransactionInstruction({
  programId: INTENT_PROGRAM,
  keys: [
    { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
    { pubkey: programData, isSigner: false, isWritable: false },
    { pubkey: ONYC_MINT, isSigner: false, isWritable: false },
    { pubkey: feeConfig, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data,
})

const { blockhash } = await conn.getLatestBlockhash('confirmed')
const tx = new Transaction({ feePayer: keypair.publicKey, recentBlockhash: blockhash }).add(ix)
tx.sign(keypair)

const sim = await conn.simulateTransaction(tx)
console.log('\nsimulation err:', sim.value.err)
if (sim.value.logs) {
  console.log(sim.value.logs.join('\n'))
}
if (sim.value.err) {
  throw new Error('simulation failed — not broadcasting')
}

if (!confirm) {
  console.log('\ndry-run only. Re-run with --confirm to broadcast.')
  process.exit(0)
}

const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false })
await conn.confirmTransaction(sig, 'confirmed')
console.log('\nbroadcast OK. sig:', sig)
