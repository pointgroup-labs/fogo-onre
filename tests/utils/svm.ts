import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Keypair, PublicKey, SendTransactionError, Transaction } from '@solana/web3.js'
import { LiteSVMProvider } from 'anchor-litesvm'
import bs58 from 'bs58'
import { FailedTransactionMetadata, LiteSVM } from 'litesvm'

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures',
)

/**
 * Create a LiteSVM instance with all program `.so` files loaded from
 * `tests/fixtures/programs/`. Filename (minus `.so`) is the program ID.
 */
export function createSvm(): LiteSVM {
  const svm = new LiteSVM()
  const programsDir = path.join(FIXTURES_DIR, 'programs')
  for (const file of fs.readdirSync(programsDir).filter(f => f.endsWith('.so'))) {
    const programId = path.basename(file, '.so')
    svm.addProgramFromFile(new PublicKey(programId), path.join(programsDir, file))
  }
  return svm
}

/** Minimal Wallet implementation compatible with anchor-litesvm's Wallet interface. */
class SimpleWallet {
  constructor(readonly payer: Keypair) {}
  get publicKey() { return this.payer.publicKey }
  async signTransaction<T extends Transaction>(tx: T): Promise<T> {
    tx.partialSign(this.payer)
    return tx
  }

  async signAllTransactions<T extends Transaction>(txs: T[]): Promise<T[]> {
    txs.forEach(tx => tx.partialSign(this.payer))
    return txs
  }
}

/**
 * Create a LiteSVM + LiteSVMProvider pair, airdropping SOL to the payer.
 * Uses `as any` cast because anchor-litesvm@0.2.1 declares dependency on
 * @coral-xyz/anchor while we use @anchor-lang/core (structurally compatible).
 */
export function createProvider(svm: LiteSVM, payer: Keypair): LiteSVMProvider {
  svm.airdrop(payer.publicKey, BigInt(10e9))
  const provider = new LiteSVMProvider(svm as any, new SimpleWallet(payer) as any)

  // Patch sendAndConfirm to use our litesvm@0.6.0's FailedTransactionMetadata.
  // anchor-litesvm bundles litesvm@0.3.3 internally, so its `instanceof` check
  // against FailedTransactionMetadata fails when we pass an LiteSVM from 0.6.0.
  provider.sendAndConfirm = async (tx: Transaction, signers?: any[], _opts?: any) => {
    // Let anchor-litesvm build & sign the tx normally
    tx.feePayer = tx.feePayer ?? provider.wallet.publicKey
    tx.recentBlockhash = svm.latestBlockhash()
    signers?.forEach((s: any) => tx.partialSign(s))
    await provider.wallet.signTransaction(tx)

    if (!tx.signature) {
      throw new Error('Missing fee payer signature')
    }
    const signature = bs58.encode(tx.signature)

    const res = svm.sendTransaction(tx)
    if (res instanceof FailedTransactionMetadata) {
      throw new SendTransactionError({
        action: 'send',
        signature,
        transactionMessage: res.err().toString(),
        logs: res.meta().logs(),
      })
    }

    return signature
  }

  return provider
}
