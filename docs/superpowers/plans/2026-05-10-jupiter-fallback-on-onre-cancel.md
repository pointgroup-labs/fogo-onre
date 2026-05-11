# Jupiter Fallback for OnRe-Rejected Withdraws — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authority-gated `swap_redemption_via_jupiter` handler that converts refunded ONyc → USDC via Jupiter v6 `shared_accounts_route`, drives the FSM to `Swapped`, and closes the singleton `RedemptionTracker` — unblocking the withdraw chain after an OnRe-rejected redemption.

**Architecture:** One new on-chain handler with Jupiter ix-data parsing on-chain, signed CPI under the existing `relayer_authority` PDA, identical close semantics to `claim_redemption_usdc`. SDK builder, daemon detection (alert-only, no auto-fire), race-classifier additions, LiteSVM tests with sha256-pinned Jupiter `.so`. CLI surface deferred — operator drives recovery via the SDK from a one-off `tsx` script (runbook in Task 9). Spec: `docs/superpowers/specs/2026-05-10-jupiter-fallback-on-onre-cancel-design.md`.

**Tech Stack:** Rust 1.95 / Anchor 1.0.2, TypeScript / vitest / litesvm 0.6, Jupiter v6 (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`), pnpm monorepo.

---

## File Map

**New files:**
- `programs/relayer/src/jupiter.rs` — Jupiter v6 program ID constant, `SHARED_ACCOUNTS_ROUTE` discriminator, parsed-ix struct + parser, route-account index constants.
- `programs/relayer/src/instructions/swap_redemption_via_jupiter.rs` — handler + `Accounts` struct.
- `packages/sdk/src/builders/jupiter.ts` — small wrapper around Jupiter `/quote` + `/swap-instructions` REST API (returns parsed ix data + accounts ready to feed into the relayer call).
- `tests/swap-redemption-via-jupiter-e2e.test.ts` — LiteSVM end-to-end.
- `tests/utils/jupiter-fixtures.ts` — Jupiter `.so` loader + sha256 pin + minimal mock route accounts.
- `tests/fixtures/programs/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4.so` — Jupiter v6 binary, fetched once.

**Modified files:**
- `programs/relayer/src/error.rs` — add `JupiterProgramMismatch`, `JupiterIxDiscriminatorMismatch`, `JupiterAmountInMismatch`, `JupiterPlatformFeeNotZero`, `JupiterMinOutTooLow`, `JupiterRouteSourceMismatch`, `JupiterRouteDestinationMismatch`, `JupiterRouteSourceMintMismatch`, `JupiterRouteDestinationMintMismatch`, `OnycConsumedMismatch`, `MaxSlippageExceeded`.
- `programs/relayer/src/constants.rs` — add `MAX_SLIPPAGE_BPS` (50).
- `programs/relayer/src/events.rs` — add `RedemptionSwappedViaJupiter`.
- `programs/relayer/src/instructions/mod.rs` — re-export new module.
- `programs/relayer/src/lib.rs` — add `pub mod jupiter;`, dispatch entry.
- `packages/sdk/src/client.ts` — add `swapRedemptionViaJupiter` builder.
- `packages/sdk/src/index.ts` — re-export builder + jupiter helper.
- `packages/cranker/src/relayer/race-classifier.ts` — add codes for the recovery path.
- `packages/cranker/src/relayer/claim-redemption-usdc.ts` — branch in advancer to alert+noop on cancel-fingerprint state.
- `tests/utils/withdraw-scaffolding.ts` — extend `pinBinaryFixtures()` with Jupiter sha256.

---

### Task 1: On-chain error variants, constant, event

**Files:**
- Modify: `programs/relayer/src/error.rs`
- Modify: `programs/relayer/src/constants.rs`
- Modify: `programs/relayer/src/events.rs`

- [ ] **Step 1: Add error variants**

Append to `RelayerError` (preserving existing variant order — Anchor codes are positional):

```rust
    #[msg("Jupiter program ID does not match the pinned constant")]
    JupiterProgramMismatch,

    #[msg("Jupiter ix discriminator is not shared_accounts_route")]
    JupiterIxDiscriminatorMismatch,

    #[msg("Jupiter ix in_amount must equal tracker.onyc_amount_in")]
    JupiterAmountInMismatch,

    #[msg("Jupiter platform_fee_bps must be zero")]
    JupiterPlatformFeeNotZero,

    #[msg("Jupiter quoted_out_amount is below caller's min_usdc_out")]
    JupiterMinOutTooLow,

    #[msg("Jupiter route source token account is not relayer onyc_ata")]
    JupiterRouteSourceMismatch,

    #[msg("Jupiter route destination token account is not relayer usdc_ata")]
    JupiterRouteDestinationMismatch,

    #[msg("Jupiter route source mint is not onyc_mint")]
    JupiterRouteSourceMintMismatch,

    #[msg("Jupiter route destination mint is not usdc_mint")]
    JupiterRouteDestinationMintMismatch,

    #[msg("Post-CPI ONyc consumed does not equal tracker.onyc_amount_in")]
    OnycConsumedMismatch,

    #[msg("min_usdc_out implies more than MAX_SLIPPAGE_BPS slippage from quoted_out")]
    MaxSlippageExceeded,
```

- [ ] **Step 2: Add slippage constant**

Append to `programs/relayer/src/constants.rs`:

```rust
/// Hard cap on slippage tolerance accepted by `swap_redemption_via_jupiter`.
/// `min_usdc_out >= quoted_out * (10_000 - MAX_SLIPPAGE_BPS) / 10_000`.
pub const MAX_SLIPPAGE_BPS: u16 = 50;
```

- [ ] **Step 3: Add event**

Append to `programs/relayer/src/events.rs`:

```rust
#[event]
pub struct RedemptionSwappedViaJupiter {
    pub flow: Pubkey,
    pub onyc_consumed: u64,
    pub usdc_received: u64,
    pub min_usdc_out: u64,
}
```

- [ ] **Step 4: Verify it builds**

Run: `cargo build -p fogo-onre-relayer`
Expected: PASS (no handler yet referencing the symbols, but variants/event/const compile clean).

- [ ] **Step 5: Commit**

```bash
git add programs/relayer/src/error.rs programs/relayer/src/constants.rs programs/relayer/src/events.rs
git commit -m "feat(relayer): error+event scaffolding for jupiter-fallback"
```

---

### Task 2: Jupiter parser module

**Files:**
- Create: `programs/relayer/src/jupiter.rs`

The Jupiter v6 `shared_accounts_route` ix has a fixed front-of-account-list layout and a Borsh-serialized data layout. Both must be pinned exactly to the published IDL — guessed values produce silent corruption, not loud failures. Step 0 below converts "go look at the IDL" into a mechanical fetch + extraction so the implementer is pasting numbers, not interpreting prose.

- [ ] **Step 0: Fetch the Jupiter v6 IDL and extract authoritative tables**

Run the following block from the repo root. It fetches the on-chain IDL via the public Anchor IDL account convention and writes two artifacts the implementer pastes into the source file in Step 1.

```bash
mkdir -p tmp/jupiter
# Pull IDL from mainnet — Anchor stores it at PDA derived from the
# program ID; `anchor idl fetch` is the supported path.
anchor idl fetch JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 \
  --provider.cluster mainnet \
  -o tmp/jupiter/jupiter-v6.json

# Extract A: shared_accounts_route account positions.
# We pin source_token, destination_token, source_mint, destination_mint.
jq '.instructions[] | select(.name == "shared_accounts_route") | .accounts | to_entries | map({index: .key, name: .value.name})' \
  tmp/jupiter/jupiter-v6.json > tmp/jupiter/account-positions.json
cat tmp/jupiter/account-positions.json

# Extract B: Swap enum variant table — variant index + payload size.
# Variants with a single Pubkey field have payload 32; with two have 64;
# zero-field variants have payload 0. Anything else is an unhandled
# shape — surface and decide before pasting.
jq '.types[] | select(.name == "Swap") | .type.variants
    | to_entries
    | map({
        tag: .key,
        name: .value.name,
        payload_bytes: (
          (.value.fields // [])
          | map(if . == "publicKey" or . == "pubkey" or .type == "publicKey" or .type == "pubkey" then 32
                elif . == "u64" or .type == "u64" then 8
                elif . == "u8"  or .type == "u8"  then 1
                elif . == "u16" or .type == "u16" then 2
                elif . == "u32" or .type == "u32" then 4
                elif . == "bool" or .type == "bool" then 1
                else null end)
          | if any(. == null) then null else add // 0 end
        )
      })' tmp/jupiter/jupiter-v6.json > tmp/jupiter/swap-variants.json
cat tmp/jupiter/swap-variants.json
```

**Inspection gate (do not skip):**
- In `account-positions.json`, find the entries named `source_token_account`, `destination_token_account` (or `source_token`, `destination_token`), `source_mint`, `destination_mint`. Record their `index`. **If any of those four accounts is absent or differently named in the IDL, stop and update the spec — the variant assumption has changed.**
- In `swap-variants.json`, every entry must have a non-null `payload_bytes`. **If any entry is `null`**, that variant carries a non-primitive field (struct, nested vec, etc.) and the simple skip-by-byte-count strategy is unsafe. Stop and switch to a full Borsh deserialize via `anchor-lang::AnchorDeserialize` on a mirrored `Swap` enum.

- [ ] **Step 1: Write a unit test for the parser**

Create `programs/relayer/src/jupiter.rs` with:

```rust
//! Jupiter v6 `shared_accounts_route` ix data parser + account index pins.
//!
//! Pinned to ONE variant by design (see spec §"Why authority-gated"):
//! the route family has multiple variants with different account layouts
//! (`route`, `shared_accounts_route`, `*_with_token_ledger`); accepting all
//! of them widens the audit surface unboundedly. This file rejects every
//! discriminator other than `SHARED_ACCOUNTS_ROUTE`.

use anchor_lang::prelude::*;

use crate::error::RelayerError;

#[constant]
pub const JUPITER_V6_PROGRAM_ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/// `sha256("global:shared_accounts_route")[..8]` — Jupiter v6 IDL.
pub const SHARED_ACCOUNTS_ROUTE_IX: [u8; 8] = [193, 32, 155, 51, 65, 214, 156, 129];

/// Account-list slot indices inside the Jupiter `shared_accounts_route`
/// instruction. **PASTE FROM `tmp/jupiter/account-positions.json`** —
/// these were verified against IDL commit `<paste git rev or fetch date>`.
/// If you change them, also update the unit test in `tests` below to
/// match.
pub const SHARED_ACCOUNTS_ROUTE_SOURCE_TOKEN_INDEX: usize = /* paste from IDL */;
pub const SHARED_ACCOUNTS_ROUTE_DESTINATION_TOKEN_INDEX: usize = /* paste from IDL */;
pub const SHARED_ACCOUNTS_ROUTE_SOURCE_MINT_INDEX: usize = /* paste from IDL */;
pub const SHARED_ACCOUNTS_ROUTE_DESTINATION_MINT_INDEX: usize = /* paste from IDL */;

/// Subset of the `shared_accounts_route` ix data we authenticate on-chain.
/// Field order mirrors the IDL: `id (u8) | route_plan (Vec<RoutePlanStep>)
/// | in_amount (u64) | quoted_out_amount (u64) | slippage_bps (u16)
/// | platform_fee_bps (u8)`. We deserialize lazily — only what we gate on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParsedSharedAccountsRoute {
    pub in_amount: u64,
    pub quoted_out_amount: u64,
    pub slippage_bps: u16,
    pub platform_fee_bps: u8,
}

/// Reads the trailing 4 fields by walking past the variable-length
/// `route_plan` Vec. Never panics on short input; returns
/// `JupiterIxDiscriminatorMismatch` for anything that isn't
/// `SHARED_ACCOUNTS_ROUTE` and a generic discriminator error for short
/// data.
pub fn parse_shared_accounts_route(data: &[u8]) -> Result<ParsedSharedAccountsRoute> {
    require!(data.len() >= 8, RelayerError::JupiterIxDiscriminatorMismatch);
    let (disc, rest) = data.split_at(8);
    require!(
        disc == SHARED_ACCOUNTS_ROUTE_IX,
        RelayerError::JupiterIxDiscriminatorMismatch
    );

    // id: u8
    require!(!rest.is_empty(), RelayerError::JupiterIxDiscriminatorMismatch);
    let mut cursor = &rest[1..];

    // route_plan: Vec<RoutePlanStep>
    require!(cursor.len() >= 4, RelayerError::JupiterIxDiscriminatorMismatch);
    let plan_len = u32::from_le_bytes(cursor[0..4].try_into().unwrap()) as usize;
    cursor = &cursor[4..];
    for _ in 0..plan_len {
        cursor = skip_route_plan_step(cursor)?;
    }

    // in_amount: u64
    require!(cursor.len() >= 8, RelayerError::JupiterIxDiscriminatorMismatch);
    let in_amount = u64::from_le_bytes(cursor[0..8].try_into().unwrap());
    cursor = &cursor[8..];

    // quoted_out_amount: u64
    require!(cursor.len() >= 8, RelayerError::JupiterIxDiscriminatorMismatch);
    let quoted_out_amount = u64::from_le_bytes(cursor[0..8].try_into().unwrap());
    cursor = &cursor[8..];

    // slippage_bps: u16
    require!(cursor.len() >= 2, RelayerError::JupiterIxDiscriminatorMismatch);
    let slippage_bps = u16::from_le_bytes(cursor[0..2].try_into().unwrap());
    cursor = &cursor[2..];

    // platform_fee_bps: u8
    require!(!cursor.is_empty(), RelayerError::JupiterIxDiscriminatorMismatch);
    let platform_fee_bps = cursor[0];

    Ok(ParsedSharedAccountsRoute {
        in_amount,
        quoted_out_amount,
        slippage_bps,
        platform_fee_bps,
    })
}

/// `RoutePlanStep` is `{ swap: Swap, percent: u8, input_index: u8,
/// output_index: u8 }`. `Swap` is a Borsh-tagged union; the variant tag
/// is one byte and most variants carry no further fields, with a few
/// exceptions (e.g. `TokenSwap`) that carry a `Pubkey` (32 bytes). We
/// don't need the values — only to skip past them.
fn skip_route_plan_step(buf: &[u8]) -> Result<&[u8]> {
    require!(!buf.is_empty(), RelayerError::JupiterIxDiscriminatorMismatch);
    let tag = buf[0];
    let mut cursor = &buf[1..];
    let payload_len = jupiter_swap_variant_payload_len(tag)?;
    require!(
        cursor.len() >= payload_len + 3,
        RelayerError::JupiterIxDiscriminatorMismatch
    );
    cursor = &cursor[payload_len..];
    // percent: u8, input_index: u8, output_index: u8
    cursor = &cursor[3..];
    Ok(cursor)
}

/// Jupiter v6 `Swap` variant payload sizes. **PASTE FROM
/// `tmp/jupiter/swap-variants.json`** — every entry must be reproduced;
/// missing tags fall through to `_ => Err(...)`, which fails closed
/// (a route using an unknown variant reverts rather than mis-skips).
fn jupiter_swap_variant_payload_len(tag: u8) -> Result<usize> {
    match tag {
        // Replace this block with one arm per row in swap-variants.json.
        // Format:
        //   N => Ok(BYTES),  // <variant name>
        // Example shape (DO NOT keep — replace from IDL output):
        //   0  => Ok(0),     // Saber
        //   17 => Ok(32),    // TokenSwap (Pubkey)
        _ => Err(error!(RelayerError::JupiterIxDiscriminatorMismatch)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_min_ix(plan_len: u32, in_amount: u64, quoted_out: u64, slippage: u16, fee: u8) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&SHARED_ACCOUNTS_ROUTE_IX);
        v.push(0); // id
        v.extend_from_slice(&plan_len.to_le_bytes());
        // assume zero-payload variants for the test
        for _ in 0..plan_len {
            v.push(0); // tag
            v.extend_from_slice(&[0, 0, 0]); // percent, input_index, output_index
        }
        v.extend_from_slice(&in_amount.to_le_bytes());
        v.extend_from_slice(&quoted_out.to_le_bytes());
        v.extend_from_slice(&slippage.to_le_bytes());
        v.push(fee);
        v
    }

    #[test]
    fn parses_minimal_one_hop() {
        let data = build_min_ix(1, 1_000_000, 950_000, 50, 0);
        let p = parse_shared_accounts_route(&data).unwrap();
        assert_eq!(p.in_amount, 1_000_000);
        assert_eq!(p.quoted_out_amount, 950_000);
        assert_eq!(p.slippage_bps, 50);
        assert_eq!(p.platform_fee_bps, 0);
    }

    #[test]
    fn rejects_wrong_discriminator() {
        let mut data = build_min_ix(0, 0, 0, 0, 0);
        data[0] ^= 0xFF;
        assert!(parse_shared_accounts_route(&data).is_err());
    }

    #[test]
    fn rejects_truncated_data() {
        let data = build_min_ix(0, 0, 0, 0, 0);
        for cut in 0..data.len() {
            assert!(parse_shared_accounts_route(&data[..cut]).is_err());
        }
    }
}
```

> **Pin failure mode (intentional):** the unit tests in `tests` mod use the all-zero-payload helper, which exercises only zero-payload variants. The full variant table from Step 0 is what guards real multi-hop routes — Task 5's e2e test against a stub route exercises one variant; Task 9's mainnet dry-run against a live Jupiter quote exercises the full table.

- [ ] **Step 2: Wire module into lib.rs**

Edit `programs/relayer/src/lib.rs`, add after `pub mod instructions;`:

```rust
pub mod jupiter;
```

- [ ] **Step 3: Run unit tests**

Run: `cargo test -p fogo-onre-relayer jupiter::tests`
Expected: 3 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add programs/relayer/src/jupiter.rs programs/relayer/src/lib.rs
git commit -m "feat(relayer): jupiter v6 shared_accounts_route parser"
```

---

### Task 3: Handler `swap_redemption_via_jupiter`

**Files:**
- Create: `programs/relayer/src/instructions/swap_redemption_via_jupiter.rs`
- Modify: `programs/relayer/src/instructions/mod.rs`
- Modify: `programs/relayer/src/lib.rs`

- [ ] **Step 1: Add the handler file**

Create `programs/relayer/src/instructions/swap_redemption_via_jupiter.rs`:

```rust
//! Withdraw chain recovery: convert refunded ONyc → USDC via Jupiter v6
//! when OnRe canceled the redemption. Authority-gated. FSM target is the
//! same `Swapped` state the happy-path `claim_redemption_usdc` reaches.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_program;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    CONFIG_SEED, FLOW_OUTBOUND_SEED, MAX_SLIPPAGE_BPS, REDEMPTION_TRACKER_SEED, RELAYER_SEED,
};
use crate::cpi::invoke_relayer_signed;
use crate::error::RelayerError;
use crate::events::RedemptionSwappedViaJupiter;
use crate::jupiter::{
    parse_shared_accounts_route, JUPITER_V6_PROGRAM_ID, SHARED_ACCOUNTS_ROUTE_IX,
    SHARED_ACCOUNTS_ROUTE_DESTINATION_MINT_INDEX, SHARED_ACCOUNTS_ROUTE_DESTINATION_TOKEN_INDEX,
    SHARED_ACCOUNTS_ROUTE_SOURCE_MINT_INDEX, SHARED_ACCOUNTS_ROUTE_SOURCE_TOKEN_INDEX,
};
use crate::state::{Flow, FlowStatus, RedemptionTracker, RelayerConfig};

pub fn handler<'info>(
    ctx: Context<'info, SwapRedemptionViaJupiter<'info>>,
    min_usdc_out: u64,
    jupiter_ix_data: Vec<u8>,
) -> Result<()> {
    let flow_key = ctx.accounts.outflight_flow.key();
    let tracker = &ctx.accounts.redemption_tracker;

    require_keys_eq!(
        tracker.flow,
        flow_key,
        RelayerError::RedemptionTrackerFlowMismatch
    );

    require!(
        ctx.accounts.outflight_flow.status == FlowStatus::RedemptionPending,
        RelayerError::FlowStatusMismatch
    );

    require_keys_eq!(
        ctx.accounts.redemption_request.key(),
        tracker.redemption_request,
        RelayerError::RedemptionRequestMismatch
    );

    // OnRe-canceled fingerprint: same closure semantics OnRe's fulfill
    // produces, but the USDC delta will be zero. Both are acceptable
    // to enter this handler — the post-CPI invariants distinguish.
    let req = &ctx.accounts.redemption_request;
    require!(
        req.lamports() == 0 && req.data_is_empty() && req.owner == &system_program::ID,
        RelayerError::RedemptionNotFulfilled
    );

    // Pin Jupiter program.
    require_keys_eq!(
        ctx.accounts.jupiter_program.key(),
        JUPITER_V6_PROGRAM_ID,
        RelayerError::JupiterProgramMismatch
    );

    // Parse + authenticate Jupiter ix data.
    let parsed = parse_shared_accounts_route(&jupiter_ix_data)?;
    require!(
        parsed.in_amount == tracker.onyc_amount_in,
        RelayerError::JupiterAmountInMismatch
    );
    require!(
        parsed.platform_fee_bps == 0,
        RelayerError::JupiterPlatformFeeNotZero
    );
    require!(
        parsed.quoted_out_amount >= min_usdc_out,
        RelayerError::JupiterMinOutTooLow
    );
    // Defense in depth on slippage: even if the operator over-discounts
    // min_usdc_out, the absolute floor here prevents accepting a route
    // whose quoted_out is wildly worse than spec.
    let slip_floor = (parsed.quoted_out_amount as u128)
        .checked_mul((10_000 - MAX_SLIPPAGE_BPS) as u128)
        .ok_or(RelayerError::FeeOverflow)?
        / 10_000;
    require!(
        (min_usdc_out as u128) >= slip_floor,
        RelayerError::MaxSlippageExceeded
    );

    // Validate Jupiter route accounts by position.
    require!(
        ctx.remaining_accounts.len() > SHARED_ACCOUNTS_ROUTE_DESTINATION_MINT_INDEX,
        RelayerError::InvalidAccountSplit
    );
    let onyc_ata_key = ctx.accounts.onyc_ata.key();
    let usdc_ata_key = ctx.accounts.usdc_ata.key();
    let onyc_mint_key = ctx.accounts.onyc_mint.key();
    let usdc_mint_key = ctx.accounts.usdc_mint.key();
    require_keys_eq!(
        *ctx.remaining_accounts[SHARED_ACCOUNTS_ROUTE_SOURCE_TOKEN_INDEX].key,
        onyc_ata_key,
        RelayerError::JupiterRouteSourceMismatch
    );
    require_keys_eq!(
        *ctx.remaining_accounts[SHARED_ACCOUNTS_ROUTE_DESTINATION_TOKEN_INDEX].key,
        usdc_ata_key,
        RelayerError::JupiterRouteDestinationMismatch
    );
    require_keys_eq!(
        *ctx.remaining_accounts[SHARED_ACCOUNTS_ROUTE_SOURCE_MINT_INDEX].key,
        onyc_mint_key,
        RelayerError::JupiterRouteSourceMintMismatch
    );
    require_keys_eq!(
        *ctx.remaining_accounts[SHARED_ACCOUNTS_ROUTE_DESTINATION_MINT_INDEX].key,
        usdc_mint_key,
        RelayerError::JupiterRouteDestinationMintMismatch
    );

    // Refunded ONyc must be present (>= because OnRe could have refunded
    // additional pre-existing balance — we burn exactly tracker.onyc_amount_in).
    ctx.accounts.onyc_ata.reload()?;
    require!(
        ctx.accounts.onyc_ata.amount >= tracker.onyc_amount_in,
        RelayerError::ZeroAmountFlow
    );

    // Snapshot intra-handler — authoritative, not the stale tracker field.
    let onyc_before = ctx.accounts.onyc_ata.amount;
    ctx.accounts.usdc_ata.reload()?;
    let usdc_before = ctx.accounts.usdc_ata.amount;

    // CPI Jupiter under relayer_authority. Ix data is the caller-supplied
    // buffer minus the discriminator — `invoke_relayer_signed` re-prepends
    // it. We pass `&[]` for args after building data manually below.
    invoke_jupiter_signed(
        &jupiter_ix_data,
        ctx.remaining_accounts,
        &ctx.accounts.relayer_authority.to_account_info(),
        ctx.accounts.relayer_config.relayer_authority_bump,
    )?;

    // Post-CPI invariants.
    ctx.accounts.onyc_ata.reload()?;
    ctx.accounts.usdc_ata.reload()?;
    let onyc_consumed = onyc_before
        .checked_sub(ctx.accounts.onyc_ata.amount)
        .ok_or(RelayerError::BalanceUnderflow)?;
    let usdc_received = ctx
        .accounts
        .usdc_ata
        .amount
        .checked_sub(usdc_before)
        .ok_or(RelayerError::BalanceUnderflow)?;
    require!(
        onyc_consumed == tracker.onyc_amount_in,
        RelayerError::OnycConsumedMismatch
    );
    require!(usdc_received >= min_usdc_out, RelayerError::ZeroAmountFlow);

    // State mutation only after every check passes.
    let flow = &mut ctx.accounts.outflight_flow;
    flow.amount = usdc_received;
    flow.status = FlowStatus::Swapped;

    emit!(RedemptionSwappedViaJupiter {
        flow: flow_key,
        onyc_consumed,
        usdc_received,
        min_usdc_out,
    });

    Ok(())
}

/// Identical signing semantics to `invoke_relayer_signed`, but the data
/// buffer is supplied verbatim (not `discriminator + Borsh(args)`),
/// because Jupiter ix data is opaque to us beyond the parser.
fn invoke_jupiter_signed<'info>(
    data: &[u8],
    remaining_accounts: &[AccountInfo<'info>],
    authority: &AccountInfo<'info>,
    authority_bump: u8,
) -> Result<()> {
    use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
    use anchor_lang::solana_program::program::invoke_signed;

    let mut metas: Vec<AccountMeta> = Vec::with_capacity(remaining_accounts.len());
    let mut authority_seen = false;
    for a in remaining_accounts {
        let is_authority = a.key == authority.key;
        authority_seen |= is_authority;
        metas.push(AccountMeta {
            pubkey: *a.key,
            is_signer: a.is_signer || is_authority,
            is_writable: a.is_writable,
        });
    }
    require!(authority_seen, RelayerError::AuthorityNotInAccounts);

    let auth_bump_arr = [authority_bump];
    let auth_seeds: &[&[u8]] = &[RELAYER_SEED, &auth_bump_arr];
    let ix = Instruction {
        program_id: JUPITER_V6_PROGRAM_ID,
        accounts: metas,
        data: data.to_vec(),
    };
    invoke_signed(&ix, remaining_accounts, &[auth_seeds])?;
    Ok(())
}

#[derive(Accounts)]
pub struct SwapRedemptionViaJupiter<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = authority @ RelayerError::UnauthorizedAuthority,
        has_one = onyc_mint,
        has_one = usdc_mint,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA seeds enforce identity. Signs the Jupiter CPI.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub onyc_mint: InterfaceAccount<'info, Mint>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = onyc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub onyc_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub usdc_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: validated transitively via the flow PDA seeds.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [FLOW_OUTBOUND_SEED, ntt_inbox_item.key().as_ref()],
        bump = outflight_flow.bump,
    )]
    pub outflight_flow: Account<'info, Flow>,

    #[account(
        mut,
        seeds = [REDEMPTION_TRACKER_SEED],
        bump = redemption_tracker.bump,
        close = payer_for_close,
    )]
    pub redemption_tracker: Account<'info, RedemptionTracker>,

    /// CHECK: pinned by `address`; original payer gets rent back.
    #[account(mut, address = redemption_tracker.payer)]
    pub payer_for_close: UncheckedAccount<'info>,

    /// CHECK: must equal `tracker.redemption_request`; handler verifies
    /// it has been closed (by OnRe cancel or fulfill — either way).
    pub redemption_request: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    /// CHECK: pinned by `address` to JUPITER_V6_PROGRAM_ID.
    #[account(address = crate::jupiter::JUPITER_V6_PROGRAM_ID)]
    pub jupiter_program: UncheckedAccount<'info>,
}
```

- [ ] **Step 2: Re-export module**

Edit `programs/relayer/src/instructions/mod.rs`. Add (alphabetically):

```rust
pub mod swap_redemption_via_jupiter;
pub use swap_redemption_via_jupiter::*;
```

- [ ] **Step 3: Wire dispatch**

Edit `programs/relayer/src/lib.rs`, inside `#[program] pub mod fogo_onre_relayer`, add:

```rust
    /// Authority-only recovery: convert refunded ONyc → USDC via Jupiter v6
    /// when OnRe canceled the redemption. Single Jupiter variant pinned
    /// (`shared_accounts_route`); ix data parsed and authenticated on-chain.
    pub fn swap_redemption_via_jupiter<'info>(
        ctx: Context<'info, SwapRedemptionViaJupiter<'info>>,
        min_usdc_out: u64,
        jupiter_ix_data: Vec<u8>,
    ) -> Result<()> {
        swap_redemption_via_jupiter::handler(ctx, min_usdc_out, jupiter_ix_data)
    }
```

- [ ] **Step 4: Build + IDL refresh**

Run: `anchor build`
Expected: PASS, IDL regenerated.

- [ ] **Step 5: Commit**

```bash
git add programs/relayer/src/instructions/swap_redemption_via_jupiter.rs \
        programs/relayer/src/instructions/mod.rs \
        programs/relayer/src/lib.rs \
        target/idl/fogo_onre_relayer.json \
        target/types/fogo_onre_relayer.ts
git commit -m "feat(relayer): authority-gated swap_redemption_via_jupiter handler"
```

---

### Task 4: Test fixture for Jupiter `.so`

**Files:**
- Create: `tests/fixtures/programs/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4.so`
- Modify: `tests/utils/withdraw-scaffolding.ts`
- Create: `tests/utils/jupiter-fixtures.ts`

- [ ] **Step 1: Pull Jupiter v6 binary**

```bash
solana program dump JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 \
  tests/fixtures/programs/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4.so \
  --url https://api.mainnet-beta.solana.com
```

- [ ] **Step 2: Compute sha256**

Run: `shasum -a 256 tests/fixtures/programs/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4.so`
Record the hex digest — paste it into the next step.

- [ ] **Step 3: Add pin to scaffolding**

Edit `tests/utils/withdraw-scaffolding.ts` `pinBinaryFixtures()`. Find the existing `expected` map (NTT, OnRe entries) and add:

```typescript
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4.so':
    '<paste sha256 hex from step 2>',
```

- [ ] **Step 4: Add fixture loader helper**

Create `tests/utils/jupiter-fixtures.ts`:

```typescript
import { PublicKey } from '@solana/web3.js'
import path from 'node:path'
import fs from 'node:fs'

export const JUPITER_V6_PROGRAM_ID = new PublicKey(
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
)

const JUPITER_SO = path.resolve(
  __dirname,
  '../fixtures/programs/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4.so',
)

export function loadJupiterIntoSvm(svm: { addProgram: (id: PublicKey, bytes: Uint8Array) => void }): void {
  const bytes = fs.readFileSync(JUPITER_SO)
  svm.addProgram(JUPITER_V6_PROGRAM_ID, bytes)
}
```

- [ ] **Step 5: Run pin sanity test**

Run: `pnpm test tests/utils -t "pinBinaryFixtures" 2>/dev/null || pnpm test tests/withdraw-flow.test.ts`
Expected: existing withdraw test still passes (pin table now includes Jupiter and matches on-disk sha256).

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/programs/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4.so \
        tests/utils/withdraw-scaffolding.ts \
        tests/utils/jupiter-fixtures.ts
git commit -m "test: pin jupiter v6 .so fixture"
```

---

### Task 5: LiteSVM end-to-end test

**Files:**
- Create: `tests/swap-redemption-via-jupiter-e2e.test.ts`

A real Jupiter route requires real AMM pools loaded into LiteSVM, which is impractical for a unit-grade test. The test uses a **stub Jupiter ix** built by hand: it sets the discriminator + minimal payload that passes `parse_shared_accounts_route`, then targets a mock pool program that performs the ONyc→USDC swap deterministically. Pattern: mirror `tests/utils/mock-accounts.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/swap-redemption-via-jupiter-e2e.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { PublicKey, Keypair } from '@solana/web3.js'
import { setupWithdrawScaffolding, advanceToRedemptionPending, simulateOnReCancel } from './utils/withdraw-scaffolding'
import { loadJupiterIntoSvm, JUPITER_V6_PROGRAM_ID } from './utils/jupiter-fixtures'
import { buildStubSharedAccountsRouteIx } from './utils/jupiter-stub-route'
import { RelayerClient } from '@fogo-onre/sdk'

describe('swap_redemption_via_jupiter (cancel-recovery)', () => {
  let rig: Awaited<ReturnType<typeof setupWithdrawScaffolding>>

  beforeAll(async () => {
    rig = await setupWithdrawScaffolding()
    loadJupiterIntoSvm(rig.svm)
    await advanceToRedemptionPending(rig)
    await simulateOnReCancel(rig) // closes redemption_request, refunds ONyc
  })

  it('routes refunded ONyc through Jupiter and reaches Swapped', async () => {
    const minUsdcOut = rig.tracker.onyc_amount_in / 1n // 1:1 stub
    const stub = buildStubSharedAccountsRouteIx({
      sourceAta: rig.onycAta,
      destAta: rig.usdcAta,
      sourceMint: rig.onycMint,
      destMint: rig.usdcMint,
      relayerAuthority: rig.relayerAuthorityPda,
      inAmount: rig.tracker.onyc_amount_in,
      quotedOut: minUsdcOut,
    })
    const sig = await rig.client.swapRedemptionViaJupiter({
      authority: rig.authority.publicKey,
      onycMint: rig.onycMint,
      usdcMint: rig.usdcMint,
      nttInboxItem: rig.nttInboxItem,
      jupiterProgram: JUPITER_V6_PROGRAM_ID,
      jupiterIxData: stub.data,
      jupiterRouteAccounts: stub.accounts,
      minUsdcOut,
    }).rpc()
    expect(sig).toBeTruthy()

    const flow = await rig.client.fetchOutflightFlow(rig.nttInboxItem)
    expect(flow!.status).toEqual({ swapped: {} })
    expect(flow!.amount).toBeGreaterThanOrEqual(minUsdcOut)

    const tracker = await rig.svm.getAccount(rig.client.redemptionTrackerPda)
    expect(tracker).toBeNull() // closed
  })

  it('rejects when authority is not the config authority', async () => {
    // ... attacker-keypair variant; expect UnauthorizedAuthority (6004)
  })

  it('rejects when min_usdc_out > MAX_SLIPPAGE_BPS below quoted', async () => {
    // expect MaxSlippageExceeded
  })

  it('rejects when in_amount != tracker.onyc_amount_in', async () => {
    // expect JupiterAmountInMismatch
  })

  it('rejects when route source ATA != relayer onyc_ata', async () => {
    // expect JupiterRouteSourceMismatch
  })
})
```

> **NOTE FOR IMPLEMENTER:** `buildStubSharedAccountsRouteIx` belongs in a small helper `tests/utils/jupiter-stub-route.ts` that you write when the test is fleshed out. The stub program target is whatever pool you mount in LiteSVM that performs a 1:1 ONyc→USDC mint-burn under the relayer-authority signer; the SPL token-swap program loaded with a deterministic curve is sufficient.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/swap-redemption-via-jupiter-e2e.test.ts -t "routes refunded ONyc"`
Expected: FAIL — `client.swapRedemptionViaJupiter` not yet defined.

- [ ] **Step 3: Commit (failing test pinned)**

```bash
git add tests/swap-redemption-via-jupiter-e2e.test.ts
git commit -m "test: failing e2e for swap_redemption_via_jupiter"
```

---

### Task 6: SDK builder

**Files:**
- Create: `packages/sdk/src/builders/jupiter.ts`
- Modify: `packages/sdk/src/client.ts`
- Modify: `packages/sdk/src/index.ts`

- [ ] **Step 1: Quote helper**

Create `packages/sdk/src/builders/jupiter.ts`:

```typescript
import { PublicKey, AccountMeta, TransactionInstruction } from '@solana/web3.js'

const JUP_QUOTE = 'https://quote-api.jup.ag/v6/quote'
const JUP_SWAP_IX = 'https://quote-api.jup.ag/v6/swap-instructions'

export const JUPITER_V6_PROGRAM_ID = new PublicKey(
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
)

export interface JupiterRouteParams {
  inputMint: PublicKey
  outputMint: PublicKey
  amount: bigint
  /** Forced to `shared_accounts_route` by `restrictIntermediateTokens=false`
   *  + `useSharedAccounts=true`; if Jupiter cannot honor, throws. */
  slippageBps: number
  userPublicKey: PublicKey
}

export interface JupiterRouteResult {
  ixData: Uint8Array
  routeAccounts: AccountMeta[]
  quotedOutAmount: bigint
  /** Address-lookup-table public keys returned by Jupiter. */
  addressLookupTables: PublicKey[]
}

export async function fetchJupiterRoute(p: JupiterRouteParams): Promise<JupiterRouteResult> {
  const q = new URL(JUP_QUOTE)
  q.searchParams.set('inputMint', p.inputMint.toBase58())
  q.searchParams.set('outputMint', p.outputMint.toBase58())
  q.searchParams.set('amount', p.amount.toString())
  q.searchParams.set('slippageBps', String(p.slippageBps))
  q.searchParams.set('platformFeeBps', '0')
  q.searchParams.set('onlyDirectRoutes', 'false')
  const quote = await (await fetch(q)).json()

  const swapResp = await fetch(JUP_SWAP_IX, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: p.userPublicKey.toBase58(),
      useSharedAccounts: true,
      wrapAndUnwrapSol: false,
    }),
  })
  const swap = await swapResp.json()
  if (!swap.swapInstruction) {
    throw new Error('Jupiter did not return a shared_accounts_route swapInstruction')
  }
  const si = swap.swapInstruction
  return {
    ixData: Buffer.from(si.data, 'base64'),
    routeAccounts: si.accounts.map((a: any) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    quotedOutAmount: BigInt(quote.outAmount),
    addressLookupTables: (swap.addressLookupTableAddresses ?? []).map(
      (s: string) => new PublicKey(s),
    ),
  }
}
```

- [ ] **Step 2: Add builder to RelayerClient**

Edit `packages/sdk/src/client.ts`. After `cancelRedemptionOnyc`, add:

```typescript
  /**
   * Authority-only recovery handler. After OnRe cancels a redemption,
   * the operator fetches a fresh Jupiter `shared_accounts_route` quote
   * (`fetchJupiterRoute`), feeds the resulting `ixData` + `routeAccounts`
   * here, and the on-chain handler authenticates the ix data, signs the
   * Jupiter CPI under `relayer_authority`, and closes the tracker.
   */
  swapRedemptionViaJupiter(params: {
    authority: PublicKey
    onycMint: PublicKey
    usdcMint: PublicKey
    nttInboxItem: PublicKey
    jupiterProgram: PublicKey
    jupiterIxData: Uint8Array
    jupiterRouteAccounts: AccountMeta[]
    minUsdcOut: bigint
  }) {
    const { outflightFlow, redemptionTracker } = this.flowPdas(params.nttInboxItem)
    return this.program.methods
      .swapRedemptionViaJupiter(new BN(params.minUsdcOut.toString()), Buffer.from(params.jupiterIxData))
      .accounts({
        authority: params.authority,
        relayerConfig: this.configPda,
        relayerAuthority: this.relayerAuthorityPda,
        onycMint: params.onycMint,
        usdcMint: params.usdcMint,
        onycAta: getAssociatedTokenAddressSync(params.onycMint, this.relayerAuthorityPda, true),
        usdcAta: getAssociatedTokenAddressSync(params.usdcMint, this.relayerAuthorityPda, true),
        nttInboxItem: params.nttInboxItem,
        outflightFlow,
        redemptionTracker,
        // payer_for_close & redemption_request resolved by Anchor via
        // `address = redemption_tracker.payer / .redemption_request` —
        // pre-fetch tracker if your caller wants to be explicit; here we
        // require the caller to pass them via remainingAccounts hookup.
        tokenProgram: TOKEN_PROGRAM_ID,
        jupiterProgram: params.jupiterProgram,
      })
      .remainingAccounts(params.jupiterRouteAccounts)
  }
```

> **IMPLEMENTER NOTE:** `payer_for_close` + `redemption_request` are pinned via `address = ...`. The SDK builder must fetch the tracker first to populate them explicitly in `.accounts({ payerForClose, redemptionRequest })` — `claimRedemptionUsdc` does the same; mirror it.

- [ ] **Step 3: Re-export**

Edit `packages/sdk/src/index.ts`. Add:

```typescript
export { fetchJupiterRoute, JUPITER_V6_PROGRAM_ID } from './builders/jupiter'
```

- [ ] **Step 4: SDK build**

Run: `pnpm sdk build`
Expected: PASS.

- [ ] **Step 5: Re-run e2e test (one case at a time as you flesh out the stub helper)**

Run: `pnpm test tests/swap-redemption-via-jupiter-e2e.test.ts`
Expected: happy-path test PASS once stub-route helper is wired; negative cases follow.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/builders/jupiter.ts packages/sdk/src/client.ts packages/sdk/src/index.ts
git commit -m "feat(sdk): swapRedemptionViaJupiter builder + jupiter quote helper"
```

---

### Task 7: Race classifier additions

**Files:**
- Modify: `packages/cranker/src/relayer/race-classifier.ts`

- [ ] **Step 1: Extend RACE_TABLE**

Edit `packages/cranker/src/relayer/race-classifier.ts`. Replace the `RACE_TABLE` block with:

```typescript
const RACE_TABLE: Record<number, string> = {
  6026: 'lost race — another cranker drained user_inbox_ata before our claim_usdc landed (InsufficientInboxBalance, code 6026)',
  // swap_redemption_via_jupiter is authority-gated, so two-cranker
  // races are impossible by construction. These entries are defensive
  // against an operator double-fire.
  3002: 'lost race — RedemptionTracker already closed (AccountDiscriminatorMismatch, code 3002)',
  3012: 'lost race — RedemptionTracker already closed (AccountNotInitialized, code 3012)',
}
```

- [ ] **Step 2: Add a unit test**

Append to whichever existing `race-classifier.test.ts` exists (or create one). Minimal:

```typescript
import { describe, it, expect } from 'vitest'
import { isLostRace } from '../src/relayer/race-classifier'

describe('isLostRace', () => {
  it('classifies AccountNotInitialized as benign race', () => {
    expect(isLostRace({ error: { errorCode: { number: 3012 } } })).toMatch(/closed/)
  })
  it('classifies AccountDiscriminatorMismatch as benign race', () => {
    expect(isLostRace({ error: { errorCode: { number: 3002 } } })).toMatch(/closed/)
  })
  it('returns null for unknown codes', () => {
    expect(isLostRace({ error: { errorCode: { number: 9999 } } })).toBeNull()
  })
})
```

- [ ] **Step 3: Run test**

Run: `pnpm test packages/cranker -t "isLostRace"`
Expected: 3 PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cranker/src/relayer/race-classifier.ts packages/cranker/test/race-classifier.test.ts
git commit -m "feat(cranker): classify recovery-path race codes"
```

---

### Task 8: Daemon detection (alert-only, no auto-fire)

**Files:**
- Modify: `packages/cranker/src/relayer/claim-redemption-usdc.ts`

The advancer currently tries `claim_redemption_usdc`, hits `ZeroAmountFlow`, and surfaces an error every cooldown. Add a pre-flight branch: when the cancel-fingerprint is detected (`request closed && usdc_delta == 0 && onyc_returned`), emit a structured alert and noop. **Do not fire the recovery handler from the daemon** — operator runs the SDK script (Task 9) manually.

- [ ] **Step 1: Add detection branch**

Edit `packages/cranker/src/relayer/claim-redemption-usdc.ts`. After fetching `(redemption_request, usdc_ata, onyc_ata)` accounts and before calling `client.claimRedemptionUsdc(...)`, add:

```typescript
    // Detect OnRe-cancel fingerprint: request closed, usdc_delta == 0,
    // ONyc refunded. Recovery is operator-driven via SDK script
    // `scripts/recover-jupiter-fallback.ts`; do not auto-fire here.
    if (
      requestClosed
      && usdcAta.amount === tracker.usdc_ata_pre_balance
      && onycAta.amount >= tracker.onyc_amount_in
    ) {
      ctx.metrics.redemptionCanceled.inc({ flow: flowKey.toBase58() })
      ctx.log.warn({
        event: 'OnReRedemptionCanceled',
        flow: flowKey.toBase58(),
        tracker: client.redemptionTrackerPda.toBase58(),
        onyc_refunded: onycAta.amount.toString(),
      }, 'OnRe canceled redemption — operator must run `swap-redemption-via-jupiter`')
      return {
        kind: 'noop',
        reason: 'OnRe canceled redemption; awaiting operator-driven Jupiter recovery',
      }
    }
```

- [ ] **Step 2: Register the metric**

Edit wherever `ctx.metrics` is constructed (likely `packages/cranker/src/metrics.ts`). Add:

```typescript
  redemptionCanceled: new Counter({
    name: 'cranker_redemption_canceled_total',
    help: 'OnRe redemption canceled; operator action required',
    labelNames: ['flow'],
  }),
```

- [ ] **Step 3: Run cranker tests**

Run: `pnpm test packages/cranker`
Expected: PASS (existing tests still green; new branch unit-tested as part of Task 5 e2e indirectly, or add a focused test if there's an existing claim-redemption-usdc.test.ts).

- [ ] **Step 4: Commit**

```bash
git add packages/cranker/src/relayer/claim-redemption-usdc.ts packages/cranker/src/metrics.ts
git commit -m "feat(cranker): alert on OnRe cancel, defer recovery to operator"
```

---

### Task 9: Operator runbook + recovery script (SDK-driven, no CLI)

**Files:**
- Create: `docs/runbooks/2026-05-10-recover-FEjqp-flow.md`
- Create: `scripts/recover-jupiter-fallback.ts`

CLI surface intentionally deferred. The operator runs the recovery from a small standalone `tsx` script using the SDK. This keeps the CLI's coupling to the new handler at zero — no CLI test debt, no flag-parsing UX to revisit, and the script lives next to the runbook so it's self-documenting.

- [ ] **Step 1: Write the recovery script**

Create `scripts/recover-jupiter-fallback.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * One-off recovery: swap refunded ONyc → USDC via Jupiter v6 after
 * OnRe canceled a redemption. Operator-driven; no daemon auto-fire.
 *
 * Usage:
 *   AUTHORITY_KEYPAIR=/path/to/auth.json \
 *   FLOW=FEjqpMcDJJpZRRFUnThF874GKVUUhx3ohnB9EepqNcBj \
 *   SLIPPAGE_BPS=50 \
 *   CONFIRM=0 \
 *   pnpm tsx scripts/recover-jupiter-fallback.ts
 *
 * Set CONFIRM=1 to broadcast. Default is dry-run.
 */
import {
  Connection, PublicKey, Keypair,
  ComputeBudgetProgram, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js'
import fs from 'node:fs'
import { RelayerClient, fetchJupiterRoute, JUPITER_V6_PROGRAM_ID } from '@fogo-onre/sdk'

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'
const FLOW = new PublicKey(must('FLOW'))
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 50)
const CONFIRM = process.env.CONFIRM === '1'
const KEYPAIR_PATH = must('AUTHORITY_KEYPAIR')

if (SLIPPAGE_BPS > 50) throw new Error('SLIPPAGE_BPS exceeds MAX_SLIPPAGE_BPS=50')

function must(k: string): string {
  const v = process.env[k]
  if (!v) throw new Error(`missing env: ${k}`)
  return v
}

const conn = new Connection(RPC, 'confirmed')
const auth = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'))),
)
const client = await RelayerClient.fromConnection(conn, auth)

const tracker = await client.fetchRedemptionTracker(client.redemptionTrackerPda)
if (!tracker) throw new Error('RedemptionTracker not held — nothing to recover')
if (!tracker.flow.equals(FLOW)) {
  throw new Error(`Tracker holds a different flow: ${tracker.flow.toBase58()}`)
}

const cfg = await client.fetchConfig()
if (!cfg.authority.equals(auth.publicKey)) {
  throw new Error(`AUTHORITY_KEYPAIR (${auth.publicKey.toBase58()}) is not relayer_config.authority (${cfg.authority.toBase58()})`)
}

const route = await fetchJupiterRoute({
  inputMint: cfg.onycMint,
  outputMint: cfg.usdcMint,
  amount: tracker.onyc_amount_in,
  slippageBps: SLIPPAGE_BPS,
  userPublicKey: client.relayerAuthorityPda,
})
const minUsdcOut = (route.quotedOutAmount * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n

console.log('jupiter-fallback recovery plan')
console.log(`  flow:           ${FLOW.toBase58()}`)
console.log(`  tracker:        ${client.redemptionTrackerPda.toBase58()}`)
console.log(`  onyc_in:        ${tracker.onyc_amount_in}`)
console.log(`  quoted_out:     ${route.quotedOutAmount}`)
console.log(`  min_usdc_out:   ${minUsdcOut} (slippage ${SLIPPAGE_BPS} bps)`)
console.log(`  ALTs:           ${route.addressLookupTables.map(p => p.toBase58()).join(', ') || '(none)'}`)

if (!CONFIRM) {
  console.log('dry-run; set CONFIRM=1 to broadcast')
  process.exit(0)
}

const ix = await client.swapRedemptionViaJupiter({
  authority: auth.publicKey,
  onycMint: cfg.onycMint,
  usdcMint: cfg.usdcMint,
  // ntt_inbox_item is derivable from the flow PDA seeds; mirror what
  // packages/cranker/src/relayer/claim-redemption-usdc.ts does (~L1567).
  nttInboxItem: deriveInboxItemFromFlow(FLOW),
  jupiterProgram: JUPITER_V6_PROGRAM_ID,
  jupiterIxData: route.ixData,
  jupiterRouteAccounts: route.routeAccounts,
  minUsdcOut,
}).instruction()

const lookupTables = (await Promise.all(
  route.addressLookupTables.map((k) => conn.getAddressLookupTable(k)),
)).map((r) => r.value!).filter(Boolean)

const blockhash = await conn.getLatestBlockhash()
const msg = new TransactionMessage({
  payerKey: auth.publicKey,
  recentBlockhash: blockhash.blockhash,
  instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
    ix,
  ],
}).compileToV0Message(lookupTables)
const tx = new VersionedTransaction(msg)
tx.sign([auth])
const sig = await conn.sendTransaction(tx)
await conn.confirmTransaction({ signature: sig, ...blockhash })
console.log(`landed: ${sig}`)

function deriveInboxItemFromFlow(_flow: PublicKey): PublicKey {
  // PASTE the derivation from packages/cranker/src/relayer/claim-redemption-usdc.ts
  // (it reads from the tracker or recomputes from the flow PDA seeds).
  throw new Error('TODO: paste inbox-item derivation from claim-redemption-usdc.ts')
}
```

> **IMPLEMENTER NOTE:** the `deriveInboxItemFromFlow` stub is the one place this script needs an explicit paste — copy the helper out of `packages/cranker/src/relayer/claim-redemption-usdc.ts` (around line 1567 in `cli/src/commands/cranker.ts`'s claim-redemption-usdc subcommand, which already does this lookup against `tracker.redemption_request`). Keep it inline; this is a one-off script, not library code.

- [ ] **Step 2: Write the runbook**

Create `docs/runbooks/2026-05-10-recover-FEjqp-flow.md`:

```markdown
# Recovery: stranded flow FEjqp…NcBj (2026-05-10)

## Pre-flight
1. Confirm flow status via SDK (REPL or one-off script):
   - `RelayerClient.fetchOutflightFlow(...)` → expect `status = RedemptionPending`.
2. Confirm tracker is held:
   - `RelayerClient.fetchRedemptionTracker(client.redemptionTrackerPda)` →
     non-null, with `flow == FEjqp…NcBj`.
3. Confirm OnRe-cancel fingerprint:
   - `redemption_request` account: `lamports == 0`, `owner == 11111111111111111111111111111111`.
   - `usdc_ata.amount == tracker.usdc_ata_pre_balance`.
   - `onyc_ata.amount >= tracker.onyc_amount_in`.
   - The cranker's `OnReRedemptionCanceled` log line (Task 8) is also a
     positive signal.

## Dry-run
```bash
AUTHORITY_KEYPAIR=/path/to/auth.json \
FLOW=FEjqpMcDJJpZRRFUnThF874GKVUUhx3ohnB9EepqNcBj \
SLIPPAGE_BPS=50 \
pnpm tsx scripts/recover-jupiter-fallback.ts
```
Inspect plan. Verify `min_usdc_out` is sane against spot ONyc/USDC price.

## Broadcast
Re-run with `CONFIRM=1`. Authority key signs.

## Post-flight
1. Confirm `flow.status == Swapped` and `flow.amount == usdc_received`.
2. Confirm tracker closed (`getAccountInfo(client.redemptionTrackerPda) == null`).
3. The cranker should auto-pick up `send-usdc-to-user` on its next scan.
4. Verify the singleton mutex is free by submitting an unrelated withdraw or
   inspecting whether new flows reach `RedemptionPending` cleanly.

## Rollback
There is no rollback. Jupiter is atomic; either the tx lands and the FSM
advances, or it reverts and state is unchanged. If the tx repeatedly
reverts, capture the Anchor error code, cross-reference `programs/relayer/src/error.rs`,
and escalate. Common codes:
- `MaxSlippageExceeded` — Jupiter quote moved; re-run after fresh quote.
- `JupiterAmountInMismatch` — quote was for a different amount; check
  `tracker.onyc_amount_in` and rerun.
- `OnycConsumedMismatch` — Jupiter route burned a different amount than
  quoted; almost always means the route includes a fee-on-transfer pool.
  Re-run with `onlyDirectRoutes=true` in `fetchJupiterRoute`.
```

- [ ] **Step 3: Commit**

```bash
git add scripts/recover-jupiter-fallback.ts docs/runbooks/2026-05-10-recover-FEjqp-flow.md
git commit -m "docs: runbook + script for jupiter-fallback recovery"
```

---

## Self-Review

**Spec coverage:**
- §Architecture (one new handler, FSM unchanged) → Task 3.
- §Authority-gated → Task 3 `Accounts.has_one = authority`.
- §Preconditions 1–10 → Task 3 handler body (gates 1–5 + 10 in pre-CPI block, 6 via `address = JUPITER_V6_PROGRAM_ID`, 7–8 via parser, 9 via position checks).
- §Handler signature with no `onyc_amount_in` parameter → Task 3 dispatch + Task 6 builder.
- §Single Jupiter variant pinned → Task 2 parser + Task 3 discriminator gate.
- §Logic sequential → Task 3 ordering matches spec.
- §Slippage policy `MAX_SLIPPAGE_BPS = 50` + `quoted_out >= min_usdc_out` defense-in-depth → Task 1 const + Task 3 invariants.
- §Compute budget + ALTs → Task 9 recovery script builds v0 tx with ALTs and `setComputeUnitLimit(1_000_000)`.
- §Race classifier additions → Task 7.
- §Cancel-fee tolerance: `>=` not exact equality on ONyc → Task 3 precondition.
- §Daemon alerts but doesn't auto-fire → Task 8.
- §Naming `swap_redemption_via_jupiter` → all tasks.
- §Out of scope (donation-grief, recovery of FEjqp) → Task 9 covers recovery; donation-grief explicitly not addressed (separate PR per spec).

**Placeholder scan:**
- Task 2 Steps 0/1 carry concrete IDL-fetch commands and explicit "paste from this file" callouts; the unknown-tag arm fails closed (`Err(JupiterIxDiscriminatorMismatch)`), so an unpopulated table reverts rather than mis-skips.
- Task 6 SDK builder note about `payerForClose`/`redemptionRequest` pin is a 5-line mirror of `claimRedemptionUsdc`'s logic — pointer is exact, not freeform.
- Task 9 recovery script has one `deriveInboxItemFromFlow` paste call-out pointing at the existing helper site in `claim-redemption-usdc` cranker module — bounded scope, surfaces immediately if missed (script throws on first run).
- Task 5 negative cases are TDD stubs with `// expect …` comments. Acceptable per TDD shape — happy-path failing test is the gate; negative cases ship before the final commit of Task 5.

**Type consistency:**
- `swapRedemptionViaJupiter` name is identical across handler dispatch (Task 3), Anchor IDL, SDK builder (Task 6), and recovery script (Task 9).
- `MAX_SLIPPAGE_BPS = 50` consistent across `constants.rs` (Task 1), recovery-script env-var clamp (Task 9), and on-chain check (Task 3).
- `RedemptionSwappedViaJupiter` event field set matches across `events.rs` and the `emit!` site.
- `tracker.onyc_amount_in` reused across handler (Task 3), recovery-script plan-print (Task 9), and SDK quote-amount input (Task 6).

No issues found. Plan complete.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-10-jupiter-fallback-on-onre-cancel.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
