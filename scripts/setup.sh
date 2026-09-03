#!/usr/bin/env bash
# uploads the worker's secrets. safe to re-run; each put overwrites.
#
#   TELEGRAM_BOT_TOKENS=111:aaa,222:bbb \
#   TELEGRAM_CHAT_ID=-100xxxxxxxxxx \
#   ./scripts/setup.sh
#
# the tokens are only used server-side, for forwardMessage and getFile. the bots
# have no commands and no webhook, so there is nothing else to register.
# optional: TELEGRAM_SCRATCH_CHAT_ID (defaults to the storage group).

set -euo pipefail
cd "$(dirname "$0")/.."

: "${TELEGRAM_BOT_TOKENS:?set TELEGRAM_BOT_TOKENS (comma-separated)}"
: "${TELEGRAM_CHAT_ID:?set TELEGRAM_CHAT_ID}"

put() { printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null && echo "  secret $1"; }

put TELEGRAM_BOT_TOKENS "$TELEGRAM_BOT_TOKENS"
put TELEGRAM_CHAT_ID    "$TELEGRAM_CHAT_ID"
[ -n "${TELEGRAM_SCRATCH_CHAT_ID:-}" ] && put TELEGRAM_SCRATCH_CHAT_ID "$TELEGRAM_SCRATCH_CHAT_ID"

echo "now run: npx wrangler deploy"
