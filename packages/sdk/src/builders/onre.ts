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
import { accountDiscriminator } from '../utils/discriminators'

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

/**
 * OnRe `RedemptionOffer` PDA. Seeds: `[redemption_offer, token_in_mint,
 * token_out_mint]`. NOTE the seed order is the *opposite* of the deposit
 * `Offer` PDA — for a withdraw, `token_in_mint` is ONyc and
 * `token_out_mint` is USDC. Don't reuse `findOnreOfferPda` here.
 */
export function findOnreRedemptionOfferPda(
  tokenInMint: PublicKey,
  tokenOutMint: PublicKey,
  programId: PublicKey = ONRE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('redemption_offer'), tokenInMint.toBuffer(), tokenOutMint.toBuffer()],
    programId,
  )
}

/**
 * OnRe `redemption_offer_vault_authority` — single global PDA owning every
 * redemption-vault token account on OnRe.
 */
export function findOnreRedemptionVaultAuthorityPda(
  programId: PublicKey = ONRE_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('redemption_offer_vault_authority')],
    programId,
  )
}

/**
 * OnRe `RedemptionRequest` PDA. Seeds: `[redemption_request,
 * redemption_offer, request_id_le_u64]`. `request_id` is the
 * `RedemptionOffer.request_counter` value snapshotted *before* the CPI
 * fires, so callers must read the counter off the live offer fixture.
 */
export function findOnreRedemptionRequestPda(
  redemptionOffer: PublicKey,
  requestId: bigint,
  programId: PublicKey = ONRE_PROGRAM_ID,
): [PublicKey, number] {
  const idBuf = Buffer.alloc(8)
  idBuf.writeBigUInt64LE(requestId)
  return PublicKey.findProgramAddressSync(
    [Buffer.from('redemption_request'), redemptionOffer.toBuffer(), idBuf],
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
 * Anchor discriminator for OnRe `RedemptionOffer` (sha256("account:RedemptionOffer")[..8]).
 *
 * RedemptionOffer layout (Anchor account):
 *
 *   disc(8) + offer(32) + token_in_mint(32) + token_out_mint(32)
 *     + executed_redemptions(u128, 16) + requested_redemptions(u128, 16)
 *     + fee_basis_points(u16, 2) + request_counter(u64, 8) + bump(u8, 1)
 *     + reserved[u8; 109]
 *
 * Total: 256 bytes. See offset constants below for individual field locations.
 */
export const REDEMPTION_OFFER_DISCRIMINATOR = accountDiscriminator('RedemptionOffer')

// Byte-pin tripwire: the hardcoded value below is the sha256("account:RedemptionOffer")[..8]
// observed against OnRe mainnet. Any drift means upstream renamed the account; refresh
// fixtures + this pin together (don't silently follow the rename).
{
  const pinned = new Uint8Array([170, 229, 178, 15, 184, 107, 140, 41])
  for (let i = 0; i < 8; i++) {
    if (REDEMPTION_OFFER_DISCRIMINATOR[i] !== pinned[i]) {
      throw new Error('RedemptionOffer discriminator drifted from mainnet pin')
    }
  }
}
/** Total serialized size in bytes. */
export const REDEMPTION_OFFER_SIZE = 256
/** Offset of `offer` (deposit-Offer PDA reference) inside RedemptionOffer data. */
export const REDEMPTION_OFFER_OFFER_OFFSET = 8
/** Offset of `token_in_mint` inside RedemptionOffer data. */
export const REDEMPTION_OFFER_TOKEN_IN_MINT_OFFSET = 40
/** Offset of `token_out_mint` inside RedemptionOffer data. */
export const REDEMPTION_OFFER_TOKEN_OUT_MINT_OFFSET = 72
/** Offset of `request_counter` (u64 LE) inside RedemptionOffer data. */
export const REDEMPTION_OFFER_REQUEST_COUNTER_OFFSET = 138
/** Offset of `bump` (u8) inside RedemptionOffer data. */
export const REDEMPTION_OFFER_BUMP_OFFSET = 146

/**
 * Coupled OnRe deployment identifiers. `state` is a PDA of `programId`, and
 * `boss` is the pubkey stored INSIDE that State account — they only make
 * sense as a set. Mixing a custom `programId` with mainnet `boss` (or vice
 * versa) silently produces an invalid account list, so the API forces them
 * to travel together.
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
  /** `redemption_offer_vault_authority` PDA — owns withdraw-side vault ATAs. */
  redemptionVaultAuthority: PublicKey
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
    redemptionVaultAuthority: findOnreRedemptionVaultAuthorityPda(programId)[0],
  }
}

/** OnRe mainnet deployment (the only one currently in production). */
export const ONRE_MAINNET_DEPLOYMENT: OnreDeployment = makeOnreDeployment(
  ONRE_PROGRAM_ID,
  ONRE_BOSS_PUBKEY,
)

/**
 * Optional overrides for `buildOnreSwapRemainingAccounts`. Defaults are wired
 * for OnRe mainnet (the same fixtures cloned into LiteSVM in the E2E tests).
 *
 * `deployment` is a single coupled object so partial overrides can't mix
 * mainnet defaults with a custom program. `tokenInProgram` and
 * `tokenOutProgram` are independent so Token-2022 mints can sit on either
 * side of the swap without forcing the other side to match.
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
 * Shared derivation for the two redemption builders. Both
 * `create_redemption_request` and `cancel_redemption_request` need the same
 * `(state, redemptionOffer, vaultAuthority, vaultTokenAccount)` quadruple
 * computed from `(tokenInMint, tokenOutMint, programId, tokenProgram)`.
 */
function resolveRedemptionVaultAccounts(params: {
  tokenInMint: PublicKey
  tokenOutMint: PublicKey
  tokenProgram?: PublicKey
  deployment?: OnreDeployment
}): {
  programId: PublicKey
  tokenProgram: PublicKey
  state: PublicKey
  redemptionOffer: PublicKey
  vaultAuthority: PublicKey
  vaultTokenAccount: PublicKey
} {
  const deployment = params.deployment ?? ONRE_MAINNET_DEPLOYMENT
  const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID
  const [redemptionOffer] = findOnreRedemptionOfferPda(
    params.tokenInMint, params.tokenOutMint, deployment.programId,
  )
  const vaultAuthority = deployment.redemptionVaultAuthority
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenInMint, vaultAuthority, true, tokenProgram,
  )
  return {
    programId: deployment.programId,
    tokenProgram,
    state: deployment.state,
    redemptionOffer,
    vaultAuthority,
    vaultTokenAccount,
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

/**
 * Build the 12-entry `remainingAccounts` array for OnRe's
 * `create_redemption_request`. Layout (first 11 entries are
 * account-declaration order from
 * `programs/onreapp/src/instructions/redemption/create_redemption_request.rs`;
 * the 12th is a Solana-runtime requirement, not an OnRe account):
 *
 *   1.  state
 *   2.  redemption_offer (mut)
 *   3.  redemption_request (init, mut)        ← position 2 (zero-indexed),
 *                                                pinned by relayer constant
 *                                                ONRE_CREATE_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX
 *   4.  redeemer (signer, mut)                ← relayer_authority PDA
 *   5.  redemption_vault_authority (PDA)
 *   6.  token_in_mint                         ← ONyc on the withdraw side
 *   7.  redeemer_token_account (mut, ATA)     ← relayer_authority's ONyc ATA
 *   8.  vault_token_account (mut, ATA)        ← redemption_vault_authority's
 *                                                ATA for ONyc
 *   9.  token_program
 *   10. associated_token_program
 *   11. system_program
 *   12. ONRE program ID (NOT consumed by OnRe's Accounts struct)
 *
 * ## Why entry 12 (the OnRe program) is appended
 *
 * The relayer's `invoke_relayer_signed` calls `solana_program::program::
 * invoke_signed(&ix, account_infos, signers)`. The `account_infos` slice it
 * passes is built from `ctx.remaining_accounts` — the runtime needs to find
 * the *target program*'s `AccountInfo` inside that slice to dispatch the
 * CPI. If the OnRe program isn't there, dispatch fails with `MissingAccount`
 * / "Unknown program onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe" on both
 * Agave and LiteSVM.
 *
 * OnRe's own `Accounts` struct only declares 11 entries and won't read
 * entry 12 — Anchor scans by position from index 0 — so appending it is
 * a pure runtime concession with no on-chain side effect. Same trick used
 * by `buildOnreSwapRemainingAccounts` (entry 22 there).
 *
 * The relayer-side `ONRE_CREATE_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX`
 * pins entry 3's role for the post-CPI binding read; entry 12 has no such
 * pin because its presence (not its identity) is what matters.
 */
/**
 * Shared parameter shape for the two OnRe redemption builders
 * (`create_redemption_request` and `cancel_redemption_request`). Both
 * builders need the same vault-derivation inputs and the same closing
 * `redemptionRequest` PDA; the per-instruction extras compose on top.
 */
export interface OnreRedemptionVaultParams {
  /** Input mint (ONyc on the withdraw side). */
  tokenInMint: PublicKey
  /**
   * Output mint (USDC on the withdraw side). Used to derive the
   * `RedemptionOffer` PDA.
   */
  tokenOutMint: PublicKey
  /** Redeemer's `tokenIn` ATA (the relayer's `onyc_ata`). */
  redeemerTokenAccount: PublicKey
  /**
   * `RedemptionRequest` PDA. On `create` derive as
   * `findOnreRedemptionRequestPda(redemptionOffer, requestCounterBeforeCpi)`;
   * on `cancel` pass the same PDA recorded on `tracker.redemption_request`.
   */
  redemptionRequest: PublicKey
  /** Token program for the input mint. Defaults to SPL Token. */
  tokenProgram?: PublicKey
  /** OnRe deployment (programId, state PDA, boss, cached PDAs). Defaults to mainnet. */
  deployment?: OnreDeployment
}

export function buildOnreCreateRedemptionRequestRemainingAccounts(
  params: OnreRedemptionVaultParams & {
    /** Redeemer = relayer_authority PDA. Forced to sign in the CPI helper. */
    redeemer: PublicKey
  },
): AccountMeta[] {
  const { programId, tokenProgram, state, redemptionOffer, vaultAuthority, vaultTokenAccount }
    = resolveRedemptionVaultAccounts(params)

  return [
    readonly(state),
    writable(redemptionOffer),
    writable(params.redemptionRequest),
    writable(params.redeemer),
    readonly(vaultAuthority),
    readonly(params.tokenInMint),
    writable(params.redeemerTokenAccount),
    writable(vaultTokenAccount),
    readonly(tokenProgram),
    readonly(ASSOCIATED_TOKEN_PROGRAM_ID),
    readonly(SystemProgram.programId),
    // Final entry: OnRe program — required in account_infos for the CPI on
    // strict validators (Agave + LiteSVM). The relayer's `invoke_signed` only
    // includes accounts it sees in `remaining_accounts`, so without this
    // entry the runtime reports "Unknown program" / MissingAccount.
    readonly(programId),
  ]
}

/**
 * Build the 14-entry `remainingAccounts` array for OnRe's
 * `cancel_redemption_request`. Layout (first 13 entries are
 * account-declaration order from
 * `programs/onreapp/src/instructions/redemption/cancel_redemption_request.rs`;
 * the 14th is the OnRe program ID for runtime CPI dispatch — same reason
 * documented on `buildOnreCreateRedemptionRequestRemainingAccounts`):
 *
 *   1.  state
 *   2.  redemption_offer (mut)
 *   3.  redemption_request (mut, close)        ← position 2 (zero-indexed),
 *                                                pinned by relayer constant
 *                                                ONRE_CANCEL_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX
 *   4.  signer (signer, mut)                   ← relayer_authority PDA
 *                                                (must match redemption_request.redeemer)
 *   5.  redeemer (CHECK)                       ← also relayer_authority PDA
 *   6.  redemption_admin (mut)                 ← rent recipient; pinned to state.redemption_admin
 *   7.  redemption_vault_authority (PDA)
 *   8.  token_in_mint                          ← ONyc on the withdraw side
 *   9.  vault_token_account (mut, ATA)         ← redemption_vault_authority's
 *                                                ATA for ONyc
 *   10. redeemer_token_account (init_if_needed, mut, ATA)
 *                                              ← relayer_authority's ONyc ATA
 *   11. token_program
 *   12. system_program
 *   13. associated_token_program
 *   14. ONRE program ID (NOT consumed by OnRe's Accounts struct)
 */
export function buildOnreCancelRedemptionRequestRemainingAccounts(
  params: OnreRedemptionVaultParams & {
    /** Signer = relayer_authority PDA. Forced to sign in the CPI helper. */
    signer: PublicKey
    /**
     * Redeemer recorded on the `RedemptionRequest`. For the relayer flow this
     * is the same as `signer` (the relayer_authority PDA).
     */
    redeemer: PublicKey
    /** OnRe `state.redemption_admin` — receives the closed-account rent. */
    redemptionAdmin: PublicKey
  },
): AccountMeta[] {
  const { programId, tokenProgram, state, redemptionOffer, vaultAuthority, vaultTokenAccount }
    = resolveRedemptionVaultAccounts(params)

  return [
    readonly(state),
    writable(redemptionOffer),
    writable(params.redemptionRequest),
    writable(params.signer),
    readonly(params.redeemer),
    writable(params.redemptionAdmin),
    readonly(vaultAuthority),
    readonly(params.tokenInMint),
    writable(vaultTokenAccount),
    writable(params.redeemerTokenAccount),
    readonly(tokenProgram),
    readonly(SystemProgram.programId),
    readonly(ASSOCIATED_TOKEN_PROGRAM_ID),
    readonly(programId),
  ]
}
