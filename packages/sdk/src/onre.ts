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
import { ONRE_PROGRAM_ID } from './constants'

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

// ---------------------------------------------------------------------------
// Mainnet fixture addresses (used by E2E tests against frozen on-chain state)
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

/** Boss pubkey from mainnet State fixture (offset 9). */
export const ONRE_BOSS_PUBKEY = new PublicKey('45YnzauhsBM8CpUz96Djf8UG5vqq2Dua62wuW9H3jaJ5')

// ---------------------------------------------------------------------------
// Offer data layout offsets (Anchor account: disc(8) + fields)
// ---------------------------------------------------------------------------

/** Offset of token_in_mint pubkey in Offer account data */
export const OFFER_TOKEN_IN_MINT_OFFSET = 8
/** Offset of token_out_mint pubkey in Offer account data */
export const OFFER_TOKEN_OUT_MINT_OFFSET = 40

// ---------------------------------------------------------------------------
// RedemptionOffer layout (Anchor account)
//
//   disc(8) + offer(32) + token_in_mint(32) + token_out_mint(32)
//     + executed_redemptions(u128, 16) + requested_redemptions(u128, 16)
//     + fee_basis_points(u16, 2) + request_counter(u64, 8) + bump(u8, 1)
//     + reserved[u8; 109]
// Total: 256 bytes
// ---------------------------------------------------------------------------

/** Anchor discriminator for OnRe `RedemptionOffer` (sha256("account:RedemptionOffer")[..8]). */
export const REDEMPTION_OFFER_DISCRIMINATOR = new Uint8Array([
  170, 229, 178, 15, 184, 107, 140, 41,
])
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

// ---------------------------------------------------------------------------
// Account-list builder
// ---------------------------------------------------------------------------

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
}

/** OnRe mainnet deployment (the only one currently in production). */
export const ONRE_MAINNET_DEPLOYMENT: OnreDeployment = {
  programId: ONRE_PROGRAM_ID,
  state: findOnreStatePda(ONRE_PROGRAM_ID)[0],
  boss: ONRE_BOSS_PUBKEY,
}

/**
 * Optional overrides for `buildOnreSwapRemainingAccounts`. Defaults are wired
 * for OnRe mainnet (the same fixtures cloned into LiteSVM in the E2E tests).
 *
 * `deployment` is a single coupled object so partial overrides can't mix
 * mainnet defaults with a custom program. `tokenInProgram` and
 * `tokenOutProgram` are independent so Token-2022 mints can sit on either
 * side of the swap without forcing the other side to match.
 *
 * The `programId` / `state` / `boss` / `tokenProgram` fields are kept for
 * backward compatibility with the original (pre-`deployment`) shape. They
 * are mutually exclusive with `deployment` (resp. `tokenInProgram` /
 * `tokenOutProgram`) and `programId` + `state` + `boss` must be supplied
 * as a complete set if any one of them is set — partial overrides throw.
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

  // ---- Deprecated legacy shape (mutually exclusive with `deployment`) ----

  /** @deprecated Use `deployment.programId`. Must be paired with `state` + `boss`. */
  programId?: PublicKey
  /** @deprecated Use `deployment.state`. Must be paired with `programId` + `boss`. */
  state?: PublicKey
  /** @deprecated Use `deployment.boss`. Must be paired with `programId` + `state`. */
  boss?: PublicKey
  /** @deprecated Use `tokenInProgram` + `tokenOutProgram`. Sets both at once. */
  tokenProgram?: PublicKey
}

/**
 * Resolve a context (possibly using deprecated legacy fields) into the
 * coupled `(deployment, tokenInProgram, tokenOutProgram)` triple. Throws on
 * partial / conflicting overrides.
 */
function resolveContext(ctx: OnreSwapContext | undefined): {
  deployment: OnreDeployment
  tokenInProgram: PublicKey
  tokenOutProgram: PublicKey
} {
  // ---- Deployment ----
  const legacyDeploymentFields = [ctx?.programId, ctx?.state, ctx?.boss]
  const legacySet = legacyDeploymentFields.filter(v => v !== undefined).length
  if (ctx?.deployment && legacySet > 0) {
    throw new Error(
      'OnreSwapContext: `deployment` is mutually exclusive with the legacy '
      + '`programId` / `state` / `boss` fields. Use `deployment` only.',
    )
  }
  if (legacySet > 0 && legacySet < 3) {
    throw new Error(
      'OnreSwapContext: legacy `programId`, `state`, and `boss` fields are '
      + 'coupled — supply all three together (or migrate to `deployment`). '
      + 'Partial overrides silently mix mainnet defaults with custom values.',
    )
  }
  const deployment: OnreDeployment = ctx?.deployment
    ?? (legacySet === 3
      ? { programId: ctx!.programId!, state: ctx!.state!, boss: ctx!.boss! }
      : ONRE_MAINNET_DEPLOYMENT)

  // ---- Token programs ----
  const usesNewSplit = ctx?.tokenInProgram !== undefined || ctx?.tokenOutProgram !== undefined
  if (ctx?.tokenProgram && usesNewSplit) {
    throw new Error(
      'OnreSwapContext: `tokenProgram` is mutually exclusive with '
      + '`tokenInProgram` / `tokenOutProgram`. Pick one shape.',
    )
  }
  const tokenInProgram = ctx?.tokenInProgram ?? ctx?.tokenProgram ?? TOKEN_PROGRAM_ID
  const tokenOutProgram = ctx?.tokenOutProgram ?? ctx?.tokenProgram ?? TOKEN_PROGRAM_ID

  return { deployment, tokenInProgram, tokenOutProgram }
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
  const { programId, state: statePda, boss } = deployment

  const [offerPda] = findOnreOfferPda(params.tokenInMint, params.tokenOutMint, programId)
  const [vaultAuthority] = findOnreVaultAuthorityPda(programId)
  const [permAuthority] = findOnrePermissionlessAuthorityPda(programId)
  const [mintAuthority] = findOnreMintAuthorityPda(programId)

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
    // 1.  offer (mut)
    { pubkey: offerPda, isSigner: false, isWritable: true },
    // 2.  state
    { pubkey: statePda, isSigner: false, isWritable: false },
    // 3.  boss
    { pubkey: boss, isSigner: false, isWritable: false },
    // 4.  vault_authority
    { pubkey: vaultAuthority, isSigner: false, isWritable: false },
    // 5.  vault_token_in_account (mut)
    { pubkey: vaultTokenIn, isSigner: false, isWritable: true },
    // 6.  vault_token_out_account (mut)
    { pubkey: vaultTokenOut, isSigner: false, isWritable: true },
    // 7.  permissionless_authority
    { pubkey: permAuthority, isSigner: false, isWritable: false },
    // 8.  permissionless_token_in_account (mut)
    { pubkey: permTokenIn, isSigner: false, isWritable: true },
    // 9.  permissionless_token_out_account (mut)
    { pubkey: permTokenOut, isSigner: false, isWritable: true },
    // 10. token_in_mint (mut)
    { pubkey: params.tokenInMint, isSigner: false, isWritable: true },
    // 11. token_in_program
    { pubkey: tokenInProgram, isSigner: false, isWritable: false },
    // 12. token_out_mint (mut)
    { pubkey: params.tokenOutMint, isSigner: false, isWritable: true },
    // 13. token_out_program
    { pubkey: tokenOutProgram, isSigner: false, isWritable: false },
    // 14. user_token_in_account (mut)
    { pubkey: params.userTokenInAccount, isSigner: false, isWritable: true },
    // 15. user_token_out_account (init_if_needed, mut)
    { pubkey: params.userTokenOutAccount, isSigner: false, isWritable: true },
    // 16. boss_token_in_account (mut)
    { pubkey: bossTokenIn, isSigner: false, isWritable: true },
    // 17. mint_authority
    { pubkey: mintAuthority, isSigner: false, isWritable: false },
    // 18. instructions_sysvar
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    // 19. user (signer, mut) — relayer_authority PDA, signed via RELAYER_SEED
    { pubkey: params.user, isSigner: false, isWritable: true },
    // 20. associated_token_program
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    // 21. system_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // 22. OnRe program — required in account_infos for the CPI on strict
    //     validators (Agave). LiteSVM is permissive without it; mainnet is not.
    { pubkey: programId, isSigner: false, isWritable: false },
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
export function buildOnreCreateRedemptionRequestRemainingAccounts(params: {
  /** Input mint (ONyc on the withdraw side). */
  tokenInMint: PublicKey
  /**
   * Output mint (USDC on the withdraw side). Used to derive the
   * `RedemptionOffer` PDA.
   */
  tokenOutMint: PublicKey
  /** Redeemer = relayer_authority PDA. Forced to sign in the CPI helper. */
  redeemer: PublicKey
  /** Redeemer's `tokenIn` ATA (the relayer's `onyc_ata`). */
  redeemerTokenAccount: PublicKey
  /**
   * `RedemptionRequest` PDA derived as `findOnreRedemptionRequestPda(
   *   redemptionOffer, requestCounterBeforeCpi)`. Caller MUST read the
   * counter off the live `RedemptionOffer` account before the CPI fires —
   * OnRe increments it inside the handler.
   */
  redemptionRequest: PublicKey
  /** Token program for the input mint. Defaults to SPL Token. */
  tokenProgram?: PublicKey
  /** Optional OnRe program override. Defaults to mainnet. */
  programId?: PublicKey
  /** Optional precomputed State PDA; defaults to `findOnreStatePda(programId)`. */
  state?: PublicKey
}): AccountMeta[] {
  const programId = params.programId ?? ONRE_PROGRAM_ID
  const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID
  const state = params.state ?? findOnreStatePda(programId)[0]

  const [redemptionOffer] = findOnreRedemptionOfferPda(
    params.tokenInMint, params.tokenOutMint, programId,
  )
  const [vaultAuthority] = findOnreRedemptionVaultAuthorityPda(programId)
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenInMint, vaultAuthority, true, tokenProgram,
  )

  return [
    // 1.  state
    { pubkey: state, isSigner: false, isWritable: false },
    // 2.  redemption_offer (mut)
    { pubkey: redemptionOffer, isSigner: false, isWritable: true },
    // 3.  redemption_request (init, mut) — INDEX = 2 (the relayer pin)
    { pubkey: params.redemptionRequest, isSigner: false, isWritable: true },
    // 4.  redeemer (signer, mut) — relayer_authority PDA, signed via RELAYER_SEED
    { pubkey: params.redeemer, isSigner: false, isWritable: true },
    // 5.  redemption_vault_authority (PDA)
    { pubkey: vaultAuthority, isSigner: false, isWritable: false },
    // 6.  token_in_mint (ONyc)
    { pubkey: params.tokenInMint, isSigner: false, isWritable: false },
    // 7.  redeemer_token_account (mut, ATA of token_in/redeemer)
    { pubkey: params.redeemerTokenAccount, isSigner: false, isWritable: true },
    // 8.  vault_token_account (mut, ATA of token_in/vault_authority)
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    // 9.  token_program
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    // 10. associated_token_program
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    // 11. system_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // 12. OnRe program — required in account_infos for the CPI on strict
    //     validators (Agave + LiteSVM). The relayer's `invoke_signed` only
    //     includes accounts it sees in `remaining_accounts`, so without
    //     this entry the runtime reports "Unknown program" / MissingAccount.
    { pubkey: programId, isSigner: false, isWritable: false },
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
export function buildOnreCancelRedemptionRequestRemainingAccounts(params: {
  /** Input mint (ONyc on the withdraw side). */
  tokenInMint: PublicKey
  /** Output mint (USDC on the withdraw side). Used to derive the `RedemptionOffer` PDA. */
  tokenOutMint: PublicKey
  /** Signer = relayer_authority PDA. Forced to sign in the CPI helper. */
  signer: PublicKey
  /**
   * Redeemer recorded on the `RedemptionRequest`. For the relayer flow this
   * is the same as `signer` (the relayer_authority PDA).
   */
  redeemer: PublicKey
  /** Redeemer's `tokenIn` ATA (the relayer's `onyc_ata`). */
  redeemerTokenAccount: PublicKey
  /** OnRe `state.redemption_admin` — receives the closed-account rent. */
  redemptionAdmin: PublicKey
  /** Same `RedemptionRequest` PDA recorded on `tracker.redemption_request`. */
  redemptionRequest: PublicKey
  /** Token program for the input mint. Defaults to SPL Token. */
  tokenProgram?: PublicKey
  /** Optional OnRe program override. Defaults to mainnet. */
  programId?: PublicKey
  /** Optional precomputed State PDA; defaults to `findOnreStatePda(programId)`. */
  state?: PublicKey
}): AccountMeta[] {
  const programId = params.programId ?? ONRE_PROGRAM_ID
  const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID
  const state = params.state ?? findOnreStatePda(programId)[0]

  const [redemptionOffer] = findOnreRedemptionOfferPda(
    params.tokenInMint, params.tokenOutMint, programId,
  )
  const [vaultAuthority] = findOnreRedemptionVaultAuthorityPda(programId)
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenInMint, vaultAuthority, true, tokenProgram,
  )

  return [
    // 1.  state
    { pubkey: state, isSigner: false, isWritable: false },
    // 2.  redemption_offer (mut)
    { pubkey: redemptionOffer, isSigner: false, isWritable: true },
    // 3.  redemption_request (mut, close) — INDEX = 2 (the relayer pin)
    { pubkey: params.redemptionRequest, isSigner: false, isWritable: true },
    // 4.  signer (signer, mut) — relayer_authority PDA, signed via RELAYER_SEED
    { pubkey: params.signer, isSigner: false, isWritable: true },
    // 5.  redeemer (CHECK) — must match redemption_request.redeemer
    { pubkey: params.redeemer, isSigner: false, isWritable: false },
    // 6.  redemption_admin (mut) — rent destination; must match state.redemption_admin
    { pubkey: params.redemptionAdmin, isSigner: false, isWritable: true },
    // 7.  redemption_vault_authority (PDA)
    { pubkey: vaultAuthority, isSigner: false, isWritable: false },
    // 8.  token_in_mint (ONyc)
    { pubkey: params.tokenInMint, isSigner: false, isWritable: false },
    // 9.  vault_token_account (mut, ATA of token_in/vault_authority)
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    // 10. redeemer_token_account (init_if_needed, mut, ATA of token_in/redeemer)
    { pubkey: params.redeemerTokenAccount, isSigner: false, isWritable: true },
    // 11. token_program
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    // 12. system_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // 13. associated_token_program
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    // 14. OnRe program — see builder docstring above for why it's appended.
    { pubkey: programId, isSigner: false, isWritable: false },
  ]
}
