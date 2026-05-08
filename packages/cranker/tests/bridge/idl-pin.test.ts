/**
 * IDL-pinned test for the FOGO redeem builders.
 *
 * Loads the upstream NTT v3 IDL JSON shipped with
 * `@wormhole-foundation/sdk-solana-ntt` and verifies that the account
 * orderings + discriminators we emit match it exactly. If NTT bumps an
 * account or arg layout, this test fires before any FOGO mainnet tx.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  buildFogoNttRedeemIx,
  buildFogoNttReleaseInboundMintIx,
  buildFogoNttReleaseInboundUnlockIx,
  NTT_ONYC_PROGRAM_ID,
} from '@fogo-onre/sdk'
import { Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'

// The IDL JSON is shipped with `@wormhole-foundation/sdk-solana-ntt`
// but is NOT exposed in the package's `exports` map, so a direct
// `require.resolve('<pkg>/dist/...')` fails. Resolve via package.json
// (always exported) and walk relative to the package root.
const require_ = createRequire(import.meta.url)
// Resolve through the package's main entry (always exported) and walk
// up to the package root. The IDL JSON is shipped in the package but
// not exposed in `exports`, so neither a direct subpath nor
// `package.json` resolves cleanly. The main entry resolves to
// `dist/esm/ts/index.js` (or similar) — we strip back to package root
// by climbing until we see `package.json`.
function resolvePackageRoot(name: string): string {
  let dir = dirname(require_.resolve(name))
  // Climb until package.json's `name` matches — pnpm ships a stub
  // package.json inside `dist/cjs/` for module-type sniffing, so we
  // can't stop at the first package.json we see.
  for (let i = 0; i < 16; i++) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
      if (meta.name === name) {
        return dir
      }
    } catch {
      // fall through
    }
    const parent = dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  throw new Error(`could not locate package root for ${name}`)
}
const pkgRoot = resolvePackageRoot('@wormhole-foundation/sdk-solana-ntt')
const idlPath = join(pkgRoot, 'dist/esm/ts/idl/3_0_0/json/example_native_token_transfers.json')
const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as { instructions: IdlInstruction[] }

interface IdlAccount {
  name: string
  isMut?: boolean
  isSigner?: boolean
  isOptional?: boolean
  accounts?: IdlAccount[]
}

interface IdlInstruction {
  name: string
  accounts: IdlAccount[]
  args: { name: string, type: unknown }[]
}

function flattenAccounts(accounts: IdlAccount[]): IdlAccount[] {
  const out: IdlAccount[] = []
  for (const a of accounts) {
    if (a.accounts) {
      out.push(...flattenAccounts(a.accounts))
    } else {
      out.push(a)
    }
  }
  return out
}

function findIx(name: string): IdlInstruction {
  const ix = idl.instructions.find(i => i.name === name)
  if (!ix) {
    throw new Error(`IDL missing instruction ${name}`)
  }
  return ix
}

function anchorSighash(rustName: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${rustName}`)).slice(0, 8)
}

describe('FOGO NTT redeem builders — IDL pin', () => {
  const payer = Keypair.generate().publicKey
  const mint = new PublicKey('oNyCm1QsAatj3ckaEwZjtAPWvstPn3Zm5MAYPtkjEfa')
  const nttManagerProgramId = NTT_ONYC_PROGRAM_ID
  const nttTransceiverMessage = Keypair.generate().publicKey
  const nttInboxItem = Keypair.generate().publicKey
  const recipientAta = Keypair.generate().publicKey

  it('redeem account order and arg layout match IDL', () => {
    const ix = buildFogoNttRedeemIx({
      payer,
      nttManagerProgramId,
      mint,
      nttTransceiverMessage,
      nttInboxItem,
    })
    const idlAccounts = flattenAccounts(findIx('redeem').accounts)
    expect(ix.keys.length).toBe(idlAccounts.length)
    for (let i = 0; i < idlAccounts.length; i++) {
      expect(ix.keys[i].isSigner, `${idlAccounts[i].name} signer`).toBe(!!idlAccounts[i].isSigner)
      expect(ix.keys[i].isWritable, `${idlAccounts[i].name} writable`).toBe(!!idlAccounts[i].isMut)
    }
    // Discriminator only — RedeemArgs is empty struct (zero borsh bytes).
    expect(ix.data.length).toBe(8)
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(Buffer.from(anchorSighash('redeem')))
  })

  function assertReleaseShape(ixName: string, builder: typeof buildFogoNttReleaseInboundMintIx, rustName: string): void {
    const ix = builder({
      payer,
      nttManagerProgramId,
      mint,
      nttInboxItem,
      recipientAta,
    })
    const required = flattenAccounts(findIx(ixName).accounts).filter(a => !a.isOptional)
    expect(ix.keys.length, `${ixName} required-accounts count`).toBe(required.length)
    for (let i = 0; i < required.length; i++) {
      expect(ix.keys[i].isSigner, `${ixName}[${required[i].name}].signer`).toBe(!!required[i].isSigner)
      expect(ix.keys[i].isWritable, `${ixName}[${required[i].name}].writable`).toBe(!!required[i].isMut)
    }
    // Discriminator + 1 byte (ReleaseInboundArgs.revertWhenNotReady : bool).
    expect(ix.data.length).toBe(9)
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(Buffer.from(anchorSighash(rustName)))
  }

  it('release_inbound_mint matches IDL (Burning mode)', () => {
    assertReleaseShape('releaseInboundMint', buildFogoNttReleaseInboundMintIx, 'release_inbound_mint')
  })

  it('release_inbound_unlock matches IDL (Locking mode)', () => {
    assertReleaseShape('releaseInboundUnlock', buildFogoNttReleaseInboundUnlockIx, 'release_inbound_unlock')
  })
})
