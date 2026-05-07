#!/usr/bin/env node
/**
 * One-shot LUT extender. Adds the sponsor's wFOGO ATA
 * (2YSaT1e3iYJMDPKCjyb5bq6UwaUqicSJ3S1VrDrFWj3Q) to the already-
 * deployed FOGO deposit LUT (DDu9vk67…) so the bridge tx compresses
 * one more writable static key. Without it the bridge serializes to
 * 1246 bytes — 14 over the 1232 packet limit; with it, ~1215.
 *
 * Why this key was missed in the original deploy: the seven EXTRA_KEYS
 * baked into deploy-fogo-deposit-lut.mjs were taken from the readonly
 * tail of a failing tx's static-key list. The sponsor wFOGO ATA shows
 * up in the *writable* segment (it's debited the executor base fee +
 * margin), and that segment was inspected later, after the first deploy.
 *
 * Why this can be a one-shot extend rather than a redeploy: the LUT's
 * authority is intentionally kept live (see comment in
 * deploy-fogo-deposit-lut.mjs) precisely so we can chase upstream
 * bridging-LUT drift and our own oversights without minting a new LUT
 * pubkey and rotating it through constants.ts.
 *
 * Usage (same env as the deploy script):
 *   FOGO_RPC_URL=https://mainnet.fogo.io \
 *   AUTHORITY_KEYPAIR=/path/to/keypair.json \
 *   node scripts/extend-fogo-deposit-lut.mjs
 */

import fs from 'node:fs'
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js'

const RPC = process.env.FOGO_RPC_URL ?? 'https://mainnet.fogo.io'
const KEYPAIR_PATH = process.env.AUTHORITY_KEYPAIR
if (!KEYPAIR_PATH) {
  console.error('Set AUTHORITY_KEYPAIR=/path/to/keypair.json (must be the LUT authority)')
  process.exit(1)
}

const LUT_PUBKEY = new PublicKey('DDu9vk67v32ZzvUmD3knTByz3mFmdGyzD81h6vg9mUmD')

// USDC.s-side fee accounts that escape compression today now that the
// deposit fee_mint is USDC.s (not wFOGO). The previous extend round
// added the sponsor's *wFOGO* ATA assuming our own paymaster (3AcB…);
// after switching to Fogo Labs' generic `sessions` sponsor (47aX6R…)
// + fee_mint=USDC.s, three new keys appear in every bridge tx and
// none of them were in the LUT — bridge tx serializes to 1305 bytes
// (73 over the 1232 paymaster limit). All three are globally
// addressable (deterministic PDAs / ATA against fixed mints + fixed
// sponsor), so safe to LUT.
//
//   feeConfig    = PDA(["fee_config", USDC.s], Xfry4dW…)
//   feeMetadata  = PDA(["metadata", metaplex, USDC.s], metaplex)
//   feeDestination = ATA(USDC.s, 47aX6R…, allowOffCurve=true)
const NEW_KEYS = [
  new PublicKey('DpwZLvKHR7ghrWFWBtms4tFte92B5MfnypeSw7oUrNs3'),
  new PublicKey('EDGkGR5EoZHddgMDHutYcPMh368VzSmamfgUSDjRWVRN'),
  new PublicKey('HPwMos9gkA9s35ZXJi5GfozxzQ2NoXHnf8zHMj9cP8AV'),
]

function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'))
  return Keypair.fromSecretKey(Uint8Array.from(raw))
}

async function main() {
  const connection = new Connection(RPC, 'confirmed')
  const authority = loadKeypair(KEYPAIR_PATH)
  console.log('Authority/payer:', authority.publicKey.toBase58())

  // Sanity: confirm the on-chain LUT authority matches the loaded key.
  // If this mismatch fires, the extend will fail at runtime anyway —
  // catching it client-side gives a clearer error.
  const before = await connection.getAddressLookupTable(LUT_PUBKEY)
  if (!before.value) {
    console.error('LUT not found:', LUT_PUBKEY.toBase58())
    process.exit(1)
  }
  const onchainAuth = before.value.state.authority
  if (!onchainAuth || !onchainAuth.equals(authority.publicKey)) {
    console.error('Authority mismatch.')
    console.error('  on-chain:', onchainAuth?.toBase58() ?? '<frozen>')
    console.error('  loaded:  ', authority.publicKey.toBase58())
    process.exit(1)
  }
  console.log(`LUT currently has ${before.value.state.addresses.length} entries`)

  // Skip keys that are already present — extend is not idempotent in
  // the sense that duplicates cost rent + slot lookup overhead even
  // though they don't change semantics.
  const existing = new Set(before.value.state.addresses.map(a => a.toBase58()))
  const toAdd = NEW_KEYS.filter(k => !existing.has(k.toBase58()))
  if (toAdd.length === 0) {
    console.log('All requested keys already in LUT — nothing to do.')
    return
  }
  console.log(`Adding ${toAdd.length} new key(s):`)
  toAdd.forEach(k => console.log('  +', k.toBase58()))

  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: authority.publicKey,
    authority: authority.publicKey,
    lookupTable: LUT_PUBKEY,
    addresses: toAdd,
  })

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: authority.publicKey })
  tx.add(extendIx)
  tx.sign(authority)
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  })
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  console.log('Extended:', sig)

  // Poll for activation — newly extended LUT slots aren't readable
  // until the next slot lands.
  for (let attempt = 0; attempt < 10; attempt++) {
    const after = await connection.getAddressLookupTable(LUT_PUBKEY)
    if (after.value && after.value.state.addresses.length === before.value.state.addresses.length + toAdd.length) {
      console.log(`Verified: on-chain now has ${after.value.state.addresses.length} entries`)
      return
    }
    await new Promise(r => setTimeout(r, 500))
  }
  console.warn('Extend confirmed but on-chain state still lagging — check manually.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
