import type { LiteSVM } from 'litesvm'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'

/** Minimum lamports for a rent-exempt Mint account (82 bytes, hardcoded). */
const MINT_RENT = 1_461_600

/** Build a Transaction with a recent blockhash from LiteSVM. */
function buildTx(svm: LiteSVM, payer: PublicKey): Transaction {
  const tx = new Transaction()
  tx.recentBlockhash = svm.latestBlockhash()
  tx.feePayer = payer
  return tx
}

/** Create a new SPL token mint inside LiteSVM. Returns the mint keypair. */
export function createMint(svm: LiteSVM, payer: Keypair, decimals = 6): Keypair {
  const mint = Keypair.generate()
  const tx = buildTx(svm, payer.publicKey)
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports: MINT_RENT,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mint.publicKey, decimals, payer.publicKey, null),
  )
  tx.sign(payer, mint)
  svm.sendTransaction(tx)
  return mint
}

/** Create an ATA and mint tokens into it. Returns the ATA address. */
export function mintTo(
  svm: LiteSVM,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint | number,
): PublicKey {
  const ata = getAssociatedTokenAddressSync(mint, owner, true)
  const tx = buildTx(svm, payer.publicKey)
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint),
    createMintToInstruction(mint, ata, payer.publicKey, amount),
  )
  tx.sign(payer)
  svm.sendTransaction(tx)
  return ata
}

/** Create an ATA (no minting). Returns the ATA address. */
export function createAta(
  svm: LiteSVM,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
): PublicKey {
  const ata = getAssociatedTokenAddressSync(mint, owner, true)
  const tx = buildTx(svm, payer.publicKey)
  tx.add(
    createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint),
  )
  tx.sign(payer)
  svm.sendTransaction(tx)
  return ata
}
