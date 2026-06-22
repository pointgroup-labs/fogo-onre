#!/usr/bin/env node
/**
 * Deploys a single Address Lookup Table on FOGO that mirrors the
 * Sessions-SDK bridging LUT (7hmMz3…) and adds the seven globals our
 * `bridge_ntt_tokens` deposit tx needs but the bridging LUT doesn't
 * cover when fee_token = wFOGO.
 *
 * Why one union LUT instead of two LUTs: the Sessions SDK accepts only
 * ONE `addressLookupTable` in `sendToPaymaster.extraConfig`, so we can't
 * pass `[bridging, ours]`. We mirror bridging + add our extras into a
 * single LUT and pass that as the single LUT.
 *
 * Usage:
 *   FOGO_RPC_URL=https://mainnet.fogo.io \
 *   AUTHORITY_KEYPAIR=/path/to/keypair.json \
 *   node scripts/deploy-fogo-deposit-lut.mjs
 *
 * The keypair is both LUT authority and rent payer. Fund it with a small
 * amount of native FOGO before running. After the LUT is deployed and
 * verified working, you can freeze it permanently with:
 *   solana address-lookup-table close <pubkey> --keypair <auth>     # NO, use deactivate+freeze
 *   (or call AddressLookupTableProgram.freezeLookupTable via a follow-up
 *   script — left out here intentionally so the LUT stays mutable until
 *   the upstream bridging LUT stops drifting.)
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
  console.error('Set AUTHORITY_KEYPAIR=/path/to/keypair.json (LUT authority + rent payer)')
  process.exit(1)
}

// Sessions-SDK bridging LUT for USDC.s on FOGO Mainnet. We mirror its
// contents so our union LUT is a strict superset.
const BRIDGING_LUT = new PublicKey('7hmMz3nZDnPJfksLuPotKmUBAFDneM2D9wWg3R1VcKSv')

// The static keys that escape compression today when fee_token=wFOGO.
// Decoded from a failing bridge tx (1339 wire bytes, 15 static keys).
const EXTRA_KEYS = [
  'ComputeBudget111111111111111111111111111111',
  'Ed25519SigVerify111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'Xfry4dW9m42ncAqm8LyEnyS5V6xu5DSJTMRQLiGkARD',
  '3X8ZFAB2fjcGSujH6YCxYBXY6p4vDVCpmCci9s9reCLs',
  '3yBs2G4pEw6YoLA16kJ2Gcs4VWkjYMNXHw5dJ8nErXH2',
  '6dM4TqWyWJsbx7obrdLcviBkTafD5E8av61zfU6jq57X',
  // OnRe fork (deposit bridge program) + SPL Memo (min_swap_out floor) — both
  // ride inline in every deposit tx; LUT them to stay under the 1232 B limit.
  'inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
].map(k => new PublicKey(k))

// AddressLookupTableProgram.extendLookupTable caps at ~30 keys per ix
// to stay under the 1232-byte tx limit. 28 is comfortable.
const EXTEND_CHUNK = 28

function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'))
  return Keypair.fromSecretKey(Uint8Array.from(raw))
}

async function sendAndConfirm(connection, payer, ixs) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey })
  ixs.forEach(ix => tx.add(ix))
  tx.sign(payer)
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  })
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  return sig
}

// Dedupe while preserving order (first occurrence wins).
function dedupe(keys) {
  const seen = new Set()
  const out = []
  for (const k of keys) {
    const s = k.toBase58()
    if (seen.has(s)) {
      continue
    }
    seen.add(s)
    out.push(k)
  }
  return out
}

async function main() {
  const connection = new Connection(RPC, 'confirmed')
  const authority = loadKeypair(KEYPAIR_PATH)
  console.log('Authority/payer:', authority.publicKey.toBase58())

  const balance = await connection.getBalance(authority.publicKey)
  console.log('Balance:', balance, 'lamports')
  if (balance < 100_000_000) {
    console.warn('WARNING: balance is low — LUT rent + multiple extends may run out.')
  }

  const bridgingResp = await connection.getAddressLookupTable(BRIDGING_LUT)
  if (!bridgingResp.value) {
    console.error('Failed to fetch bridging LUT', BRIDGING_LUT.toBase58())
    process.exit(1)
  }
  const bridgingAddresses = bridgingResp.value.state.addresses
  console.log(`Bridging LUT (${BRIDGING_LUT.toBase58()}) has ${bridgingAddresses.length} entries`)

  const unionList = dedupe([...bridgingAddresses, ...EXTRA_KEYS])
  console.log(`Union list: ${unionList.length} entries (bridging=${bridgingAddresses.length} + extras=${EXTRA_KEYS.length}, after dedupe)`)

  const slot = await connection.getSlot('confirmed')
  const [createIx, lutPubkey] = AddressLookupTableProgram.createLookupTable({
    authority: authority.publicKey,
    payer: authority.publicKey,
    recentSlot: slot,
  })
  console.log('LUT pubkey will be:', lutPubkey.toBase58())
  const createSig = await sendAndConfirm(connection, authority, [createIx])
  console.log('  created:', createSig)

  for (let i = 0; i < unionList.length; i += EXTEND_CHUNK) {
    const chunk = unionList.slice(i, i + EXTEND_CHUNK)
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: authority.publicKey,
      authority: authority.publicKey,
      lookupTable: lutPubkey,
      addresses: chunk,
    })
    const sig = await sendAndConfirm(connection, authority, [extendIx])
    console.log(`  extended +${chunk.length} (${i + chunk.length}/${unionList.length}):`, sig)
  }

  // LUTs need ~1 slot to be active; poll briefly before verifying.
  for (let attempt = 0; attempt < 10; attempt++) {
    const resp = await connection.getAddressLookupTable(lutPubkey)
    if (resp.value && resp.value.state.addresses.length === unionList.length) {
      console.log('Verified: on-chain has', resp.value.state.addresses.length, 'entries')
      break
    }
    await new Promise(r => setTimeout(r, 500))
  }

  console.log('\nDONE. Add to packages/webapp/src/constants.ts:')
  console.log(`  export const FOGO_DEPOSIT_LUT = new PublicKey('${lutPubkey.toBase58()}')`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
