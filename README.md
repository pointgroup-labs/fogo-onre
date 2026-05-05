# Fogo OnRe

A cross-chain yield bridge. Users deposit **USDC.s on FOGO** and receive
**bONyc on FOGO** — a token that earns yield from
[OnRe](https://github.com/onre-finance/onre-sol)'s tokenized reinsurance
product (ONyc) on Solana. To withdraw, users send bONyc back and
receive USDC.s.

The on-chain bridge is a single immutable Solana program (the
**relayer**) that holds no funds at rest and routes capital between
[Wormhole NTT](https://wormhole.com/products/native-token-transfers)
(both USDC.s ↔ USDC and ONyc ↔ bONyc) and
[OnRe](https://github.com/onre-finance/onre-sol) (USDC ↔ ONyc on
Solana).

## How it works

```
              FOGO                              Solana
              ────                              ──────
deposit:   USDC.s ──NTT──> USDC ──swap──> ONyc ──NTT──> bONyc
withdraw:  bONyc  ──NTT──> ONyc ──redeem──> USDC ──NTT──> USDC.s
```

**Deposit** (one user transaction on FOGO; the rest is permissionless cranking):

1. User NTT-sends USDC.s → relayer receives USDC on Solana
2. Relayer swaps USDC → ONyc on OnRe
3. Relayer NTT-locks ONyc → bONyc minted to user on FOGO

**Withdraw** (one user transaction on FOGO; OnRe asynchronously fulfills):

1. User NTT-sends bONyc → relayer receives ONyc on Solana
2. Relayer requests redemption from OnRe (`request_redemption_onyc`)
3. OnRe's `redemption_admin` fulfills the request, paying out USDC
4. Relayer claims the USDC and NTT-sends USDC.s back to the user

Yield accrues automatically: bONyc represents a claim on ONyc, whose
on-chain price advances as OnRe's reinsurance positions earn.

## Trust model in one paragraph

The relayer is the user's trust boundary. Its program ID is canonical,
its CPI destinations (NTT, OnRe) are hardcoded, and it cannot
move funds outside the user-signed flow — no admin can drain the
in-transit ATAs. The config authority can adjust fees (capped at **10%
per leg**, with a 2-day timelock on increases) and rotate the fee
vault. The upgrade authority can ship a new `.so` and bypass everything
— it must be a multisig or set to `None`. Full detail in
[`docs/security.md`](./docs/security.md).

## Repo layout

```
programs/relayer/    Anchor program (Rust). The only on-chain component.
packages/sdk/        TypeScript SDK (@fogo-onre/sdk).
tests/               LiteSVM end-to-end tests.
docs/                Architecture, security model, deployment guides.
scripts/             Codama client generation, changelog config.
```

## Quick start

```bash
# Build the program
anchor build

# Run the Rust unit tests + LiteSVM end-to-end tests
anchor test
pnpm test

# Lint
cargo clippy --workspace
pnpm lint
```

Toolchain is pinned: Rust 1.95.0, Anchor 1.0.2, Solana CLI 3.1.8,
pnpm 10.33.0, Node 24.

## Documentation

| File                                                     | Read for                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| [`docs/architecture.md`](./docs/architecture.md)         | Full system design, CPI flow, component responsibilities     |
| [`docs/security.md`](./docs/security.md)                 | Trust assumptions, blast radius of every key, attack surface |
| [`docs/deploy-checklist.md`](./docs/deploy-checklist.md) | Mandatory pre-deploy sign-off gate                           |
| [`docs/deploy-mainnet.md`](./docs/deploy-mainnet.md)     | Step-by-step mainnet deployment runbook                      |

## Program ID

`onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp` — same on localnet,
devnet, and mainnet. Pinned in
[`Anchor.toml`](./Anchor.toml) and `programs/relayer/src/lib.rs`.
