/**
 * Helpers for OnRe (onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe) PDA derivations
 * used in E2E tests with real mainnet fixtures.
 */

import { ONRE_PROGRAM_ID } from '@fogo-onre/sdk'
import { PublicKey } from '@solana/web3.js'

// ---------------------------------------------------------------------------
// PDA derivations
// ---------------------------------------------------------------------------

export function findOnreStatePda(
  programId: PublicKey = ONRE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('state')], programId)
}

export function findOnreOfferPda(
  tokenInMint: PublicKey,
  tokenOutMint: PublicKey,
  programId: PublicKey = ONRE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('offer'), tokenInMint.toBuffer(), tokenOutMint.toBuffer()],
    programId,
  )
}

export function findOnreVaultAuthorityPda(
  programId: PublicKey = ONRE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('offer_vault_authority')],
    programId,
  )
}

export function findOnrePermissionlessAuthorityPda(
  programId: PublicKey = ONRE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('permissionless-1')],
    programId,
  )
}

export function findOnreMintAuthorityPda(
  programId: PublicKey = ONRE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('mint_authority')],
    programId,
  )
}

// ---------------------------------------------------------------------------
// Mainnet fixture addresses
// ---------------------------------------------------------------------------

/** OnRe Offer PDA for USDC->ONyc (mainnet mints) */
export const ONRE_OFFER_FIXTURE = 'E88zkA9Pxb1i8EfSHrEW5ZUe6hiQbo8DHWQ3WhDFw7p6'
/** OnRe State PDA */
export const ONRE_STATE_FIXTURE = 'EL5qwcpKyc2FuQxjWmVLEwpcb4LXXwwWWjMYjf1yi3to'
/** OnRe vault_authority PDA */
export const ONRE_VAULT_AUTHORITY_FIXTURE = 'Ce3R5ZxvW3cnsGS63ikR8KCdA22nkoXW3PnY83yaLJ78'
/** OnRe permissionless_authority PDA */
export const ONRE_PERM_AUTHORITY_FIXTURE = '6MvXFNjBDb7arkEHS68Es6MN2giH7SehdHUvYRPFgbyC'
/** OnRe mint_authority PDA */
export const ONRE_MINT_AUTHORITY_FIXTURE = 'AbpE5YLpdpxj2jRczG9P341Jicf67NvZsaZYrATbMnNX'

// ---------------------------------------------------------------------------
// Offer data layout offsets (Anchor account: disc(8) + fields)
// ---------------------------------------------------------------------------

/** Offset of token_in_mint pubkey in Offer account data */
export const OFFER_TOKEN_IN_MINT_OFFSET = 8
/** Offset of token_out_mint pubkey in Offer account data */
export const OFFER_TOKEN_OUT_MINT_OFFSET = 40

// ---------------------------------------------------------------------------
// Boss pubkey from mainnet State fixture (offset 9)
// ---------------------------------------------------------------------------

export const ONRE_BOSS_PUBKEY = new PublicKey('45YnzauhsBM8CpUz96Djf8UG5vqq2Dua62wuW9H3jaJ5')
