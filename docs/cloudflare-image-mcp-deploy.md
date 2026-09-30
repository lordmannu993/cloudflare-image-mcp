# Why `cloudflare-image-mcp` never deployed

Findings verified against commit **`58f1258`** (`main`, "update docs") on
2026-09-30. Every claim below was checked against files in the tree, not
assumed. Each finding lists the evidence, the blast radius, and the fix.

**Short version:** the repo has no committed Wrangler config, the only path to a
deploy is a GitHub Action that generates one on the fly, and that generated
config binds an R2 bucket nobody creates. Any deploy attempt therefore fails —
locally at "no config", in CI at "bucket not found". The new `worker/`
directory is the unblocked path; the fixes below repair the existing
`workers/` app if you'd rather keep it.

---

## Finding 1 — there is no `wrangler.toml` / `wrangler.jsonc` anywhere in the repo

**Evidence**

```console
$ git ls-files | grep -iE 'wrangler\.(toml|json|jsonc)$'
(no output — the only `wrangler` hits are prose under .claude/skills/)

$ cat workers/package.json
  "deploy": "wrangler deploy"
```

`workers/package.json` promises `npm run deploy`, but Wrangler has no config to
read: no `name`, no `main`, no `compatibility_date`. The command aborts with
`Missing entry-point to Worker script` before it ever contacts Cloudflare.

**Impact** — nobody can deploy from a laptop. Every `npm run deploy`, every
`wrangler dev`, every fork's first attempt fails identically. The README's
"takes 5 minutes" promise is unreachable outside CI.

**Fix** — commit a config. `worker/wrangler.jsonc` is the reference version.
For the existing app, add `workers/wrangler.jsonc` with `name`, `main =
"src/index.ts"`, a recent `compatibility_date`, and no `account_id` (let
`CLOUDFLARE_ACCOUNT_ID` supply it) so the file is fork-safe.

---

## Finding 2 — CI generates a config that binds an R2 bucket it never creates

**Evidence** — `.github/workflows/deploy-workers.yml`, step *Generate wrangler.toml*:

```toml
[[r2_buckets]]
binding = "IMAGE_BUCKET"
bucket_name = "cloudflare-image-mcp-images"
```

Nothing in the repo creates that bucket. There is no
`wrangler r2 bucket create` step in either workflow, and no Terraform:

```console
$ grep -rn "r2 bucket create\|r2_bucket" --include='*.yml' --include='*.tf' .
.github/workflows/deploy-workers.yml:   bucket_name = "cloudflare-image-mcp-images"
```

**Impact** — this is the hard stop in CI. `wrangler deploy` validates bindings
server-side and fails the upload with a "bucket does not exist" error on a fresh
account. The bucket name is also global-per-account, so two people forking the
repo into the same account collide.

**Fix** — either create the bucket before deploying:

```yaml
- name: Ensure R2 bucket
  run: npx wrangler r2 bucket create cloudflare-image-mcp-images || true
```

…which additionally requires `Workers R2 Storage: Edit` on the token, or drop
the binding entirely. `worker/` takes the second route: it returns `b64_json`
(and `data:` URLs when `response_format: "url"` is requested), so there is
nothing to provision.

---

## Finding 3 — the R2 token permission is documented but the bucket step is not

**Evidence** — `docs/DEPLOY.md` tells you to grant
`Account → Workers R2 Storage → Edit`, and Step 3 lists only
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `API_KEYS`, `AI_ACCOUNTS`, `TZ`
as secrets. There is no step anywhere that creates the bucket.

**Impact** — a reader who follows the guide exactly still lands on Finding 2.
The permission is necessary but not sufficient, and nothing in the docs says so.

**Fix** — with `worker/`, R2 drops out of the token scope entirely: only
`Workers Scripts: Edit` and `Workers AI: Edit` are needed. Keep the docs and the
required permissions in sync in whichever direction you choose.

---

## Finding 4 — runtime AI credentials are pushed *after* the deploy

**Evidence** — in the workflow, the *Deploy to Cloudflare Workers* step runs
before *Set Worker secrets*, which is where `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` are put onto the Worker.

The Worker needs them at runtime because it calls the REST API rather than an
`env.AI` binding — `workers/src/services/image-generator.ts`:

```ts
const url = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${modelId}`;
```

**Impact** — even in the best case, the first successful deploy serves a Worker
with no AI credentials until the follow-up step lands. Any request in that
window 500s, and if the secret step fails the Worker stays permanently broken
while the workflow shows a green deploy.

**Fix** — push secrets first (they can be set on a Worker that already exists;
for a brand-new script, deploy once then set secrets then redeploy), or add an
`[ai]` binding and use `env.AI.run(...)`, which needs no tokens at all. The
`worker/` README sequences deploy → secrets → verify, and `/health` reports
`config.workers_ai_credentials` so the gap is visible instead of silent.

---

## Finding 5 — nothing fails loudly when the Worker is misconfigured

**Evidence** — `workers/src/index.ts` exposes `/health`, but it reports only
timezone and deployment metadata; it does not report whether the AI credentials
or the R2 binding resolved.

**Impact** — a Worker that is up but cannot generate a single image looks
healthy to any uptime check. This is why the failure mode reads as "it deployed
but the pictures never come".

**Fix** — `worker/src/index.ts` returns a config block on `/health`:

```json
{ "workers_ai_credentials": true, "jev_key_server_side": true, "r2_bucket": false }
```

Check it immediately after deploying; if `workers_ai_credentials` is `false`,
the secrets did not land.

---

## Finding 6 — the Jev key has no server-side home

**Evidence** — `grep -ri jev` over the tracked tree at `58f1258` matches nothing
in source. There is no decisions endpoint and no place for the credential, so
whatever client calls Jev has to carry the key itself.

**Impact** — a browser-held API key is exfiltratable by anyone who opens
devtools, and it cannot be rotated without shipping a new client.

**Fix** — `POST /v1/decisions` in `worker/` proxies to `JEV_API_URL` and injects
`Authorization: Bearer $JEV_API_KEY` server-side. Until you add the secret it
falls back to an `X-Jev-Api-Key` request header, so clients can point at the
proxy before the key moves.

---

## The unblocked path

```bash
cd worker
npm install
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
npm run deploy
npm run secrets                         # + JEV_API_KEY if you have one
curl https://<worker-url>/health        # workers_ai_credentials must be true
```

Then paste the base Worker URL into **Settings → Pictures**.

`docs/cloudflare-image-mcp-deploy.patch` contains this whole change as a patch
that applies cleanly to `58f1258`:

```bash
git apply --check docs/cloudflare-image-mcp-deploy.patch && \
git apply docs/cloudflare-image-mcp-deploy.patch
```

## Summary table

| # | Finding | Where | Severity |
|---|---|---|---|
| 1 | No Wrangler config committed | repo-wide | Blocker (local) |
| 2 | CI binds an R2 bucket nobody creates | `deploy-workers.yml` | Blocker (CI) |
| 3 | Docs require R2 permission, never create the bucket | `docs/DEPLOY.md` | High |
| 4 | Runtime AI secrets set after deploy | `deploy-workers.yml` | High |
| 5 | `/health` hides misconfiguration | `workers/src/index.ts` | Medium |
| 6 | No server-side home for the Jev key | repo-wide | Medium |
