# Cranker Bot — Hetzner Docker Deployment Design

**Date**: 2026-05-08
**Status**: Spec — pending implementation plan
**Scope**: Productionize the permissionless cranker as a long-running daemon on a Hetzner Cloud VM, with auto-update, observability, and operational hygiene appropriate for grief-only blast radius.

## Context

The Solana relayer (`programs/relayer/`) exposes seven *permissionless* instructions that drive cross-chain user flows: `claim_usdc`, `swap_usdc_to_onyc`, `lock_onyc`, `unlock_onyc`, `request_redemption_onyc`, `claim_redemption_usdc`, `send_usdc_to_user`. Anyone can sign these — but in practice nobody will, so user flows stall without an automated bot.

The existing `packages/cli/src/commands/cranker.ts` (~1485 lines) implements one-shot orchestration via an `advance` subcommand. It is shaped for admin/debugging use: parses CLI args, builds and broadcasts one batch of txs, exits. Comments inside it explicitly note race-loss recovery is "NOT YET IMPLEMENTED." It is **not** a 24/7 daemon and cannot be deployed as one.

This spec turns the cranker into a real daemon and ships it to a single Hetzner Cloud CX22 in Ashburn (~$5/mo) running Docker Compose with Prometheus-based observability and Watchtower-based auto-updates.

### Trust model recap

- **Cranker keypair** signs only permissionless instructions. It is **not** the relayer authority. Hard invariant: `CRANKER_KEYPAIR ≠ RelayerConfig.authority`. The daemon refuses to start if these match.
- **Blast radius** of a compromised cranker key: grief only — RedemptionTracker mutex hold, NTT rate-limit consumption, gas drain. No path to user funds.
- This trust profile is what makes a single VM with no HA acceptable, and what makes Watchtower auto-pulling `:main` an acceptable update model — neither would be acceptable for an authority-tier key.

## Architecture

### Package layout

A new workspace package owns the daemon. The CLI is no longer involved in production cranking.

```
packages/cranker/
  src/
    index.ts          # entrypoint: parse env, validate invariants, start loop
    daemon.ts         # while-loop, WS wake, heartbeat, abort timeouts, signal handling
    scan.ts           # one full scan pass: enumerate watched PDAs, dispatch advance
    advance/          # per-leg state machines (extracted from cli/cranker.ts)
      claim-usdc.ts
      swap-usdc-to-onyc.ts
      lock-onyc.ts
      unlock-onyc.ts
      request-redemption.ts
      claim-redemption.ts
      send-usdc-to-user.ts
    rpc.ts            # AbortSignal-wrapped Connection + Wormholescan helpers, hard timeouts
    metrics.ts        # prom-client registry + tiny http server (/metrics, /healthz)
    config.ts         # env-var schema, validates required vars at startup
  Dockerfile
  package.json
```

**Dependency direction**: `packages/cranker` depends on `@fogo-onre/sdk` directly. `packages/cli` imports `advance/` modules from `@fogo-onre/cranker` so the existing one-shot `cli cranker advance` debugging command keeps working without code duplication. The daemon owns the canonical orchestration logic.

### Scan loop

```ts
const wakeup = new EventEmitter()
const ws = connection.onLogs(RELAYER_PROGRAM_ID, () => wakeup.emit('wake'))

while (running) {
  const t0 = Date.now()
  try {
    await scanAndAdvance({ signal: AbortSignal.timeout(60_000) })
    metrics.scanIterations.inc({ result: 'ok' })
    metrics.heartbeat.set(Date.now() / 1000)
  } catch (err) {
    metrics.scanIterations.inc({ result: 'error' })
    log.error(err)
  }
  metrics.scanDuration.observe((Date.now() - t0) / 1000)

  await Promise.race([
    sleep(30_000),
    once(wakeup, 'wake'),
  ])
}
```

The 30s `sleep` is the **correctness floor**, not the WS subscription. Codex review surfaced that `connection.onLogs(RELAYER_PROGRAM_ID)` is best-effort — providers silently drop subscriptions, reconnect with slot gaps, or rate-limit. WS is treated as a wake-early hint; correctness depends on the poll-driven `scanAndAdvance()` enumerating all watched PDAs every 30s regardless of whether any wake event fired. The `wakeup` event only collapses median reaction latency from ~15s to <1s for the common case.

`scanAndAdvance()` is the genuinely new code on top of `advance/`: it enumerates Flow PDAs in non-terminal status, the singleton RedemptionTracker, and outstanding OutboxItem PDAs, then dispatches each to the appropriate `advance/<leg>.ts` module. Bounded concurrency (default 4 in-flight advances) prevents one stuck leg from blocking others while still capping RPC load.

### Hardening

Lifted directly from the codex review's P2 findings:

- **Top-level handlers**: `unhandledRejection` and `uncaughtException` log + `process.exit(1)`. Crash-on-unknown is the policy; Docker restarts the container.
- **RPC timeouts**: every `Connection` call wrapped to take an `AbortSignal`. Default 15s per call. Wormholescan calls 10s. No bare `await connection.x()` anywhere in the daemon.
- **Bounded concurrency**: max 4 simultaneous `advance` operations across all legs.
- **Memory ceiling**: `--max-old-space-size=512` in Node args. CX22 has 4GB; this prevents one runaway scan from impacting Prom/Grafana.
- **Signal handling**: `SIGTERM` flips `running = false`, drains in-flight advances (up to 30s grace), then exits 0. Compose's stop_grace_period is set to 45s.

### Metrics surface

`prom-client` registry exposed on `127.0.0.1:9090/metrics`. Bound to loopback inside the container; published only to the host's loopback via compose. Prometheus (also on the box) scrapes localhost. No public exposure ever.

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `cranker_scan_iterations_total` | counter | `result=ok\|error` | Loop liveness |
| `cranker_scan_duration_seconds` | histogram | — | Loop performance |
| `cranker_heartbeat_age_seconds` | gauge | — | Drives `/healthz` and stale-detection alerts |
| `cranker_tx_sent_total` | counter | `instruction`, `result=landed\|sim_failed\|send_failed` | Per-leg reliability |
| `cranker_rpc_errors_total` | counter | `endpoint=solana\|fogo\|wormholescan`, `kind=timeout\|http_5xx\|http_4xx\|ws_drop` | Upstream health |
| `cranker_flow_advance_total` | counter | `leg`, `from_status`, `to_status` | State-machine progress |
| `cranker_keypair_sol_balance` | gauge | — | Spend alarm without a separate cron |
| `cranker_ws_subscription_alive` | gauge (0/1) | — | WS health for `/healthz` |

`/healthz` returns 200 iff: `heartbeat_age < 90s` AND process is not in shutdown. Returns 503 otherwise. Docker `HEALTHCHECK` and Watchtower both consume `/healthz`.

### Self-kill on wedge (the "unhealthy doesn't restart" fix)

Docker's `restart: unless-stopped` reacts to **exit codes**, not health status — a container marked `unhealthy` will sit there forever unless something kills it. Rather than introduce an autoheal sidecar, the daemon owns its own liveness and exits the process when its own heartbeat goes stale.

```ts
// runs in a separate setInterval, independent of scan loop
setInterval(() => {
  const ageMs = Date.now() - lastHeartbeatAt
  if (ageMs > 120_000) {
    log.fatal({ ageMs }, 'heartbeat stale — self-killing for restart')
    process.exit(1)
  }
}, 15_000)
```

This catches the wedged-but-alive failure mode codex flagged: any path that prevents the scan loop from completing for >120s — hung RPC promise, deadlocked async path, infinite catch loop — triggers process exit, which `restart: unless-stopped` *does* honor. The 120s self-kill threshold sits 30s above the `/healthz` 90s threshold deliberately: monitoring goes red first (operator sees the alert), self-kill fires second (auto-recovery without operator action).

### PDA enumeration strategy

The "scan all watched PDAs every 30s" claim deserves an explicit account-by-account budget rather than a hand-wave. Concrete scopes:

| Account class | Owner | Filter | Expected count | Strategy |
|---|---|---|---|---|
| `Flow` PDAs (non-terminal) | `RELAYER_PROGRAM_ID` | `memcmp(discriminator) + memcmp(status != Closed)` | O(in-flight users), bounded by `MAX_FEE_BPS`-side rate limits — realistically <50 at peak | `getProgramAccounts` with discriminator + status filters, dataSlice on status byte for cheap pagination |
| `RedemptionTracker` singleton | `RELAYER_PROGRAM_ID` | known PDA address | exactly 1 | `getAccountInfo` (no enumeration) |
| `OutboxItem` PDAs (released, awaiting Wormhole pickup) | `NTT_USDC_PROGRAM_ID` and `NTT_ONYC_PROGRAM_ID` | `memcmp(discriminator) + memcmp(released = true)` | O(in-flight VAAs), bounded — <20 at peak | `getProgramAccounts` per NTT manager program |
| `RedemptionRequest` PDAs | OnRe program | `memcmp(discriminator)` | bounded by per-user redemption queue | `getProgramAccounts` |

`getProgramAccounts` is rate-limited and/or paid on most public RPC providers (Helius, QuickNode, Triton). At <100 accounts per filter at peak, scrape cost is negligible — but the daemon **must** use a paid RPC endpoint, never `api.mainnet-beta.solana.com` (which disables `getProgramAccounts` for unknown callers). RPC endpoint configuration is required, not optional; the daemon refuses to start without it.

If account counts grow beyond ~500 per filter, switch to a Helius webhook or Geyser subscription. Out of scope for v1; documented as a known scaling cliff.

### Container image

Multi-stage `node:24-alpine` using `pnpm deploy` to flatten workspace symlinks into a self-contained runtime tree. A naive `COPY node_modules` from the build stage breaks because `node_modules/@fogo-onre/sdk` is a symlink into `packages/sdk` that doesn't exist in the runtime image. `pnpm deploy --prod` resolves the workspace graph and writes a flat directory.

```dockerfile
FROM node:24-alpine AS build
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages ./packages
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @fogo-onre/cranker build
RUN pnpm deploy --filter @fogo-onre/cranker --prod /out

FROM node:24-alpine
# Pin UID/GID so host-side keypair file ownership can match exactly.
RUN addgroup -g 10001 -S cranker && adduser -u 10001 -G cranker -S cranker
WORKDIR /app
COPY --from=build --chown=cranker:cranker /out /app
USER cranker
EXPOSE 9090
# 120s start-period absorbs cold-start RPC handshake + first full PDA scan
# without flapping unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=120s \
  CMD wget -qO- http://127.0.0.1:9090/healthz || exit 1
CMD ["node", "--max-old-space-size=512", "dist/index.js"]
```

The metrics HTTP server inside the daemon binds `0.0.0.0:9090` (not `127.0.0.1`) — the network boundary is enforced at the **host** in compose via `127.0.0.1:9090:9090`, not inside the container. Binding the in-container server to loopback would block sibling-container scrapes from Prometheus.

**Keypair file ownership**: on the host, `/etc/cranker/keypair.json` is `0400` owned by `10001:10001` (matching the in-container `cranker` UID/GID). This makes `0400` actually readable by the container's non-root user without granting host root anything extra. The `0400` (not `0440`) keeps the file unreadable by any host user other than UID 10001, which on a dedicated VM is unused for anything else.

### Compose stack

The full $5/mo stack on the CX22, in one file:

```yaml
# /etc/cranker/docker-compose.yml
services:
  cranker:
    image: ghcr.io/<org>/fogo-onre-cranker:main
    restart: unless-stopped
    env_file: /etc/cranker/.env
    volumes:
      - /etc/cranker/keypair.json:/keypair.json:ro
    ports:
      - "127.0.0.1:9090:9090"
    stop_grace_period: 45s
    labels:
      com.centurylinklabs.watchtower.enable: "true"

  watchtower:
    image: containrrr/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --label-enable --interval 300 --cleanup
    environment:
      WATCHTOWER_NOTIFICATION_URL: ${WATCHTOWER_SLACK_WEBHOOK}

  prometheus:
    image: prom/prometheus:latest
    restart: unless-stopped
    volumes:
      - /etc/cranker/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prom-data:/prometheus
    ports:
      - "127.0.0.1:9091:9090"
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.retention.time=14d
      - --storage.tsdb.retention.size=2GB

  alertmanager:
    image: prom/alertmanager:latest
    restart: unless-stopped
    volumes:
      - /etc/cranker/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
    ports:
      - "127.0.0.1:9093:9093"

  grafana:
    image: grafana/grafana:latest
    restart: unless-stopped
    volumes:
      - grafana-data:/var/lib/grafana
      - /etc/cranker/grafana-datasources.yml:/etc/grafana/provisioning/datasources/ds.yml:ro
    environment:
      GF_SECURITY_ADMIN_PASSWORD__FILE: /run/secrets/grafana_admin
      GF_SERVER_ROOT_URL: https://grafana.cranker.tailnet
    ports:
      - "127.0.0.1:3000:3000"
    secrets:
      - grafana_admin

volumes:
  prom-data:
  grafana-data:

secrets:
  grafana_admin:
    file: /etc/cranker/grafana_admin_password
```

All ports bind to `127.0.0.1`; access from the operator workstation is via Tailscale's `tailscale serve` or `ssh -L` only. No `0.0.0.0` listeners.

### Update model

Watchtower polls `ghcr.io/<org>/fogo-onre-cranker:main` every 5 minutes. On a new digest:

1. Watchtower pulls.
2. Stops the existing container with SIGTERM (45s grace — the daemon's SIGTERM handler drains in-flight advances).
3. Starts new container.
4. Docker `HEALTHCHECK` polls `/healthz` every 30s. If unhealthy after 3 retries, container is marked unhealthy.
5. Watchtower posts to Slack on success or failure.

CI (GitHub Actions) builds the image on every push to `main` and additionally tags releases with `vX.Y.Z`. The `:main` tag is the rolling channel; `vX.Y.Z` tags exist for explicit rollback.

**Rollback procedure**: edit `image:` in compose to a known-good `vX.Y.Z` or `@sha256:...` digest, `docker compose up -d cranker`. One command. Runbook keeps the last three known-good digests.

### Host bootstrap and Tailscale

Tailscale is the only inbound-access mechanism for the box. Public port 22 is firewalled off; SSH binds to the Tailscale interface only. This means **if `tailscaled` dies, the operator loses SSH access and Grafana access simultaneously** — the only remaining recovery path is the Hetzner web console (KVM-over-web).

Bootstrap sequence on a fresh CX22:

1. Initial provision via Hetzner web console: create user `ops` (UID arbitrary), add operator SSH public keys to `~/.ssh/authorized_keys`, disable root SSH, disable password auth.
2. `apt install tailscale ufw fail2ban unattended-upgrades`.
3. `tailscale up --auth-key=<ephemeral-tagged-key> --advertise-tags=tag:cranker --ssh`. The auth key is a **tagged ephemeral key** generated from the Tailscale admin console scoped to `tag:cranker`; ephemeral means the node deregisters automatically if it goes offline >30 days.
4. Tailscale ACL (managed in the Tailscale admin, version-controlled separately) grants `tag:operator` → `tag:cranker:22,3000,9091,9093` and nothing else. No other tag can reach the box.
5. `ufw default deny incoming; ufw allow in on tailscale0; ufw enable`. Public 22 stays closed; only Tailscale-side SSH works.
6. Create the host `cranker` group and user with **UID/GID 10001** (matching the in-container user). `groupadd -g 10001 cranker; useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin cranker`.
7. `mkdir -p /etc/cranker; chown root:root /etc/cranker; chmod 0750 /etc/cranker`.
8. Place `keypair.json`, `.env`, `docker-compose.yml`, `prometheus.yml`, `alertmanager.yml`, `grafana-datasources.yml`, `grafana_admin_password`. `chown 10001:10001 /etc/cranker/keypair.json && chmod 0400 /etc/cranker/keypair.json`. Other config files: `0640 root:docker`.
9. `docker compose -f /etc/cranker/docker-compose.yml up -d`.

**Tailscale failure modes and mitigations**:
- `tailscaled` crashes → systemd restarts it (default unit behavior). If it crash-loops, operator must use Hetzner web console KVM to debug.
- Tailscale auth-key expires (default 90 days for non-ephemeral) → use ephemeral keys or rotate proactively. Documented in the rotation runbook.
- Tailscale company outage → SSH and Grafana go dark for the duration. The cranker daemon itself keeps running — it makes only outbound connections to RPC endpoints, which don't traverse Tailscale. Grief-only blast radius makes this acceptable.

### SSH and host hardening

Lifted from codex review's P2 key-custody bullet. None of these are negotiable:

- SSH bound to `tailscale0` interface only — public port 22 firewalled off via `ufw`.
- Root login disabled; key auth only; password auth disabled.
- `fail2ban` on the SSH port (Tailscale-side, defense in depth against compromised operator keys).
- `unattended-upgrades` enabled for security patches.
- No SSH agent forwarding from operator workstations.
- Cranker keypair file: `0400`, owned by host UID/GID `10001:10001` (matches in-container `cranker` user), mounted read-only into container. Host root can still read/replace it (root bypasses POSIX perms); no other host user can.

### Disk and log management

CX22 has 40GB. Naive defaults will fill it within weeks via Docker logs and journald. Hard requirements:

- **Docker daemon log driver**: `/etc/docker/daemon.json` sets `{"log-driver": "json-file", "log-opts": {"max-size": "50m", "max-file": "5"}}`. Caps per-container log volume at 250MB.
- **journald**: `/etc/systemd/journald.conf` sets `SystemMaxUse=1G`, `SystemMaxFileSize=100M`.
- **Watchtower `--cleanup`** removes old image layers but won't recover space if a build leaks intermediate layers. Manual `docker system prune -a` monthly via cron.
- **Prometheus retention**: `--storage.tsdb.retention.time=14d --storage.tsdb.retention.size=2GB` (already in compose). At ~30 series × 30s scrape × 14d, actual disk use is well under 1GB. The 2GB cap is a hard ceiling.
- **Grafana volume**: bounded by dashboard count + user count, expected <100MB.
- **Disk-usage alert**: node_exporter (added to compose if not already) feeds `node_filesystem_avail_bytes`; Alertmanager pages on <5GB free.

Total disk budget on 40GB CX22: cranker image+layers ~500MB, Prom ~2GB, Grafana ~100MB, Docker logs cap ~1.5GB total, journald 1GB, OS+apt cache ~5GB, headroom 30GB. Survivable; but the disk-usage alert is required, not optional.

### Spend alarm

The cranker keypair is funded with ≤0.5 SOL at any time. The daemon's `cranker_keypair_sol_balance` gauge is scraped every 30s; Alertmanager fires on:
- balance < 0.05 SOL → page (refund needed)
- balance dropped >0.2 SOL in 1h → page (anomalous spend, possible compromise)

## Tradeoffs and rejections

- **Co-located Prometheus vs Grafana Cloud free tier**: chose co-located. Single-host failure takes both the cranker and its monitoring offline simultaneously, but given the grief-only blast radius and the simplicity gain (one compose file, one host, one cost line), this is acceptable. Grafana Cloud was the alternative; it adds an external dependency and a second account to manage. If we later need durable historical metrics we can ship a remote-write target without restructuring the stack.
- **Watchtower vs manual SSH deploys**: chose Watchtower because the healthcheck + metrics + alertmanager combination makes auto-deploy of `:main` *partially* safe — a wedged new image is detected by `/healthz` failing the Docker healthcheck within ~90s, the daemon self-kills at 120s, the container restarts, and Slack gets a notification. Without those signals, auto-deploy would be reckless; with them, it removes the deploy step from operator toil. **Residual risk explicitly accepted**: `/healthz` only proves the scan loop completed an iteration — it cannot detect *semantic* regressions (wrong program ID baked into the new image, off-by-one in PDA enumeration, a leg cranking the wrong direction). Mitigation is the staging-deploy gate before any tag promotion plus Alertmanager rules on `cranker_flow_advance_total{from→to}` regression patterns. A determined bad merge can still ship to prod for ~5 minutes before alerting fires; this is the price of auto-deploy and we are paying it knowingly.
- **Single VM, no HA**: accepted given grief-only blast radius. RTO target: rebuild from runbook in <2h. Documented; not engineered around.
- **Removed CLI involvement in production**: codex was right that bolting daemon shape onto `cli/cranker.ts` would mix admin and prod paths. Extracting `advance/` to the cranker package and having CLI consume it preserves the debugging affordance without coupling the daemon to admin tooling.
- **`prom-client` is the only new runtime dep** in the cranker package. No metrics library beyond it; no APM agent; no log shipper (stdout → `docker logs` → host journald is fine for a single-VM grief-only daemon).

## Verification

After implementation:

1. `pnpm build` — workspace builds, including new `@fogo-onre/cranker` package.
2. `pnpm lint` — 0 errors.
3. `pnpm test` — full vitest suite passes; new tests cover the scan-loop dispatcher and metrics surface.
4. `docker build packages/cranker -t cranker:dev` — image builds locally.
5. `docker run --rm cranker:dev node dist/index.js --help` — daemon binary boots, prints usage.
6. End-to-end staging deploy on a separate Hetzner box pointed at devnet Solana / staging FOGO before mainnet.
7. Manual chaos checks on staging: kill WS RPC endpoint mid-scan, kill Solana RPC entirely, exhaust cranker SOL balance, send SIGTERM mid-advance — daemon must recover or fail loudly via metrics in every case.

## Out of scope

- Multi-region / HA cranker.
- HSM/KMS for cranker keypair (key is grief-only; tiny SOL balance + spend alarm is the proportionate mitigation).
- Public Grafana dashboard. Internal Tailscale-only access for now.
- Migration of the CLI's interactive `cranker advance` UX. CLI keeps importing `advance/` from cranker package; user-facing CLI behavior is unchanged.
- Auto-rollback on health regression. Watchtower currently only auto-forwards; rollback is human-driven via runbook.

## Open questions for implementation

None blocking. All design decisions resolved in this spec.
