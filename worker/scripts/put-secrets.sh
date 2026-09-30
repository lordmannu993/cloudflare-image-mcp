#!/usr/bin/env bash
# Push the three secrets this Worker understands, reading them from the
# environment so nothing is ever echoed into shell history or a file.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID in your environment}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN in your environment}"

printf '%s' "$CLOUDFLARE_ACCOUNT_ID" | npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
printf '%s' "$CLOUDFLARE_API_TOKEN" | npx wrangler secret put CLOUDFLARE_API_TOKEN

if [ -n "${JEV_API_KEY:-}" ]; then
  printf '%s' "$JEV_API_KEY" | npx wrangler secret put JEV_API_KEY
else
  echo "ℹ️  JEV_API_KEY not set — /v1/decisions will require an X-Jev-Api-Key header."
fi

if [ -n "${API_KEYS:-}" ]; then
  printf '%s' "$API_KEYS" | npx wrangler secret put API_KEYS
fi
echo "✅ secrets pushed"
