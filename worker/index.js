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
const VERSION = '2.4.0';

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

// Model-file download path shape: <org>/<repo>/resolve/<main|sha>/<file...>.
// The file segment may include subdirectories (e.g. onnx/tokenizer.json) but
// never ".." or "//", so the proxy stays a fixed-target pass-through.
const RAW_MODEL_PATH_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/resolve\/(main|[0-9a-f]{40})\/([A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*)$/;

// Workers cap response bodies at 100MB, and a ~0.5B ONNX model ships weight
// blobs (model.onnx / model.onnx_data / *quantized / *.safetensors) far larger
// than that. The LFS/CDN hosts those blobs are served from send
// `access-control-allow-origin: *`, so the browser can fetch them directly.
// Every other file a Transformers.js model needs (config.json, tokenizer.json,
// tokenizer_config.json, spiece.model, vocab.json, merges.txt, preprocessor
// configs, …) is small, so this worker streams those through CORS-open with a
// stable same-origin cache key. The split is decided by file name because the
// upstream content-type/content-length is not trustworthy (Hugging Face serves
// even JSON as application/octet-stream over its xet/CDN path, sometimes without
// a content-length).
const RAW_MAX_STREAM_BYTES = 8 * 1024 * 1024;
const RAW_LARGE_FILE_RE = /\.(?:safetensors|onnx|onnx_data|bin|pt|pth|msgpack|gguf|ggml|h5|tflite|npy)\b/i;

// ── Cloudflare AI (Workers AI) — Phase A ────────────────────────────────────
// The SPA talks to the Workers AI binding through these keyless endpoints; the
// browser never holds an API key. Only the pinned model surface below is
// exposed — this is not a token/URL relay.
const CORS_HEAD = { 'access-control-allow-origin': '*' };
const CF_DIALOG_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const CF_EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const CF_EMBED_MAX_CHARS = 4096;
const CF_ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);

function hasAiBinding(env) {
  return !!env && typeof env.AI === 'object' && env.AI !== null;
}

function ndjson(lines, status = 200, extra = {}) {
  return new Response(lines.join('\n'), {
    status,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

// Coerce a request-body messages array into the strict { role, content } shape
// Workers AI expects, dropping empty entries. Returns null when nothing usable.
function sanitizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const clean = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = CF_ALLOWED_ROLES.has(m.role) ? m.role : 'user';
    const content = typeof m.content === 'string' ? m.content : '';
    clean.push({ role, content });
  }
  return clean.length ? clean : null;
}

// Workers AI may attach tool_calls either at the top level or under `message`.
function pickToolCalls(out) {
  if (!out || typeof out !== 'object') return null;
  if (Array.isArray(out.tool_calls) && out.tool_calls.length) return out.tool_calls;
  if (out.message && Array.isArray(out.message.tool_calls) && out.message.tool_calls.length) {
    return out.message.tool_calls;
  }
  return null;
}

function normalizeToolCall(tc) {
  if (!tc || typeof tc !== 'object') return null;
  const fn = (tc.function && typeof tc.function === 'object') ? tc.function : {};
  return {
    id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: {
      name: fn.name || '',
      arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
    },
  };
}

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
        note: 'Edge host: static assets + Hugging Face model proxy + optional Cloudflare AI (Workers AI) inference.',
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

    // Server-side model-file proxy for the Transformers.js runtime. The on-device
    // engine downloads config/tokenizer/weights directly from
    // huggingface.co/[model]/resolve/[revision]/[file]; Hugging Face answers with
    // redirects (resolve-cache, CDN), and a redirect target that 404s or lacks
    // CORS headers surfaces in the browser as confusing "Cross-Origin Request
    // Blocked … Status code: 404" errors. Routing the same-origin Worker lets us
    // (a) follow the redirect chain server-side, (b) re-serve small files CORS-open
    // with a stable cache key, and (c) answer a readable JSON error on failure.
    // Large weight blobs are 302-redirected back to the direct URL (see
    // RAW_MAX_STREAM_BYTES); they are served by LFS/CDN hosts that already send
    // `access-control-allow-origin: *`, so the browser can fetch them directly.
    if (request.method === 'GET' && pathname === '/api/hub/raw') {
      const modelPath = (url.searchParams.get('path') || '').trim();
      const trace = () => ({ 'access-control-allow-origin': '*' });
      if (!RAW_MODEL_PATH_RE.test(modelPath) || modelPath.split('/').some((s) => s === '.' || s === '..')) {
        return json({ ok: false, error: 'Invalid "path" parameter' }, 400, trace());
      }
      const upstream = `https://huggingface.co/${modelPath}`;
      try {
        const res = await fetch(upstream);
        if (!res.ok) {
          return json({ ok: false, error: `Model file not found (HTTP ${res.status})`, path: modelPath }, 502, trace());
        }
        const cl = Number(res.headers.get('content-length') || 0);
        if (RAW_LARGE_FILE_RE.test(modelPath) || cl >= RAW_MAX_STREAM_BYTES) {
          return Response.redirect(upstream, 302);
        }
        const headers = {
          'content-type': res.headers.get('content-type') || 'application/octet-stream',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=300',
        };
        if (cl > 0) headers['content-length'] = String(cl);
        return new Response(res.body, { status: 200, headers });
      } catch (err) {
        return json({ ok: false, error: (err && err.message) ? err.message : 'Upstream unavailable' }, 502, trace());
      }
    }

    // ── Cloudflare AI backend — Phase A ─────────────────────────────────────
    // Chat (streamed NDJSON or, for tool calling, a single NDJSON response)
    // and text embeddings, both over the Workers AI binding.
    if (request.method === 'OPTIONS' && pathname.startsWith('/api/ai/')) {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'Content-Type',
        },
      });
    }

    if (request.method === 'GET' && pathname === '/api/ai/health') {
      const avail = hasAiBinding(env);
      return json({
        ok: avail,
        detail: avail
          ? `Workers AI ready (${CF_DIALOG_MODEL}, ${CF_EMBED_MODEL})`
          : 'Workers AI binding (env.AI) is not configured on this Worker',
        model: CF_DIALOG_MODEL,
        embedModel: CF_EMBED_MODEL,
      }, 200, CORS_HEAD);
    }

    if (request.method === 'POST' && pathname === '/api/ai/chat') {
      if (!hasAiBinding(env)) {
        return json({ ok: false, error: 'Workers AI binding is not configured on this Worker' }, 503, CORS_HEAD);
      }
      let payload = null;
      try { payload = await request.json(); } catch (_) {}
      const messages = sanitizeMessages(payload && payload.messages);
      if (!messages) {
        return json({ ok: false, error: 'Request body must include a non-empty "messages" array of { role, content }' }, 400, CORS_HEAD);
      }
      const model = (payload && typeof payload.model === 'string' && payload.model.trim()) ? payload.model.trim() : CF_DIALOG_MODEL;
      const maxTokens = (payload && Number.isInteger(payload.maxTokens) && payload.maxTokens > 0) ? Math.min(payload.maxTokens, 2048) : 512;
      const tools = Array.isArray(payload && payload.tools) && payload.tools.length ? payload.tools : null;
      try {
        // Tool calling runs non-streaming: the model returns its answer (or its
        // tool calls) in a single result, so we emit the matching NDJSON lines.
        if (tools) {
          const out = await env.AI.run(model, { messages, max_tokens: maxTokens, tools });
          const lines = [];
          const text = typeof out === 'string' ? out : (out && typeof out.response === 'string' ? out.response : '');
          if (text) lines.push(JSON.stringify({ text: String(text).trim() }));
          const tcs = pickToolCalls(out);
          if (tcs) for (const tc of tcs) {
            const norm = normalizeToolCall(tc);
            if (norm) lines.push(JSON.stringify({ toolCall: norm }));
          }
          if (!lines.length) lines.push(JSON.stringify({ text: '' }));
          return ndjson(lines, 200, CORS_HEAD);
        }

        const stream = await env.AI.run(model, { messages, max_tokens: maxTokens }, { stream: true });
        const encoder = new TextEncoder();
        const { readable, writable } = new TransformStream();
        (async () => {
          const writer = writable.getWriter();
          try {
            for await (const chunk of stream) {
              const part = (chunk && typeof chunk.response === 'string') ? chunk.response : '';
              if (part) await writer.write(encoder.encode(JSON.stringify({ text: part }) + '\n'));
            }
          } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            await writer.write(encoder.encode(JSON.stringify({ error: msg }) + '\n')).catch(() => {});
          } finally {
            await writer.close().catch(() => {});
          }
        })();
        return new Response(readable, {
          status: 200,
          headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-store',
            ...CORS_HEAD,
          },
        });
      } catch (err) {
        return json({ ok: false, error: `Workers AI request failed: ${err && err.message ? err.message : err}` }, 502, CORS_HEAD);
      }
    }

    if (request.method === 'POST' && pathname === '/api/ai/embed') {
      if (!hasAiBinding(env)) {
        return json({ ok: false, error: 'Workers AI binding is not configured on this Worker' }, 503, CORS_HEAD);
      }
      let payload = null;
      try { payload = await request.json(); } catch (_) {}
      const text = (payload && typeof payload.text === 'string') ? payload.text.trim() : '';
      if (!text) return json({ ok: false, error: 'Request body must include a non-empty string "text"' }, 400, CORS_HEAD);
      try {
        const model = (payload && typeof payload.model === 'string' && payload.model.trim()) ? payload.model.trim() : CF_EMBED_MODEL;
        const out = await env.AI.run(model, { text: text.slice(0, CF_EMBED_MAX_CHARS) });
        const data = Array.isArray(out && out.data) ? out.data : null;
        const flat = (data && data.length && Array.isArray(data[0])) ? data[0] : data;
        if (!Array.isArray(flat) || flat.length === 0) {
          return json({ ok: false, error: 'Unexpected embedding response shape' }, 502, CORS_HEAD);
        }
        return json({ ok: true, model, dim: flat.length, embedding: flat }, 200, CORS_HEAD);
      } catch (err) {
        return json({ ok: false, error: `Workers AI embedding failed: ${err && err.message ? err.message : err}` }, 502, CORS_HEAD);
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