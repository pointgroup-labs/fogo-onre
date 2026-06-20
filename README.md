# Fogo OnRe

[![FOGO](https://img.shields.io/badge/FOGO-grey?logo=lightning&style=for-the-badge)](https://fogo.io)
[![npm](https://img.shields.io/npm/v/@ignitionfi/fogo-onre?logo=npm&logoColor=white&style=for-the-badge)](https://www.npmjs.com/package/@ignitionfi/fogo-onre)
[![CI](https://img.shields.io/github/actions/workflow/status/pointgroup-labs/fogo-onre/ci.yml?logo=githubactions&logoColor=white&style=for-the-badge&label=CI)](https://github.com/pointgroup-labs/fogo-onre/actions/workflows/ci.yml)

A cross-chain yield bridge. Deposit **USDC.s on FOGO** and receive **ONyc**
— a token that earns yield from
[OnRe](https://github.com/onre-finance/onre-sol)'s tokenized reinsurance on
Solana. Withdraw by sending ONyc back for USDC.s. You sign **one**
transaction on FOGO; everything after is permissionless cranking.

## How it works

```mermaid
flowchart LR
    subgraph dep [Deposit]
        direction LR
        A["USDC.s · FOGO"] -->|NTT| B["USDC · Solana"]
        B -->|swap| C["ONyc · Solana"]
        C -->|NTT| D["ONyc · FOGO"]
    end
    subgraph wd [Withdraw]
        direction LR
        E["ONyc · FOGO"] -->|NTT| F["ONyc · Solana"]
        F -->|swap| G["USDC · Solana"]
        G -->|NTT| H["USDC.s · FOGO"]
    end
```

Both legs run over [Wormhole NTT](https://wormhole.com/products/native-token-transfers)
(USDC.s ↔ USDC and ONyc ↔ ONyc). On Solana, a small **relayer** program holds
funds only while a flow is open, swaps through the configured venue, then sends
the output back to FOGO. Each leg is the same three-step pipeline, driven by
three permissionless relayer instructions:

| Step       | Instruction | Deposit                     | Withdraw                     |
| ---------- | ----------- | --------------------------- | ---------------------------- |
| 1. Receive | `receive`   | claim inbound USDC from NTT | claim inbound ONyc from NTT  |
| 2. Swap    | `swap`      | USDC → ONyc                 | ONyc → USDC                  |
| 3. Send    | `send`      | NTT-send ONyc back to FOGO  | NTT-send USDC.s back to FOGO |

`receive` opens a one-shot `Flow` receipt. `swap` enforces the user's signed
minimum output, and `send` returns the result to the recorded recipient. Yield
accrues automatically — ONyc is a claim on a position whose on-chain price
advances as OnRe's reinsurance book earns.

## Trust model

The relayer is the user's trust boundary. For each token pair, it pins the
token mints, NTT managers, and allowed FOGO origin programs at initialization.
Flow instructions are permissionless: a cranker can execute them, but cannot
change the recipient or lower the user's signed `min_swap_out`. If no swap ever
clears that floor, anyone can `refund` the inbound token back to FOGO after a
timeout, so funds are never stranded.

The config authority can rotate the fee vault and adjust fees, capped at
**10% per leg** with a ~2-day timelock on increases. The upgrade authority can
ship new bytecode and bypass every check, so it must be a multisig or finalized
to `None` at deploy. Full detail in [`docs/architecture.md`](./docs/architecture.md).

## Program IDs

First-party programs. Third-party CPI targets, NTT managers, and token mints
are listed in [`docs/architecture.md`](./docs/architecture.md). Confirm deploy
status on-chain before assuming any cluster is live.

| Program                  | Chain  | ID                                            |
| ------------------------ | ------ | --------------------------------------------- |
| Relayer                  | Solana | `onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp` |
| `intent_transfer` (fork) | FOGO   | `inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9` |

## Components

| Path                        | Description                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `programs/relayer/`         | Anchor program (Rust) — the Solana relayer.                                                |
| `programs/intent-transfer/` | First-party fork of FOGO's intent_transfer entry, with reviewed edits; workspace-excluded. |
| `packages/sdk/`             | TypeScript SDK (`@fogo-onre/sdk`): client + builders.                                      |
| `packages/cli/`             | Operator CLI (`@fogo-onre/cli`): configure + ops.                                          |
| `packages/cranker/`         | Off-chain VAA executor that drives the legs.                                               |
| `packages/webapp/`          | Next.js front-end.                                                                         |
| `tests/`                    | LiteSVM end-to-end tests.                                                                  |

## Quick start

```bash
pnpm install

# Build the relayer .so (vanity program ID → --ignore-keys) + SDK
anchor build --ignore-keys
pnpm sdk build

# Test
cargo test -p fogo-ntt-relayer --lib   # Rust unit tests
pnpm test                              # LiteSVM e2e (pretest rebuilds .so + SDK)
```

Toolchain is pinned: Rust 1.95.0, Anchor 1.0.2, Solana CLI 3.1.8,
pnpm 11.1.0, Node 24.

## Development

```bash
cargo fmt --all              # format Rust
cargo clippy --workspace     # lint Rust
pnpm lint                    # lint TypeScript / Markdown
pnpm lint:fix                # auto-fix
```

## Documentation

[`docs/architecture.md`](./docs/architecture.md) — system design, the flow
lifecycle, on-chain state, the instruction surface, and the trust model.

## License

[Apache License 2.0](./LICENSE).
