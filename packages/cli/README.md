# @fogo-onre/cli

Admin CLI for the Fogo OnRe relayer program on Solana.

## Build

```bash
pnpm cli:build
```

Produces a single CJS bundle at `dist/cli.js` with the SDK and Anchor core
inlined. The `bin` entry registers it as `fogo-onre`, which pnpm symlinks
into the root `node_modules/.bin/` because the workspace root depends on
this package.

## Run

```bash
pnpm cli relayer show
pnpm cli relayer initialize --deposit-fee-bps 50 --withdraw-fee-bps 100
```

Rebuild whenever you edit CLI or SDK sources.

## Global options

| Flag                   | Default                                        | Notes                                                                   |
| ---------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `-u, --url <url>`      | `mainnet-beta` (or `$SOLANA_RPC_URL`)          | Cluster name (`mainnet-beta`/`testnet`/`devnet`) or any HTTP(S) RPC URL |
| `-k, --keypair <path>` | `$SOLANA_KEYPAIR` → `~/.config/solana/id.json` | Signer keypair (not needed for `show`)                                  |

## Commands

### `relayer show`

Read-only. Dumps the `GlobalConfig` admin singleton, the `PairConfig`, and
the relayer authority PDA. No keypair required.

```bash
fogo-onre relayer show
```

### `relayer bootstrap`

One-time creation of the `GlobalConfig` admin singleton. Must run before
`initialize`. **Dry-run by default**; pass `--confirm` to broadcast.

```bash
fogo-onre relayer bootstrap --confirm
```

### `relayer initialize`

Per-pair creation of a `PairConfig` + relayer-owned ATAs. Admin-gated —
requires `bootstrap` first. **Dry-run by default**; pass `--confirm` to
broadcast.

Optional flags with sensible defaults:

- `--usdc-mint` defaults to canonical Solana USDC (`EPjFWdd5…`)
- `--onyc-mint` defaults to OnRe's ONyc mint (`oNyCm1…`)
- `--fee-vault` defaults to the signer's ONyc ATA
- `--authority` defaults to the signer's pubkey

Minimal invocation (uses every default):

```bash
# dry-run
fogo-onre relayer initialize --deposit-fee-bps 50 --withdraw-fee-bps 100

# broadcast
fogo-onre relayer initialize --deposit-fee-bps 50 --withdraw-fee-bps 100 --confirm
```

If the signer doesn't yet hold ONyc, the default fee-vault ATA won't exist
and pre-flight #4 will fail. Either create it first:

```bash
spl-token --url mainnet-beta create-account oNyCm1QsAatj3ckaEwZjtAPWvstPn3Zm5MAYPtkjEfa
```

…or pass `--fee-vault <existing-onyc-account>`.

### `relayer set-admin` / `relayer accept-admin`

Two-step global admin rotation. The current admin nominates a successor with
`set-admin`; the nominee claims it with `accept-admin`. Dry-run by default;
pass `--confirm` to broadcast.

```bash
fogo-onre relayer set-admin --new-admin <pubkey> --confirm
fogo-onre relayer accept-admin --confirm
```

### `relayer configure`

Authority-only mutation of `PairConfig`. Dry-run by default.

```bash
# Rotate fee_vault
fogo-onre relayer configure --fee-vault <pubkey> --confirm

# Two-step authority handover (current authority sets pending; new key claims separately)
fogo-onre relayer configure --new-authority <pubkey> --confirm
```

Fee-bps increases above the current value are subject to the on-chain
~2-day timelock. Decreases apply immediately.
