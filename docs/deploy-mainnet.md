# Mainnet Deployment Guide

A step-by-step walkthrough for shipping the Fogo OnRe relayer to Solana
mainnet-beta. Written so a deployer who has never touched this repo can
follow it end to end.

> **Read [`deploy-checklist.md`](./deploy-checklist.md) first.**
> That checklist is the mandatory sign-off gate. This guide tells you
> _how_ to execute the deploy; the checklist tells you _whether you are
> allowed to_. They are companions, not substitutes.

---

## 1. What gets deployed (and what does not)

| Artifact                                     | Where                      | This repo?                               |
| -------------------------------------------- | -------------------------- | ---------------------------------------- |
| `relayer` Anchor program                     | Solana mainnet-beta        | ✅                                       |
| Solana-side NTT manager (ONyc, locking mode) | Solana mainnet-beta        | ✅ — deployed via `ntt` CLI, see §7.1    |
| FOGO-side NTT manager (ONyc, burning mode)   | FOGO chain                 | ✅ — deployed via `ntt` CLI, see §7.1    |
| Solana-side NTT manager (USDC.s, wrap mode)  | Solana mainnet-beta        | ❌ — already live, you only reference it |
| FOGO-side NTT manager (USDC.s, native mode)  | FOGO chain                 | ❌ — already live, you only reference it |
| `@fogo-onre/sdk` (TS client)                 | npm (or internal registry) | ✅                                       |
| OnRe program                                 | Solana                     | ❌ — already live, you only reference it |

There is **no FOGO-side smart contract written by us** beyond the NTT
manager scaffold. Users hold ONyc directly on FOGO (it's the
NTT-bridged representation of the ONyc held in NTT custody on Solana).
All custom program logic lives in the Solana relayer.

**Program ID** (same on localnet, devnet, mainnet):
`onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp`
Source: `Anchor.toml` `[programs.mainnet]` and
`programs/relayer/src/lib.rs` (`declare_id!`).

**External program IDs** (hardcoded in
`programs/relayer/src/constants.rs`):

| Program                       | Address                                       |
| ----------------------------- | --------------------------------------------- |
| Wormhole NTT Manager (USDC.s) | `nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk` |
| Wormhole NTT Manager (ONyc)   | `nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd` |
| OnRe                          | `onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe` |
| FOGO Wormhole chain ID        | `51`                                          |

The relayer does **not** CPI Wormhole Core or the legacy Token Bridge /
Gateway. The two bridge legs use **distinct NTT manager programs**:
USDC.s ↔ USDC routes through `nttu74…` (above), and ONyc ↔ ONyc routes
through `nttpna5vXW7…`. The relayer pins each leg to the correct
program at compile time via `NTT_USDC_PROGRAM_ID`
(`programs/relayer/src/constants.rs:9`) and `NTT_ONYC_PROGRAM_ID`
(`programs/relayer/src/constants.rs:12`). Verifying NTT setup (§7.1)
is on the deploy critical path. Re-verify each ID against mainnet
(`solana program show <id>`) before deploying — the ONyc NTT manager
in particular may not yet be live on Solana mainnet at the time of
your deploy; if `solana program show` returns "Account not found",
coordinate with the ONyc NTT manager admin to land the deploy at
exactly `nttpna5vXW7…` before continuing. See deploy-checklist.md §4.

---

## 2. Prerequisites

### Toolchains (versions are strict)

| Tool       | Pinned to | Pinned by                       |
| ---------- | --------- | ------------------------------- |
| Rust       | 1.95.0    | `rust-toolchain.toml`           |
| Anchor     | 1.0.1     | `Anchor.toml`                   |
| Solana CLI | 3.1.8     | `Anchor.toml`                   |
| pnpm       | 10.33.0   | `package.json` `packageManager` |
| Node       | 24        | `.github/workflows/ci.yml`      |

Mismatched versions are the most common cause of "the binary I built
locally doesn't match CI." Use a verifiable Docker build (step 3) to
sidestep this.

### Inputs you must already have

- **Canonical program keypair** for
  `onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp` — held in operator
  storage (HSM, sealed envelope, etc.).
- **ONyc NTT vanity keypair** that produces
  `nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd` — same handling. See
  §7.1 for why the Solana-side NTT program ID is pinned. Note this is
  the **ONyc** manager (`NTT_ONYC_PROGRAM_ID`, `constants.rs:12`); the
  USDC.s manager (`nttu74…`) is already live and is a third-party
  artifact, not something you deploy.
- **Upgrade authority** — multisig (≥3-of-5 hardware-key signers) or
  immutable (`--final`). Hot/warm single keys are forbidden by §2 of
  the checklist.
- **Config authority** — multisig with the same handling as upgrade
  authority. Reuse the upgrade-authority multisig unless you have a
  documented reason not to (see deploy-checklist.md §2b).
- **Pre-existing ONyc-mint `TokenAccount` to receive fees**
  (`fee_vault`). It MUST NOT be the relayer's own ONyc ATA — the
  `initialize` constraint
  (`programs/relayer/src/instructions/initialize.rs:110`) rejects
  aliases at deploy time.
- **Deploy wallet** funded with SOL (and a separate wallet funded with
  FOGO for the NTT-on-FOGO deployment). See §2.1 for the line-item
  budget.
- **Mainnet RPC** with adequate rate limits (a paid tier is recommended;
  `solana program deploy` retries hard).
- **Decided fee values** — `deposit_fee_bps` and `withdraw_fee_bps`,
  each 0–1000 (capped by `MAX_FEE_BPS = 1000`, i.e. 10%).

### 2.1. Funding budget

Solana rent-exempt minimum follows
`(account_size + 128) × 3480 × 2 / 1e9` SOL. The upgradeable BPF
loader allocates a Program Data Account roughly 2× the `.so` size, so
program rent dominates the budget. Numbers below assume a 300–500 KB
`.so` for both programs — **re-verify against the actual binary**
(`ls -l target/deploy/fogo_onre_relayer.so`) before transferring funds.

#### Solana

| Bucket                                               | SOL           | Notes                                                                                      |
| ---------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| Relayer program rent                                 | **6–8**       | Scales with `.so` size; ~5.6 SOL at 400 KB                                                 |
| NTT manager program rent (Solana side)               | **4–6**       | Comparable-size Anchor program                                                             |
| `initialize` ix + all PDAs and ATAs                  | ~0.02         | RelayerConfig + USDC/ONyc ATAs + redeemer intake ATA + fee_vault ATA + NTT init accounts   |
| `RedemptionTracker` PDA rent                         | ~0.002        | Singleton, allocated lazily on first `request_redemption_onyc`; refunded on close          |
| Buffer for failed deploys + ephemeral upload buffers | **2**         | `solana program deploy` retries leave buffer accounts; reclaim with `solana program close` |
| Cranker float (if same wallet cranks at launch)      | **1**         | ~0.0015 SOL Flow PDA rent per in-flight flow (refunded on close)                           |
| **Recommended total**                                | **13–17 SOL** |                                                                                            |

#### FOGO

FOGO is a Solana-VM L1, so the rent model is structurally identical
to Solana. ⚠️ **Verify FOGO's `lamports_per_byte_year` and any rent
subsidies against the official FOGO chain config before sizing the
wallet** — some Solana-fork L1s subsidize rent for verified
contracts, which can drop these numbers by an order of magnitude.

Assuming FOGO uses Solana-identical rent parameters:

| Bucket                                                   | FOGO           | Notes                                               |
| -------------------------------------------------------- | -------------- | --------------------------------------------------- |
| FOGO-side NTT manager program rent (Burning mode)        | **4–6**        | Comparable to Solana NTT manager size               |
| NTT init + ONyc mint creation                            | ~0.01          | NTT manager creates the ONyc mint and pays its rent |
| Peer registration + rate limit PDAs                      | ~0.005         | One-time                                            |
| Per-inbound-message account rent (refundable, but float) | ~0.001 each    | NTT inbox items                                     |
| Buffer for failed deploys                                | **2**          |                                                     |
| **Recommended total**                                    | **10–14 FOGO** | (or ~1–3 FOGO if rent is subsidized)                |

The relayer itself does **not** run on FOGO — the entire FOGO budget
is for the NTT manager + ONyc setup. End users need their own FOGO
for NTT-send gas, but that's a UX concern, not a deploy budget.

---

## 3. Build the binary

Run from the repo root.

```bash
# 1. Confirm clean tree on the audited deploy commit
git status                 # expect: nothing to commit, working tree clean
git log -1 --oneline       # write this hash into the deploy record

# 2. Restore the canonical program keypair under the build's expected filename.
#    Without this step, anchor build will GENERATE a fresh orphan keypair
#    and the resulting binary will embed the wrong program ID.
cp <secure-vault>/onren-keypair.json \
   target/deploy/fogo_onre_relayer-keypair.json

solana-keygen pubkey target/deploy/fogo_onre_relayer-keypair.json
# MUST print: onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp

# 3. Verifiable build (Docker-pinned toolchain — eliminates host drift)
anchor build --verifiable

# 4. Cross-check the embedded program ID
anchor keys list
# expected: relayer: onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp

# 5. Capture the binary hash for the deploy record
sha256sum target/deploy/fogo_onre_relayer.so
```

Run the test suites and record results:

```bash
cargo test -p fogo-onre-relayer --lib   # 30 tests, all must pass
pnpm install --frozen-lockfile
pnpm test                                # vitest, all must pass
pnpm lint                                # informational only — see deploy-checklist.md §9
```

---

## 3.1. OnRe intent fork — audit-carryover gate

`programs/intent-transfer/` is an **ID-only fork** of Fogo's audited
`intent_transfer` (upstream tag `intent-transfer/v0.1.2`, commit
`f372c48df8215f5db76d51e914a6d4e9dc31f69e`). The source changes vs
upstream are the `declare_id!` swap plus the FOGO session-rail
user-token debit, captured in full by `scripts/intent-fork.expected.diff`
(the gate in §3.1 enforces the diff is exactly that artifact). The fork is workspace-excluded and
builds under its own upstream-matching profile (anchor `0.31.1`,
`overflow-checks`/`lto = "fat"`/`codegen-units = 1`, no `opt-level = z`).

Before deploying the fork, run the gate from the repo root:

```bash
scripts/verify-intent-fork.sh
```

It asserts (a) the vendored `src/` differs from the pinned upstream
commit by only `declare_id!`, then (b) runs `solana-verify build
--library-name intent_transfer` and writes the deterministic
`.so` hash to `target/deploy/intent_transfer.sha256`. Record that hash
in the deploy log. Set `SKIP_REPRODUCIBLE_BUILD=1` to run only the
source-diff check on hosts without Docker.

CI runs half (a) of this gate on every PR (the `intent-fork` job in
`.github/workflows/ci.yml`, with `SKIP_REPRODUCIBLE_BUILD=1`), so a
source drift beyond `declare_id!` fails the build before merge. Half
(b) — the reproducible-build hash — needs Docker and stays a deploy-time
step you run here.

> Known non-fatal diagnostic: the SBF linker reports a stack-offset
> overage on `BridgeNttTokens::try_accounts` (~136 bytes). It originates
> in the audited upstream source (anchor account-validation codegen),
> not our change, and the `.so` links and runs. Cross-check it appears
> identically against an upstream-only build.

---

## 4. Configure the deploy environment

Two ways to point at mainnet:

### Option A — edit `Anchor.toml`

```toml
[provider]
cluster = "https://api.mainnet-beta.solana.com" # or your private RPC
wallet = ".keys/deploy.json"
```

### Option B — CLI flags (no file changes)

```bash
anchor deploy --provider.cluster <RPC_URL> --provider.wallet .keys/deploy.json
```

Option B leaves `Anchor.toml` clean for review. Either is fine.

---

## 5. Deploy the program

The deployer wallet pays rent and tx fees but does **not** need to be
the upgrade authority. Use `--upgrade-authority` to land the program
directly under the multisig and avoid a "deployer-held window."

### Recommended: `solana program deploy` with multisig authority from t=0

```bash
solana program deploy \
  --program-id  target/deploy/fogo_onre_relayer-keypair.json \
  --upgrade-authority <MULTISIG_VAULT_ADDRESS> \
  --url <MAINNET_RPC> \
  --keypair .keys/deploy.json \
  target/deploy/fogo_onre_relayer.so
```

For an **immutable** deploy (per deploy-checklist.md §2 option 1), run
`solana program set-upgrade-authority --final <PROGRAM_ID>` from the
multisig once you've completed Phase 6 verification — _not before_, in
case you need to patch.

### Alternative: `anchor deploy` then transfer

```bash
anchor deploy --provider.cluster <RPC>
solana program set-upgrade-authority \
  <PROGRAM_ID> \
  --new-upgrade-authority <MULTISIG> \
  --skip-new-upgrade-authority-signer-check
```

This works but creates a window where the deployer holds upgrade
authority. Acceptable only if the deployer key is treated as
multisig-equivalent during that window.

### Verify the deploy

```bash
solana program show <PROGRAM_ID> --url <RPC>
```

Confirm:

- `Authority` matches the multisig (or `None` if immutable)
- `Last Deployed Slot` matches the slot of your deploy transaction
- `Data Length` is consistent with the `.so` size
- Re-hash the on-chain binary if your RPC supports `program dump`:
  ```bash
  solana program dump <PROGRAM_ID> /tmp/onchain.so --url <RPC>
  sha256sum /tmp/onchain.so   # must match the hash from §3 step 5
  ```

---

## 6. Initialize program state (one-shot)

The `initialize` instruction creates the singleton `RelayerConfig` PDA,
the relayer-authority-owned USDC and ONyc ATAs, and the redeemer-owned
short-lived USDC intake ATA. **It can only run once per program ID.**

If a prior run on the same program ID left a stale `RelayerConfig` PDA
(possible on dev/test clusters that share the program ID), see
deploy-checklist.md §1 — no migration ix ships, recovery is manual
(re-`initialize` after closing the stale PDA, or reallocate via a
one-shot upgrade).

### Account & argument summary

Source: `programs/relayer/src/instructions/initialize.rs:47-117` and
`programs/relayer/src/lib.rs`.

| Param                                                         | Type                | Source                                                                 |
| ------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `deposit_fee_bps`                                             | `u16` (0–1000)      | Decided value                                                          |
| `withdraw_fee_bps`                                            | `u16` (0–1000)      | Decided value                                                          |
| `authority` (signer)                                          | `Pubkey`            | Multisig                                                               |
| `usdc_mint`                                                   | `Mint`              | Solana mainnet USDC (`EPjFW…`)                                         |
| `onyc_mint`                                                   | `Mint`              | OnRe ONyc mint (verify against fixtures in `packages/sdk/src/onre.ts`) |
| `fee_vault`                                                   | ONyc `TokenAccount` | Pre-existing, **NOT** the relayer's ONyc ATA                           |
| `relayer_config`                                              | PDA                 | Auto-derived: `["relayer_config"]`                                     |
| `relayer_authority`                                           | PDA                 | Auto-derived: `["relayer"]`                                            |
| `redeemer_authority`                                          | PDA                 | Auto-derived: `["redeemer"]`                                           |
| `usdc_ata` / `onyc_ata` / `redeemer_usdc_ata`                 | ATA                 | Auto-derived                                                           |
| `token_program`, `associated_token_program`, `system_program` | program             | Standard                                                               |

The SDK `RelayerClient.initialize` (`packages/sdk/src/client.ts`)
derives every PDA and ATA for you.

### Build, route through multisig, send

```ts
import { AnchorProvider } from '@anchor-lang/core'
import { RelayerClient } from '@fogo-onre/sdk'
import { Connection, PublicKey } from '@solana/web3.js'

const connection = new Connection(MAINNET_RPC, 'confirmed')
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' })
const client = new RelayerClient(provider)

const builder = client.initialize({
  authority: MULTISIG_PUBKEY,
  usdcMint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  onycMint: ONYC_MINT,
  feeVault: PREEXISTING_FEE_VAULT_ATA,
  depositFeeBps: 25, // example
  withdrawFeeBps: 25, // example
})

const tx = await builder.transaction()
// → serialize, hand to Squads (or your multisig of choice), collect
//   threshold signatures, broadcast.
```

### Post-init verification

```ts
const cfg = await client.fetchConfig()
console.log({
  authority: cfg.authority.toBase58(),
  pendingAuthority: cfg.pendingAuthority?.toBase58() ?? null,
  usdcMint: cfg.usdcMint.toBase58(),
  onycMint: cfg.onycMint.toBase58(),
  feeVault: cfg.feeVault.toBase58(),
  depositFeeBps: cfg.depositFeeBps,
  withdrawFeeBps: cfg.withdrawFeeBps,
  pendingFee: cfg.pendingFee, // must be null
})
```

Cross-check on Solana Explorer:

- `RelayerConfig` PDA exists at `findConfigPda()`
- USDC ATA exists at `getAssociatedTokenAddressSync(USDC, findAuthorityPda(), true)`
- ONyc ATA exists likewise
- Redeemer USDC intake ATA exists at the redeemer-authority-owned ATA
- `fee_vault` is the address you passed and is owned by your treasury

---

## 7. External integrations (out-of-band coordination)

These are not in this repo; they require talking to the operators of
each system. Without them, flows stall and you'll see opaque CPI
failures.

| Integration                                 | What you need                                                                                                                                                                   | Owner                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **NTT peer registration**                   | The FOGO-side NTT manager registered as a peer of the Solana NTT manager (and vice versa). Without it, `lock_onyc` / `unlock_onyc` revert on `peer not found`.                  | NTT manager admin (you, post-§7.1)     |
| **NTT rate limits**                         | Per-call + per-24h caps documented in deploy-checklist.md §5. Confirm they accommodate expected throughput.                                                                     | NTT manager admin (you, post-§7.1)     |
| **OnRe `Offer` (USDC → ONyc)**              | Live `Offer` PDA at `[b"offer", USDC_mint, ONyc_mint]` under OnRe. `swap_usdc_to_onyc` reverts without it.                                                                      | OnRe operator                          |
| **OnRe `RedemptionOffer` (ONyc → USDC)**    | Required by `request_redemption_onyc`. Verify funded and active per deploy-checklist.md §4.                                                                                     | OnRe operator                          |
| **OnRe `redemption_admin` liveness**        | Asynchronously fulfills `RedemptionRequest` PDAs created by `request_redemption_onyc`. Latency is the user-visible withdraw SLA. See security.md §3 and deploy-checklist.md §8. | OnRe operator                          |
| **USDC.s NTT manager (FOGO ↔ Solana USDC)** | The USDC.s NTT deployment must already be live and the relayer's expected peers / rate limits configured. `claim_usdc` and `send_usdc_to_user` CPI it directly.                 | USDC.s NTT manager admin (third party) |
| **OnRe price-vector update authority**      | Documented per deploy-checklist.md §6. Governs ONyc price evolution, which is what generates user yield.                                                                        | OnRe operator                          |

### 7.1. NTT setup for ONyc ↔ ONyc (one-time, before any deposit can land)

This is the most involved step. Skip nothing here — without NTT, the
deposit chain stops at `lock_onyc` and ONyc never reaches the FOGO
user, and the withdraw chain stops at `unlock_onyc` because there is
no inbound NTT message to consume.

**Why ONyc isn't in the Wormhole Portal.** The Portal Bridge UI
(`portalbridge.com`) only lists tokens deployed via the legacy Token
Bridge / WTT framework. NTT tokens are intentionally not curated into
the Portal — Wormhole Contributors keep that UI restricted to prevent
abuse. NTT tokens get a custom UI built with
[Wormhole Connect](https://github.com/wormhole-foundation/demo-ntt-connect).
The relayer doesn't depend on any UI; it CPIs the on-chain manager
directly.

**The hardcoded-program-ID constraint.** `programs/relayer/src/constants.rs:12`
pins the ONyc NTT manager program ID to
`nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd` (the `nttpna…` vanity
prefix — a specific keypair was generated for it). The Solana-side NTT
deployment for ONyc **must land at exactly this address.** Two
consequences:

1. The deployer must hold the program keypair that produces this
   pubkey. Treat it with the same care as the relayer program keypair
   (HSM / sealed envelope; restored under
   `target/deploy/<ntt-binary>-keypair.json` before `anchor build` of
   the NTT program).
2. If you deploy NTT under a different program ID, the relayer is
   unusable as-is — `constants.rs` must be updated and the relayer
   redeployed under a fresh audit.

The USDC.s NTT manager (`nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk`,
`constants.rs:9`) is already live on Solana mainnet and is referenced
by the relayer; you don't redeploy it.

**Prerequisites for NTT setup.**

- ONyc SPL mint already exists on Solana (issued by OnRe).
- ONyc NTT program keypair (the `nttpna…` vanity keypair that produces
  `nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd`).
- FOGO-side NTT program keypair (vanity not required, but document the
  resulting address).
- ONyc representation: do **not** pre-create. NTT in Burning mode on
  FOGO creates the ONyc mint and holds mint authority itself.
- `ntt` CLI installed. See
  [github.com/wormhole-foundation/native-token-transfers](https://github.com/wormhole-foundation/native-token-transfers)
  for the current install instructions; they change across versions.

**Walkthrough.** Source-verified against Wormhole's NTT docs.

```bash
# 1. Scaffold the deployment workspace
ntt new ntt-onyc
cd ntt-onyc

# 2. Solana side — LOCKING mode (ONyc is canonical here, locked not burned).
#    --program-key MUST be the keypair that yields nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd.
solana-keygen pubkey <ONYC_NTT_VANITY_KEYPAIR>.json
# expected: nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd

ntt add-chain Solana \
  --latest \
  --mode locking \
  --token <ONYC_MINT_ADDRESS> \
  --payer <DEPLOY_KEYPAIR>.json \
  --program-key <ONYC_NTT_VANITY_KEYPAIR>.json

# 3. FOGO side — BURNING mode. The NTT manager will create the ONyc
#    mint and hold mint authority. If FOGO is not yet a known chain to
#    your CLI version, you'll need a CLI fork that knows chain ID 51 or
#    hand-edit deployment.json.
ntt add-chain Fogo \
  --latest \
  --mode burning \
  --payer <FOGO_DEPLOY_KEYPAIR>.json

# 4. Edit deployment.json — set the inbound + outbound rate limits to
#    the values agreed in deploy-checklist.md §5.
$EDITOR deployment.json

# 5. Push: deploys both managers, registers each as the other's peer,
#    applies rate limits. This is the one command that does the most.
ntt push --payer <DEPLOY_KEYPAIR>.json
```

**Verify before relying on the relayer.**

```bash
# Solana NTT manager landed at the canonical pubkey
solana program show nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd \
  --url <MAINNET_RPC>

# Inspect the deployment + peer registration state
ntt status

# Low-value end-to-end NTT transfer (no relayer involved yet)
ntt token-transfer --network Mainnet \
  --source-chain Solana --destination-chain Fogo \
  --amount 0.001 \
  --destination-address <FOGO_TEST_WALLET> \
  --deployment-path ./deployment.json
```

If the test transfer delivers ONyc to your FOGO test wallet, NTT is
ready and the relayer's `lock_onyc` / `unlock_onyc` will resolve the
peer and custody accounts.

**What this does NOT cover.**

- Creating the ONyc SPL mint itself — that's an OnRe operation.
- Wormhole Connect UI — separate frontend project; the relayer
  doesn't need it to function.
- Adding FOGO to the NTT CLI's chain registry if it isn't already
  known — coordinate with the Wormhole / FOGO teams.

---

### 7.2. OnRe intent fork — deploy, dual-mint config, sponsor

The deposit leg routes `bridge_ntt_tokens` through the OnRe fork of
Fogo's `intent_transfer` (`inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9`,
upstream plus the `declare_id!` swap and the session-rail debit; see §3.1). The
redeem leg routes through the **same** fork — the hard cutover dropped
the legacy plain-NTT withdraw, so there is no `REDEEM_VIA_INTENT` flag
to flip: redeem is unconditional in code and goes live the moment its
ONyc fee/NTT config (step 3) is registered and the sponsor lane (step 4)
is funded. The relayer pins this program's setter PDA as an allowlisted
VAA originator, and the webapp targets it via `DEPOSIT_INTENT_PROGRAM_ID`.
Until the fork is deployed and its per-mint config registered, neither
leg can land on it.

**Prerequisites.**

- Fork program keypair `.keys/inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9.json`
  (user-custodied; do not regenerate — the pubkey is pinned in
  `constants.rs`, the SDK, and the webapp).
- The fork's BPF **upgrade authority** keypair — `register_ntt_config`
  and `register_fee_config` are gated by `UpgradeAuthority` (the
  program-data upgrade authority must sign).
- Fee levels per mint (Open Q1): `bridge_transfer_fee` must cover gas
  sponsorship + the executor relay baseFee. Decide before registering.

**1. Build + deploy the fork.** It is excluded from `anchor build`
(its own anchor 0.31.1 workspace), so build it standalone:

```bash
# Deterministic build (same path the audit-carryover gate uses, §3.1)
cd programs/intent-transfer
solana-verify build --library-name intent_transfer
# → programs/intent-transfer/target/deploy/intent_transfer.so

solana program deploy target/deploy/intent_transfer.so \
  --program-id <REPO>/.keys/inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9.json \
  --upgrade-authority <FORK_UPGRADE_AUTH>.json \
  --url <MAINNET_RPC>
# Verify it landed at the pinned address:
solana program show inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9 --url <MAINNET_RPC>
```

**2. Initialize the setter PDA** (`["intent_transfer"]`) per the fork's
setup, exactly as Fogo initializes upstream. The relayer and webapp
both derive this PDA deterministically; it must exist before the first
`bridge_ntt_tokens`.

**3. Register NTT + fee config for BOTH mints.** `register_ntt_config`
writes `ExpectedNttConfig[mint].manager` (PDA `["expected_ntt_config",
mint]`); `register_fee_config` writes `FeeConfig[mint]` =
`{ intrachain_transfer_fee, bridge_transfer_fee }` (PDA `["fee_config",
mint]`). Both are signed by the fork upgrade authority. Run for:

| Mint   | Address                                       | NTT manager (`ntt_manager` arg)               |
| ------ | --------------------------------------------- | --------------------------------------------- |
| USDC.s | `USDC_S_MINT` (`constants.rs`)                | `nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk` |
| ONyc   | `oNyCm1QsAatj3ckaEwZjtAPWvstPn3Zm5MAYPtkjEfa` | `nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd` |

(ONyc config is for the Phase-2 redeem leg; register it now to avoid a
second admin pass.)

**4. Stand up OUR paymaster lane + fund the sponsor.** The webapp uses
`FOGO_BRIDGE_PAYMASTER_DOMAIN = APP_DOMAIN` (`https://app.ignitionfi.xyz`)
and `FOGO_BRIDGE_VARIATION = 'OnReBridge'`. Configure the paymaster to
sponsor `bridge_ntt_tokens` shaped for the fork under `OnReBridge`, then
fund the autoassigned sponsor:

```bash
# Resolve our domain's sponsor (the pubkey the webapp pins per deposit)
curl 'https://fogo-mainnet.dourolabs-paymaster.xyz/api/sponsor_pubkey?domain=https%3A%2F%2Fapp.ignitionfi.xyz&index=autoassign'
# Fund that pubkey with FOGO native gas; it also owns the fee_destination
# ATA, so the deposit bridge fee accrues to us.
```

**5. Freeze the fork's upgrade authority (Open Q4).** While the fork is
upgradeable, its holder can replace the audited bytecode and void the
carryover the §3.1 gate proves. Once **both** legs have passed the §8
smoke test, freeze it — and use the **same multisig as the relayer's
upgrade authority** (deploy-checklist.md §2). There is no operational
reason to split them: either key alone is already total over its
program, so a second roster only widens the signer surface.

```bash
solana program set-upgrade-authority \
  inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9 \
  --new-upgrade-authority <RELAYER_UPGRADE_MULTISIG> \
  --url <MAINNET_RPC>
# Or `--final` for an immutable fork (no future patch path; matches a
# `--final` relayer per deploy-checklist.md §2 option 1).
```

Do **not** freeze before §8 passes — keep a patch path open while the
legs are still being validated.

**6. Record the results** (fill after execution):

| Item                          | Value / tx sig                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fork deploy sig               | `5JyDPu7RD51AfHXkoWVJRWnXB8LS1i5rYhmtpK9vKGTwTvXZ6qAWBTZ9Qc1tXr1Uj8gkjx3s2Ak89mC4vmaJn3aJ`                                                                                                    |
| Fork session-rail upgrade sig | `5FgStbQbrpYPqrEQW99hHpCpmeN2G5v2bdm9aBT61XvAoBihb67iJP3Ukq1gRg84qYTCfkBhh78RjoZHTCjraFg9` (verified hash `16557be43dfed0bd40b6986bf14ec5fc0e8524c4f1782767120df168290ce299`, slot 527819920) |
| Fork prefix-trim upgrade sig  | `4JdRi3EFUzLkTffP7a6q52cXWLgxG6NHCV46d2VFLKm3ssRTegPacEdxgJmP1FMFci4Vyz5Doiyc1HvPkNKo2duo` (verified hash `9f4f15e5c2fbf21b4276b5d6549647fb03477ee76dfcd7c2aba11f1b288cbb14`, slot 527976757; `BRIDGE_MESSAGE_PREFIX` → `Fogo Bridge\n` for deposit-tx size fit) |
| Fork fee_recipient upgrade sig | `4occELfCDsuN9TTz83vp8iyUd9xtbD4krKXbgKzoSHZokFyHdVoo9rATWmnJj6vxKNtDwoDTpcownQm1vcq3krEN` (verified hash `fc1bad40c8a4c3f3234bf99a2be35eb88e14cd855259e63b52038459a5dd66a6`, slot 528094419; configurable `FeeConfig.fee_recipient`, `update_fee_config` ix [5]) |
| FeeConfig migration USDC.s     | `4MfW5e1bUPUwhukvQsuLfjatZrWGW6Mx93hn7yeRJUYNFkdXYxgLSyVPtHM3pBa9ebsadAMqm4temLgMhp62zyi8` (PDA `7i5UFAHZTKb8St5q4LkZAYmocYSajyd6cqd26CoMvXo6` → len 56, fees preserved, fee_recipient `tiaModT7…GzKLA`) |
| FeeConfig migration ONyc       | `5WnhokUC88Q8866pTzXXeXeBwmnteRZBf4EJcCj3YeQySRRGe8h5ntW1JcrBnjDLGtMkwGTgn8GC77t3pXxeWDr7` (PDA `AwzcPdcBCttk5kczF2KUzPMPwMoNzmM5utkAKVRKQoBW` → len 56, fees preserved, fee_recipient `tiaModT7…GzKLA`) |
| Deposit LUT += fee ATA         | `3R8UtMjo1vpf2Kac5bQ28Qk9ztU6uasmQyZuRsMNiapksxqhfHUsjN2WigTxwUeyVK4ZaDSdqwhtPrbn5PWwDkK6` (LUT `DDu9vk67…` += `A8jKKrMVwhdts75R8NvnjVt6FKxLvcuz3i5jsGV61iAp` = ATA(USDC.s, tiaModT7)) |
| Redeem LUT += fee ATA          | `42uLj8JNPaWbw13FesDCkeDziCzGLgD6vHxfdT3tNHP5RWUsVEdyYFkehhM33WiEFsgwP8VzVxoVZ9Zkb7G5pfFK` (LUT `236GGhU4…` += `9XHZa5pR3NVacHCLZoRrHNpDTuxf8PjvRPrv8Usrbu7m` = ATA(ONyc, tiaModT7)) |
| Redeem LUT += 6 static keys    | `3XGfjP1VtGAtbFtj6hQmPXhwKbDBHoJPwusxJor5Pzfcs577pzVth694xzrXzc4JoHUJVqS8NZz3BbrvjtrhPUkv` (LUT `236GGhU4…` += `5S4JfYAi…`, `Hm3Edu5h…`, `HUF7LHXm…`, `WCp5zSuQ…`, `433jJQoq…`, `F1Msm7Jz…`; compresses redeem tx 1232 B → 1046 B so paymaster re-sign fits — fixes redeem `sponsor_and_send` 502) |
| Setter PDA init sig           | n/a — signer-only PDA, no init instruction                                                                                                                                                    |
| Fork upgrade-authority freeze | deferred — kept upgradeable until §8 passes                                                                                                                                                   |
| `register_ntt_config` USDC.s  | `Rwh2e14SAAp7BL9u8wHUxYgbPCcMvAwBeLvyaHTtZwphpkTmUaMXD5UgngYsyGyHy5nUit9he8DKX17mNj6HGME`                                                                                                     |
| `register_fee_config` USDC.s  | `4JGrN3brzhNuA3UmfNWB1iv2eoVG986kwJLUJrDyJdeXWNq3xVFCA4p8UTJ7ECEquvk6GUn3v1YfSHnud4FNc3eR` (mirrors upstream: intrachain 10000, bridge 2000000)                                               |
| `register_ntt_config` ONyc    | `Y5NEsptawFYkNE1i2it2au8zRDtYYbG6gfb7UP97QAmampHjBWWNBquNRQ6QbAuKXbnknHZFqPLVqsnHmoxeweP`                                                                                                     |
| `register_fee_config` ONyc    | `2XbVpRoy7wfyh3fczcKTGCaduonbe1Uznus5VdLytFbxnZgg2T8eYBNsYWbFt9gSrWx8QNe6iQ4XcA4ngsWvpLW1` (same raw as USDC.s: intrachain 10000, bridge 2000000; ONyc is 9-decimals)                         |
| `OnReBridge` sponsor pubkey   | `3AcB3szJnHeSiyLVLRS1a75vsYnYPMZCy5h1dzQV2n1G` (funded, 184.65 SOL)                                                                                                                           |

---

## 8. Mainnet smoke test

Before announcing the deploy, run **one** low-value end-to-end deposit
**and** one withdraw on mainnet. Both legs must succeed before opening
to users.

### 8.1. Deposit cycle (FOGO → ONyc on FOGO)

1. From a test FOGO wallet, NTT-send a small amount of USDC.s to
   Solana, addressed to the relayer's payload destination.
2. Wait for the NTT attestation.
3. Crank `claim_usdc` (any wallet — permissionless). Confirm a Flow PDA
   exists at `findInflightFlowPda(nttInboxItem)`.
4. Crank `swap_usdc_to_onyc`. Confirm the relayer's ONyc ATA balance
   increases.
5. Crank `lock_onyc`. Confirm:

- ONyc lands on the test FOGO wallet
- The Flow PDA is closed (rent returned to the cranker)
- The fee vault balance increased by the expected amount

### 8.2. Withdraw cycle (ONyc on FOGO → USDC.s on FOGO)

1. From the test FOGO wallet, NTT-send a small amount of ONyc back to
   Solana, addressed to the relayer's redeemer payload.
2. Wait for the NTT attestation.
3. Crank `unlock_onyc`. Confirm a Flow PDA appears in `Unlocked` state
   and the relayer's ONyc ATA balance increases by `gross`.
4. Crank `request_redemption_onyc`. Confirm:

- The singleton `RedemptionTracker` PDA is allocated and bound to
  this flow's `RedemptionRequest`
- The relayer's ONyc ATA balance decreased by exactly `gross`
  (balance-delta guard)

5. Wait for OnRe's `redemption_admin` to fulfill the request. Document
   the observed latency for the operational runbook (deploy-checklist.md §8).
6. Crank `claim_redemption_usdc`. Confirm USDC lands in the relayer's
   USDC ATA and the `RedemptionTracker` advances to `Claimed`.
7. Crank `send_usdc_to_user`. Confirm:

- USDC.s lands on the test FOGO wallet via NTT
- The Flow PDA closes (rent returned to the cranker)
- The `RedemptionTracker` closes (rent returned to whoever paid for it)
- Fees applied per `apply_fee_bps` (`programs/relayer/src/state.rs`)
  — zero rounding drift expected

### 8.3. Reconcile

Apply the on-chain `apply_fee_bps` formula to both cycles and confirm
math matches to the lamport. Capture transaction signatures for the
deploy record.

If any step fails: **do not announce or open the deploy to users**.
Investigate against the `events.rs` log output, fix, and redeploy
under a new buffer (or roll back upgrade authority to a paused state
if you went immutable).

---

## 9. Operational handoff

Before declaring the deploy "live":

1. **Cranker is staffed.** Per deploy-checklist.md §8, you've decided
   bot / public / user-self cranking and the chosen party has SOL refill
   and stuck-flow alerting in place. Note the withdraw chain has a
   liveness dependency on OnRe's `redemption_admin`; the cancel escape
   hatch (`cancel_redemption_onyc`, gated on the relayer config
   authority) is your only recourse if fulfillment stalls.
2. **Authority rotation rehearsed.** If the deployer held authority
   even briefly, rotate to the long-term multisig now via the two-step
   propose/accept flow:
   ```ts
   // Step 1 (current authority signs — route through its multisig)
   const proposeTx = await (
     await client.configure({ newAuthority: NEW_MULTISIG })
   ).transaction()
   //   → Squads-route, collect threshold signatures, broadcast.
   //   → Verify on-chain: cfg.pendingAuthority equals NEW_MULTISIG.

   // Step 2 (NEW authority signs — current authority does NOT participate)
   const acceptTx = await (
     await client.acceptAuthority({ pendingAuthority: NEW_MULTISIG })
   ).transaction()
   //   → Squads-route under the NEW multisig, broadcast.
   ```
3. **Monitoring is live:**

- Stuck Flow PDAs older than your stale-threshold (deposits should
  close within minutes; alert if any sits >1h)
- Stuck `RedemptionTracker` — if it sits in `Requested` state past
  the documented OnRe fulfillment SLA, page the cancel-decision owner
- Fee vault balance growing in line with deposit volume
- `pendingFee` becoming `Some(_)` — alert when a staged fee change
  is about to apply (timelock = `FEE_TIMELOCK_SLOTS = 432_000`
  slots ≈ 2 days)
- Relayer ATA balances: USDC and ONyc should usually be near zero
  (in-transit only); persistent non-zero balances mean a stuck flow

4. **Public deploy record published:** program ID, deploy commit hash,
   binary sha256, multisig address + roster, fee_vault address, SDK
   version, deploy date, signer.

### Webapp: archival FOGO RPC required

The webapp's bridge-history view (`BridgeHistory` component, backed by `useBridgeHistory`) calls `getSignaturesForAddress` against the user's canonical USDC.s and ONyc ATAs on FOGO. This returns unbounded history only when the configured FOGO RPC is **archival**. Public/free FOGO RPCs typically prune the signature index to the last ~2 days, which silently caps the user's visible history at that horizon — the feature looks incomplete with no error.

Verify pre-prod by paging an ATA back >7 days; if the cursor terminates earlier than expected, swap to an archival provider before going live. The RPC URL is configured via `NEXT_PUBLIC_FOGO_RPC_URL` (or the user's settings drawer override; see `packages/webapp/src/store/settings.ts`).

---

## 10. Reference: post-deploy admin operations

| Operation                    | Instruction                                              | Signer                      | Effect                                                   |
| ---------------------------- | -------------------------------------------------------- | --------------------------- | -------------------------------------------------------- |
| Decrease fees                | `configure(deposit_fee_bps?, withdraw_fee_bps?, _)`      | authority                   | Instant                                                  |
| Increase fees                | `configure(...)` then re-`configure(...)` after timelock | authority                   | ~2 days (auto-promoted on next `configure` after window) |
| Rotate fee vault             | `configure(_, _, _)` with `fee_vault` account passed     | authority                   | Instant                                                  |
| Propose new authority        | `configure(_, _, Some(new_pk))`                          | authority                   | Stages `pending_authority`                               |
| Accept authority             | `accept_authority`                                       | new authority (NOT current) | Atomic swap                                              |
| Cancel pending rotation      | `configure(_, _, Some(Pubkey::default()))`               | authority                   | Instant                                                  |
| Set / repoint price oracle   | `configure(_, _, _, _, Some(offer_pda))`                 | authority                   | Instant (required: swap fail-closes `BadPriceOracle` until set) |
| Cancel stuck OnRe redemption | `cancel_redemption_onyc`                                 | authority                   | Returns ONyc to user, closes tracker                     |

The permissionless flow-cranking instructions (`receive`, `swap`,
`send`) need **no admin key**. Anyone with SOL for tx fees can crank
them. (These merged the legacy split handlers `claim_usdc` /
`unlock_onyc` → `receive`, `swap_usdc_to_onyc` / `swap_onyc_to_usdc` →
`swap`, `send_usdc_to_user` → `send`.)

### Live mainnet deployment record

| Date       | Action                          | Program / PDA                                  | Signer    | Signature / slot |
| ---------- | ------------------------------- | ---------------------------------------------- | --------- | ---------------- |
| 2026-06-02 | Relayer upgrade → v0.2.0 (merged `receive`/`swap`/`send`) | `onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp` | tiaModT7  | `35QYSJuPBxVfWutopuiA5TTPr6n5mypxmJrZdm4vCUFMkoTQWJinKFrZGBN1QVqNjTuNhiY8QxvZNkWsTzH3pWvw` (slot 423801710) |
| 2026-06-02 | `configure` set `price_oracle` → OnRe offer PDA `E88zkA9Pxb1i8EfSHrEW5ZUe6hiQbo8DHWQ3WhDFw7p6` | RelayerConfig `6SNyNCF2DhqhNvi9Fy6vM3hVCX5RpuoFU9fCQvn6wTQi` | tiaModT7  | `5zdLScdSp6C65xb9EKWUVDNCsLAGwFQPoKi6TFXSHBVeaX6sp9gNrCZusSyFjkk1uePifegvLUf8KDoD4XFysLQJ` |
| 2026-06-02 | Relayer upgrade → swap-guard fix (pre-CPI revoke of stale delegate; clears the `9nnLbot` ONyc-ATA residue DoSing all swaps) | `onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp` | tiaModT7  | `5CupGUkMccJojnvmzyJzEnHYZ9DPiqXGy8MTcZLJBPFA7c4EKfURCK91kWSkncJCdY2zXHm9qi3EMzqDeLVBSYG1` (slot 423807505) |
| 2026-06-02 | Send-leg LUT created + extended (33 stable NTT/Wormhole accounts) — compresses `transfer_lock` + `release_wormhole_outbound` + Flow-close v0 tx under 1232 B. Set cranker `SEND_LOOKUP_TABLE` to this. | LUT `9aF7QN6HTtfQ6Wvo2UMFeTuHyaBxidMHhbTbN16Bwuyk` | tiaModT7  | create `3d1vFrCVQMYzxo3Lzp2HR9WyCazcBivRgh47k23p6r5zGdA7uuAxRDVFZs3VXpQcoddi1dZeASUewYYDTAcDM52z`; extend `23WdS3gTX272cfX1JBLJs6WpqaaJ9M8iJW3fgR52fguPfm4h1aVyhefNmH5Bzm2dzrHnGGC9wgz9WTQevfsJurjk`, `5GLLQAEYedX34MuEMfhao8iyJAa7oCnizy4n53xKqZxk6UQ1tg11r4sNg76enAmcj7qWeT4wMgVqCRkmrVrCuLnz` |

---

## 11. Companion documents

| File                                              | Read for                                             |
| ------------------------------------------------- | ---------------------------------------------------- |
| [`deploy-checklist.md`](./deploy-checklist.md)    | Mandatory sign-off gate. Read before this guide.     |
| [`security.md`](./security.md)                    | Trust assumptions, blast radius of each key          |
| [`architecture.md`](./architecture.md)            | Full system design                                   |
| `programs/relayer/src/constants.rs`               | Canonical external program IDs and ix discriminators |
| `programs/relayer/src/instructions/initialize.rs` | `initialize` ix definitive spec                      |
| `packages/sdk/src/client.ts`                      | SDK reference for building admin txs                 |

---

## 12. Glossary

- **USDC.s** — the NTT-bridged USDC on FOGO. What users deposit
  and what they receive on withdraw.
- **ONyc** — OnRe's yield-bearing token, native on Solana. Held in NTT
  custody on Solana while users hold its ONyc representation on FOGO.
  Yield accrues as the OnRe price vector advances.
- **ONyc** — the NTT-bridged representation of ONyc on FOGO. What
  users hold directly after a deposit. There is no vault wrapper and
  no separate share token.
- **Curator / Cranker** — any wallet that calls a permissionless
  instruction. Has no privileged access; pays tx fees, gets Flow PDA /
  `RedemptionTracker` rent back when the flow closes.
- **Authority** — the multisig set at `initialize`. Can `configure`,
  `cancel_redemption_onyc`. Bounded blast radius capped by
  `MAX_FEE_BPS = 1000` (10% per leg) — see security.md §4.2.5.
- **Upgrade authority** — the multisig (or `None`) that can ship a new
  `.so`. Total blast radius — bypasses every safety property.
- **Flow PDA** — single-use receipt created by an inbound bridge
  message, consumed by the matching outbound transfer. Carries the
  originating FOGO wallet so a stolen cranker key cannot redirect funds.
- **RedemptionTracker** — singleton PDA serializing the withdraw chain.
  Allocated on `request_redemption_onyc`, closed on
  `claim_redemption_usdc` or `cancel_redemption_onyc`. Prevents
  concurrent withdraws against the OnRe `RedemptionOffer`.
- **Fee vault** — pre-existing ONyc TokenAccount that receives protocol
  fees. Must not alias the relayer's own ONyc ATA.
- **Timelock** — `FEE_TIMELOCK_SLOTS = 432_000` (~2 days). Applies to
  fee _increases_ only; decreases are instant.
