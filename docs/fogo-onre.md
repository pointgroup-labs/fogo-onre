# OnRe Vault on FOGO

## Overview

The OnRe Vault lets users on FOGO deposit USDC.s and earn yield from OnRe's tokenized reinsurance product (ONyc) on Solana.
Users receive a share token (wONyc) representing their proportional claim on the vault's total assets. They never interact with Solana, bridges, or OnRe directly.

### Tokens

| Token  | Chain  | What it is                                        | Held by                              |
| ------ | ------ | ------------------------------------------------- | ------------------------------------ |
| USDC.s | FOGO   | Stablecoin (Wormhole-bridged USDC)                | Users, vault reserve PDA             |
| USDC   | Solana | Native USDC                                       | Relayer PDA (in-transit only)        |
| ONyc   | Solana | OnRe yield-bearing reinsurance token              | Relayer PDA (in-transit), NTT locker |
| bONyc  | FOGO   | NTT-bridged ONyc (1:1 with locked ONyc on Solana) | Vault backing PDA                    |
| wONyc  | FOGO   | Vault share token — user's receipt                | Users                                |

wONyc (share token) and bONyc (bridged ONyc backing) are separate mints. The vault holds bONyc as backing and mints/burns wONyc for users. wONyc price appreciates as the underlying bONyc value grows.

### System Components

Two custom programs:

- **OnRe Vault Program** (FOGO) — user-facing vault that holds USDC.s reserve and bONyc backing, mints/burns wONyc share tokens
- **Relayer Program** (Solana) — immutable, PDA-custody program that relays tokens between Wormhole Gateway, OnRe, and Wormhole NTT

Three existing Wormhole products:

- **Wormhole Gateway** — bridges USDC.s (FOGO) to USDC (Solana) and back
- **Wormhole NTT** — bridges ONyc (Solana) to bONyc (FOGO) and back (lock-and-mint mode)
- **Wormhole Queries** — guardian-attested reads of OnRe price vector parameters (rare, only when APR changes)

## Architecture

```
FOGO                                    Solana
+--------------------------+           +------------------------+
|                          |           |                        |
|  OnRe Vault Program      |           |  Relayer Program       |
|                          |           |  (immutable, no admin) |
|  PDA accounts:           | Gateway   |                        |
|  +- USDC.s reserve       |<==(USDC)==>  PDA accounts:         |
|  +- bONyc backing        |           |  +- USDC ATA           |
|                          | NTT       |  +- ONyc ATA           |
|  Share token: wONyc      |<==(ONyc)=>|                        |
|                          |           |  CPI into:             |
|  NAV (on-chain):         | Queries   |  +- OnRe (both dirs)   |
|  = reserve_usdc +        |<==(rare)==|  +- Wormhole Gateway    |
|    bonyc_bal * price     |           |  +- Wormhole NTT       |
|                          |           |                        |
|  Governance: multisig    |           |  Hardcoded destinations:|
|  (fees, pause, params)   |           |  +- OnRe program ID    |
|                          |           |  +- Gateway program ID  |
+--------------------------+           |  +- FOGO vault address  |
         ^                             +------------------------+
         |                                      ^
         +-------- Curator (authorized) --------+
                   zero custody
                   stolen key = zero fund loss
```

## Chain Map

| Component           | Chain           | Role                                                                                          |
| ------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| OnRe Vault Program  | FOGO            | User-facing vault: deposit/withdraw USDC.s, mint/burn wONyc, hold reserve + bONyc backing     |
| Relayer Program     | Solana          | CPI relayer: Gateway -> OnRe -> NTT. Immutable, no admin, PDA custody, hardcoded destinations |
| Wormhole Gateway    | FOGO <-> Solana | Bridges USDC.s to USDC and back                                                               |
| Wormhole NTT        | FOGO <-> Solana | Bridges ONyc (locked on Solana) to bONyc (minted on FOGO) and back                            |
| Wormhole Queries    | Solana -> FOGO  | Guardian-attested reads of OnRe price vector parameters                                       |
| OnRe Program        | Solana          | Yield source. USDC -> ONyc via `take_offer_permissionless`. Reverse for redemption.           |
| Curator             | Off-chain       | Authorized caller that triggers deploy/withdraw operations. Never holds tokens.               |
| Governance Multisig | FOGO            | Sets fees, reserve target, pause, price vector updates                                        |

## User Flows

### Deposit

**What the user does:** Connects wallet on FOGO, enters USDC.s amount, clicks "Deposit".

**What happens:**

1. User calls `vault.deposit(amount)` on FOGO
2. Vault transfers USDC.s from user to vault reserve PDA
3. Vault mints wONyc share tokens to user at current NAV
4. Done. Single transaction, instant.

**NAV calculation at deposit time:**

```
price_per_share = total_vault_value / total_shares_outstanding
shares_minted = deposit_amount / price_per_share
total_vault_value = usdc_reserve + (bonyc_balance * onyc_price)
```

On first deposit (`total_shares_outstanding = 0`), `price_per_share` is defined as 1.0 (1 wONyc = 1 USDC.s). The first depositor receives shares equal to their deposit amount. To prevent the classic inflation attack (deposit 1 wei, donate to vault, next depositor rounds to 0 shares), the `initialize` instruction mints a small amount of dead shares to a burn address.

- `usdc_reserve`: read from vault's USDC.s token account (on FOGO)
- `bonyc_balance`: read from vault's bONyc token account (on FOGO)
- `onyc_price`: computed deterministically from cached price vector: `price = base_price * (1 + apr * effective_time / 31_536_000)`

### Withdraw (instant — reserve sufficient)

**What the user does:** Enters wONyc amount, clicks "Withdraw".

**What happens:**

1. User calls `vault.withdraw(shares)` on FOGO
2. Vault calculates USDC.s owed: `shares * price_per_share`
3. Vault burns wONyc share tokens
4. Vault transfers USDC.s from reserve to user
5. Done. Single transaction, instant.

### Withdraw (queued — reserve insufficient)

1. User calls `vault.queue_withdraw(shares)` on FOGO
2. Vault burns wONyc share tokens immediately (non-reversible — no cancel mechanism, shares cannot be reclaimed)
3. Vault creates a withdrawal request PDA tracking the user and USDC.s owed at current NAV
4. User sees "queued" status

USDC.s owed is locked at the NAV at queue time. This is safe because ONyc price is monotonically increasing within a price vector, and vector updates are rate-limited to ±2% NAV impact.

**Behind the scenes (curator processes queue):**

5. Curator initiates bONyc burn on FOGO via NTT (bONyc burned, guardian message sent)
6. On Solana: NTT releases ONyc to relayer PDA
7. Relayer CPI: OnRe `take_offer_permissionless` (ONyc -> USDC)
8. Relayer CPI: Wormhole Gateway transfer (USDC -> FOGO vault)
9. USDC.s arrives in vault reserve on FOGO
10. Curator calls `vault.fulfill_withdrawals()` — queued users paid from reserve (FIFO)

### Capital Deployment (curator-operated, invisible to user)

When vault reserve exceeds the target (e.g., >30% of TVL), the curator deploys excess capital into OnRe:

1. Curator calls `vault.deploy_capital(amount)` on FOGO
2. Vault program CPI into Wormhole Gateway's FOGO-side contract, sending USDC.s with the relayer PDA's USDC ATA on Solana as the recipient (if Gateway doesn't support CPI, this becomes a separate curator-signed Gateway transfer — see assumption #8)
3. Guardian VAA signed (~1-2 min)
4. On Solana, curator calls `relayer.deploy(VAA)`:
   - Gateway `complete_transfer(VAA)` -> USDC in relayer PDA ATA
   - CPI OnRe `take_offer_permissionless` (USDC -> ONyc) -> ONyc in relayer PDA ATA
   - CPI NTT lock (ONyc locked in NTT contract)
   - If all three CPIs don't fit in one tx (~50 accounts, <1.4M CU), split into separate txs — tokens sit safely in relayer PDA between txs
5. Guardian attestation for NTT (~1-2 min)
6. NTT mints bONyc directly to vault's bONyc PDA token account on FOGO (recipient specified in the NTT transfer)
7. Vault NAV increases automatically (vault holds more bONyc)

## NAV and Price

### On-chain NAV

The vault's NAV is fully verifiable on-chain on FOGO:

```
NAV = usdc_reserve + (bonyc_balance * onyc_price)
```

Both `usdc_reserve` and `bonyc_balance` are token account balances on FOGO — anyone can read them. No trusted reporting needed for balances.

### ONyc Price Vector

OnRe's pricing model is deterministic within a pricing vector:

```
price = base_price * (1 + apr * effective_time / SECONDS_IN_YEAR)
```

Vector parameters (`base_price`, `apr`, `start_time`, `price_fix_duration`) are stored on OnRe's Solana state account. These change rarely (e.g., when OnRe adjusts APR, roughly monthly).

When parameters change, the FOGO vault's cached vector is updated via:

- Wormhole Queries (guardian-attested read of OnRe state), or
- Governance multisig transaction (manual update with verification)

The vault enforces a rate limit on price vector updates (max +/-2% NAV change per update) to bound damage from stale or malicious updates.

## Fee Mechanics

The vault captures fees using the same patterns as the Stake Pool program:

| Fee Type        | When                | Mechanism                                                                                                            |
| --------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Deposit fee     | On `deposit()`      | Small % of USDC.s retained by vault before minting shares                                                            |
| Withdrawal fee  | On `withdraw()`     | Small % deducted from USDC.s payout                                                                                  |
| Performance fee | On user interaction | When `price_per_share` has increased since last fee capture, vault mints fee shares to treasury before the operation |

Fee parameters are set by the governance multisig, with rate limiting to prevent sudden changes.

## Security Model

### Custody

No human or key ever holds user funds:

| Location                     | Custodian           | Can steal?    |
| ---------------------------- | ------------------- | ------------- |
| USDC.s reserve (FOGO)        | Vault program PDA   | No            |
| bONyc backing (FOGO)         | Vault program PDA   | No            |
| USDC in-transit (Solana)     | Relayer program PDA | No            |
| ONyc in-transit (Solana)     | Relayer program PDA | No            |
| ONyc locked for NTT (Solana) | NTT contract        | No            |
| USDC in Wormhole (transit)   | Wormhole guardians  | Systemic risk |

### Curator Key Compromise

If the curator key is stolen, the attacker can call:

- `relayer.deploy()` — converts USDC to ONyc and NTT-locks it. Tokens go to vault. **No theft.**
- `relayer.withdraw()` — redeems ONyc for USDC and bridges to vault. Tokens go to vault. **No theft.**
- `vault.deploy_capital()` — sends reserve USDC.s to Gateway. Ends up in relayer PDA then vault via NTT. **No theft.**
- `vault.fulfill_withdrawals()` — pays queued users from reserve. **No theft, just accelerates legitimate payouts.**

Worst case with stolen curator key: suboptimal timing of deploy/withdraw operations, or griefing by triggering unnecessary OnRe redemptions (reduces yield temporarily). Zero fund loss.

### Relayer Program

Deployed as **immutable** (no upgrade authority). All CPI destinations are hardcoded at compile time:

- OnRe program ID
- Wormhole Gateway program ID
- Wormhole NTT program ID
- FOGO vault address (for Gateway transfer destination)

No instruction exists to send tokens to an arbitrary address. Tokens can only flow between: relayer PDA <-> OnRe, relayer PDA <-> NTT, relayer PDA <-> Gateway (destination: FOGO vault).

**Risk: relayer immutability.** If OnRe upgrades their program ID, or Wormhole upgrades Gateway/NTT contracts, the relayer is bricked. Mitigation: deploy a new relayer and update the FOGO vault's relayer reference via governance. The old relayer's PDA funds (if any in-transit) would need to be drained via the old program's existing instructions first. The FOGO vault program stores the relayer address as a configurable parameter (`set_relayer` governance instruction), not a hardcoded constant.

**Risk: relayer bug.** A bug could strand funds in the PDA. Mitigated by: thorough audit before immutable deployment, small blast radius (only in-transit amounts at risk, typically one batch worth), FOGO vault reserve + bONyc unaffected.

### Vault Program

Upgradeable via governance multisig (for bug fixes). Governance can:

- Set fee parameters (rate-limited)
- Set reserve target percentage
- Update price vector parameters (rate-limited to +/-2% NAV impact)
- Update relayer address (for relayer upgrades)
- Pause deposits/withdrawals (emergency)

Governance **cannot** withdraw funds to arbitrary accounts. All fund flows are programmatic (deposit/withdraw/deploy/fulfill). However, the governance multisig is the ultimate trust root: a malicious program upgrade could change any constraint. This is the standard upgradeability tradeoff — same model as all major DeFi vaults. Mitigated by timelock on upgrades and multisig threshold.

### External Dependencies

| Dependency           | If it fails                          | Impact                                                                                                                                                                                            |
| -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wormhole Guardians   | Compromised or offline               | If offline: reserve-only mode, no fund loss. If compromised: could forge NTT attestation to mint unbacked bONyc, inflating vault NAV. Systemic risk shared with all Wormhole-dependent protocols. |
| Wormhole Gateway     | Can't bridge USDC                    | Reserve-only mode. No new deploys. No fund loss.                                                                                                                                                  |
| Wormhole NTT         | Can't move ONyc cross-chain          | Can't deploy new capital or return ONyc. Reserve still works. Existing bONyc in vault is safe.                                                                                                    |
| OnRe protocol        | Yield stops, redemptions may fail    | Share price stops appreciating. Queued withdrawals delayed. **Investment risk — users bear ONyc devaluation.**                                                                                    |
| OnRe redemption cap  | Vault needs to redeem more than cap  | OnRe enforces ~2.5% NAV/week redemption limit. Large queued withdrawals may take multiple weeks to fulfill. Reserve pool absorbs short-term demand.                                               |
| OnRe offer liquidity | Can't swap in one or both directions | Deploy or withdrawal delayed until liquidity returns. Reserve covers instant withdrawals.                                                                                                         |
| Curator goes offline | No deploys, no queue fulfillment     | Reserve accumulates. Existing bONyc appreciates. No fund loss. Degraded yield on new deposits.                                                                                                    |

The system **degrades gracefully**. Each external failure reduces functionality but never causes fund loss.

## FOGO Vault Program — Instruction Set

### Initialization

| Instruction                                          | Accounts                                                                                         | Description                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `initialize(fees, reserve_target_bps, price_vector)` | authority, vault_pda, share_mint, reserve_ata, bonyc_ata, curator, system_program, token_program | Create vault state, initialize share mint (wONyc) with vault PDA as mint authority, create reserve and backing token accounts |

### User Instructions

| Instruction                   | Accounts                                                                       | Description                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `deposit(amount: u64)`        | user, vault, reserve_ata, share_mint, user_share_ata, token_program            | Transfer USDC.s to reserve, mint wONyc at current NAV                                                                    |
| `withdraw(shares: u64)`       | user, vault, reserve_ata, share_mint, user_share_ata, token_program            | Burn wONyc, transfer USDC.s from reserve. Fails if reserve insufficient.                                                 |
| `queue_withdraw(shares: u64)` | user, vault, share_mint, user_share_ata, withdrawal_request_pda, token_program | Burn wONyc, create withdrawal request PDA with USDC.s owed. `request_id` is an auto-incrementing counter on vault state. |

### Curator Instructions

| Instruction                    | Accounts                                             | Description                                                                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy_capital(amount: u64)`  | curator, vault, reserve_ata, gateway_accounts        | CPI into Wormhole Gateway FOGO-side contract. Sends USDC.s from reserve, recipient = relayer PDA on Solana. Only callable when reserve > target. Enforces minimum batch size to ensure economic bridge crossings. |
| `receive_backing()`            | curator, vault, bonyc_ata                            | No-op if bONyc balance hasn't changed. Otherwise captures the new bONyc balance into vault accounting and triggers performance fee capture if `price_per_share` increased.                                        |
| `fulfill_withdrawals()`        | curator, vault, reserve_ata, withdrawal_request_pdas | Pay queued withdrawal requests from reserve. Processes FIFO.                                                                                                                                                      |
| `initiate_return(amount: u64)` | curator, vault, bonyc_ata, ntt_accounts              | Burns bONyc via NTT to unlock ONyc on Solana (sent to relayer PDA). Used to replenish reserve.                                                                                                                    |

### Governance Instructions

| Instruction                                                  | Accounts         | Description                                                        |
| ------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------ |
| `set_fees(deposit_fee, withdraw_fee, performance_fee)`       | authority, vault | Update fee parameters. Rate-limited.                               |
| `set_reserve_target(basis_points: u16)`                      | authority, vault | Set target reserve as % of TVL                                     |
| `update_price_vector(base_price, apr, start_time, duration)` | authority, vault | Update cached OnRe price vector. Rate-limited to +/-2% NAV impact. |
| `set_curator(new_curator: Pubkey)`                           | authority, vault | Rotate curator authority                                           |
| `set_relayer(new_relayer: Pubkey)`                           | authority, vault | Update Solana relayer address (for relayer upgrades)               |
| `pause()`                                                    | authority, vault | Emergency pause all deposits/withdrawals                           |
| `unpause()`                                                  | authority, vault | Resume operations                                                  |

### State Accounts

**Vault (PDA, seeds: `["onre_vault", authority, share_mint]`)**

```
authority: Pubkey           // governance multisig
curator: Pubkey             // authorized curator
relayer: Pubkey             // Solana relayer program address (updatable for upgrades)
share_mint: Pubkey          // wONyc token mint
reserve_ata: Pubkey         // USDC.s reserve token account
bonyc_ata: Pubkey           // bONyc backing token account
total_shares: u64           // outstanding wONyc supply
deposit_fee: Fee            // basis points
withdrawal_fee: Fee         // basis points
performance_fee: Fee        // basis points
reserve_target_bps: u16     // target reserve as % of TVL
price_vector: PriceVector   // cached OnRe pricing params
last_nav_update: i64        // timestamp of last price vector update
last_fee_price: u64         // price_per_share at last performance fee capture
next_request_id: u64        // auto-incrementing counter for withdrawal request PDAs
paused: bool                // emergency pause flag
```

**PriceVector**

```
base_price: u64             // 9 decimal precision (1.0 = 1_000_000_000)
apr: u64                    // scaled by 1_000_000
start_time: i64             // unix timestamp
price_fix_duration: u64     // interval in seconds
```

**WithdrawalRequest (PDA, seeds: `["withdrawal", vault, user, request_id]`)**

```
user: Pubkey                // recipient
usdc_owed: u64              // USDC.s amount to pay
created_at: i64             // timestamp
```

## Solana Relayer Program — Instruction Set

| Instruction              | Description                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy(vaa: Vec<u8>)`   | Claim USDC from Gateway (`complete_transfer` with VAA) -> CPI OnRe `take_offer_permissionless` (USDC->ONyc) -> CPI NTT lock (ONyc). Atomic if compute allows, otherwise split across txs with tokens held in relayer PDA between. |
| `deploy_step2()`         | If `deploy` was split: CPI OnRe (USDC->ONyc) from PDA.                                                                                                                                                                            |
| `deploy_step3()`         | If `deploy` was split: CPI NTT lock (ONyc) from PDA.                                                                                                                                                                              |
| `withdraw(vaa: Vec<u8>)` | CPI NTT `redeem(VAA)` to release ONyc to relayer PDA ATA -> CPI OnRe `take_offer_permissionless` (ONyc->USDC) -> CPI Gateway transfer (USDC to FOGO vault). Same split-step pattern if needed.                                    |
| `withdraw_step2()`       | If `withdraw` was split: CPI Gateway transfer (USDC to FOGO vault).                                                                                                                                                               |

No admin instructions. No upgrade authority. No persistent state beyond PDA token accounts. All destinations hardcoded. Curator authorization checked on each call.

## Assumptions to Validate Before Building

| # | Assumption                                                     | Validation                                                            | Blocks                                       |
| - | -------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| 1 | OnRe will coordinate on NTT deployment for ONyc                | Confirm with OnRe. Required for bONyc on FOGO.                        | Entire design                                |
| 2 | OnRe has a permissionless ONyc->USDC offer (reverse direction) | Query offer PDA for the ONyc/USDC pair. Confirm with OnRe.            | Withdrawal flow                              |
| 3 | OnRe's permissionless offers work with PDA callers (no KYC)    | Test with PDA signer via CPI on devnet. Confirm with OnRe.            | Relayer program                              |
| 4 | Gateway + OnRe + NTT CPIs fit in one Solana tx                 | Prototype on devnet. Measure accounts and CU.                         | Relayer instruction design (atomic vs split) |
| 5 | OnRe price vector updates are infrequent                       | Confirm with OnRe. If frequent, need automated Queries.               | Price vector update mechanism                |
| 6 | Wormhole Queries can verify OnRe state from FOGO on-chain      | Test on FOGO testnet. Fallback: governance-only vector updates.       | Price vector trust model                     |
| 7 | OnRe ONyc->USDC offer has sufficient normal liquidity          | Monitor over time. Size reserve target accordingly.                   | Withdrawal reliability                       |
| 8 | Wormhole Gateway FOGO-side contract supports CPI from vault    | Test on FOGO testnet. If not, `deploy_capital` becomes a two-tx flow. | Deploy capital instruction                   |

## UX States

### Deposit

| State      | User sees                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| Input      | Amount field, USDC.s balance, estimated wONyc to receive, current vault APY (net of fees), fee breakdown |
| Confirming | Wallet approval prompt (single FOGO transaction)                                                         |
| Complete   | Success with wONyc received, tx link                                                                     |
| Error      | Descriptive error + retry (vault paused, below minimum, etc.)                                            |

### Withdraw (instant)

| State      | User sees                                                                    |
| ---------- | ---------------------------------------------------------------------------- |
| Input      | wONyc amount, estimated USDC.s return (including accrued yield, net of fees) |
| Confirming | Wallet approval prompt                                                       |
| Complete   | Success with USDC.s received, tx link                                        |

### Withdraw (queued)

| State      | User sees                                                                  |
| ---------- | -------------------------------------------------------------------------- |
| Input      | wONyc amount, notice that withdrawal will be queued (reserve insufficient) |
| Confirming | Wallet approval prompt                                                     |
| Queued     | Position in queue, estimated time, withdrawal request ID                   |
| Complete   | USDC.s received notification                                               |

### Portfolio View

- Current wONyc balance
- Current value in USDC.s (`wONyc balance × price_per_share`)
- Total yield earned since first deposit
- Current vault APY (net of fees)
- Reserve health indicator (% of TVL in reserve)

## Alternatives Considered

We evaluated five architectures before arriving at the current design. The table below compares them across the dimensions that matter.

|                                     | Direct NTT (no vault)                          | GLAM Vault + Relayer                 | FOGO Vault + Multisig on Solana                                          | FOGO Vault + Solana Agent + Queries     | **FOGO Vault + NTT + Relayer**                                              |
| ----------------------------------- | ---------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------- |
| **User UX**                         | Slow (2 bridges, 3-5 min per deposit/withdraw) | Slow (2 bridges per tx)              | Instant (single FOGO tx)                                                 | Instant (single FOGO tx)                | **Instant (single FOGO tx)**                                                |
| **Custom programs**                 | 0                                              | 1 (relayer on Solana)                | 1 (FOGO vault)                                                           | 2 (FOGO vault + Solana agent)           | **2 (FOGO vault + small relayer)**                                          |
| **Custody risk**                    | None (user holds wONyc directly)               | High (relayer holds funds mid-flow)  | Medium (multisig signers can collude)                                    | None (PDA on both chains)               | **None (PDA + NTT locker)**                                                 |
| **Stolen key impact**               | N/A                                            | Full fund loss                       | Full fund loss if signers collude                                        | Zero fund loss                          | **Zero fund loss**                                                          |
| **NAV trust**                       | N/A (user holds token directly)                | Trusted relayer reports              | Trusted multisig reports; Queries mitigate but attest point-in-time only | Queries (guardian-attested, continuous) | **On-chain on FOGO (vault reads own bONyc balance)**                        |
| **Oracle dependency**               | None                                           | Continuous                           | Continuous (Queries or trusted report)                                   | Continuous (Queries for NAV)            | **Rare (price vector sync only, ~monthly)**                                 |
| **Bridge products used**            | Gateway + NTT                                  | Gateway + NTT                        | Gateway only                                                             | Gateway only                            | **Gateway + NTT**                                                           |
| **OnRe coordination needed**        | Yes (NTT for ONyc)                             | No (permissionless)                  | No (permissionless)                                                      | No (permissionless)                     | **Yes (NTT for ONyc)**                                                      |
| **Solana deployment**               | None                                           | Relayer program                      | None                                                                     | Agent program                           | **Relayer (~100 LOC, immutable)**                                           |
| **Reserve pool / instant withdraw** | No (every withdraw hits bridge + OnRe queue)   | No (every withdraw hits bridge)      | Yes                                                                      | Yes                                     | **Yes**                                                                     |
| **Fee capture**                     | Awkward (skim on swap)                         | GLAM vault level                     | Native (same as stake pool)                                              | Native (same as stake pool)             | **Native (same as stake pool)**                                             |
| **Product control**                 | None (frontend to OnRe)                        | Limited (GLAM controls yield)        | Full                                                                     | Full                                    | **Full**                                                                    |
| **Automated operations**            | User-driven                                    | Semi (relayer is human-operated)     | No (multisig = manual approvals)                                         | Yes (permissionless operations)         | **Yes (curator calls, zero custody)**                                       |
| **Relayer/agent upgrade path**      | N/A                                            | Redeploy relayer                     | N/A                                                                      | Redeploy agent, update vault            | **Deploy new relayer, update vault via governance**                         |
| **Scales to multi-strategy**        | No (one NTT per token)                         | Partially (GLAM supports strategies) | Yes (swap curator wallet strategy)                                       | Yes (deploy new agent)                  | **Yes (new relayer per cross-chain strategy, native strategies need none)** |

### Why Each Alternative Was Rejected

**Direct NTT (no vault):** Users must bridge USDC.s to Solana, swap to ONyc, bridge ONyc back via NTT — two bridge crossings per operation, 3-5 minute waits, requires Solana wallet awareness. Also directly exposes users to OnRe's redemption queue (2.5% NAV/week cap). Acceptable for DeFi power users, not for a consumer product.

**GLAM Vault + Relayer:** The relayer is described as a "dumb passthrough" but actually has custody of user funds mid-flow. If the relayer key is compromised or goes offline, funds are at risk or stuck. GLAM adds a third-party dependency (fund management wrapper) that isn't needed when targeting a single strategy. Adds complexity without adding security.

**FOGO Vault + Multisig on Solana:** Eliminates the Solana program, but the multisig holding ONyc is a custodial arrangement. Multisig signers can collude and steal. Operations require manual human approval, preventing automation. Wormhole Queries can attest balances, but only at a point in time — between attestations the multisig can move funds.

**FOGO Vault + Solana Agent + Queries:** Close to the chosen design — PDA custody on both chains, zero-custody curator, automated operations. But without NTT, the vault can't hold the backing asset on FOGO. NAV depends on continuous Wormhole Queries attestations (guardian-attested Solana state), which is operationally heavier than holding bONyc directly and computing price from a rarely-changing vector. Also requires a more substantial Solana agent program that holds ONyc long-term.

**FOGO Vault + NTT + Relayer:** Combines the best properties: instant UX (FOGO vault with reserve), zero custody (PDA + NTT locker), on-chain verifiable NAV (vault holds bONyc directly), minimal oracle dependency (rare price vector sync), small Solana footprint (stateless immutable relayer), and full product control (fees, reserve, pause, strategy upgrades).

## Future: Curated Vault Standard for FOGO

The vault program described in this doc is not specific to OnRe. The core logic — share token mint/burn, reserve pool, deposit/withdraw/queue, NAV calculation, fee structure, curator authorization, governance — is strategy-agnostic.

Each vault deployment configures its own deposit asset, backing token, strategy, and price source. One program, many vaults, each independent.

FOGO needs yield infrastructure. Instead of building one-off integrations per protocol, the vault program becomes the standard way to offer yield on FOGO.

### Composability

Every vault share token is a standard SPL token. It plugs into any FOGO protocol: lending collateral, AMM liquidity, DAO treasuries, or as backing in another vault (vault-of-vaults).

## Operations: upgrade-in-place rollout for the two-stage `claim_usdc` flow

The `claim_usdc` instruction uses a two-stage token flow: Token Bridge mints
into a short-lived USDC ATA owned by a dedicated `redeemer` PDA (seeds =
`[b"redeemer"]` under the relayer program id), and the same instruction
sweeps the balance into the long-lived authority-owned USDC ATA. Fresh
deployments provision the intake ATA inside `initialize`.

Existing deployments that predate this change need the intake ATA created
exactly once before the next `claim_usdc`. **No program instruction is
required** — an ATA address is deterministic from `(mint, owner)` and the
Associated Token Account program accepts any funder. Run:

```ts
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { findRedeemerAuthorityPda, RELAYER_PROGRAM_ID } from '@fogo-onre/sdk'
import { PublicKey, Transaction } from '@solana/web3.js'

const USDC_MINT = new PublicKey(/* wrapped-USDC.s mint on Solana */)
const [redeemerPda] = findRedeemerAuthorityPda(RELAYER_PROGRAM_ID)
const redeemerUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, redeemerPda, true)

const ix = createAssociatedTokenAccountInstruction(
  payer.publicKey,  // anyone — ATA creation does not require the owner to sign
  redeemerUsdcAta,
  redeemerPda,      // owner
  USDC_MINT,
)
// Send as a single-instruction tx signed only by `payer`.
```

CLI equivalent:

```bash
spl-token create-account <USDC_MINT> \
  --owner <REDEEMER_PDA> \
  --fee-payer <any-keypair>
```

The operation is idempotent in the sense that the ATA program errors if
the ATA already exists; re-running is safe and a no-op. Verify afterward
that `redeemerUsdcAta` exists, is owned by the SPL Token program, has
`mint == USDC_MINT`, and has `owner == redeemerPda`.

No upgrade authority is needed. The flow works on both upgradable and
immutable deployments — the instruction surface of the relayer is
unchanged; only its internal account handling evolved to read this
pre-existing ATA.

