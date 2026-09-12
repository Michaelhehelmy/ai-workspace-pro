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
const VERSION = '2.1.1';

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
      try {
        const res = await fetch(upstream);
        if (!res.ok) {
          return json({ ok: false, error: `Upstream search failed with ${res.status}` }, 502);
        }
        const raw = await res.text();
        const body = raw.trim() ? raw : '{}';
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=300',
            'access-control-allow-origin': '*',
          },
        });
      } catch (err) {
        return json({ ok: false, error: (err && err.message) ? err.message : 'Upstream search unavailable' }, 502);
      }
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