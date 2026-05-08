import { sha256 } from '@noble/hashes/sha2.js'

/**
 * Anchor instruction sighash: `sha256("global:<name>")[..8]`. The relayer
 * mirrors NTT's and OnRe's Anchor-generated discriminators, so this helper
 * is the single point where the convention is encoded.
 */
export function ixDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8)
}

/**
 * Anchor account discriminator: `sha256("account:<TypeName>")[..8]`. Used
 * by the hand-written Borsh decoders to validate account types without
 * pulling in the full IDL-derived `BorshAccountsCoder`.
 */
export function accountDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`account:${name}`)).slice(0, 8)
}
