/**
 * app/ai/backend.js - LLM Backend Interface & Registry
 *
 * A "backend" is a provider for the app's model needs. Every backend adopts a
 * small uniform contract so the rest of the app (Models tab, pipeline, agent
 * loop) can treat on-device Transformers.js, a local llama.cpp server, an
 * Ollama install, or a remote Pi agent as interchangeable providers.
 *
 * ── Backend contract ───────────────────────────────────────────────────────
 * {
 *   id: string,                                   // registry key
 *   label: string,                                // Models-tab label
 *   kind: string,                                 // 'transformers' | 'openai-compatible' | 'ollama' | ...
 *   canTools: boolean,                            // native tool-calling supported?
 *   health(): Promise<{ ok, detail? }>,           // configured & reachable?
 *   embed?(text, modelOverride?): Promise<Float32Array|null>,   // optional
 *   generate(req): AsyncGenerator<{ text } | { toolCall }>,     // mandatory
 *     // req = { system?, messages: [{ role, content }], tools?, maxTokens? }
 *     //   streams text deltas ({ text }) and may finish with { toolCall }
 * }
 *
 * Providers self-register at import time via `registerBackend(createBackend())`.
 * The shared `PIPELINE_STAGES` registry describes which capabilities the app
 * requires from its model providers (embedder, classifier, ner, generator).
 */

// ── Typed errors (shared across every provider) ──────────────────────────────
export class ModelError extends Error {
  constructor(code, stage, message, fix, model, cause) {
    super(message);
    this.name = 'ModelError';
    this.code = code;      // E_DISABLED | E_LOAD_PACKAGE | E_LOAD_MODEL | E_INFER | E_UNKNOWN_STAGE | E_NO_CONFIG | E_INTERNAL
    this.stage = stage;    // 'encoder' | 'intent' | 'tagger' | 'dialog' | null
    this.model = model || null;
    this.fix = fix || null;
    if (cause !== undefined) this.cause = cause;
  }
}

export function formatModelError(err) {
  const e = err instanceof ModelError
    ? err
    : (err && typeof err === 'object' && err.code && err.message)
      ? new ModelError(err.code, err.stage || null, String(err.message), err.fix || null, err.model || null)
      : new ModelError('E_INTERNAL', null, err && err.message ? String(err.message) : String(err), null);
  let out = `⚠️ ${e.message}`;
  if (e.stage) out += ` (stage: ${e.stage})`;
  if (e.model) out += ` (model: ${e.model})`;
  if (e.code) out += ` [${e.code}]`;
  if (e.fix) out += ` — ${e.fix}`;
  return out;
}

// ── Capability stages the app expects from model providers ───────────────────
/**
 * Shared pipeline-stage registry. Stages carry no hardcoded model — which
 * model each stage uses is decided at runtime (device-fit recommendation over
 * the current catalog, or an explicit user pick). `resolveStage` maps any
 * key/role/task back to a stage.
 */
export const PIPELINE_STAGES = {
  encoder: { key: 'encoder', task: 'feature-extraction',       role: 'embedder'   },
  intent:  { key: 'intent',  task: 'zero-shot-classification', role: 'classifier' },
  tagger:  { key: 'tagger',  task: 'token-classification',     role: 'ner'        },
  dialog:  { key: 'dialog',  task: 'text2text-generation',     role: 'generator'  }
};

export const ROLE_TO_STAGE = { embedder: 'encoder', classifier: 'intent', ner: 'tagger', generator: 'dialog' };
export const TASK_TO_STAGE = {
  'feature-extraction': 'encoder',
  'zero-shot-classification': 'intent',
  'token-classification': 'tagger',
  'text2text-generation': 'dialog'
};

export function resolveStage(keyOrRoleOrTask) {
  const k = ROLE_TO_STAGE[keyOrRoleOrTask] || TASK_TO_STAGE[keyOrRoleOrTask] || keyOrRoleOrTask;
  return PIPELINE_STAGES[k] || null;
}

// ── Registry ─────────────────────────────────────────────────────────────────
const backends = new Map();

export function createBackend(def) {
  if (!def || typeof def.id !== 'string' || !def.id.trim()) {
    throw new Error('Backend requires a non-empty string id');
  }
  if (typeof def.generate !== 'function') {
    throw new Error(`Backend "${def.id}" must implement generate(req)`);
  }
  return Object.freeze({
    id: def.id,
    label: def.label || def.id,
    kind: def.kind || 'generic',
    canTools: !!def.canTools,
    health: def.health || (async () => ({ ok: true })),
    embed: typeof def.embed === 'function' ? def.embed : null,
    generate: def.generate
  });
}

export function registerBackend(backend) {
  backends.set(backend.id, backend);
  return backend;
}

export function getBackend(id) {
  return backends.get(id) || null;
}

export function listBackends() {
  return [...backends.values()];
}