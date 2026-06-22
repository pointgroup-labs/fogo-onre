# syntax=docker/dockerfile:1.7
# Multi-stage build for the @fogo-onre/cranker daemon.
# Stage 1: install only cranker's dep closure + build SDK + cranker.
# Stage 2: minimal runtime image with the production-only deploy subtree.

FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Activate corepack and let it pick the pnpm version from the root
# `package.json` "packageManager" field — single source of truth so
# this Dockerfile doesn't drift from the rest of the repo.
RUN corepack enable

WORKDIR /repo

# Layer 1: lockfile + workspace manifests only. This layer changes on
# any dep bump but not on source edits, so the install layer hits
# cache on every source-only push.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/cranker/package.json packages/cranker/

# Filter install to cranker's dep closure (`...` includes transitive
# workspace deps, i.e. @fogo-onre/sdk). Skips webapp and cli entirely
# — webapp alone drags in Next.js, React, full Wormhole SDK, and the
# WalletConnect graph (hundreds of MB) that cranker never imports.
# `--ignore-scripts` skips postinstalls during install; we already run
# explicit `pnpm --filter ... build` steps below for what actually
# needs to be built (SDK + cranker).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts \
      --filter @fogo-onre/cranker... \
      --filter @fogo-onre/sdk...

# Layer 2: source. Only the two packages we actually compile, plus the
# Anchor IDL/types the SDK reads at build. Avoids busting cache on
# unrelated source edits (webapp, cli, tests, docs).
COPY packages/sdk packages/sdk
COPY packages/cranker packages/cranker

# Build SDK first (cranker depends on its dist), then cranker.
RUN pnpm --filter @fogo-onre/sdk build \
 && pnpm --filter @fogo-onre/cranker build

# Produce a self-contained, prod-only deployable subtree at /out.
# `--legacy` keeps the pre-v10 deploy semantics (workspace packages
# are copied verbatim, no inject-workspace-packages requirement). The
# v10 default needs every workspace dep marked injected in the root
# manifest, which is more invasive than this single deploy site needs.
RUN pnpm deploy --legacy --filter @fogo-onre/cranker --prod /out

# ----------------------------------------------------------------------------

FROM node:24-bookworm-slim AS runtime

# dumb-init reaps zombies and forwards SIGTERM to Node — without it,
# `docker stop` waits 10s and SIGKILLs, skipping our shutdown handlers
# entirely. ca-certificates so Node TLS can verify the RPC endpoints.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# UID 10001 is pinned so volume permissions are stable across rebuilds.
RUN groupadd --system --gid 10001 cranker \
 && useradd --system --uid 10001 --gid cranker --create-home --shell /usr/sbin/nologin cranker

WORKDIR /app
COPY --from=builder --chown=cranker:cranker /out /app

RUN chown cranker:cranker /app

USER cranker

ENV NODE_ENV=production
EXPOSE 9090

# --start-period covers cold-start config validation + PairConfig
# fetch (~5–30s on a healthy paid RPC). Healthcheck hits /healthz which
# returns 503 when heartbeat is stale. Uses Node directly to avoid an
# extra apt dependency (wget/curl).
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9090/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/bin.js"]
