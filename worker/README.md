# worker/ — the deployable Worker

A single-file Cloudflare Worker that actually deploys against a bare account:
no R2 bucket, no queues, no KV, no pre-provisioning, zero runtime dependencies.

| Route | Method | What it does |
|---|---|---|
| `/health` (and `/`) | GET | Liveness + a config report showing which secrets are present (never their values) |
| `/v1/models` | GET | OpenAI-shaped list of the supported FLUX.2 models |
| `/v1/images/generations` | POST | OpenAI-compatible text-to-image on **FLUX.2** via Workers AI |
| `/v1/decisions` | POST | **Jev proxy** — forwards the body upstream with `JEV_API_KEY` attached server-side |

Supported models: `@cf/black-forest-labs/flux-2-klein-4b` (default),
`flux-2-klein-9b`, `flux-2-dev`.

> **Why no R2?** The old `workers/` app requires an R2 bucket
> (`cloudflare-image-mcp-images`) to exist before deploy, which is the main
> reason deploys failed. This Worker returns images as `b64_json`, and when you
> ask for `response_format: "url"` it hands back an inline `data:` URL instead.

---

## Deploy (about 5 minutes)

### 1. Get two values from Cloudflare

| Value | Where |
|---|---|
| **Account ID** | [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → right sidebar |
| **API Token** | [API Tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token → Custom token |

Token permissions — **only these two are needed** (no R2, no Zone):

- `Account` → `Workers Scripts` → `Edit`
- `Account` → `Workers AI` → `Edit`

### 2. Install and log in

```bash
cd worker
npm install
npx wrangler login          # or: export CLOUDFLARE_API_TOKEN=...
```

### 3. Deploy

```bash
export CLOUDFLARE_ACCOUNT_ID=your_account_id
export CLOUDFLARE_API_TOKEN=your_api_token
npm run deploy
```

Wrangler prints the URL:

```
https://cloudflare-image-worker.<your-subdomain>.workers.dev
```

### 4. Add the secrets that light it up

The deploy succeeds without secrets, but image generation needs the Workers AI
credentials at *runtime* too (the Worker calls the REST API, so it needs its own
copy — the deploy-time env vars are not visible to the running Worker).

```bash
export JEV_API_KEY=...        # optional — moves the Jev key server-side
export API_KEYS=key1,key2     # optional — requires Bearer auth on /v1/*
npm run secrets               # pushes ACCOUNT_ID, API_TOKEN, JEV_API_KEY, API_KEYS
```

Or manually:

```bash
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put JEV_API_KEY      # optional
npx wrangler secret put API_KEYS         # optional
```

### 5. Verify

```bash
curl https://cloudflare-image-worker.<sub>.workers.dev/health
```

`config.workers_ai_credentials` must be `true`. Then:

```bash
curl -X POST https://cloudflare-image-worker.<sub>.workers.dev/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"a red fox in falling snow, cinematic","size":"1024x1024"}' \
  | head -c 200
```

### 6. Paste the URL into Settings → Pictures

Use the base URL (no trailing path) — the client appends `/v1/images/generations`
itself. If you set `API_KEYS`, paste one of those keys in the API-key field.

---

## Request reference

`POST /v1/images/generations`

```jsonc
{
  "prompt": "a red fox in falling snow",       // required, ≤ 2048 chars
  "model": "@cf/black-forest-labs/flux-2-dev", // optional, defaults to klein-4b
  "n": 1,                                      // 1–4
  "size": "1024x1024",                         // 256–2048, snapped to /32
  "steps": 6,                                  // 1–50
  "seed": 42,
  "response_format": "b64_json"                // or "url" → data: URL
}
```

`POST /v1/decisions` — body is forwarded verbatim to `JEV_API_URL`
(default `https://api.jev.ai/v1/decisions`) with `Authorization: Bearer $JEV_API_KEY`.
Point it elsewhere by editing `vars.JEV_API_URL` in `wrangler.jsonc`. Until
`JEV_API_KEY` exists the proxy falls back to an `X-Jev-Api-Key` request header,
so clients can migrate before the secret lands.

---

## Local development

```bash
cp .dev.vars.example .dev.vars   # then fill in your values
npx wrangler dev
```

`.dev.vars` is git-ignored.
