#!/usr/bin/env bash
# One-shot: deploy -> push runtime secrets -> resolve URL -> verify /health.
# Reads credentials from the environment; never writes them to disk.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID in your environment}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN in your environment}"

WORKER_NAME=$(node -e "
  const fs=require('fs');
  const raw=fs.readFileSync('wrangler.jsonc','utf8').replace(/^\s*\/\/.*$/gm,'');
  console.log(JSON.parse(raw).name);
")

echo "==> 1/4 deploying \"$WORKER_NAME\""
npx wrangler deploy

echo "==> 2/4 pushing runtime secrets"
printf '%s' "$CLOUDFLARE_ACCOUNT_ID" | npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
printf '%s' "$CLOUDFLARE_API_TOKEN"  | npx wrangler secret put CLOUDFLARE_API_TOKEN
if [ -n "${JEV_API_KEY:-}" ]; then
  printf '%s' "$JEV_API_KEY" | npx wrangler secret put JEV_API_KEY
else
  echo "    (JEV_API_KEY not set - /v1/decisions will require an X-Jev-Api-Key header)"
fi
if [ -n "${API_KEYS:-}" ]; then
  printf '%s' "$API_KEYS" | npx wrangler secret put API_KEYS
fi

echo "==> 3/4 resolving workers.dev URL"
SUBDOMAIN=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{
      const j=JSON.parse(s);
      if(!j.success){console.error(JSON.stringify(j.errors||j));process.exit(1);}
      console.log(j.result?.subdomain||'');
    });")

if [ -z "$SUBDOMAIN" ]; then
  echo "❌ No workers.dev subdomain on this account. Enable it: Cloudflare dashboard -> Workers & Pages -> Subdomain."
  exit 1
fi

URL="https://$WORKER_NAME.$SUBDOMAIN.workers.dev"

echo "==> 4/4 verifying $URL/health"
sleep 8
HEALTH=$(curl -sS --retry 5 --retry-delay 4 "$URL/health")
echo "$HEALTH"

echo "$HEALTH" | node -e "
  let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{
    const h=JSON.parse(s);
    if(!h.config.workers_ai_credentials){
      console.error('\n❌ workers_ai_credentials is false - the secrets did not land. Re-run this script.');
      process.exit(1);
    }
    console.log('\n✅ Live. Paste this into Settings -> Pictures:\n');
    console.log('   ' + process.env.URL + '\n');
  });
" URL="$URL"
