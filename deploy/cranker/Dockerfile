# syntax=docker/dockerfile:1.7
# Multi-stage build for the @fogo-onre/cranker daemon.
# Stage 1: install all workspace deps + build SDK + cranker.
# Stage 2: minimal runtime image with the production-only deploy subtree.

FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /repo

# Copy lockfile and workspace manifests first for better layer caching.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/cranker/package.json packages/cranker/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Now copy sources. SDK has Anchor IDL it depends on; copy the whole repo
# to avoid cherry-picking IDL/program-build outputs.
COPY . .

# Build SDK first (cranker depends on its dist), then cranker.
RUN pnpm --filter @fogo-onre/sdk build \
 && pnpm --filter @fogo-onre/cranker build

# Produce a self-contained, prod-only deployable subtree at /out.
RUN pnpm deploy --filter @fogo-onre/cranker --prod /out

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

USER cranker

ENV NODE_ENV=production
EXPOSE 9090

# --start-period covers cold-start config validation + RelayerConfig
# fetch (~5–30s on a healthy paid RPC). Healthcheck hits /healthz which
# returns 503 when heartbeat is stale. Uses Node directly to avoid an
# extra apt dependency (wget/curl).
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9090/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/bin.js"]
