# Withdraw-Path Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four OnRe-path withdraw handlers (`request_redemption_onyc`, `claim_redemption_usdc`, `cancel_redemption_onyc`, `redeem_onyc`) with a single permissionless `swap_onyc_to_usdc` handler. ONyc → USDC conversion goes through any swap program under NAV-anchored slippage protection.

**Architecture:** New handler is a near-copy of `redeem_onyc.rs` minus the cancel-branch state (tracker, redemption_request, cooldown) plus fee deduction. Security model: NAV floor (tightened to 10 bps) + bounded SPL Approve + plain `invoke`. State machine becomes `Claimed → Swapped` for outbound flows. State types (`FlowStatus::RedemptionPending`, `RedemptionTracker`, `RelayerConfig.last_redeem_slot`) are **kept as deprecated** to satisfy byte-stability invariants — historical PDAs must still deserialize. Pre-deploy drain of `RedemptionPending` flows is a hard gate.

**Tech Stack:** Anchor 1.0.2 / Rust 1.95.0 / Solana 3.1.8 / TypeScript / vitest / LiteSVM.

**Spec:** `docs/superpowers/specs/2026-05-11-withdraw-path-simplification-design.md`

---

## Phase 0: Baseline and drain gate

### Task 0: Worktree, baseline, spec commit

**Files:** none modified; baseline only.

- [ ] **Step 1: Create isolated worktree**

```bash
cd /Users/tiamo/RustroverProjects/fogo-onre
git worktree add ../fogo-onre-withdraw-simplify -b feat/withdraw-path-simplification
cd ../fogo-onre-withdraw-simplify
pnpm install
```

- [ ] **Step 2: Baseline test + build**

```bash
pnpm test 2>&1 | tee /tmp/baseline-tests.txt
anchor build
cargo clippy --workspace -- -D warnings
```

Expected: 170/170 pass, clean build, zero clippy warnings. If anything red, STOP — fix the baseline before starting.

- [ ] **Step 3: Commit spec**

```bash
git add docs/superpowers/specs/2026-05-11-withdraw-path-simplification-design.md
git commit -m "docs: withdraw-path simplification spec"
```

### Task 0.5: Pre-deploy drain verification (HARD GATE)

**Why this exists:** Any `Flow` with `status == FlowStatus::RedemptionPending` (borsh tag 2) becomes permanently stuck once `claim_redemption_usdc` and `redeem_onyc` are deleted. The borsh tag invariant test guarantees the variant stays *deserializable*, but no handler will advance it. This task verifies prod state before we cross the point of no return.

**Files:** Create `scripts/audit-redemption-pending-flows.ts`

- [ ] **Step 1: Write the audit script**

Pattern after existing scripts in `scripts/`. The script:
1. Connects to mainnet via `process.env.SOLANA_RPC_URL` (or `--rpc` flag).
2. Enumerates all `Flow` accounts owned by the relayer program via `getProgramAccounts` filtered by Flow discriminator.
3. Counts flows by status. Asserts `RedemptionPending` count == 0 and `RedemptionTracker` count == 0.
4. Exits non-zero if any are found, printing PDA addresses so operators can drive them through `claim_redemption_usdc` / `redeem_onyc` before merge.

```ts
// scripts/audit-redemption-pending-flows.ts
import { Connection, PublicKey } from '@solana/web3.js'
import { RELAYER_PROGRAM_ID, flowAccountDiscriminator, redemptionTrackerDiscriminator } from '@fogo-onre/sdk'

async function main() {
  const rpc = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'
  const conn = new Connection(rpc, 'confirmed')
  const flows = await conn.getProgramAccounts(new PublicKey(RELAYER_PROGRAM_ID), {
    filters: [{ memcmp: { offset: 0, bytes: flowAccountDiscriminator() } }],
  })
  // Flow layout: 8 (discrim) + 32 (fogo_sender) + 1 (status) + ...
  // status byte at offset 40.
  const pending = flows.filter(f => f.account.data[40] === 2)
  const trackers = await conn.getProgramAccounts(new PublicKey(RELAYER_PROGRAM_ID), {
    filters: [{ memcmp: { offset: 0, bytes: redemptionTrackerDiscriminator() } }],
  })
  if (pending.length > 0 || trackers.length > 0) {
    console.error(`HARD GATE: ${pending.length} RedemptionPending flows, ${trackers.length} trackers`)
    for (const p of pending) console.error('  flow', p.pubkey.toBase58())
    for (const t of trackers) console.error('  tracker', t.pubkey.toBase58())
    process.exit(1)
  }
  console.log('drain verified: no RedemptionPending flows, no trackers')
}
main().catch(e => { console.error(e); process.exit(2) })
```

- [ ] **Step 2: Run against mainnet**

```bash
SOLANA_RPC_URL=<mainnet-rpc> pnpm tsx scripts/audit-redemption-pending-flows.ts
```

Expected: exit 0 with "drain verified" message. If exit 1, **STOP the entire plan**. Operators must drain via existing handlers before this work can proceed.

- [ ] **Step 3: Commit script**

```bash
git add scripts/audit-redemption-pending-flows.ts
git commit -m "chore: add pre-deploy drain audit script"
```

---

## Phase 1: New handler on-chain (TDD)

### Task 1: Failing happy-path integration test

**Files:** Create `tests/swap-onyc-to-usdc.test.ts`

- [ ] **Step 1: Read existing template**

```bash
# Use these as the reference for scaffolding shape:
# - tests/redeem-onyc-e2e.test.ts (closest match: same swap-via-Jupiter shape)
# - tests/utils/withdraw-scaffolding.ts (pinned-fixture rig)
```

- [ ] **Step 2: Write failing test**

```ts
import { describe, expect, it } from 'vitest'
import { buildWithdrawScaffold, type WithdrawScaffold } from './utils/withdraw-scaffolding'

describe('swap_onyc_to_usdc', () => {
  it('happy path: Claimed → Swapped, fee debited, USDC delta ≥ floor', async () => {
    const s: WithdrawScaffold = await buildWithdrawScaffold()
    // Outbound flow at Claimed with ONyc already credited to relayer_onyc_ata
    // (the state unlock_onyc leaves the chain in).
    const flow = await s.seedOutboundClaimedFlow({ onycAmount: 1_000_000n })
    // Mock Jupiter route returning 999_500 USDC for 999_000 ONyc (post-5bps fee, 1:1 price).
    // Floor at 10 bps slippage = 999_000 * 9990 / 10_000 = 998_001.
    const swapIxData = s.buildMockSwapIx({ outAmount: 999_500n })

    const sig = await s.client.swapOnycToUsdc({
      ntt_inbox_item: flow.nttInboxItem,
      swap_program: s.mockSwapProgram,
      swap_delegate: s.mockSwapDelegate,
      swap_ix_data: swapIxData,
      remaining_accounts: s.mockSwapAccounts(),
    }).rpc()

    const flowAfter = await s.client.fetchFlow(flow.pda)
    expect(flowAfter.status).toEqual({ swapped: {} })
    expect(flowAfter.amount).toBeGreaterThanOrEqual(998_001n) // ≥ floor
    expect(await s.feeVaultOnycBalance()).toBe(500n) // 5 bps of 1_000_000
  })
})
```

- [ ] **Step 3: Verify FAIL**

```bash
pnpm test tests/swap-onyc-to-usdc.test.ts -t 'happy path'
```

Expected: FAIL — `client.swapOnycToUsdc is not a function`.

- [ ] **Step 4: Commit failing test**

```bash
git add tests/swap-onyc-to-usdc.test.ts
git commit -m "test: failing happy-path for swap_onyc_to_usdc"
```

### Task 2: Implement `swap_onyc_to_usdc.rs`

**Files:**
- Create: `programs/relayer/src/instructions/swap_onyc_to_usdc.rs`
- Modify: `programs/relayer/src/instructions/mod.rs`
- Modify: `programs/relayer/src/lib.rs`
- Possibly modify: `programs/relayer/src/events.rs` (add `OnycSwapped` event mirroring `OnycRedeemed`)

- [ ] **Step 1: Write the handler** — near-copy of `redeem_onyc.rs` with these deltas:
  - No `redemption_tracker`, no `redemption_request`, no cooldown, no `last_redeem_slot` update.
  - Status check: `Claimed` (not `RedemptionPending`).
  - Withdraw fee deducted from `flow.amount` (the ONyc unlocked by `unlock_onyc`) via `relayer_config.apply_withdraw_fee(...)` and transferred to `fee_vault_onyc_ata`.
  - Approve and floor computed against post-fee net.
  - Final: `flow.amount = usdc_received; flow.status = Swapped`.

Full handler body (the long pseudocode I gave in the prior plan was wrong — use this exact structure, modeled on `redeem_onyc.rs`):

```rust
//! Permissionless ONyc→USDC conversion via any swap program. Same security
//! model as the deleted `redeem_onyc`: NAV floor + bounded SPL Approve +
//! plain `invoke`. Operates directly on outbound `Flow` after `unlock_onyc`,
//! no OnRe redemption-request intermediate.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface, TransferChecked, transfer_checked};

use crate::constants::{
    CONFIG_SEED, FLOW_OUTBOUND_SEED, MAX_SLIPPAGE_BPS, ONRE_DEPOSIT_OFFER_SEED, ONRE_PROGRAM_ID,
    RELAYER_SEED,
};
use crate::cpi::approve_swap_delegate;
use crate::error::RelayerError;
use crate::events::OnycSwapped;
use crate::onre::{
    apply_slippage_floor, calculate_step_price, parse_active_offer_vector, redemption_expected_out,
};
use crate::state::{Flow, FlowStatus, RelayerConfig};

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, SwapOnycToUsdc<'info>>,
    swap_ix_data: Vec<u8>,
) -> Result<()> {
    let clock = Clock::get()?;
    let now_unix = clock.unix_timestamp as u64;
    let flow_key = ctx.accounts.outflight_flow.key();
    let gross_onyc = ctx.accounts.outflight_flow.amount;

    require!(
        ctx.accounts.outflight_flow.status == FlowStatus::Claimed,
        RelayerError::FlowStatusMismatch
    );
    require!(gross_onyc > 0, RelayerError::ZeroAmountFlow);

    // 1. Fee deduction (mirrors request_redemption_onyc semantics).
    let (net_onyc, fee_onyc) = ctx.accounts.relayer_config.apply_withdraw_fee(gross_onyc)?;
    let authority_bump = ctx.accounts.relayer_config.relayer_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[RELAYER_SEED, &[authority_bump]]];

    if fee_onyc > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.onyc_ata.to_account_info(),
                    mint: ctx.accounts.onyc_mint.to_account_info(),
                    to: ctx.accounts.fee_vault_onyc_ata.to_account_info(),
                    authority: ctx.accounts.relayer_authority.to_account_info(),
                },
                signer_seeds,
            ),
            fee_onyc,
            ctx.accounts.onyc_mint.decimals,
        )?;
    }

    // 2. NAV floor — full Offer-address-and-mints validation
    //    (verbatim from redeem_onyc.rs).
    require_keys_eq!(
        *ctx.accounts.onre_offer.owner,
        ONRE_PROGRAM_ID,
        RelayerError::OnreOfferOwnerMismatch
    );
    let (expected_offer_pda, _bump) = Pubkey::find_program_address(
        &[
            ONRE_DEPOSIT_OFFER_SEED,
            ctx.accounts.relayer_config.usdc_mint.as_ref(),
            ctx.accounts.relayer_config.onyc_mint.as_ref(),
        ],
        &ONRE_PROGRAM_ID,
    );
    require_keys_eq!(
        ctx.accounts.onre_offer.key(),
        expected_offer_pda,
        RelayerError::OnreOfferAddressMismatch
    );

    let nav_floor: u64 = {
        let offer_data = ctx.accounts.onre_offer.try_borrow_data()?;
        require!(
            offer_data.len() >= crate::constants::ONRE_OFFER_ACCOUNT_SIZE,
            RelayerError::OnreOfferTooShort
        );
        let in_mint = Pubkey::try_from(&offer_data[8..40])
            .map_err(|_| error!(RelayerError::OnreOfferTooShort))?;
        let out_mint = Pubkey::try_from(&offer_data[40..72])
            .map_err(|_| error!(RelayerError::OnreOfferTooShort))?;
        require_keys_eq!(in_mint, ctx.accounts.relayer_config.usdc_mint, RelayerError::OnreOfferTokenInMintMismatch);
        require_keys_eq!(out_mint, ctx.accounts.relayer_config.onyc_mint, RelayerError::OnreOfferTokenOutMintMismatch);
        let active = parse_active_offer_vector(&offer_data, now_unix)?;
        let price = calculate_step_price(&active, now_unix)?;
        let gross_expected = redemption_expected_out(
            net_onyc,
            price,
            ctx.accounts.onyc_mint.decimals,
            ctx.accounts.usdc_mint.decimals,
        )?;
        apply_slippage_floor(gross_expected, MAX_SLIPPAGE_BPS)?
    };

    // 3. Reload post-fee onyc_ata; assert sufficient balance.
    ctx.accounts.onyc_ata.reload()?;
    require!(
        ctx.accounts.onyc_ata.amount >= net_onyc,
        RelayerError::ZeroAmountFlow
    );
    let onyc_before = ctx.accounts.onyc_ata.amount;
    let usdc_before = ctx.accounts.usdc_ata.amount;

    // 4. Bounded Approve to swap_delegate for exactly net_onyc.
    approve_swap_delegate(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.onyc_ata.to_account_info(),
        &ctx.accounts.relayer_authority,
        authority_bump,
        &ctx.accounts.swap_delegate,
        net_onyc,
    )?;

    // 5. Plain invoke — never invoke_signed; signer flags forwarded verbatim.
    let metas: Vec<AccountMeta> = ctx
        .remaining_accounts
        .iter()
        .map(|a| AccountMeta { pubkey: *a.key, is_signer: a.is_signer, is_writable: a.is_writable })
        .collect();
    invoke(
        &Instruction {
            program_id: *ctx.accounts.swap_program.key,
            accounts: metas,
            data: swap_ix_data,
        },
        ctx.remaining_accounts,
    )?;

    // 6. Exact-consume on ONyc, floor-check on USDC.
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
    require!(onyc_consumed == net_onyc, RelayerError::OnycConsumedMismatch);
    require!(usdc_received >= nav_floor, RelayerError::RedeemSlippageBelowFloor);

    // 7. Flip status; overwrite flow.amount with usdc_received for the next leg.
    let flow = &mut ctx.accounts.outflight_flow;
    flow.amount = usdc_received;
    flow.status = FlowStatus::Swapped;

    emit!(OnycSwapped {
        flow: flow_key,
        onyc_consumed,
        usdc_received,
        fee_onyc,
        nav_floor,
        swap_program: *ctx.accounts.swap_program.key,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SwapOnycToUsdc<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = onyc_mint,
        has_one = usdc_mint,
    )]
    pub relayer_config: Box<Account<'info, RelayerConfig>>,

    /// CHECK: signs only SPL Approve and the fee TransferChecked.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub onyc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = onyc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub onyc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub usdc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = onyc_mint,
        associated_token::authority = relayer_config.fee_vault,
        associated_token::token_program = token_program,
    )]
    pub fee_vault_onyc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: validated transitively via the flow PDA seed binding.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [FLOW_OUTBOUND_SEED, ntt_inbox_item.key().as_ref()],
        bump = outflight_flow.bump,
    )]
    pub outflight_flow: Box<Account<'info, Flow>>,

    /// CHECK: (owner == ONRE_PROGRAM_ID) AND (key == PDA([b"offer", usdc_mint, onyc_mint])).
    pub onre_offer: UncheckedAccount<'info>,

    /// CHECK: router-agnostic. Safety from NAV-floor + bounded Approve + plain invoke.
    pub swap_program: UncheckedAccount<'info>,

    /// CHECK: SPL delegate for the swap; Approve bounded to net_onyc; SPL auto-clears at zero.
    pub swap_delegate: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
```

- [ ] **Step 2: Add `OnycSwapped` event to `events.rs`**

```rust
#[event]
pub struct OnycSwapped {
    pub flow: Pubkey,
    pub onyc_consumed: u64,
    pub usdc_received: u64,
    pub fee_onyc: u64,
    pub nav_floor: u64,
    pub swap_program: Pubkey,
}
```

- [ ] **Step 3: Wire into `mod.rs` and `lib.rs`**

`instructions/mod.rs`: add `pub mod swap_onyc_to_usdc;`.

`lib.rs` inside `#[program]`:
```rust
/// Permissionless: convert outbound flow's ONyc → USDC via any swap program
/// under NAV-anchored slippage protection. Replaces the OnRe-redemption chain.
pub fn swap_onyc_to_usdc<'info>(
    ctx: Context<'_, '_, '_, 'info, SwapOnycToUsdc<'info>>,
    swap_ix_data: Vec<u8>,
) -> Result<()> {
    swap_onyc_to_usdc::handler(ctx, swap_ix_data)
}
```

- [ ] **Step 4: Build**

```bash
anchor build
```

Expected: clean build. Reuses existing `RelayerError` variants — no new errors needed.

- [ ] **Step 5: Run Task 1 test, still FAIL on missing SDK**

```bash
pnpm test tests/swap-onyc-to-usdc.test.ts -t 'happy path'
```

Expected: FAIL on `client.swapOnycToUsdc is not a function`. SDK wiring is Phase 2.

- [ ] **Step 6: Commit**

```bash
git add programs/relayer/src/
git commit -m "feat(relayer): add swap_onyc_to_usdc handler"
```

### Task 3: Below-floor revert test + tighten `MAX_SLIPPAGE_BPS`

**Files:**
- Modify: `tests/swap-onyc-to-usdc.test.ts`
- Modify: `programs/relayer/src/constants.rs`
- Modify: `packages/cranker/src/relayer/onre-nav.ts` (TS mirror — `MAX_SLIPPAGE_BPS` constant)

- [ ] **Step 1: Tighten the constant**

```rust
// programs/relayer/src/constants.rs
pub const MAX_SLIPPAGE_BPS: u16 = 10;  // was 50
```

The Rust↔TS mirror test (`packages/cranker/tests/relayer/onre-nav.test.ts:188`) reads the Rust constant via regex; once the Rust value changes, the TS constant must match. Update `packages/cranker/src/relayer/onre-nav.ts` accordingly.

- [ ] **Step 2: Add below-floor test**

```ts
it('reverts when swap output below NAV floor', async () => {
  const s = await buildWithdrawScaffold()
  const flow = await s.seedOutboundClaimedFlow({ onycAmount: 1_000_000n })
  // Floor for net 999_000 at 10 bps = ~998_001. Return 997_999.
  const swapIxData = s.buildMockSwapIx({ outAmount: 997_999n })
  await expect(
    s.client.swapOnycToUsdc({ /* ... */ swap_ix_data: swapIxData }).rpc()
  ).rejects.toThrow(/RedeemSlippageBelowFloor/)
})
```

- [ ] **Step 3: Run mirror test**

```bash
pnpm test packages/cranker/tests/relayer/onre-nav.test.ts -t 'max-slippage'
```

Expected: PASS (both sides at 10 now).

- [ ] **Step 4: Commit**

```bash
git add tests/swap-onyc-to-usdc.test.ts programs/relayer/src/constants.rs packages/cranker/src/relayer/onre-nav.ts
git commit -m "feat(relayer): tighten MAX_SLIPPAGE_BPS 50→10; add below-floor test"
```

---

## Phase 2: SDK builder

### Task 4: Add `swapOnycToUsdc` to RelayerClient

**Files:**
- Create: `packages/sdk/src/builders/swap-onyc-to-usdc.ts` (account-resolver)
- Modify: `packages/sdk/src/client.ts` (client method)

- [ ] **Step 1: Read existing builder pattern**

```bash
ls packages/sdk/src/builders/
grep -n "redeemOnyc\|RedeemOnyc" packages/sdk/src/builders/ packages/sdk/src/client.ts
```

Use `redeem-onyc.ts` builder as the template. The new builder's account set is `redeem_onyc` minus `redemption_tracker`/`payer_for_close`/`redemption_request` and plus `fee_vault_onyc_ata`.

- [ ] **Step 2: Build SDK, regenerate IDL types**

```bash
pnpm sdk build
```

Expected: types in `packages/sdk/src/idl/` regenerate including `swapOnycToUsdc`.

- [ ] **Step 3: Implement client method**

```ts
async swapOnycToUsdc(args: {
  nttInboxItem: PublicKey
  swapProgram: PublicKey
  swapDelegate: PublicKey
  swapIxData: Uint8Array
  remainingAccounts: AccountMeta[]
}) {
  return this.program.methods
    .swapOnycToUsdc(Buffer.from(args.swapIxData))
    .accounts({
      relayerConfig: this.relayerConfigPda,
      relayerAuthority: this.relayerAuthorityPda,
      onycMint: this.onycMint,
      usdcMint: this.usdcMint,
      onycAta: getAssociatedTokenAddressSync(this.onycMint, this.relayerAuthorityPda, true),
      usdcAta: getAssociatedTokenAddressSync(this.usdcMint, this.relayerAuthorityPda, true),
      feeVaultOnycAta: getAssociatedTokenAddressSync(this.onycMint, this.config.feeVault, true),
      nttInboxItem: args.nttInboxItem,
      outflightFlow: findOutflightFlowPda(args.nttInboxItem, this.program.programId)[0],
      onreOffer: findOnreOfferPda(this.usdcMint, this.onycMint)[0],
      swapProgram: args.swapProgram,
      swapDelegate: args.swapDelegate,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(args.remainingAccounts)
}
```

- [ ] **Step 4: Run Phase 1 tests**

```bash
pnpm test tests/swap-onyc-to-usdc.test.ts
```

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/
git commit -m "feat(sdk): swapOnycToUsdc client method"
```

---

## Phase 3: Cranker handler

### Task 5: Cranker `swap-onyc-to-usdc.ts` advance handler

**Files:**
- Create: `packages/cranker/src/relayer/swap-onyc-to-usdc.ts`
- Create: `packages/cranker/tests/relayer/swap-onyc-to-usdc.test.ts`
- Modify: `packages/cranker/src/relayer/scan.ts` (dispatch table at `pickAdvanceForStatus`)
- Modify: `packages/cranker/src/relayer/index.ts` (export new handler in `AdvanceFns`)

- [ ] **Step 1: Failing test**

Mirror `packages/cranker/tests/relayer/redeem-onyc-quote.test.ts` structure. Cover:
- Happy path: quote clears 10 bps floor → `kind: 'advanced'`
- Below floor on all routes → `kind: 'noop'` with `reason` naming the gap
- Jupiter HTTP throws → `kind: 'noop'` with `quote_failed`
- Jupiter hangs past `rpcTimeoutMs` → typed timeout, not freeze
- Threads `relayerAuthorityPda` to Jupiter as `userPublicKey` (regression guard)

- [ ] **Step 2: Implement handler**

The quote-building logic ports verbatim from `packages/cranker/src/relayer/redeem-onyc-quote.ts`. The submit path swaps the deleted `client.redeemOnyc(...)` for `client.swapOnycToUsdc(...)`. The handler does not need cancel-fingerprint detection (no cancel branch exists anymore).

- [ ] **Step 3: Run tests green**

```bash
pnpm test packages/cranker/tests/relayer/swap-onyc-to-usdc.test.ts
```

- [ ] **Step 4: Wire into dispatch at `scan.ts:335`**

Edit `pickAdvanceForStatus` in `packages/cranker/src/relayer/scan.ts`:

```ts
function pickAdvanceForStatus(status: FlowStatus | string, fns: AdvanceFns): DispatchFn | undefined {
  switch (status) {
    // Deposit leg — unchanged
    case 'Pending':
      return fns.claimUsdc
    case 'Claimed':
      return fns.swapUsdcToOnyc
    case 'Swapped':
      return fns.lockOnyc
    // Withdraw leg — collapsed
    case 'WithdrawPending':
      return fns.unlockOnyc
    case 'WithdrawClaimed':
      return fns.swapOnycToUsdc  // was: fns.requestRedemptionOnyc
    case 'WithdrawSwapped':
      return fns.sendUsdcToUser
    // 'RedemptionPending' case removed — no handler dispatches it anymore.
    default:
      return undefined
  }
}
```

`AdvanceFns` in `packages/cranker/src/relayer/index.ts` loses `requestRedemptionOnyc`, `claimRedemptionUsdc`, gains `swapOnycToUsdc`.

- [ ] **Step 5: Commit**

```bash
git add packages/cranker/
git commit -m "feat(cranker): swap-onyc-to-usdc dispatch handler"
```

---

## Phase 4: CLI subcommand

### Task 6: `cli swap-onyc-to-usdc` subcommand

**Files:**
- Modify: `packages/cli/src/commands/cranker.ts` (or wherever the existing `redeem-onyc` subcommand lives — find via `grep -rn "redeem-onyc\|redeemOnyc" packages/cli/`)

- [ ] **Step 1: Locate existing subcommand pattern**

```bash
grep -rn "redeem-onyc\|redeemOnyc\|requestRedemptionOnyc" packages/cli/
```

- [ ] **Step 2: Add `swap-onyc-to-usdc` subcommand**

Pattern after the existing `redeem-onyc` subcommand. Arguments: `--ntt-inbox-item <pubkey>`. Output: signature on success, structured noop reason on no-route.

- [ ] **Step 3: Smoke-test**

```bash
pnpm cli swap-onyc-to-usdc --ntt-inbox-item <test-flow-pda>
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/
git commit -m "feat(cli): swap-onyc-to-usdc subcommand"
```

---

## Phase 5: Cutover and deletion

> New path is end-to-end functional. Old handlers still exist. Drain gate (Task 0.5) has been verified at deploy time. Now delete.

### Task 7: Delete old on-chain handlers

**Files:**
- Delete: `programs/relayer/src/instructions/{request_redemption_onyc,claim_redemption_usdc,cancel_redemption_onyc,redeem_onyc}.rs`
- Modify: `programs/relayer/src/instructions/mod.rs`
- Modify: `programs/relayer/src/lib.rs`
- Modify: `programs/relayer/src/constants.rs` (delete `REDEEM_COOLDOWN_SLOTS`)
- Modify: `programs/relayer/src/state.rs` (deprecate, do NOT delete; see Step 4)

- [ ] **Step 1: Delete handler files**

```bash
git rm programs/relayer/src/instructions/{request_redemption_onyc,claim_redemption_usdc,cancel_redemption_onyc,redeem_onyc}.rs
```

- [ ] **Step 2: Remove module declarations + entry points**

`instructions/mod.rs`: delete the four `pub mod` lines.
`lib.rs`: delete the four `#[program]` functions and their doc comments.

- [ ] **Step 3: Delete `REDEEM_COOLDOWN_SLOTS`**

`constants.rs`: delete the constant. The cooldown comment can go.

- [ ] **Step 4: Deprecate state — DO NOT DELETE**

`state.rs`:
- `FlowStatus::RedemptionPending` → add `#[deprecated(note = "withdraw-path simplification 2026-05; variant retained for byte-stability of historical PDAs")]` immediately above the variant. **Do not remove.** The `flow_status_borsh_tag_invariant` test still passes.
- `RedemptionTracker` struct → add the same `#[deprecated]` above the struct. The `redemption_tracker_holds_withdraw_chain_state` test still passes.
- `RelayerConfig.last_redeem_slot` → rename to `_reserved_was_last_redeem_slot` with a doc comment explaining the byte-stability lock. Update the `cfg_with` test helper accordingly. The `relayer_config_init_space_is_unchanged_by_redesign` test asserting `INIT_SPACE = 190` still passes.
- `REDEMPTION_TRACKER_SEED` in `constants.rs` → keep for the (deprecated) struct.

> **Why this matters:** Anchor's borsh derivation will silently shift account layouts if you delete or reorder these. Existing config and flow PDAs would deserialize as garbage on the next relayer call. The deprecation markers communicate intent without breaking byte compatibility.

- [ ] **Step 5: Build**

```bash
anchor build
```

Will fail with dangling references in `claim_usdc.rs` / `send_usdc_to_user.rs` / `swap_usdc_to_onyc.rs` — those still pass `redemption_tracker: SystemAccount`. Resolve in Task 8.

- [ ] **Step 6: Commit (non-building intermediate)**

```bash
git add -A
git commit -m "refactor(relayer): delete OnRe-path handlers; deprecate state types"
```

### Task 8: Keep `redemption_tracker` mutex constraints (defensive, no change to handlers)

**Files:** No edits needed.

**Why this is a do-nothing step:** I considered deleting the `redemption_tracker: SystemAccount<'info>` lines from `claim_usdc.rs:285`, `send_usdc_to_user.rs:122`, and `swap_usdc_to_onyc.rs:125`. Decided against. Reasoning:

- `SystemAccount` asserts the account is uninitialized (system-program-owned, zero lamports). After Task 7, no handler ever instantiates `RedemptionTracker`, so the constraint is trivially satisfied at every call.
- The constraint costs ~1 µs of compute per handler call. Free.
- If a future change reintroduces tracker init by accident, the absent-required constraint surfaces the regression at call time instead of silently allowing a half-built singleton to live on chain.

So Task 7 *should* build clean — the dangling references I worried about are still resolved because `REDEMPTION_TRACKER_SEED` and the `RedemptionTracker` type both still exist (as deprecated). The `SystemAccount` lines do not reference deleted types.

- [ ] **Step 1: Re-build to confirm Task 7 actually compiles**

```bash
anchor build
cargo clippy --workspace -- -D warnings -A deprecated
```

The `-A deprecated` allows warnings on the intentionally-deprecated state types; other warnings still fail. If this compiles clean, no edits needed in this task.

If it doesn't compile clean, the remaining failures are the actual gaps to fix (likely imports of deleted module paths). Resolve those minimally.

- [ ] **Step 2: Commit only if anything changed**

```bash
git add -A
git status  # if clean, skip commit
```

### Task 9: Delete SDK / cranker / CLI surface for old handlers

**Files:**
- Delete: SDK builders for the four handlers
- Delete: cranker handler files for the four legs
- Delete: cranker test files for the four legs
- Modify: SDK `client.ts`, `index.ts`
- Modify: cranker `index.ts` (AdvanceFns)
- Modify: CLI command file
- Delete: `scripts/recover-redeem-onyc.ts` (if present)

- [ ] **Step 1: Inventory all references**

```bash
grep -rn "requestRedemptionOnyc\|claimRedemptionUsdc\|cancelRedemptionOnyc\|redeemOnyc\b\|redemptionTrackerPda" packages/ scripts/ | grep -v 'node_modules\|dist\|\.next'
```

- [ ] **Step 2: Delete files**

```bash
git rm packages/cranker/src/relayer/{request-redemption-onyc,claim-redemption-usdc,cancel-redemption-handler,redeem-onyc-quote,claim-redemption-usdc}.ts 2>/dev/null || true
git rm packages/cranker/tests/relayer/{cancel-redemption-handler,redeem-onyc-quote,claim-redemption-usdc,request-redemption-onyc}.test.ts 2>/dev/null || true
git rm scripts/recover-redeem-onyc.ts 2>/dev/null || true
# SDK builder files — discover via:
find packages/sdk/src/builders -name '*redemption*' -o -name '*redeem*' | grep -v 'swap-onyc-to-usdc'
```

> Note: keep `packages/cranker/src/relayer/onre-nav.ts` and the corresponding test — they're shared with the new handler (NAV math + slippage mirror).

- [ ] **Step 3: Remove references from SDK / cranker / CLI**

For each match from Step 1 outside deleted files: delete the surrounding code (client method, type export, CLI subcommand, dispatch entry).

- [ ] **Step 4: Re-grep — should be empty (except CHANGELOG-style files)**

```bash
grep -rn "requestRedemptionOnyc\|claimRedemptionUsdc\|cancelRedemptionOnyc\|\.redeemOnyc\b" packages/ scripts/ | grep -v 'node_modules\|dist'
```

- [ ] **Step 5: Full test run**

```bash
pnpm test
anchor build
cargo clippy --workspace -- -D warnings -A deprecated
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove OnRe-path TS surface"
```

---

## Phase 6: Integration, docs, deploy artifacts

### Task 10: Withdraw-chain e2e test

**Files:**
- Modify: existing withdraw-chain e2e suite

- [ ] **Step 1: Locate**

```bash
grep -rln "describe.*withdraw\|WithdrawClaimed\|WithdrawSwapped" tests/
```

- [ ] **Step 2: Update to new flow**

The withdraw e2e becomes: `claim_usdc` (deposit) is not exercised; start from `unlock_onyc (Claimed)` → `swap_onyc_to_usdc (Swapped)` → `send_usdc_to_user (Done)`. Delete any setup that staged `RedemptionTracker` or used `request_redemption_onyc`.

- [ ] **Step 3: Run e2e**

```bash
pnpm test tests/withdraw-chain-e2e.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: withdraw-chain e2e routes via swap_onyc_to_usdc"
```

### Task 11: Docs

**Files:**
- Modify: `CLAUDE.md` (Code Structure section)
- Modify: `docs/architecture.md`
- Modify: `docs/security.md`
- Modify: `docs/deploy-mainnet.md`
- Modify: `docs/deploy-checklist.md`

- [ ] **Step 1: `CLAUDE.md`**

In the "Solana program — `programs/relayer/src/`" list, replace the four old handler entries with `swap_onyc_to_usdc`. In the "Token Flow" / status header, note that the OnRe-redemption path is removed; state types retained as deprecated for byte-stability.

- [ ] **Step 2: `docs/security.md`**

Remove threat-model entries for the four deleted handlers. Add the `swap_onyc_to_usdc` entry with the NAV-floor + bounded-Approve + plain-invoke argument and the tightened 10 bps slippage cap.

- [ ] **Step 3: `docs/deploy-mainnet.md` + `docs/deploy-checklist.md`**

- Withdraw-chain section updates to: `claim_usdc → swap_usdc_to_onyc → lock_onyc` (deposit) and `unlock_onyc → swap_onyc_to_usdc → send_usdc_to_user` (withdraw).
- **Add hard pre-deploy gate**: "Run `pnpm tsx scripts/audit-redemption-pending-flows.ts` against mainnet. Must exit 0. If any `RedemptionPending` flows or trackers exist, drain via existing `claim_redemption_usdc` / `redeem_onyc` calls on the **pre-deploy** program version (still upgrade-deployable) before deploying this version."
- Add operational liquidity gate: confirm ONyc/USDC depth clears 10 bps at expected redemption sizes via Jupiter quote dry-run for `(small, median, max-expected)` sizes.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs: reflect withdraw-path simplification + drain gate"
```

### Task 12: IDL update verification

**Files:** None modified directly; verification step.

**Why this exists:** Removing four `#[program]` entries removes four IDL methods. Anyone using the IDL for off-chain decoding (block explorers, indexers, external integrators) must either consume the new IDL or pin to the old commit.

- [ ] **Step 1: Diff the IDL**

```bash
git diff main -- target/idl/fogo_onre_relayer.json | head -200
```

Expected: four methods removed (`requestRedemptionOnyc`, `claimRedemptionUsdc`, `cancelRedemptionOnyc`, `redeemOnyc`); one added (`swapOnycToUsdc`); deprecated state types still present.

- [ ] **Step 2: Note IDL upgrade step in deploy checklist**

Add to `docs/deploy-checklist.md` under post-deploy: `anchor idl upgrade <PROGRAM_ID> -f target/idl/fogo_onre_relayer.json --provider.cluster mainnet`. Without this, on-chain IDL queries return stale methods.

- [ ] **Step 3: Commit any deploy-checklist edits**

```bash
git add docs/deploy-checklist.md
git commit -m "docs: anchor idl upgrade post-deploy step" || true
```

### Task 13: Final verification

- [ ] **Step 1: Full green pass**

```bash
pnpm test
pnpm lint
anchor build
cargo clippy --workspace -- -D warnings -A deprecated
cargo fmt --all --check
```

- [ ] **Step 2: Diff stats vs main**

```bash
git diff --stat main
```

Expected: net deletion ~1200–1500 LOC, addition ~350 LOC.

- [ ] **Step 3: Self-review**

Read full diff. Check for:
- Orphaned `use` lines importing deleted modules
- Cranker metrics naming deleted handlers (`metrics.redeemOnyc*`)
- Race classifier hardcoded error ordinals — `RelayerError` enum order must not have shifted (all variants are *additive* under "APPEND ONLY" rule per `error.rs:92`)
- Webapp `@fogo-onre/sdk` import sites still compile (the SDK lost four methods)

Fix inline.

- [ ] **Step 4: Tag pre-deletion commit**

```bash
# Find the commit just before Task 7 (handler deletion); helps re-derive
# the OnRe path later if ever needed.
git tag pre-withdraw-simplification <commit-sha>
git push origin pre-withdraw-simplification
```

- [ ] **Step 5: Ready for PR**

```bash
git log --oneline main..HEAD
```

Commit history should read: spec → drain script → failing tests → handler → constant tighten → SDK → cranker → CLI → handler deletion → TS surface deletion → e2e → docs → IDL.

---

## Self-review against spec

1. **Coverage.** Every spec section maps to a task: new handler (1–3), tightened slippage (3), deletions (7), kept-deprecated state (7 Step 4), SDK/cranker/CLI (4–6, 9), pre-deploy drain (0.5, 11), liquidity gate (11). Sibling-constraint preservation handled implicitly in Task 8 (no-op).

2. **Placeholders.** None — every step has the actual code or actual command. The one looseness is "discover SDK builder paths via `find`" in Task 9 because the exact filenames depend on what the SDK currently has; that's a `grep`-and-delete sweep, not a content gap.

3. **Type consistency.** `swap_onyc_to_usdc` used uniformly. Accounts struct matches the handler body. Client method args match the Accounts struct field names. CLI argument names line up.

4. **TDD.** Tasks 1, 3, 5 all write failing test before implementation. Phase 5 (deletion) is verification-loop-driven rather than TDD, which is correct for deletion sweeps.

5. **Byte-stability discovered late.** Original spec said "delete `RedemptionTracker` / `RedemptionPending` / `last_redeem_slot`" — that was wrong. Three tests in `state.rs` (lines 487, 499, 530) pin layout. Plan updated to deprecate-not-delete, and the spec has been corrected.

---

## Execution

Two options:

**1. Subagent-Driven (recommended)** — Fresh subagent per task, two-stage review (spec compliance + code quality) per task, fast iteration.

**2. Inline** — Execute in this session via executing-plans with checkpoints.

**Open empirical gate (precondition, not a task):** Confirm ONyc/USDC Jupiter depth clears 10 bps at expected redemption sizes. If fails, the design needs revisiting — either widen the floor (loosens security) or this whole plan stops being relevant.

Which approach?
