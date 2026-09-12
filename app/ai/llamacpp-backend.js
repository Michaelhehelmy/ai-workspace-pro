/**
 * app/ai/llamacpp-backend.js - llama.cpp server backend
 *
 * Connects to a locally running `llama-server` (llama.cpp) over its
 * OpenAI-compatible HTTP API. This is the preferred local provider for
 * long-context dialogue: start it with `llama-server --jinja -ngl 999`
 * (router mode, 3 worker instances).
 *
 * Default endpoint: http://localhost:8080/v1
 * Capabilities: chat completions, embeddings. No native tool calling.
 */

import { state } from '../../core/state.js';
import { ModelError, createBackend, registerBackend } from './backend.js';

function getConfig() {
  const backends = (state.config && state.config.app && state.config.app.ai && state.config.app.ai.backends) || {};
  return backends.llamacpp || {};
}

function baseUrl() {
  return String(getConfig().url || 'http://localhost:8080/v1').replace(/\/+$/, '');
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`);
  }
  return res.json();
}

async function health() {
  if (!getConfig().enabled) {
    return { ok: false, detail: 'llama.cpp backend is disabled in config (app.ai.backends.llamacpp.enabled)' };
  }
  try {
    const base = baseUrl();
    const healthUrl = base.replace(/\/v1$/, '') + '/health';
    const data = await fetchJSON(healthUrl, { method: 'GET' });
    return { ok: true, detail: data.status || 'llama.cpp ready' };
  } catch (err) {
    return { ok: false, detail: err.message || 'llama.cpp unreachable' };
  }
}

async function embed(text, modelOverride) {
  if (!text) return null;
  try {
    const base = baseUrl();
    const data = await fetchJSON(`${base}/embeddings`, {
      method: 'POST',
      body: JSON.stringify({ input: String(text) })
    });
    const vec = data && data.data && data.data[0] && data.data[0].embedding;
    if (!vec) return null;
    return Float32Array.from(vec);
  } catch (_) {
    return null;
  }
}

async function* generate(req = {}) {
  const system = typeof req.system === 'string' ? req.system : '';
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const payload = { messages: [], max_tokens: req.maxTokens || 150 };
  if (system) payload.messages.push({ role: 'system', content: system });
  for (const m of messages) {
    payload.messages.push({ role: (m && m.role) || 'user', content: (m && m.content) || '' });
  }
  if (!payload.messages.length) return;

  // Pass tool schemas when provided (llama-server with --jinja supports function calling)
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    payload.tools = req.tools.map(t => ({
      type: 'function',
      function: {
        name: t.function?.name || t.name,
        description: t.function?.description || t.description || '',
        parameters: t.function?.parameters || t.parameters || {}
      }
    }));
  }

  try {
    const base = baseUrl();
    const data = await fetchJSON(`${base}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const choice = data && data.choices && data.choices[0];
    const msg = choice && choice.message;
    const text = (msg && msg.content) || '';
    if (text) yield { text: String(text).trim() };

    // Yield tool calls if present (OpenAI-compatible format)
    if (msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        yield {
          toolCall: {
            id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: {
              name: tc.function?.name || '',
              arguments: typeof tc.function?.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments || {})
            }
          }
        };
      }
    }
  } catch (err) {
    throw new ModelError(
      'E_INFER', 'dialog',
      `llama.cpp request failed: ${err.message}`,
      'Ensure llama-server is running and reachable at the configured URL.'
    );
  }
}

export const llamacppBackend = registerBackend(createBackend({
  id: 'llamacpp',
  label: 'llama.cpp server',
  kind: 'llamacpp',
  canTools: false,
  health,
  embed,
  generate
}));

export default llamacppBackend;