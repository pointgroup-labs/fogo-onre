# Fogo OnRe — operational entrypoints.
#
# Targets are documented with `##` so `make help` (the default) auto-prints
# them. Keep descriptions short. Add new targets with `## description`.

.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

# Anchor cluster for deploy-* targets. Override on the CLI:
#   make deploy CLUSTER=devnet
CLUSTER ?= localnet

.PHONY: help install build sync-idl \
        test test-rust test-ts test-watch \
        lint lint-fix fmt fmt-check check \
        clean clean-all \
        deploy deploy-devnet deploy-mainnet \
        webapp-dev webapp-build \
        sdk-build \
        ci

help: ## Show this help
	@awk 'BEGIN{FS=":.*##"; printf "\nUsage: make <target>\n\nTargets:\n"} \
	  /^[a-zA-Z_-]+:.*##/{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install JS deps (pnpm)
	pnpm install --frozen-lockfile

build: ## anchor build + sync IDL into SDK + sdk build
	pnpm build

sync-idl: ## Copy fresh target/idl/relayer.json into the SDK
	pnpm sync-idl

test: ## Full test suite (rebuilds via pretest)
	pnpm test

test-rust: ## Rust unit tests only (no SDK rebuild)
	cargo test --lib -p fogo-onre-relayer

test-ts: ## TS tests only, skip the rebuild pretest hook
	pnpm exec vitest run

test-watch: ## TS tests in watch mode
	pnpm exec vitest

lint: ## ESLint (TS) + clippy (Rust)
	pnpm lint
	cargo clippy --workspace --all-targets -- -D warnings

lint-fix: ## ESLint --fix (Rust formatting via `make fmt`)
	pnpm lint:fix

fmt: ## cargo fmt
	cargo fmt --all

fmt-check: ## cargo fmt --check (CI-friendly)
	cargo fmt --all -- --check

check: fmt-check lint test ## Pre-push gate: format, lint, test

clean: ## Remove build artefacts (target/, dist/, generated IDL JSON)
	rm -rf target packages/sdk/dist packages/webapp/.next

clean-all: clean ## clean + node_modules
	rm -rf node_modules packages/*/node_modules

sdk-build: ## Build the SDK alone
	pnpm sdk build

webapp-dev: ## Run the Next.js webapp in dev mode
	pnpm webapp dev

webapp-build: ## Production build of the webapp
	pnpm webapp build

deploy: ## anchor deploy to $CLUSTER (default: localnet)
	anchor deploy --provider.cluster $(CLUSTER)

deploy-devnet: ## anchor deploy to devnet
	$(MAKE) deploy CLUSTER=devnet

deploy-mainnet: ## anchor deploy to mainnet (review docs/deploy-mainnet.md first)
	@echo "Deploying to MAINNET. Cancel within 5s if unintended..." >&2
	@sleep 5
	$(MAKE) deploy CLUSTER=mainnet

ci: fmt-check lint test ## What CI runs
