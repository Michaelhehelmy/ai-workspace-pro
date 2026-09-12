/**
 * app/ai/ollama-backend.js - Ollama backend
 *
 * Connects to a locally running Ollama instance over its native HTTP API.
 * Ollama natively supports both text generation and embeddings, making it the
 * preferred local provider for embeddings when available.
 *
 * Default endpoint: http://localhost:11434
 * Capabilities: chat completions, embeddings, tool calling (Ollama >= 0.4).
 */

import { state } from '../../core/state.js';
import { ModelError, createBackend, registerBackend } from './backend.js';

function getConfig() {
  const backends = (state.config && state.config.app && state.config.app.ai && state.config.app.ai.backends) || {};
  return backends.ollama || {};
}

function baseUrl() {
  return String(getConfig().url || 'http://localhost:11434').replace(/\/+$/, '');
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
    return { ok: false, detail: 'Ollama backend is disabled in config (app.ai.backends.ollama.enabled)' };
  }
  try {
    const base = baseUrl();
    const data = await fetchJSON(`${base}/api/tags`, { method: 'GET' });
    const models = (data && data.models) || [];
    return { ok: true, detail: `Ollama ready — ${models.length} model(s) available` };
  } catch (err) {
    return { ok: false, detail: err.message || 'Ollama unreachable' };
  }
}

async function embed(text, modelOverride) {
  if (!text) return null;
  try {
    const base = baseUrl();
    const data = await fetchJSON(`${base}/api/embeddings`, {
      method: 'POST',
      body: JSON.stringify({
        model: modelOverride || getConfig().model || 'llama3.2',
        prompt: String(text)
      })
    });
    const vec = data && data.embedding;
    if (!vec) return null;
    return Float32Array.from(vec);
  } catch (_) {
    return null;
  }
}

async function* generate(req = {}) {
  const system = typeof req.system === 'string' ? req.system : '';
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const payload = { model: req.model || getConfig().model || 'llama3.2', messages: [], stream: false };
  if (system) payload.messages.push({ role: 'system', content: system });
  for (const m of messages) {
    payload.messages.push({ role: (m && m.role) || 'user', content: (m && m.content) || '' });
  }
  if (!payload.messages.length) return;

  // Pass tool schemas when provided (Ollama >= 0.4 supports function calling)
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
    const data = await fetchJSON(`${base}/api/chat`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const msg = data && data.message;
    const text = (msg && msg.content) || '';
    if (text) yield { text: String(text).trim() };

    // Yield tool calls if present
    if (msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const args = tc.function?.arguments || tc.arguments || {};
        yield {
          toolCall: {
            id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: {
              name: tc.function?.name || tc.name || '',
              arguments: typeof args === 'string' ? args : JSON.stringify(args)
            }
          }
        };
      }
    }
  } catch (err) {
    throw new ModelError(
      'E_INFER', 'dialog',
      `Ollama request failed: ${err.message}`,
      'Ensure Ollama is running and the requested model is pulled (ollama pull <model>).'
    );
  }
}

export const ollamaBackend = registerBackend(createBackend({
  id: 'ollama',
  label: 'Ollama',
  kind: 'ollama',
  canTools: true,
  health,
  embed,
  generate
}));

export default ollamaBackend;