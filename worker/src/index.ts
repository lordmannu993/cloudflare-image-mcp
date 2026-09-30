// ============================================================================
// cloudflare-image-worker
// A single-file, dependency-free Cloudflare Worker.
//
//   GET  /health                 liveness + config report (no secrets leaked)
//   GET  /v1/models              OpenAI-shaped model list (FLUX.2 family)
//   POST /v1/images/generations  OpenAI-compatible text-to-image on FLUX.2
//   POST /v1/decisions           Jev decisions proxy (keeps JEV_API_KEY server-side)
//
// Deliberately has NO R2 binding: images come back as base64 / data URLs, so
// the Worker deploys against a bare Cloudflare account with zero provisioning.
// ============================================================================

export interface Env {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  JEV_API_URL?: string;
  JEV_API_KEY?: string;
  API_KEYS?: string;
  DEFAULT_MODEL?: string;
}

const FLUX2_MODELS = [
  '@cf/black-forest-labs/flux-2-klein-4b',
  '@cf/black-forest-labs/flux-2-klein-9b',
  '@cf/black-forest-labs/flux-2-dev',
] as const;

const DEFAULT_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
const DEFAULT_JEV_URL = 'https://api.jev.ai/v1/decisions';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...headers },
  });
}

function fail(message: string, status = 400, type = 'invalid_request_error'): Response {
  return json({ error: { message, type, code: status } }, status);
}

// ---------------------------------------------------------------------------
// Auth (optional): only enforced when API_KEYS is set
// ---------------------------------------------------------------------------
function authorized(request: Request, env: Env): boolean {
  const configured = (env.API_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (configured.length === 0) return true;

  const header = request.headers.get('Authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const query = new URL(request.url).searchParams.get('key') || '';
  return configured.includes(bearer) || configured.includes(query);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseSize(size: unknown): { width: number; height: number } {
  const fallback = { width: 1024, height: 1024 };
  if (typeof size !== 'string') return fallback;
  const m = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/i.exec(size.trim());
  if (!m) return fallback;
  const clamp = (n: number) => Math.min(2048, Math.max(256, Math.round(n / 32) * 32));
  return { width: clamp(Number(m[1])), height: clamp(Number(m[2])) };
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** FLUX.2 on Workers AI takes multipart/form-data and returns base64 or binary. */
async function runFlux2(
  env: Env,
  model: string,
  fields: Record<string, string | number | undefined>
): Promise<string> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error(
      'Worker is missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN secrets. See worker/README.md.'
    );
  }

  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') form.append(key, String(value));
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
    { method: 'POST', headers: { Authorization: `Bearer ${apiToken}` }, body: form }
  );

  if (!res.ok) {
    throw new Error(`Workers AI error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const payload = (await res.json()) as any;
    const result = payload?.result ?? payload;
    if (typeof result === 'string') return result;
    if (typeof result?.image === 'string') return result.image;
    throw new Error('Unexpected Workers AI JSON response shape');
  }
  return toBase64(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// POST /v1/images/generations
// ---------------------------------------------------------------------------
async function imagesGenerations(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return fail('Request body must be valid JSON');
  }

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return fail('`prompt` is required');
  if (prompt.length > 2048) return fail('`prompt` exceeds 2048 characters');

  const model = typeof body?.model === 'string' && body.model.startsWith('@cf/')
    ? body.model
    : env.DEFAULT_MODEL || DEFAULT_MODEL;
  if (!FLUX2_MODELS.includes(model as (typeof FLUX2_MODELS)[number])) {
    return fail(`Unsupported model \`${model}\`. Supported: ${FLUX2_MODELS.join(', ')}`);
  }

  const n = Math.min(4, Math.max(1, Number(body?.n) || 1));
  const { width, height } = parseSize(body?.size);
  const format = body?.response_format === 'url' ? 'url' : 'b64_json';
  const steps = body?.steps === undefined ? undefined : Math.min(50, Math.max(1, Number(body.steps)));

  try {
    const images = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        runFlux2(env, model, {
          prompt,
          width,
          height,
          steps,
          seed: body?.seed === undefined ? undefined : Number(body.seed) + i,
        })
      )
    );

    return json({
      created: Math.floor(Date.now() / 1000),
      model,
      data: images.map((b64) =>
        // No R2 bucket in this Worker: "url" is served as an inline data URL.
        format === 'url'
          ? { url: `data:image/png;base64,${b64}`, revised_prompt: prompt }
          : { b64_json: b64, revised_prompt: prompt }
      ),
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Image generation failed', 502, 'api_error');
  }
}

// ---------------------------------------------------------------------------
// POST /v1/decisions  — thin Jev proxy so the browser never holds JEV_API_KEY
// ---------------------------------------------------------------------------
async function decisionsProxy(request: Request, env: Env): Promise<Response> {
  const upstream = env.JEV_API_URL || DEFAULT_JEV_URL;

  // Prefer the server-side key; fall back to a caller-supplied key so the
  // endpoint still works before JEV_API_KEY has been added.
  const forwarded = request.headers.get('X-Jev-Api-Key') || '';
  const key = env.JEV_API_KEY || forwarded;
  if (!key) {
    return fail(
      'No Jev credential available. Add the JEV_API_KEY secret to the Worker, or send X-Jev-Api-Key.',
      503,
      'configuration_error'
    );
  }

  const raw = await request.text();
  try {
    const res = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Content-Type': request.headers.get('Content-Type') || 'application/json',
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      body: raw,
    });

    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'application/json',
        ...CORS,
      },
    });
  } catch (err) {
    return fail(
      `Jev upstream unreachable (${upstream}): ${err instanceof Error ? err.message : String(err)}`,
      502,
      'api_error'
    );
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (path === '/' || path === '/health') {
      return json({
        status: 'ok',
        service: 'cloudflare-image-worker',
        time: new Date().toISOString(),
        default_model: env.DEFAULT_MODEL || DEFAULT_MODEL,
        endpoints: ['/health', '/v1/models', '/v1/images/generations', '/v1/decisions'],
        config: {
          workers_ai_credentials: Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN),
          jev_key_server_side: Boolean(env.JEV_API_KEY),
          jev_upstream: env.JEV_API_URL || DEFAULT_JEV_URL,
          auth_required: Boolean((env.API_KEYS || '').trim()),
          r2_bucket: false,
        },
      });
    }

    if (path === '/v1/models' && request.method === 'GET') {
      if (!authorized(request, env)) return fail('Invalid or missing API key', 401, 'authentication_error');
      return json({
        object: 'list',
        data: FLUX2_MODELS.map((id) => ({
          id,
          object: 'model',
          owned_by: 'black-forest-labs',
          created: 0,
        })),
      });
    }

    if (path === '/v1/images/generations') {
      if (request.method !== 'POST') return fail('Method not allowed', 405);
      if (!authorized(request, env)) return fail('Invalid or missing API key', 401, 'authentication_error');
      return imagesGenerations(request, env);
    }

    if (path === '/v1/decisions') {
      if (request.method !== 'POST') return fail('Method not allowed', 405);
      if (!authorized(request, env)) return fail('Invalid or missing API key', 401, 'authentication_error');
      return decisionsProxy(request, env);
    }

    return fail(`No route for ${request.method} ${path}`, 404, 'not_found');
  },
};
