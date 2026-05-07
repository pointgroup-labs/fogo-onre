# TODO / Open Design Questions

Deferred work and design proposals not yet on a release plan. Each
entry captures the trade-offs already discussed so the next person to
pick it up doesn't re-do the analysis.

---

## Instant withdraw via DEX swap (Jupiter or pinned AMM)

**Status:** proposed, not scheduled. Decision needed before any code.

**Goal:** offer users a synchronous-ish withdraw path that bypasses
OnRe's `redemption_admin` fulfillment latency, accepting a price
discount in exchange.

### What "instant" actually buys

The withdraw chain has three latency contributors:

1. **NTT attestation** (ONyc → ONyc on Solana) — guardian quorum,
   ~minutes, _unavoidable_
2. **OnRe redemption fulfillment** (ONyc → USDC) — async, gated on
   `redemption_admin`, hours to days, **this is the only piece a DEX
   swap replaces**
3. **Gateway attestation** (USDC → USDC.s on FOGO) — guardian quorum,
   ~minutes, _unavoidable_

So "instant" is really "minutes instead of hours" — meaningful, but
not the synchronous UX a FOGO-side vault would give.

### Price source is the central trade-off

|              | OnRe `RedemptionOffer` (today) | DEX route (proposed)              |
| ------------ | ------------------------------ | --------------------------------- |
| Price source | NAV — what ONyc is worth       | Market — what LPs pay             |
| Liquidity    | OnRe (the issuer)              | Whatever AMM pool exists          |
| Discount     | None (NAV − relayer fee)       | NAV − market spread − relayer fee |
| Failure mode | Slow                           | Slippage, sandwich, no liquidity  |

ONyc's secondary market is almost certainly thin and discounted — LPs
holding ONyc against OnRe's redemption-queue cap demand a premium. A
user picking "instant" pays that discount on top of the relayer fee.
Order-of-magnitude: 1% spread + 0.25% relayer fee on a $10k withdraw
= $125 lost vs. waiting. Many users would still pick async at the
better price.

### Security-model cost

The relayer's central safety property today:

> Every CPI destination is **hardcoded** in
> `programs/relayer/src/constants.rs` and verified at audit time.
> A stolen cranker key cannot route funds anywhere not on the
> allowlist.

Jupiter's aggregator (`JUP6Lk…`) doesn't fit — it dispatches into
arbitrary downstream AMM programs whose addresses appear in
`remaining_accounts`. Allowlisting Jupiter implicitly allowlists
whatever Orca/Raydium/Meteora/etc. pools it routes through that day.
That breaks the audited-CPI-allowlist property.

### Three implementation options, in order of conservatism

1. **Pinned single AMM pool.** Pick one specific ONyc/USDC pool (e.g.,
   a designated Orca whirlpool). Hardcode the pool program ID and
   pool address in `constants.rs`. CPI directly. Loses cross-venue
   price discovery; keeps the audit property.
2. **Jupiter, gated on user `min_amount_out`.** User signs
   "accept no less than X USDC for Y ONyc." Trusts Jupiter's program
   but not its routes. Requires a dedicated audit pass for Jupiter's
   CPI surface.
3. **FOGO vault with USDC.s reserve** (the original Phase 2 design,
   currently shelved). Withdraws paid instantly from the reserve in a
   single FOGO transaction — no Wormhole attestations, no DEX, no
   `redemption_admin`. Relayer asynchronously refills the reserve via
   today's chain. Textbook "async backend, sync UX" pattern (Yearn,
   Morpho, Sommelier). Largest engineering scope; cleanest
   architecture; relayer needs zero changes.

### Recommendation

If FOGO-vault bandwidth exists → **option 3**.
If a quick win is needed → **option 1** (pinned pool, new
`swap_onyc_to_usdc_pool` instruction alongside the existing redemption
pair, balance-delta guard analogous to `request_redemption_onyc`).
**Avoid option 2** unless there is a strong reason — audit cost
outweighs route-flexibility benefit for a token with one realistic
counterparty.

### Concrete next step (if option 1 is chosen)

Spec out `swap_onyc_to_usdc_pool`:

- Accounts: relayer ONyc ATA, relayer USDC ATA, pinned pool, pool
  token vaults, user's outbound flow PDA, fee vault
- Args: `min_amount_out: u64`
- Pre/post balance-delta guard on both ATAs (defends against
  pool-account substitution by the cranker)
- New constants in `constants.rs`: pool program ID, pool address
- User-visible: SDK exposes both `withdraw()` (async, NAV) and
  `withdrawInstant()` (sync, market) with clear pricing signal
