import type { AccountMeta } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js'
import { ONRE_PROGRAM_ID } from '../constants'
import { readonly, writable } from '../utils/accountMeta'

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

/** Boss pubkey from mainnet State fixture (offset 9). */
export const ONRE_BOSS_PUBKEY = new PublicKey('45YnzauhsBM8CpUz96Djf8UG5vqq2Dua62wuW9H3jaJ5')

/** Offset of token_in_mint pubkey in Offer account data */
export const OFFER_TOKEN_IN_MINT_OFFSET = 8
/** Offset of token_out_mint pubkey in Offer account data */
export const OFFER_TOKEN_OUT_MINT_OFFSET = 40

/**
 * Coupled OnRe deployment identifiers — `state` is a PDA of `programId`
 * and `boss` is stored inside that State account, so they only make sense
 * as a set. The API forces them to travel together; mixing a custom
 * `programId` with a foreign `boss` silently yields an invalid account list.
 */
export interface OnreDeployment {
  programId: PublicKey
  state: PublicKey
  boss: PublicKey
  /** `offer_vault_authority` PDA — owns deposit-side vault ATAs. */
  vaultAuthority: PublicKey
  /** `permissionless-1` PDA — used by `take_offer_permissionless`. */
  permissionlessAuthority: PublicKey
  /** `mint_authority` PDA — mints ONyc on the deposit leg. */
  mintAuthority: PublicKey
}

/** Build an `OnreDeployment` from a `programId` + `boss` pair, deriving all PDAs. */
export function makeOnreDeployment(programId: PublicKey, boss: PublicKey): OnreDeployment {
  return {
    programId,
    state: findOnreStatePda(programId)[0],
    boss,
    vaultAuthority: findOnreVaultAuthorityPda(programId)[0],
    permissionlessAuthority: findOnrePermissionlessAuthorityPda(programId)[0],
    mintAuthority: findOnreMintAuthorityPda(programId)[0],
  }
}

/** OnRe mainnet deployment (the only one currently in production). */
export const ONRE_MAINNET_DEPLOYMENT: OnreDeployment = makeOnreDeployment(
  ONRE_PROGRAM_ID,
  ONRE_BOSS_PUBKEY,
)

/**
 * Optional overrides for `buildOnreSwapRemainingAccounts`; defaults wired
 * for OnRe mainnet. `deployment` is one coupled object so partial overrides
 * can't mix mainnet defaults with a custom program. The two token-program
 * fields are independent so a Token-2022 mint can sit on either side.
 */
export interface OnreSwapContext {
  /** OnRe deployment (programId, state PDA, boss). Defaults to mainnet. */
  deployment?: OnreDeployment
  /** Token program for `tokenInMint`. Defaults to SPL Token. */
  tokenInProgram?: PublicKey
  /** Token program for `tokenOutMint`. Defaults to SPL Token. */
  tokenOutProgram?: PublicKey
  /**
   * Boss's `tokenIn` ATA — receives the OnRe protocol fee. Defaults to the
   * ATA derived from `(tokenInMint, deployment.boss, tokenInProgram)`.
   * Override only if the on-chain boss uses a non-canonical token account.
   */
  bossTokenInAccount?: PublicKey
}

/** Resolve a context into the coupled `(deployment, tokenInProgram, tokenOutProgram)` triple. */
function resolveContext(ctx: OnreSwapContext | undefined): {
  deployment: OnreDeployment
  tokenInProgram: PublicKey
  tokenOutProgram: PublicKey
} {
  return {
    deployment: ctx?.deployment ?? ONRE_MAINNET_DEPLOYMENT,
    tokenInProgram: ctx?.tokenInProgram ?? TOKEN_PROGRAM_ID,
    tokenOutProgram: ctx?.tokenOutProgram ?? TOKEN_PROGRAM_ID,
  }
}

/**
 * Build the 22-entry `remainingAccounts` array for OnRe's
 * `take_offer_permissionless`. Layout (proven against OnRe mainnet binary):
 *
 *   1.  offer (mut)                  12. token_out_mint (mut)
 *   2.  state                        13. token_out_program
 *   3.  boss                         14. user_token_in_account (mut)
 *   4.  vault_authority              15. user_token_out_account (mut)
 *   5.  vault_token_in (mut)         16. boss_token_in_account (mut)
 *   6.  vault_token_out (mut)        17. mint_authority
 *   7.  permissionless_authority     18. instructions_sysvar
 *   8.  perm_token_in (mut)          19. user (signer, mut)
 *   9.  perm_token_out (mut)         20. associated_token_program
 *   10. token_in_mint (mut)          21. system_program
 *   11. token_in_program             22. ONRE program (for invoke_signed)
 */
export function buildOnreSwapRemainingAccounts(params: {
  /** The mint being spent (USDC for deposit, ONyc for withdrawal). */
  tokenInMint: PublicKey
  /** The mint being received (ONyc for deposit, USDC for withdrawal). */
  tokenOutMint: PublicKey
  /** Source ATA — the relayer's operating ATA for `tokenInMint`. */
  userTokenInAccount: PublicKey
  /** Destination ATA — the relayer's operating ATA for `tokenOutMint`. */
  userTokenOutAccount: PublicKey
  /**
   * The OnRe-side `user` (signer, mut). For relayer CPIs this is the
   * relayer authority PDA — the program signs with `RELAYER_SEED`.
   */
  user: PublicKey
  ctx?: OnreSwapContext
}): AccountMeta[] {
  const { deployment, tokenInProgram, tokenOutProgram } = resolveContext(params.ctx)
  const { programId, state: statePda, boss, vaultAuthority, permissionlessAuthority: permAuthority, mintAuthority } = deployment

  const [offerPda] = findOnreOfferPda(params.tokenInMint, params.tokenOutMint, programId)

  // ATA derivation depends on the token program (Token-2022 vs SPL Token).
  // Vault/perm/boss accounts holding `tokenIn` must use `tokenInProgram`;
  // those holding `tokenOut` must use `tokenOutProgram`.
  const vaultTokenIn = getAssociatedTokenAddressSync(
    params.tokenInMint, vaultAuthority, true, tokenInProgram,
  )
  const vaultTokenOut = getAssociatedTokenAddressSync(
    params.tokenOutMint, vaultAuthority, true, tokenOutProgram,
  )
  const permTokenIn = getAssociatedTokenAddressSync(
    params.tokenInMint, permAuthority, true, tokenInProgram,
  )
  const permTokenOut = getAssociatedTokenAddressSync(
    params.tokenOutMint, permAuthority, true, tokenOutProgram,
  )
  const bossTokenIn = params.ctx?.bossTokenInAccount
    ?? getAssociatedTokenAddressSync(params.tokenInMint, boss, true, tokenInProgram)

  return [
    writable(offerPda),
    readonly(statePda),
    readonly(boss),
    readonly(vaultAuthority),
    writable(vaultTokenIn),
    writable(vaultTokenOut),
    readonly(permAuthority),
    writable(permTokenIn),
    writable(permTokenOut),
    writable(params.tokenInMint),
    readonly(tokenInProgram),
    writable(params.tokenOutMint),
    readonly(tokenOutProgram),
    writable(params.userTokenInAccount),
    writable(params.userTokenOutAccount),
    writable(bossTokenIn),
    readonly(mintAuthority),
    readonly(SYSVAR_INSTRUCTIONS_PUBKEY),
    writable(params.user),
    readonly(ASSOCIATED_TOKEN_PROGRAM_ID),
    readonly(SystemProgram.programId),
    // Final entry: OnRe program ID. Required in account_infos for the CPI on
    // strict validators (Agave). LiteSVM is permissive without it; mainnet is not.
    readonly(programId),
  ]
}
