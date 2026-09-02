#!/usr/bin/env bash
# builds the bundled index under public/ from the postgres database.
#
#   DATABASE_URL='postgresql://...' ./scripts/build-index.sh
#
# use neon's direct endpoint, not -pooler.

set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL (direct endpoint, not -pooler)}"
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
cd "$(dirname "$0")/.."

# -At with an explicit tab separator; no COPY-style backslash escaping
psql "$DATABASE_URL" -At -F $'\t' -v ON_ERROR_STOP=1 <<'SQL' | node scripts/shard-index.mjs
SELECT public_id,
       regexp_replace(original_name, E'[\\r\\n\\t]', ' ', 'g'),
       telegram_message_id,
       COALESCE(file_size, 0),
       COALESCE(mime_type, ''),
       COALESCE(extract(epoch FROM upload_date)::bigint, 0)
FROM files
WHERE deleted IS NOT TRUE
  AND telegram_message_id ~ '^[0-9]+$'
  AND public_id IS NOT NULL
  AND original_name IS NOT NULL
ORDER BY public_id;
SQL
