/**
 * app/models.js - ModelScheduler
 *
 * A staged multi-model runtime. Instead of loading a big model and keeping
 * every model resident, we keep a set of SMALL specialist models and load
 * exactly ONE at a time (policy: "swap"). The previous model is disposed
 * (ONNX session released) before the next stage loads, so memory footprint
 * stays roughly constant and small.
 *
 * Stages:
 *   encoder → feature-extraction  (semantic embeddings / retrieval / tool scoring)
 *   intent  → zero-shot-classification (intent, personas, small talk)
 *   tagger  → token-classification (entity / parameter extraction)
 *   dialog  → text2text-generation (natural-language responses)
 *
 * Every stage degrades gracefully: in Node or offline the Transformer import
 * throws and we return null, letting deterministic fallbacks take over.
 */

import { isBrowser } from '../core/env.js';
import { state, getActiveBusiness } from '../core/state.js';
import { populateModelSelects, renderConfigEditor } from './ui.js';

// ── Stage registry ──────────────────────────────────────────────────────────
export const PIPELINE_STAGES = {
  encoder: { key: 'encoder', task: 'feature-extraction',        role: 'embedder',   default: 'Xenova/all-MiniLM-L6-v2',          mb: 90 },
  intent:  { key: 'intent',  task: 'zero-shot-classification',  role: 'classifier', default: 'Xenova/mobilebert-uncased-mnli',   mb: 110 },
  tagger:  { key: 'tagger',  task: 'token-classification',      role: 'ner',        default: 'Xenova/bert-base-NER',             mb: 180 },
  dialog:  { key: 'dialog',  task: 'text2text-generation',      role: 'generator',  default: 'Xenova/LaMini-Flan-T5-248M',        mb: 260 }
};

const ROLE_TO_STAGE = { embedder: 'encoder', classifier: 'intent', ner: 'tagger', generator: 'dialog' };
const TASK_TO_STAGE = {
  'feature-extraction': 'encoder',
  'zero-shot-classification': 'intent',
  'token-classification': 'tagger',
  'text2text-generation': 'dialog'
};

let transformModule = null;
let loadPromise = null;
let mutedTransformersWarnings = false;

// ── Scheduler state — one active model at a time ─────────────────────────────
const active = { key: null, modelId: null, pipe: null };
let chain = Promise.resolve();

function pipelineStatus() {
  return state.pipeline || (state.pipeline = { status: 'idle', stage: null, model: null, queue: 0, loads: 0 });
}

function pipelineConfig() {
  return (state.config && state.config.modelSettings && state.config.modelSettings.pipeline) || null;
}

function stageModel(stageDef) {
  const pipeCfg = pipelineConfig();
  if (pipeCfg && Array.isArray(pipeCfg.stages)) {
    const match = pipeCfg.stages.find(s => s.key === (stageDef && stageDef.key));
    if (match && match.model) return match.model;
  }
  const ms = state.config && state.config.modelSettings;
  if (ms) {
    if (stageDef.key === 'encoder' && ms.embedder) return ms.embedder;
    if (stageDef.key === 'intent' && ms.classifier) return ms.classifier;
    if (stageDef.key === 'dialog' && ms.generator) return ms.generator;
  }
  return stageDef.default;
}

export function getTransformers() {
  if (transformModule) return Promise.resolve(transformModule);
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    if (isBrowser && window.transformers) {
      transformModule = window.transformers;
      return transformModule;
    }

    try {
      const mod = await import(
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js'
      );
      if (mod && mod.pipeline) transformModule = mod;
    } catch (e1) {
      try {
        const mod = await import('@xenova/transformers@2.17.2');
        if (mod && mod.pipeline) transformModule = mod;
      } catch (e2) {
        throw new Error('Transformers.js failed to load from CDN');
      }
    }

    if (!transformModule) throw new Error('Transformers.js failed to load');
    if (!mutedTransformersWarnings) {
      try {
        transformModule.env && (transformModule.env.allowLocalModels = false);
        transformModule.env && (transformModule.env.useBrowserCache = true);
        if (transformModule.env && transformModule.env.backends && transformModule.env.backends.onnx) {
          transformModule.env.backends.onnx.wasm && (transformModule.env.backends.onnx.wasm.proxy = false);
          if (typeof WebAssembly !== 'undefined' && WebAssembly.Memory) {
            try {
              const sizeMb = (state.config && state.config.modelSettings && state.config.modelSettings.memory && state.config.modelSettings.memory.wasmInitialMb) || 64;
              transformModule.env.backends.onnx.wasm.wasmMemory = new WebAssembly.Memory({ initial: sizeMb, maximum: 8192 });
            } catch (_) {}
          }
        }
      } catch (_) {}
      mutedTransformersWarnings = true;
    }
    return transformModule;
  })();

  return loadPromise;
}

function resolveStage(keyOrRoleOrTask) {
  const k = ROLE_TO_STAGE[keyOrRoleOrTask] || TASK_TO_STAGE[keyOrRoleOrTask] || keyOrRoleOrTask;
  return PIPELINE_STAGES[k] || null;
}

const modelStatus = {
  loading: false,
  loaded: null,
  error: null,
  stage: null
};

export async function updateModelStatus(status) {
  const current = String(status || '').toLowerCase();
  if (current.includes('load') || current.includes('swap')) {
    if (current.includes('ready') || current.includes('done')) {
      modelStatus.loading = false;
      modelStatus.error = null;
    } else if (current.includes('error') || current.includes('fail')) {
      modelStatus.loading = false;
      modelStatus.error = current;
    } else {
      modelStatus.loading = true;
      modelStatus.error = null;
    }
  } else if (current.includes('ready')) {
    modelStatus.loading = false;
    modelStatus.error = null;
  } else if (current.includes('error')) {
    modelStatus.error = current;
  }

  if (isBrowser) {
    const statusEl = document.getElementById('modelStatus');
    const stageEl = document.getElementById('pipelineStage');
    if (statusEl) {
      if (modelStatus.error) {
        statusEl.textContent = 'Model Status: Error loading model';
        statusEl.className = 'badge bg-danger';
      } else if (modelStatus.loading) {
        statusEl.textContent = 'Model Status: Loading...';
        statusEl.className = 'badge bg-warning text-dark';
      } else {
        statusEl.textContent = `Model Status: ${modelStatus.loaded ? 'Ready (' + modelStatus.loaded + ')' : 'Ready'}`;
        statusEl.className = 'badge bg-success';
      }
    }
    if (stageEl) {
      stageEl.textContent = modelStatus.stage ? `Stage: ${modelStatus.stage}` : '';
    }
  }

  return modelStatus;
}

async function disposeActive() {
  const p = active.pipe;
  if (!p) return;
  active.key = null;
  active.modelId = null;
  active.pipe = null;
  try {
    if (typeof p.dispose === 'function') await p.dispose();
  } catch (_) {}
  try {
    if (p.model && typeof p.model.dispose === 'function') await p.model.dispose();
  } catch (_) {}
  pipelineStatus().status = 'idle';
  try { await updateModelStatus('Model Status: Ready'); } catch (_) {}
}

async function buildPipeline(stageDef, modelId) {
  const status = pipelineStatus();
  status.status = 'loading';
  status.stage = stageDef.key;
  status.model = modelId;
  status.loads++;
  modelStatus.stage = stageDef.key;
  modelStatus.loaded = modelId;
  await updateModelStatus('Model Status: Loading...');

  const transformers = await getTransformers();
  let pipeline;
  try {
    pipeline = transformers.pipeline;
  } catch (_) {
    pipeline = transformers.default ? transformers.default.pipeline : null;
  }
  if (!pipeline) throw new Error('Transformers pipeline API not found');

  const ms = (state.config && state.config.modelSettings) || {};
  const progressEl = isBrowser ? document.getElementById('modelProgress') : null;
  const dtype = ms.dtype || 'q8';
  const opts = { dtype };
  const device = 'cpu';

  const pipe = await pipeline(stageDef.task, modelId, {
    ...opts,
    device,
    progress_callback: (p) => {
      if (p && p.status === 'progress' && p.progress) {
        if (progressEl) progressEl.style.width = `${p.progress}%`;
      }
    }
  });

  active.key = stageDef.key;
  active.modelId = modelId;
  active.pipe = pipe;

  if (progressEl) progressEl.style.width = '0%';
  modelStatus.loaded = modelId;
  modelStatus.stage = stageDef.key;
  modelStatus.loading = false;
  modelStatus.error = null;
  status.status = 'ready';
  await updateModelStatus('Model Status: Ready');

  if (stageDef.role === 'embedder') {
    populateModelSelects();
    renderConfigEditor();
  }
  return pipe;
}

/**
 * Load a pipeline for a stage, guaranteeing at most one model resident.
 * Returns the pipeline and RETAINS it until the next stage loads.
 */
export function loadStage(key, modelOverride) {
  const stageDef = resolveStage(key);
  if (!stageDef) return Promise.reject(new Error(`Unknown pipeline stage "${key}"`));
  const modelId = (typeof modelOverride === 'string' && modelOverride)
    ? modelOverride
    : (modelOverride && typeof modelOverride === 'object' && modelOverride.model) || stageModel(stageDef);

  if (active.key === stageDef.key && active.modelId === modelId && active.pipe) {
    return Promise.resolve(active.pipe);
  }

  const op = chain.then(async () => {
    if (active.key === stageDef.key && active.modelId === modelId && active.pipe) return active.pipe;
    await disposeActive();
    try {
      return await buildPipeline(stageDef, modelId);
    } catch (err) {
      pipelineStatus().status = 'idle';
      pipelineStatus().stage = null;
      pipelineStatus().model = null;
      modelStatus.loading = false;
      modelStatus.error = err && err.message ? String(err.message) : 'stage unavailable';
      await updateModelStatus('Model Status: Error').catch(() => {});
      throw err;
    }
  });
  chain = op.catch(() => {});
  return op;
}

/**
 * Load a stage, run `fn(pipeline)`, then dispose it (unless retain:true).
 * This is the "one model at a time" entry point used by the pipeline.
 */
export async function inferStage(key, fn, opts = {}) {
  const pipe = await loadStage(key, opts.model);
  try {
    return await fn(pipe);
  } finally {
    if (!opts.retain) {
      await disposeActive();
    }
  }
}

export function unloadStage(key) {
  if (active.key === key) return disposeActive();
  return Promise.resolve();
}

export async function unloadAll() {
  await disposeActive();
  chain = Promise.resolve();
}

export function isStageLoaded(key) {
  const stageDef = resolveStage(key);
  return !!(stageDef && active.key === stageDef.key && active.pipe);
}

export function getPipelineStatus() {
  return { status: pipelineStatus().status, currentStage: active.key, currentModel: active.modelId, model: modelStatus };
}

/**
 * Compatibility loader used by existing data flows (embeddings, generator
 * fallback). Returns the pipeline, retained in the single slot until the next
 * stage loads. Returns null instead of throwing when models are unavailable.
 */
export async function getModel(type, modelName, modelRole) {
  const config = state.config;
  if (!config || !config.modelSettings) {
    throw new Error('Configuration not loaded');
  }
  const stageDef = resolveStage(modelRole || type);
  if (!stageDef) throw new Error(`No pipeline stage for "${type}/${modelRole}"`);
  try {
    return await loadStage(stageDef.key, modelName);
  } catch (err) {
    console.warn(`[models] Stage "${stageDef.key}" unavailable:`, err.message);
    return null;
  }
}

export async function computeEmbedding(schemaName, data, stateInstance = state) {
  try {
    const biz = getActiveBusiness(stateInstance);
    const schema = biz && biz.schemas ? biz.schemas[schemaName] : null;
    if (!schema) return null;
    const fields = schema.vectorize || Object.keys(schema.fields || {});
    const text = fields.map(f => data[f]).filter(Boolean).join(' ');
    if (!text) return null;
    const embedder = await getModel(
      'feature-extraction',
      stateInstance.config && stateInstance.config.modelSettings ? stateInstance.config.modelSettings.embedder : undefined,
      'embedder'
    );
    if (!embedder) return null;
    const out = await embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  } catch (e) {
    return null;
  }
}

export async function embedText(text, modelOverride) {
  if (!text) return null;
  const embedder = await getModel(
    'feature-extraction',
    modelOverride ||
      (state.config && state.config.modelSettings ? state.config.modelSettings.embedder : undefined),
    'embedder'
  );
  if (!embedder) return null;
  const out = await embedder(String(text), { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}