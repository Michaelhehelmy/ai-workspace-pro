/**
 * app/ai/cfai-backend.js - Cloudflare AI (Workers AI) backend
 *
 * Routes chat completions + embeddings to Workers AI through the hosting
 * Worker's keyless /api/ai/* endpoints (see worker/index.js, Phase A). This is
 * the recommended cloud provider: it needs no local server, exposes no API key
 * to the browser, and supports native tool calling (canTools) — which the agent
 * loop (Phase C) builds on. Token deltas arrive as NDJSON lines; some models
 * deliver the whole reply as a single line — both render the same way.
 *
 * The backend degrades gracefully when the app is NOT hosted on the Worker
 * (e.g. bare static hosting): every call fails closed inside this module, so
 * the pipeline falls back to on-device Transformers.js exactly as before.
 */

import { state } from '../../core/state.js';
import { ModelError, createBackend, registerBackend } from './backend.js';
import { markBackendFailed } from './routing.js';

const CF_DIALOG_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
const CF_EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';

function getConfig() {
  const backends = (state.config && state.config.app && state.config.app.ai && state.config.app.ai.backends) || {};
  return backends.cfai || {};
}

function apiUrl(path) {
  return `/api/ai/${path}`;
}

// Split signed-newline-delimited JSON lines from a Workers fetch response body.
// `onLine` receives each parsed message; streamed text deltas arrive as soon as
// the Worker emits them (true token streaming on screen).
async function streamNDJSON(res, onLine) {
  if (!res || !res.body) {
    const text = await res.text().catch(() => '');
    for (const raw of String(text).split('\n')) onLine(raw.trim());
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      onLine(buffer.slice(0, nl).trim());
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.trim()) onLine(buffer.trim());
}

async function health() {
  if (!getConfig().enabled) {
    return { ok: false, detail: 'Cloudflare AI backend is disabled in config (app.ai.backends.cfai.enabled)' };
  }
  try {
    const res = await fetch(apiUrl('health'));
    if (!res.ok) return { ok: false, detail: `No /api/ai/health endpoint (HTTP ${res.status})` };
    const data = await res.json().catch(() => null);
    if (!data) return { ok: false, detail: 'Malformed /api/ai/health response' };
    return { ok: !!data.ok, detail: data.detail || (data.ok ? 'Cloudflare AI ready' : 'Cloudflare AI unavailable') };
  } catch (err) {
    return { ok: false, detail: 'No /api/ai/health endpoint (app not hosted on the Worker)' };
  }
}

async function embed(text, modelOverride) {
  if (!text) return null;
  try {
    const res = await fetch(apiUrl('embed'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text), model: modelOverride || getConfig().embedModel || CF_EMBED_MODEL })
    });
    const data = await res.json().catch(() => null);
    const embedding = data && data.embedding;
    if (!Array.isArray(embedding) || !embedding.length) { markBackendFailed('cfai', 'malformed embed response'); return null; }
    return Float32Array.from(embedding);
  } catch (_) {
    markBackendFailed('cfai', 'embed request failed');
    return null;
  }
}

async function* generate(req = {}) {
  const system = typeof req.system === 'string' ? req.system : '';
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const payload = { messages: [], max_tokens: req.maxTokens || 512 };
  if (system) payload.messages.push({ role: 'system', content: system });
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = (m.role === 'system' || m.role === 'assistant' || m.role === 'user' || m.role === 'tool') ? m.role : 'user';
    const entry = { role, content: typeof m.content === 'string' ? m.content : '' };
    // Multi-turn tool use: tool results keep their name/tool_call_id and the
    // assistant message keeps the tool_calls array it is responding to.
    if (role === 'tool') {
      if (typeof m.name === 'string' && m.name) entry.name = m.name;
      if (typeof m.tool_call_id === 'string' && m.tool_call_id) entry.tool_call_id = m.tool_call_id;
    }
    if (role === 'assistant' && Array.isArray(m.tool_calls)) entry.tool_calls = m.tool_calls;
    payload.messages.push(entry);
  }
  if (!payload.messages.length) return;

  // Tool schemas — the Worker responds non-streaming to these so it can detect
  // a { toolCall } result; we yield it exactly like the other backends do.
  if (Array.isArray(req.tools) && req.tools.length) {
    payload.tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: (t.function && t.function.name) || t.name || '',
        description: (t.function && t.function.description) || t.description || '',
        parameters: (t.function && t.function.parameters) || t.parameters || {}
      }
    }));
  }
  if (getConfig().model && typeof req.model !== 'string') {
    payload.model = getConfig().model;
  } else if (typeof req.model === 'string') {
    payload.model = req.model;
  }

  let res;
  try {
    res = await fetch(apiUrl('chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    markBackendFailed('cfai', `transport failed: ${err.message}`);
    throw new ModelError(
      'E_INFER', 'dialog',
      `Cloudflare AI unreachable: ${err.message}`,
      'Host the app on the Worker (worker/index.js) so /api/ai/chat exists.'
    );
  }

  const handleLine = (line) => {
    if (!line) return;
    let msg = null;
    try { msg = JSON.parse(line); } catch (_) { return; }
    if (msg.error) throw new ModelError('E_INFER', 'dialog', String(msg.error), 'Check the Worker /api/ai/chat logs.');
    if (typeof msg.text === 'string' && msg.text) chunks.push(msg.text);
    if (msg.toolCall) toolCalls.push(msg.toolCall);
  };
  const chunks = [];
  const toolCalls = [];

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const d = await res.json(); if (d && d.error) detail = d.error; } catch (_) {}
    markBackendFailed('cfai', detail);
    throw new ModelError('E_INFER', 'dialog', `Cloudflare AI request failed: ${detail}`, 'Check the Worker /api/ai/chat logs.');
  }

  try {
    await streamNDJSON(res, handleLine);
  } catch (err) {
    if (err instanceof ModelError) throw err;
    throw new ModelError('E_INFER', 'dialog', `Cloudflare AI stream failed: ${err.message}`);
  }

  for (const t of chunks) yield { text: t };
  for (const tc of toolCalls) yield { toolCall: tc };
}

export const cfaiBackend = registerBackend(createBackend({
  id: 'cfai',
  label: 'Cloudflare AI',
  kind: 'cloudflare-ai',
  canTools: true,
  health,
  embed,
  generate
}));

export default cfaiBackend;