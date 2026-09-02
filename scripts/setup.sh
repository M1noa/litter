#!/usr/bin/env bash
# uploads the worker secrets and points every bot's webhook at the deployment.
# safe to re-run; each step overwrites rather than duplicates.
#
#   TELEGRAM_BOT_TOKENS=111:aaa,222:bbb \
#   TELEGRAM_CHAT_ID=-100xxxxxxxxxx \
#   PUBLIC_URL=https://litter.minoa.cat \
#   ./scripts/setup.sh
#
# optional: TELEGRAM_SCRATCH_CHAT_ID (defaults to the storage group),
#           TELEGRAM_ALLOWED_USERS, TELEGRAM_WEBHOOK_SECRET (generated if unset).

set -euo pipefail
cd "$(dirname "$0")/.."

: "${TELEGRAM_BOT_TOKENS:?set TELEGRAM_BOT_TOKENS (comma-separated)}"
: "${TELEGRAM_CHAT_ID:?set TELEGRAM_CHAT_ID}"
: "${PUBLIC_URL:?set PUBLIC_URL, e.g. https://litter.minoa.cat}"
: "${TELEGRAM_WEBHOOK_SECRET:=$(openssl rand -hex 24)}"

put() { printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null && echo "  secret $1"; }

echo "secrets:"
put TELEGRAM_BOT_TOKENS      "$TELEGRAM_BOT_TOKENS"
put TELEGRAM_CHAT_ID         "$TELEGRAM_CHAT_ID"
put TELEGRAM_WEBHOOK_SECRET  "$TELEGRAM_WEBHOOK_SECRET"
[ -n "${TELEGRAM_SCRATCH_CHAT_ID:-}" ] && put TELEGRAM_SCRATCH_CHAT_ID "$TELEGRAM_SCRATCH_CHAT_ID"
[ -n "${TELEGRAM_ALLOWED_USERS:-}" ]   && put TELEGRAM_ALLOWED_USERS   "$TELEGRAM_ALLOWED_USERS"

echo "webhooks:"
i=0
IFS=, read -ra TOKENS <<< "$TELEGRAM_BOT_TOKENS"
for t in "${TOKENS[@]}"; do
  ok=$(curl -s "https://api.telegram.org/bot${t}/setWebhook" \
    --data-urlencode "url=${PUBLIC_URL}/tg/webhook/${i}" \
    --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
    --data-urlencode 'allowed_updates=["message"]' \
    --data-urlencode 'drop_pending_updates=true')
  echo "  /tg/webhook/${i} -> $(printf '%s' "$ok" | tr -d '\n' | cut -c1-90)"
  i=$((i + 1))
done

echo
echo "webhook secret: $TELEGRAM_WEBHOOK_SECRET"
echo "now run: npx wrangler deploy"
