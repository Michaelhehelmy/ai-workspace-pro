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