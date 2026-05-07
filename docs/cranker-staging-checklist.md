# Cranker Staging Verification Checklist

Run this checklist on a staging host (separate Hetzner CX22 or local Docker) before promoting any cranker build to mainnet. Tick boxes as they pass; do not promote until every box passes.

**Build under test:** `ghcr.io/<org>/cranker:sha-________` &nbsp;&nbsp;&nbsp;&nbsp; **Operator:** ____________ &nbsp;&nbsp;&nbsp;&nbsp; **Date:** ____________

## A. Image hygiene

- [ ] `docker pull ghcr.io/<org>/cranker:sha-<sha>` succeeds.
- [ ] `docker run --rm <image> id` shows `uid=10001 gid=10001`.
- [ ] `docker image inspect <image> --format '{{.Size}}'` is < 300 MB.
- [ ] `docker image inspect <image> --format '{{.Config.Healthcheck.Test}}'` references `/healthz`.

## B. Boot-time guards

- [ ] **Bad keypair path.** `docker run --rm -e KEYPAIR_PATH=/dev/null -e SOLANA_RPC_URL=... ... <image>` exits non-zero within 5s with a JSON `level: fatal` log including `KEYPAIR_PATH`.
- [ ] **Public mainnet-beta RPC rejected.** With `SOLANA_RPC_URL=https://api.mainnet-beta.solana.com`, container exits non-zero within 5s with the paid-RPC error.
- [ ] **Authority-keypair invariant fires.** Deliberately deploy with the authority keypair on devnet (never mainnet). Container exits non-zero with "refusing to start".
- [ ] **Healthy boot.** With valid devnet config, `/healthz` returns 200 within 60s of `docker compose up -d`.
- [ ] `/metrics` endpoint returns prom-format text containing all eight cranker metric names: `cranker_scan_iterations_total`, `cranker_scan_duration_seconds`, `cranker_heartbeat_age_seconds`, `cranker_tx_sent_total`, `cranker_rpc_errors_total`, `cranker_flow_advance_total`, `cranker_keypair_sol_balance`, `cranker_ws_subscription_alive`.

## C. Scan loop

- [ ] Logs show scan iterations incrementing once per `SCAN_INTERVAL_MS`.
- [ ] `cranker_heartbeat_age_seconds` stays below 30 over a 10-minute window under normal operation.
- [ ] **Watchdog self-kill.** `docker pause cranker` for `HEARTBEAT_STALE_MS + 30s`, then `docker unpause cranker`. Container self-kills (exit 1 from process.exit in watchdog) and Docker restarts it. Verify with `docker compose ps` showing recent restart timestamp.

## D. Flow advancement (devnet, with seeded VAA)

- [ ] Inject a fake Pending VAA via Wormholescan stub (or real devnet bridge tx). Cranker advances it: logs show `claim_usdc` tx with `result: ok`; `cranker_flow_advance_total{leg="deposit", from_status="Pending", to_status="Claimed"}` increments by 1.
- [ ] Cranker continues to Swapped (`swap_usdc_to_onyc`) on next scan; metric increments.
- [ ] Cranker continues to Closed (`lock_onyc`) on next scan; metric increments.
- [ ] **Idempotency.** After advancement, the same VAA is not re-attempted on subsequent scans (Flow status terminal → noop).

## E. Observability stack

- [ ] `curl -s http://127.0.0.1:9091/-/healthy` (Prometheus) returns 200.
- [ ] Prometheus targets page (port-forward and visit `/targets`) shows `cranker` job as `UP`.
- [ ] `docker compose exec prometheus promtool check rules /etc/prometheus/rules.yml` reports zero errors.
- [ ] Grafana at `127.0.0.1:3000` (port-forward) shows the Cranker dashboard with non-empty data after 10 minutes.
- [ ] **CrankerDown alert fires.** `docker compose stop cranker`, wait 3 minutes, confirm Alertmanager (`/alerts`) shows `CrankerDown` firing. `docker compose start cranker`, confirm alert resolves.

## F. Rollback drill

- [ ] Edit compose to pin a prior sha tag, `docker compose pull && docker compose up -d cranker`. Verify `docker inspect` shows the older image digest.
- [ ] Restore `:latest`, run `docker compose up -d cranker`. Verify newer image digest. Watchtower's next poll (≤60s) leaves the running tag alone (it only rolls `:latest` consumers).

## G. Cleanup

- [ ] `docker compose down -v` (drops named volumes — staging only).
- [ ] Sweep residual SOL from staging keypair to a treasury wallet.
- [ ] `shred -u secrets/cranker-keypair.json` on host and on the originating machine.

## Sign-off

```
Build sha:        ____________________________
Verified by:      ____________________________
Date / time UTC:  ____________________________
Notes / deviations from clean run:
  ____________________________________________
  ____________________________________________
```

Promote to mainnet only after this checklist is complete and signed.
