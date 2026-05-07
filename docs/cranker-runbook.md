# Cranker Operations Runbook

Operator-facing guide: take a clean Hetzner CX22 from blank to running cranker; rollback; key rotation; incident response; DR.

## 1. Provision & harden the host

1. Order a Hetzner CX22 (2 vCPU, 4 GB, Ubuntu 24.04 LTS).
2. SSH in as `root` with the keypair you registered at order time.
3. Create an unprivileged user and copy your pubkey to it:
   ```sh
   adduser --disabled-password --gecos "" deploy
   usermod -aG sudo deploy
   mkdir -p /home/deploy/.ssh && cp /root/.ssh/authorized_keys /home/deploy/.ssh/
   chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
   ```
4. Harden SSH (`/etc/ssh/sshd_config`):
   ```
   PermitRootLogin prohibit-password
   PasswordAuthentication no
   PubkeyAuthentication yes
   AllowUsers deploy
   ```
   Then `systemctl reload ssh`. Confirm a second SSH session as `deploy` works **before** logging out the root session.
5. Install firewall + automatic updates + fail2ban:
   ```sh
   apt update && apt upgrade -y
   apt install -y ufw unattended-upgrades fail2ban
   ufw default deny incoming
   ufw default allow outgoing
   ufw allow 22/tcp
   ufw enable
   dpkg-reconfigure -plow unattended-upgrades   # accept defaults
   systemctl enable --now fail2ban
   ```
6. Install Docker engine + compose plugin from Docker's apt repo (Ubuntu's bundled docker.io is too old for Compose v2):
   ```sh
   curl -fsSL https://get.docker.com | sh
   usermod -aG docker deploy
   ```
   Log out and back in for the group to apply.
7. Reboot, confirm `journalctl -u ssh -b` is clean and `docker compose version` reports v2.

## 2. Initial deploy

1. As `deploy`, clone the deploy directory:
   ```sh
   sudo mkdir -p /opt/cranker && sudo chown deploy:deploy /opt/cranker
   cd /opt/cranker
   git clone --depth=1 https://github.com/<org>/<repo>.git src
   cp -r src/deploy/cranker/* .
   rm -rf src
   ```
2. Configure runtime env:
   ```sh
   cp cranker.env.example cranker.env
   vim cranker.env   # fill in SOLANA_RPC_URL, SOLANA_WS_URL, FOGO_RPC_URL
   ```
3. Place the cranker keypair (generated **off-host** — see §4):
   ```sh
   mkdir -p secrets && chmod 700 secrets
   # scp cranker-keypair.json from your trusted machine into ./secrets/
   chmod 600 secrets/cranker-keypair.json
   ```
4. Authenticate to ghcr.io (PAT with `read:packages` scope; use `docker logout` after first pull if you don't want creds persisted):
   ```sh
   echo "$GHCR_PAT" | docker login ghcr.io -u <gh-user> --password-stdin
   ```
5. Bring the stack up:
   ```sh
   docker compose up -d
   docker compose ps   # all five services should show "healthy" within ~2m
   curl -s http://127.0.0.1:9090/healthz
   ```
6. Verify on-chain activity: `docker compose logs -f cranker` should show `cranker started` followed by per-scan iterations. The `assertCrankerNotAuthority` check runs at boot — if your keypair equals `RelayerConfig.authority`, the container exits 1 with an explicit error.

## 3. Rolling updates and rollback

**Rolling forward** is automatic — Watchtower pulls `:latest` every 60s and recreates the container.

**Rollback to a specific commit:**
```sh
cd /opt/cranker
# Edit docker-compose.yml: pin cranker image to a prior sha tag, e.g.
#   image: ghcr.io/<org>/cranker:sha-<oldsha>
docker compose pull cranker
docker compose up -d cranker
```
Watchtower will not override a pinned-sha tag. To re-enable rolling updates, restore `:latest` and `docker compose up -d cranker`.

## 4. Cranker key rotation

The cranker key is grief-only — its theft costs at most a small amount of SOL fee burn. Rotate on schedule (~quarterly) or immediately on suspected compromise.

1. **Generate off-host** on a trusted machine you control (never on the production server):
   ```sh
   solana-keygen new --no-bip39-passphrase --outfile cranker-new.json
   solana-keygen pubkey cranker-new.json   # note the pubkey
   ```
2. **Verify the new pubkey is NOT** `RelayerConfig.authority`. The on-host `assertCrankerNotAuthority` check will catch this at boot, but verify out-of-band first to avoid a crashloop.
3. Fund with ~0.5 SOL: `solana transfer <new-pubkey> 0.5 --keypair <treasury>`.
4. Copy to host: `scp cranker-new.json deploy@<host>:/opt/cranker/secrets/`.
5. On host:
   ```sh
   cd /opt/cranker
   chmod 600 secrets/cranker-new.json
   mv secrets/cranker-keypair.json secrets/cranker-old.json
   mv secrets/cranker-new.json secrets/cranker-keypair.json
   docker compose restart cranker
   docker compose logs --tail=50 cranker | grep "cranker started"  # verify new pubkey
   ```
6. Sweep residual SOL from the old keypair to treasury:
   ```sh
   solana transfer <treasury-pubkey> ALL --keypair secrets/cranker-old.json --allow-unfunded-recipient
   ```
7. Securely delete the old keypair: `shred -u secrets/cranker-old.json` and from the originating machine.

## 5. Incident response

| Symptom | First diagnostic | Likely cause | Action |
|---|---|---|---|
| `CrankerHeartbeatStale` | `docker compose logs --tail=200 cranker` | RPC outage, stuck scan | Watchdog should self-kill; if not, `docker compose restart cranker` |
| `CrankerDown` | `docker compose ps` | Container crashed | Read last log lines for `level: fatal`; common: config validation, RPC unreachable |
| `CrankerKeypairLowSol` | `solana balance <cranker-pubkey>` | Fees consumed | Top up immediately |
| `CrankerScanErrorRate` warn | Logs grep `level: error` | Upstream ABI drift, RPC errors | Check NTT/OnRe binary fixtures; see CLAUDE.md "Third-party CPI ABI sync" |
| Container crashlooping immediately after deploy | `docker compose logs cranker` | Bad env var, missing keypair, paid-RPC validation, authority-keypair invariant | Read the JSON `level: fatal` message; fix env or keypair |
| Suspected key compromise | — | — | Rotate keypair (§4) immediately; review on-chain activity for anomalous tx |

The cranker has **no fund-redirect powers** — `ValidatedTransceiverMessage` in the relayer pins the recipient on-chain. Worst case from cranker compromise: griefing (paying fees for no-op tx). Authority compromise is materially different — that's a separate `docs/security.md` runbook.

## 6. Disaster recovery

- **Host loss:** Provision a fresh CX22 and re-run §1 + §2. RTO ~1 hour. The cranker is stateless; the only meaningful loss is Prometheus tsdb history (we accept that).
- **ghcr.io outage:** If you have a host with a recent image cached, `docker save ghcr.io/<org>/cranker:sha-<x> | ssh new-host docker load`, then pin the loaded tag in compose.
- **RPC provider outage:** Edit `cranker.env`, swap to a fallback URL, `docker compose restart cranker`.
- **All paid RPC outages simultaneously:** the cranker is permissionless — anyone can advance flows manually with the CLI. Operate from the CLI on a dev machine until RPC returns.

## 7. Routine maintenance

- **Weekly:** Open Grafana (`ssh -L 3000:127.0.0.1:3000 deploy@<host>`, then http://127.0.0.1:3000), review trends. Confirm SOL balance > 0.5.
- **Monthly:** `apt upgrade && reboot` during a low-activity window. Cranker is idempotent; Docker brings it back. Verify `cranker_heartbeat_age_seconds` settles within 2 minutes post-reboot.
- **Quarterly:** Test rollback procedure on staging. Rotate cranker keypair (§4).
