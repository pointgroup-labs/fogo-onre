# Intent Transfer Program

A fork of FOGO's `intent-transfer` program — the on-chain program that turns a
signed user intent on FOGO into a Wormhole NTT bridge transfer (USDC on deposit,
ONyc on withdraw) and collects the protocol's bridge fee along the way.

## Why it forked

In the upstream program the fee always lands in the sponsor's account. The
sponsor is the gasless fee-payer whose key the protocol does not hold, so the
protocol's own revenue was accruing somewhere it could never reach.

The fork fixes that, and runs under its own program ID and upgrade authority so
the deployment is self-governed:

- upstream: `Xfry4dW9m42ncAqm8LyEnyS5V6xu5DSJTMRQLiGkARD`
- fork:     `inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9`

## What changed

The fee recipient is now a field on the per-mint `FeeConfig` rather than being
hard-wired to the sponsor, so fees collect into an account the protocol
controls. The sponsor still signs and pays gas — it just no longer keeps the
fee.

Everything else is mechanical: token debits flow through FOGO's in-session
token rail (`session_token.rs`) for gasless transfers, and a few accounts are
boxed to stay within stack and transaction-size limits.
