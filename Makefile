# Fogo OnRe — operational entrypoints.
#
# Convention: every target documented with `## section: description` shows
# up grouped under its section in `make help`. Sections are ordered by the
# first appearance of each name.

.DEFAULT_GOAL := help
SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
MAKEFLAGS += --no-print-directory --warn-undefined-variables

# Override on CLI:  make deploy CLUSTER=devnet
CLUSTER ?= localnet

# Auto-PHONY: every target name extracted from the Makefile becomes phony.
# Avoids the maintenance burden of a hand-curated `.PHONY:` list.
.PHONY: $(shell awk -F':' '/^[a-zA-Z_-]+:.*##/ {print $$1}' $(MAKEFILE_LIST))

help: ## info: List targets, grouped by section
	@awk 'BEGIN {FS = ":.*## "} \
	  /^[a-zA-Z_-]+:.*## / { \
	    p = index($$2, ": "); \
	    sec = substr($$2, 1, p - 1); \
	    desc = substr($$2, p + 2); \
	    if (!(sec in seen)) { seen[sec] = 1; order[++n] = sec; } \
	    body[sec] = body[sec] sprintf("  \033[36m%-14s\033[0m %s\n", $$1, desc); \
	  } \
	  END { \
	    printf "\nUsage: make <target>\n"; \
	    for (i = 1; i <= n; i++) { \
	      printf "\n\033[1m%s\033[0m\n%s", order[i], body[order[i]]; \
	    } \
	  }' $(MAKEFILE_LIST)

info: ## info: Print toolchain versions (paste into bug reports)
	@printf "node    "; node --version
	@printf "pnpm    "; pnpm --version
	@printf "rustc   "; rustc --version
	@printf "cargo   "; cargo --version
	@printf "anchor  "; anchor --version
	@printf "solana  "; solana --version

install: ## setup: Install JS deps (frozen lockfile)
	pnpm install --frozen-lockfile

build: ## build: anchor build → sdk build (SDK refreshes its own IDL via prebuild)
	pnpm build

test: ## test: Full suite (rebuilds via pretest)
	pnpm test

test-rust: ## test: Rust unit tests only (no rebuild)
	cargo test --lib -p fogo-ntt-relayer

test-ts: ## test: TS tests only, no rebuild (assumes 'make build' already ran)
	pnpm exec vitest run

test-watch: ## test: TS tests in watch mode
	pnpm exec vitest

# Usage:  make test-only T='claim_usdc'
test-only: ## test: Run a single test by name (T=...)
	@test -n "$$T" || { echo "Usage: make test-only T='test name'" >&2; exit 1; }
	pnpm exec vitest run -t "$$T"

lint: ## quality: ESLint + clippy (fails on warnings)
	pnpm lint
	cargo clippy --workspace --all-targets -- -D warnings

lint-fix: ## quality: ESLint --fix
	pnpm lint:fix

fmt: ## quality: cargo fmt --all
	cargo +nightly fmt --all

fmt-check: ## quality: cargo fmt --check (CI gate)
	cargo +nightly fmt --all -- --check

check: fmt-check lint test ## quality: Pre-push gate (fmt + lint + test)

audit: ## quality: cargo audit + pnpm audit (advisory; non-blocking)
	-cargo audit
	-pnpm audit

clean: ## clean: Remove build artefacts (target/, dist/, .next/)
	rm -rf target packages/sdk/dist packages/webapp/.next packages/webapp/.turbo

reset: clean ## clean: clean + drop node_modules (re-run 'make install' after)
	rm -rf node_modules packages/*/node_modules

webapp-dev: ## dev: Next.js webapp in dev mode
	pnpm webapp dev

webapp-build: ## dev: Production build of the webapp
	pnpm webapp build

# Path to the env file the cranker reads. Override on CLI:
#   make cranker CRANKER_ENV=/path/to/your.env
CRANKER_ENV ?= deploy/cranker/cranker.env

cranker-build: ## cranker: Bundle the cranker daemon (tsup → dist/bin.js)
	pnpm --filter @fogo-onre/cranker build

# Source the env file with `set -a` so every var becomes an export, then
# exec node so signals (SIGTERM/SIGINT) reach the daemon directly. Without
# `exec` they'd hit make first and produce a confusing double-shutdown.
# `_env` normalization: bash's `.` (source) treats bare names as
# PATH-relative, so prepend `./` for relative paths but leave absolute
# paths untouched.
cranker: cranker-build ## cranker: Run the daemon locally (override env: CRANKER_ENV=path)
	@test -f $(CRANKER_ENV) || { \
	  echo "missing env file: $(CRANKER_ENV)" >&2; \
	  echo "  cp deploy/cranker/cranker.env.example $(CRANKER_ENV) && edit" >&2; \
	  exit 1; \
	}
	@_env="$(CRANKER_ENV)"; case "$$_env" in /*) ;; *) _env="./$$_env" ;; esac; \
	  set -a; . "$$_env"; set +a; \
	  exec node packages/cranker/dist/bin.js

deploy: ## deploy: anchor deploy to $CLUSTER (default: localnet)
	anchor deploy --provider.cluster $(CLUSTER)

deploy-devnet: ## deploy: anchor deploy to devnet
	@$(MAKE) deploy CLUSTER=devnet

deploy-mainnet: ## deploy: anchor deploy to mainnet (typed confirmation required)
	@echo "MAINNET DEPLOY — review docs/deploy-mainnet.md and docs/deploy-checklist.md first."
	@read -r -p "Type 'mainnet' to proceed: " confirm; \
	  [[ "$$confirm" == "mainnet" ]] || { echo "Aborted." >&2; exit 1; }
	@$(MAKE) deploy CLUSTER=https://mainnet.helius-rpc.com/?api-key=e7029c83-db93-4397-b540-114b2111e9f5
	# @$(MAKE) deploy CLUSTER=mainnet

ci: install fmt-check lint test ## ci: Exact sequence CI runs
