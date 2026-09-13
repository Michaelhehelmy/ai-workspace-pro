/**
 * worker/index.js - Cloudflare Workers entry point
 *
 * The entire AI Workspace Pro app is static: every pipeline stage runs
 * on-device (Transformers.js in the user's browser, or their own
 * Ollama / llama.cpp endpoints). This Worker is a thin edge host that:
 *
 *   1. serves a tiny health/API surface (`/api/health`),
 *   2. delegates everything else to the static assets binding (env.ASSETS).
 *
 * Keep this file dependency-free: it must never import code from /app or
 * /core, so the Worker bundle stays tiny and total-isolate friendly.
 */

const SERVICE = 'ai-workspace-pro';
const VERSION = '2.2.0';

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

// "org/repo" shape used by every Hugging Face model id the catalog touches.
const REPO_PATH_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Server-side response pass-through. The browser cannot always read upstream
// JSON directly (DuckDuckGo and Hugging Face do not send Access-Control-Allow-
// Origin on every response, error pages in particular), so this worker proxies
// a small fixed set of upstreams and re-serves them CORS-open to the SPA.
async function proxyUpstream(upstream, cacheSeconds = 0) {
  try {
    const res = await fetch(upstream);
    if (!res.ok) {
      return json({ ok: false, error: `Upstream failed with ${res.status}` }, 502);
    }
    const raw = await res.text();
    return new Response(raw.trim() ? raw : '{}', {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
        'access-control-allow-origin': '*',
      },
    });
  } catch (err) {
    return json({ ok: false, error: (err && err.message) ? err.message : 'Upstream unavailable' }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'GET' && (pathname === '/api/health' || pathname === '/api/version')) {
      return json({
        ok: true,
        service: SERVICE,
        version: VERSION,
        env: 'workers',
        ts: new Date().toISOString(),
        note: 'Static asset host only — all AI models run on the user device.',
      });
    }

    // Server-side search proxy. The DuckDuckGo Instant Answer API sends no
    // CORS headers, so a direct browser fetch is blocked by the same-origin
    // policy. Proxying here keeps the on-device app working when hosted on
    // this Worker; the browser tool falls back to a graceful inline result
    // when this endpoint is absent (e.g. bare static hosting).
    if (request.method === 'GET' && pathname === '/api/web/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ ok: false, error: 'Missing "q" query parameter' }, 400);
      const upstream = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=0`;
      return proxyUpstream(upstream, 300);
    }

    // Server-side Hugging Face Hub proxy for the model catalog bootstrap. The
    // Hub API echoes `Access-Control-Allow-Origin` only for accepted origins,
    // and its error pages carry no CORS headers at all, so a direct browser
    // fetch can be blocked by the same-origin policy. Proxying the two calls
    // the catalog makes (the transformers.js model listing and per-model info)
    // keeps the on-device catalog working from the Worker origin. This is not
    // an open proxy: the upstream host is fixed and the model path is
    // validated to the "org/repo" shape.
    if (request.method === 'GET' && pathname === '/api/hub/models') {
      const params = new URLSearchParams();
      for (const key of url.searchParams.keys()) params.set(key, url.searchParams.get(key));
      return proxyUpstream(`https://huggingface.co/api/models?${params}`, 300);
    }
    if (request.method === 'GET' && pathname === '/api/hub/info') {
      const modelPath = (url.searchParams.get('path') || '').trim();
      if (!REPO_PATH_RE.test(modelPath)) {
        return json({ ok: false, error: 'Invalid "path" parameter' }, 400);
      }
      // Forward only the two query shapes the app uses — blobs=true (catalog
      // sizing) and expand[]=siblings (reachability probe) — so the proxy stays
      // a fixed-target pass-through, never an open relay.
      const forward = new URLSearchParams();
      if (url.searchParams.get('blobs') !== null) forward.set('blobs', 'true');
      for (const expand of url.searchParams.getAll('expand[]')) {
        if (/^[A-Za-z0-9_-]+$/.test(expand)) forward.append('expand[]', expand);
      }
      const query = forward.toString();
      return proxyUpstream(`https://huggingface.co/api/models/${modelPath}${query ? '?' + query : ''}`, 300);
    }

    if (pathname.startsWith('/api/')) {
      return json({ ok: false, error: 'Not found', path: pathname }, 404);
    }

    // Assets binding serves the SPA (wrangler `assets` config). With
    // `run_worker_first: true` we land here for page requests too.
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return json({ ok: false, error: 'ASSETS binding unavailable' }, 500);
  },
};