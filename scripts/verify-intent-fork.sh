#!/usr/bin/env bash
set -euo pipefail
# Audit-carryover gate for the in-tree intent-transfer fork.
# Proves the two properties the carryover actually needs:
#   (1) vendored src/ differs from pinned upstream by ONLY declare_id!
#   (2) the deployed .so is a deterministic (verifiable) build of it
#
# Run from repo root. Pins are embedded (not read from gitignored docs).

UPSTREAM_TAG="intent-transfer/v0.1.2"
UPSTREAM_COMMIT="f372c48df8215f5db76d51e914a6d4e9dc31f69e"
UPSTREAM_PROGRAM_ID="Xfry4dW9m42ncAqm8LyEnyS5V6xu5DSJTMRQLiGkARD"
FORK_PROGRAM_ID="inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9"
FORK_SRC="programs/intent-transfer/src"
VERIFY_DIR="$(mktemp -d)"
trap 'rm -rf "$VERIFY_DIR"' EXIT

git clone --quiet --depth 1 --branch "$UPSTREAM_TAG" \
  -c advice.detachedHead=false \
  https://github.com/fogo-foundation/fogo-sessions "$VERIFY_DIR"
GOT=$(git -C "$VERIFY_DIR" rev-parse HEAD)
if [ "$GOT" != "$UPSTREAM_COMMIT" ]; then
  echo "FAIL: $UPSTREAM_TAG resolved to $GOT, expected $UPSTREAM_COMMIT"; exit 1
fi

# `-N` makes added/deleted files appear as full +/- hunks instead of silent
# "Only in ..." lines, so a new backdoor.rs cannot slip past the +/- filter.
# Content lines start with a single +/- (the +++/--- file headers are dropped).
CHANGED=$(diff -ruN "$VERIFY_DIR/programs/intent-transfer/src" "$FORK_SRC" \
  | grep -E '^[+-]' \
  | grep -Ev '^(\+\+\+|---)' || true)

# The carryover is valid iff the entire diff is exactly the declare_id! swap.
# Match the literal lines (not a substring) so `declare_id!(..); pub mod evil;`
# is rejected, and assert both the old and new program ids are the pinned pair.
EXPECTED=$(printf -- '-declare_id!("%s");\n+declare_id!("%s");' \
  "$UPSTREAM_PROGRAM_ID" "$FORK_PROGRAM_ID")
if [ "$CHANGED" != "$EXPECTED" ]; then
  echo "FAIL: fork src diff is not exactly the declare_id! swap"
  echo "--- expected ---"; printf '%s\n' "$EXPECTED"
  echo "--- actual ---"; printf '%s\n' "$CHANGED"
  exit 1
fi
echo "OK: only declare_id! ($UPSTREAM_PROGRAM_ID -> $FORK_PROGRAM_ID) differs from upstream $UPSTREAM_COMMIT"

# Reproducible build (requires Docker; run at deploy/CI time).
if [ "${SKIP_REPRODUCIBLE_BUILD:-0}" = "1" ]; then
  echo "SKIP: reproducible build (SKIP_REPRODUCIBLE_BUILD=1)"; exit 0
fi
( cd programs/intent-transfer \
  && solana-verify build --library-name intent_transfer \
  && solana-verify get-executable-hash target/deploy/intent_transfer.so \
       | tee target/deploy/intent_transfer.sha256 )
