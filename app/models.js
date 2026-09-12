/**
 * app/models.js - Model coordinator (public model API)
 *
 * This is the app's front-door for everything model-related, and it is now a
 * thin coordinator over pluggable LLM backends:
 *
 *   • app/ai/backend.js — the backend interface, registry, shared contracts
 *     (ModelError, PIPELINE_STAGES, resolveStage).
 *   • app/ai/transformers-backend.js — the on-device Transformers.js provider
 *     (scheduler, swap policy, preloads).
 *   • app/ai/llamacpp-backend.js / app/ai/ollama-backend.js — local-API
 *     providers (added in Phase 1, routed per stage via app.ai.backends).
 *
 * models.js keeps every public function the rest of the app already imports
 * (see app.js / test.js / pipeline.js) so the migration is behavior-preserving:
 * it re-exports the Transformers scheduler, and keeps the catalog helpers,
 * the direct-import model loader, and the best-effort embedding helpers here.
 */

import { isBrowser } from '../core/env.js';
import { state, getActiveBusiness } from '../core/state.js';
import { populateModelSelects, renderConfigEditor } from './ui.js';
import {
  ModelError,
  formatModelError,
  PIPELINE_STAGES,
  ROLE_TO_STAGE,
  TASK_TO_STAGE,
  resolveStage
} from './ai/backend.js';
import {
  setTransformersHooks,
  getTransformers,
  getStatus,
  getModelIdForStage,
  loadStage,
  unloadStage,
  unloadAll,
  isStageLoaded,
  inferStage,
  preloadModels,
  forcePreload
} from './ai/transformers-backend.js';
import { resolveBackendForStage } from './ai/routing.js';
import { detectDevice, recommendModelSet } from '../core/device.js';

/**
 * Resolve the argument to a DeviceProfile. Accepts an injected probe bag
 * (an object whose formFactor key is a function) or an existing profile
 * (object carrying a string tier); otherwise detects from browser probes.
 */
function resolveDeviceProfile(input) {
  if (input && typeof input === 'object' && typeof input.formFactor === 'function') return detectDevice(input);
  if (input && typeof input === 'object' && typeof input.tier === 'string') return input;
  return detectDevice();
}

// ── Re-exported scheduler / contracts (unchanged public surface) ─────────────
export { ModelError, formatModelError, PIPELINE_STAGES, resolveStage };
export { setTransformersHooks, getTransformers, loadStage, unloadStage, unloadAll, isStageLoaded, inferStage, preloadModels, forcePreload };

/**
 * Pipeline status snapshot — same shape as before the backend split so
 * callers (ui.js, test.js) keep reading status/currentStage/currentModel/
 * model/disabled.
 */
export function getPipelineStatus() {
  return getStatus();
}

/**
 * Resolve the stage + model id for an arbitrary model id string (direct import
 * by model name). Checks configured availableModels, then configured stage
 * assignments, then id heuristics. Always falls back to null (never guesses a
 * fake placement).
 */
export function resolveModelName(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return null;
  const ms = state.config && state.config.modelSettings;

  const avail = (ms && Array.isArray(ms.availableModels) ? ms.availableModels : [])
    .find(m => m && (m.id === id || m.name === id));
  if (avail && avail.type) {
    const mapped = ROLE_TO_STAGE[avail.type] || TASK_TO_STAGE[avail.type] || avail.type;
    const st = resolveStage(mapped);
    if (st) return { stage: st, modelId: avail.id || id };
  }

  for (const st of Object.values(PIPELINE_STAGES)) {
    if (getModelIdForStage(st) === id) return { stage: st, modelId: id };
  }

  const lower = id.toLowerCase();
  if (/mini.?lm|bge-|mpnet|e5-|sentence|gte-/.test(lower)) return { stage: PIPELINE_STAGES.encoder, modelId: id };
  if (/nli|mnli|mobilebert|bart-large-mnli|zero-shot/.test(lower)) return { stage: PIPELINE_STAGES.intent, modelId: id };
  if (/ner|token-class|bert-base/.test(lower)) return { stage: PIPELINE_STAGES.tagger, modelId: id };
  if (/t5|flan|gpt|llama|phi|gemma|mistral|bloom|qwen|bart-cnn/.test(lower)) return { stage: PIPELINE_STAGES.dialog, modelId: id };
  return null;
}

// ── Model catalog (UI + direct import) ────────────────────────────────────────
/**
 * The configured model catalog (modelSettings.availableModels), normalized to
 * non-empty entries. The UI selects and the Models tab render from this list;
 * `applyStageModel()` picks a catalog entry for a stage.
 */
export function getModelCatalog() {
  const ms = state.config && state.config.modelSettings;
  const list = ms && Array.isArray(ms.availableModels) ? ms.availableModels : [];
  return list.filter(m => m && typeof m.id === 'string' && m.id);
}

export function getModelMeta(modelId) {
  return getModelCatalog().find(m => m.id === modelId) || null;
}

/**
 * All selectable models for a pipeline stage: the catalog narrowed to the
 * stage's role/type, with the currently-configured model guaranteed present
 * (flagged `current`) even if it is not in the catalog (e.g. a custom id).
 */
export function getModelsForStage(stageKeyOrDef) {
  const stageDef = resolveStage(stageKeyOrDef);
  if (!stageDef) return [];
  const type = stageDef.role;
  const currentId = getModelIdForStage(stageDef);
  const out = [];
  const seen = new Set();
  for (const m of getModelCatalog()) {
    if (m.type !== type && m.type !== stageDef.key && m.type !== stageDef.task) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ ...m, stage: stageDef.key });
  }
  if (currentId && !seen.has(currentId)) {
    out.unshift({ id: currentId, name: String(currentId).split('/').pop(), type, stage: stageDef.key, description: 'Currently configured model (custom id)', sizeMb: null });
  }
  for (const m of out) m.current = m.id === currentId;
  return out;
}

/**
 * Full per-stage options snapshot for the Models tab: key, task, role, the
 * configured model, whether the stage is resident, and the selectable catalog.
 */
export function getStageOptions() {
  const opts = [];
  for (const stage of Object.values(PIPELINE_STAGES)) {
    opts.push({
      key: stage.key,
      role: stage.role,
      task: stage.task,
      label: stage.key[0].toUpperCase() + stage.key.slice(1),
      model: getModelIdForStage(stage),
      loaded: isStageLoaded(stage.key),
      options: getModelsForStage(stage.key)
    });
  }
  return opts;
}

/**
 * Device-aware recommendations: detect the client device (or use an injected
 * profile), then map each pipeline stage to the best-fit catalog model.
 * Returns model ids that exist in the catalog, falling back to the current
 * stage model if a recommended id is not available.
 */
export function getDeviceRecommendations(profileOrProbes, opts = {}) {
  const profile = resolveDeviceProfile(profileOrProbes);
  const catalog = getModelCatalog();
  const plan = recommendModelSet(profile, catalog);
  const recs = plan.stages || {};
  const stages = [];

  for (const stageOpt of getStageOptions()) {
    const key = stageOpt.key;
    const rec = recs[key] || {};
    const meta = getModelMeta(rec.model);
    const fallbackId = stageOpt.model;
    const pick = meta ? rec.model : (rec.model && getModelMeta(rec.model) ? rec.model : fallbackId);
    const pickMeta = getModelMeta(pick);
    stages.push(Object.freeze({
      key,
      stage: stageOpt.label,
      recommended: pick,
      name: pickMeta ? pickMeta.name : pick,
      sizeMb: pickMeta ? pickMeta.sizeMb : null,
      reason: meta && meta.id === pick ? rec.reason : (pickMeta ? `Falling back to ${pickMeta.name} (catalog lookup)` : 'No catalog match — keeping current model'),
      current: stageOpt.model,
      loaded: stageOpt.loaded
    }));
  }

  return Object.freeze({
    profile: Object.freeze({ ...profile }),
    tier: plan.tier,
    dtype: plan.dtype,
    notes: plan.notes,
    stages: Object.freeze(stages)
  });
}

/**
 * Build a modelSettings object reflecting the recommended setup for a device
 * profile so it can be persisted via ConfigAPI.updateConfig. Does not mutate
 * state. Returns null when configuration has not loaded yet.
 */
export function buildRecommendedModelSettings(profileOrProbes) {
  const ms = state.config && state.config.modelSettings;
  if (!ms) return null;
  const profile = resolveDeviceProfile(profileOrProbes);
  const catalog = getModelCatalog();
  const plan = recommendModelSet(profile, catalog);
  const stageMap = new Map();
  const stages = (ms.pipeline && Array.isArray(ms.pipeline.stages)) ? ms.pipeline.stages.slice() : [];
  for (const st of stages) { if (st && st.key) stageMap.set(st.key, st); }

  for (const stageDef of Object.values(PIPELINE_STAGES)) {
    const rec = (plan.stages || {})[stageDef.key] || {};
    const meta = getModelMeta(rec.model);
    const model = meta ? rec.model : ((stageMap.get(stageDef.key) || {}).model || stageDef.default);
    if (stageMap.has(stageDef.key)) {
      const idx = stages.findIndex(s => s && s.key === stageDef.key);
      stages[idx] = { ...stages[idx], model };
    } else {
      stages.push({ key: stageDef.key, task: stageDef.task, role: stageDef.role, model });
    }
  }

  const out = {
    ...ms,
    dtype: plan.dtype || ms.dtype,
    embedder: (plan.stages || {}).encoder && (plan.stages.encoder.model || ms.embedder),
    classifier: (plan.stages || {}).intent && (plan.stages.intent.model || ms.classifier),
    generator: (plan.stages || {}).dialog && (plan.stages.dialog.model || ms.generator),
    pipeline: {
      ...(ms.pipeline || {}),
      stages
    },
    availableModels: catalog
  };
  // keep top-level helpers equal to their stage assignments
  const enc = stages.find(s => s && s.key === 'encoder');
  const int = stages.find(s => s && s.key === 'intent');
  const diag = stages.find(s => s && s.key === 'dialog');
  if (enc) out.embedder = enc.model;
  if (int) out.classifier = int.model;
  if (diag) out.generator = diag.model;
  return out;
}

/**
 * Assign a model to a pipeline stage (in-memory only — the caller persists via
 * ConfigAPI.updateConfig). Keeps the top-level embedder/classifier/generator
 * helpers in sync with pipeline.stages so every code path reads one answer.
 * Rejects with a typed error when the stage or model is not usable.
 */
export function applyStageModel(stageKey, modelId) {
  const stageDef = resolveStage(stageKey);
  if (!stageDef) {
    throw new ModelError('E_UNKNOWN_STAGE', stageKey, `Unknown pipeline stage "${stageKey}".`, 'Use one of: encoder, intent, tagger, dialog.');
  }
  const id = typeof modelId === 'string' && modelId.trim() ? modelId.trim() : null;
  if (!id) {
    throw new ModelError('E_LOAD_MODEL', stageDef.key, 'A model id is required.', 'Pick a model from the catalog or type a Hugging Face model id.');
  }
  if (!state.config || !state.config.modelSettings) {
    throw new ModelError('E_NO_CONFIG', stageDef.key, 'Configuration not loaded — cannot assign a model.', 'Call init() / loadConfiguration() first.');
  }
  const ms = state.config.modelSettings;
  if (!ms.pipeline || !Array.isArray(ms.pipeline.stages)) ms.pipeline = { policy: 'swap', threshold: 0.35, memory: { maxSimultaneous: 1, wasmInitialMb: 64 }, stages: Object.values(PIPELINE_STAGES).map(s => ({ key: s.key, task: s.task, role: s.role, model: s.default })) };
  const stageCfg = ms.pipeline.stages.find(s => s && s.key === stageDef.key);
  if (stageCfg) stageCfg.model = id;
  else ms.pipeline.stages.push({ key: stageDef.key, task: stageDef.task, role: stageDef.role, model: id });
  if (stageDef.role === 'embedder') ms.embedder = id;
  if (stageDef.role === 'classifier') ms.classifier = id;
  if (stageDef.role === 'generator') ms.generator = id;
  return { stage: stageDef.key, model: id };
}

/**
 * Public model loader — the "direct import by model name" API.
 *
 *   await getModel('Xenova/all-MiniLM-L6-v2')  // by model id (resolved)
 *   await getModel('embedder')                 // by stage key / role / task
 *   await getModel('feature-extraction', configuredModelId, 'embedder')  // legacy 3-arg form
 *
 * Resolves to the live pipeline (retained in the swap slot) or rejects with a
 * `ModelError` carrying `code`, `stage`, `model`, and `fix`.
 */
export async function getModel(typeOrName, modelName, modelRole) {
  const config = state.config;
  if (!config || !config.modelSettings) {
    throw new ModelError('E_NO_CONFIG', null, 'Configuration not loaded — cannot resolve models.', 'Call init() / loadConfiguration() first.');
  }
  if (typeof typeOrName !== 'string' || !typeOrName.trim()) {
    throw new ModelError('E_UNKNOWN_STAGE', null, 'getModel requires a model id or stage key.', 'Pass a Hugging Face model id (e.g. "Xenova/all-MiniLM-L6-v2") or a stage key (encoder/intent/tagger/dialog).');
  }

  let stageKey = null;
  let mid = null;

  if (modelName || modelRole) {
    const stage = resolveStage(modelRole || typeOrName);
    stageKey = stage && stage.key;
    mid = modelName || (stage && getModelIdForStage(stage));
  } else {
    const byName = resolveModelName(typeOrName);
    if (byName) {
      stageKey = byName.stage.key;
      mid = byName.modelId;
    } else {
      const stage = resolveStage(typeOrName);
      if (stage) {
        stageKey = stage.key;
        mid = getModelIdForStage(stage);
      }
    }
  }

  if (!stageKey || !mid) {
    throw new ModelError('E_UNKNOWN_STAGE', null, `No pipeline stage resolves for "${typeOrName}".`, 'Use a known HF model id, a stage key, or an entry listed in modelSettings.availableModels.');
  }

  return loadStage(stageKey, mid);
}

/**
 * Default modelSettings (used by "Reset to defaults"). Keeps the current
 * availableModels catalog so newly-added models survive a reset, and rebuilds
 * the small stage list from the stage registry defaults.
 */
export function defaultModelSettings() {
  const ms = state.config && state.config.modelSettings;
  const catalog = (ms && Array.isArray(ms.availableModels)) ? ms.availableModels : [];
  return {
    dtype: 'q8',
    preloadOnOpen: !!ms.preloadOnOpen,
    embedder: PIPELINE_STAGES.encoder.default,
    classifier: PIPELINE_STAGES.intent.default,
    generator: PIPELINE_STAGES.dialog.default,
    pipeline: {
      policy: 'swap',
      threshold: 0.35,
      memory: { maxSimultaneous: 1, wasmInitialMb: 64 },
      stages: Object.values(PIPELINE_STAGES).map(s => ({ key: s.key, task: s.task, role: s.role, model: s.default }))
    },
    availableModels: catalog
  };
}

/**
 * Enrichment: compute/store an embedding for a record. Best-effort — returns
 * null when the embedder is unavailable so data operations never block on the
 * model. Records without embeddings fall back to keyword search (honest).
 */
export async function computeEmbedding(schemaName, data, stateInstance = state) {
  try {
    const biz = (stateInstance && getActiveBusiness) ? getActiveBusiness(stateInstance) : null;
    const schema = biz && biz.schemas ? biz.schemas[schemaName] : null;
    if (!schema) return null;
    const fields = schema.vectorize || Object.keys(schema.fields || {});
    const text = fields.map(f => data[f]).filter(Boolean).join(' ');
    if (!text) return null;
    const ms = stateInstance.config && stateInstance.config.modelSettings;
    const embedder = await getModel((ms && ms.embedder) || PIPELINE_STAGES.encoder.default);
    const out = await embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  } catch (e) {
    return null;
  }
}

/**
 * Enrichment: embed free text. Best-effort — null when the embedder is
 * unavailable (callers fall back to deterministic keyword logic).
 */
export async function embedText(text, modelOverride) {
  if (!text) return null;

  // Try the configured remote embedder backend first (llamacpp / ollama)
  try {
    const backend = resolveBackendForStage('embedder');
    if (backend && backend.id !== 'transformers' && typeof backend.embed === 'function') {
      const vec = await backend.embed(String(text), modelOverride);
      if (vec) return Array.from(vec);
    }
  } catch (_) { /* fall through to on-device */ }

  // On-device Transformers.js fallback
  try {
    const ms = state.config && state.config.modelSettings;
    const embedder = await getModel(modelOverride || (ms && ms.embedder) || PIPELINE_STAGES.encoder.default);
    const out = await embedder(String(text), { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  } catch (err) {
    if (!(err instanceof ModelError && err.code === 'E_DISABLED')) {
      console.warn('[models] embeddings unavailable:', formatModelError(err));
    }
    return null;
  }
}

// ── Browser-only wiring: Transformers provider ↔ Models-tab UI ───────────────
// The scheduler used to poke the DOM directly; it now reports through hooks and
// this coordinator forwards them to the exact same elements/behaviour.
if (isBrowser) {
  setTransformersHooks({
    onStatus(s) {
      const statusEl = document.getElementById('modelStatus');
      const stageEl = document.getElementById('pipelineStage');
      if (statusEl) {
        if (s.error) {
          statusEl.textContent = 'Model Status: Error loading model';
          statusEl.className = 'badge bg-danger';
        } else if (s.loading) {
          statusEl.textContent = 'Model Status: Loading...';
          statusEl.className = 'badge bg-warning text-dark';
        } else {
          statusEl.textContent = `Model Status: ${s.loaded ? 'Ready (' + s.loaded + ')' : 'Ready'}`;
          statusEl.className = 'badge bg-success';
        }
      }
      if (stageEl) {
        stageEl.textContent = s.stage ? `Stage: ${s.stage}` : '';
      }
    },
    onProgress(pct) {
      const progressEl = document.getElementById('modelProgress');
      if (progressEl) progressEl.style.width = `${pct}%`;
    },
    onEmbedderReady() {
      populateModelSelects();
      renderConfigEditor();
    }
  });
}