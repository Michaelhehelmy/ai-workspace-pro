/**
 * app/ai/routing.js - Per-stage backend router
 *
 * Reads the per-stage backend selection from config (`app.ai.routing`) and
 * resolves it against the registered backends. When a stage is set to "auto"
 * (the default), it probes each enabled backend in priority order (Cloudflare
 * AI first when enabled — it needs no local server and supports embeddings and
 * tool calling natively — then Ollama, then llama.cpp), falling back to the
 * on-device Transformers.js provider if none are reachable.
 *
 * Health probes are cached for 30 seconds to avoid a network round-trip on
 * every request while still detecting servers that appear/disappear at runtime.
 */

import { state } from '../../core/state.js';
import { getBackend, listBackends } from './backend.js';

const HEALTH_TTL_MS = 30_000;
const healthCache = new Map();  // id → { ok, detail, ts }

// ── Routing config helpers ───────────────────────────────────────────────────

function routingConfig() {
  return (state.config && state.config.app && state.config.app.ai && state.config.app.ai.routing) || {};
}

function backendsConfig() {
  return (state.config && state.config.app && state.config.app.ai && state.config.app.ai.backends) || {};
}

// ── Health probe with TTL cache ──────────────────────────────────────────────

async function probeHealth(backend) {
  const now = Date.now();
  const cached = healthCache.get(backend.id);
  if (cached && (now - cached.ts) < HEALTH_TTL_MS) return cached;

  let result;
  try {
    result = await backend.health();
  } catch (err) {
    result = { ok: false, detail: err.message || 'health probe failed' };
  }
  const entry = { ...result, ts: now };
  healthCache.set(backend.id, entry);
  return entry;
}

export function resetHealthCache() {
  healthCache.clear();
}

// Record a runtime failure for a backend so auto-routing skips it for the TTL
// window without re-probing. Backends that fail *at call time* (e.g. no
// /api/ai/* endpoints on bare static hosting) report their own failure so the
// very next request falls through to the next backend instead of repeating it.
export function markBackendFailed(id, detail = 'runtime failure') {
  healthCache.set(id, { ok: false, detail, ts: Date.now() });
}

// ── Per-stage resolution ─────────────────────────────────────────────────────

/**
 * Probe health for all enabled backends and return an array of
 * `{ id, label, kind, ok, detail }` for the Models tab.
 */
export async function probeAllBackends() {
  const out = [];
  for (const b of listBackends()) {
    if (b.id === 'transformers') continue;  // always available, skip from picker
    const h = await probeHealth(b);
    out.push({ id: b.id, label: b.label, kind: b.kind, ok: h.ok, detail: h.detail || '' });
  }
  return out;
}

/**
 * Auto-routing priority. Cloudflare AI first — it needs no local server and
 * natively supports streaming, embeddings, and tool calling, so it is the best
 * default for a Worker-hosted app. Ollama second, llama.cpp third.
 * Transformers.js is always the final fallback (handled separately).
 */
const AUTO_PRIORITY = ['cfai', 'ollama', 'llamacpp'];

/**
 * Resolve the best backend for a given pipeline stage.
 *
 *   stageKey: 'dialog' | 'embedder' | 'intent' | 'tagger'
 *
 * Returns the resolved backend object (always has an `id`). The caller
 * distinguishes the Transformers.js fallback by checking `backend.id !== 'transformers'`.
 *
 * `intent` and `tagger` are not routed — they always resolve to the
 * Transformers.js provider because zero-shot classification and NER require
 * HF-specific pipelines that llama.cpp and Ollama cannot replicate.
 */
export function resolveBackendForStage(stageKey) {
  const routing = routingConfig();
  const configured = routing[stageKey] || 'auto';

  if (configured === 'transformers') {
    return getBackend('transformers');
  }

  if (configured !== 'auto') {
    const backend = getBackend(configured);
    return backend || getBackend('transformers');
  }

  // Auto: probe each enabled backend in priority order
  const backendsCfg = backendsConfig();
  for (const id of AUTO_PRIORITY) {
    const cfg = backendsCfg[id];
    if (!cfg || !cfg.enabled) continue;
    const backend = getBackend(id);
    if (!backend) continue;
    // For the embedder stage, only route to backends that have an embed function
    if (stageKey === 'embedder' && !backend.embed) continue;
    // Synchronous check of cached health (avoids blocking on network in the hot path)
    const cached = healthCache.get(id);
    if (cached && !cached.ok) continue;   // recently failed → skip
    if (!cached) {
      // No probe yet — tentatively route to the first enabled backend.
      // A failed health() will be caught at call time and fall through.
      return backend;
    }
    return backend;
  }

  return getBackend('transformers');
}

/**
 * Update the routing config at runtime (called by the Models tab pickers).
 */
export async function setStageBackend(stageKey, backendId) {
  if (!state.config) return;
  if (!state.config.app) state.config.app = {};
  if (!state.config.app.ai) state.config.app.ai = {};
  if (!state.config.app.ai.routing) state.config.app.ai.routing = {};
  state.config.app.ai.routing[stageKey] = backendId || 'auto';
}