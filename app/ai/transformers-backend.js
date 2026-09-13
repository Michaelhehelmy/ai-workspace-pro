/**
 * app/ai/transformers-backend.js - Transformers.js (on-device) backend
 *
 * The default offline provider. Owns the Transformers.js bootstrap and the
 * single-resident model scheduler (policy: "swap") that previously lived in
 * app/models.js. All UI/status side-effects are delegated through hooks
 * (`setTransformersHooks`) so this module stays importable from Node (tests)
 * without touching the DOM.
 *
 * Exposes a standard LLM backend (see app/ai/backend.js) plus the scheduler
 * primitives the coordinator (app/models.js) re-exports so the app's public
 * model API is unchanged.
 *
 * Stages:
 *   encoder → feature-extraction  (semantic embeddings / retrieval / tool scoring)
 *   intent  → zero-shot-classification (intent, personas, small talk)
 *   tagger  → token-classification (entity / parameter extraction)
 *   dialog  → text2text-generation (natural-language responses)
 *
 * No canned/mock behaviour lives here. Every failure is a typed `ModelError`
 * with a machine-readable code and actionable `fix`. Model weights are cached
 * (browser Cache Storage / Node `.cache/transformers`) so subsequent runs are
 * offline. `preloadModels()` warms the cache and the swap slot on page access.
 */

import { isBrowser } from '../../core/env.js';
import { hasWorkerHubProxy } from './hub.js';
import { state } from '../../core/state.js';
import {
  ModelError,
  formatModelError,
  PIPELINE_STAGES,
  ROLE_TO_STAGE,
  TASK_TO_STAGE,
  resolveStage,
  createBackend,
  registerBackend
} from './backend.js';

const TRANSFORMERS_VERSION = '3.3.3';
const BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/transformers.min.js`;

// ── Runtime switches ─────────────────────────────────────────────────────────
function modelsDisabled() {
  if (typeof process !== 'undefined' && process.env && process.env.MODELS_DISABLED) {
    const v = String(process.env.MODELS_DISABLED).toLowerCase();
    return v === '1' || v === 'true';
  }
  if (isBrowser && window.__MODELS_DISABLED__) return true;
  return false;
}

let transformModule = null;
let loadPromise = null;
let mutedTransformersWarnings = false;

// ── Scheduler state — one active model at a time ─────────────────────────────
const active = { key: null, modelId: null, pipe: null };
let chain = Promise.resolve();

const modelStatus = { loading: false, loaded: null, error: null, stage: null };

// ── UI/status hooks (assigned once by app/models.js in the browser) ──────────
const hooks = { onStatus: null, onProgress: null, onEmbedderReady: null };

export function setTransformersHooks(h) {
  Object.assign(hooks, h || {});
}

function pipelineStatus() {
  return state.pipeline || (state.pipeline = { status: 'idle', stage: null, model: null, queue: 0, loads: 0, errors: [] });
}

function notifyStatus() {
  if (typeof hooks.onStatus === 'function') {
    try {
      hooks.onStatus({
        error: modelStatus.error,
        loading: modelStatus.loading,
        loaded: modelStatus.loaded,
        stage: modelStatus.stage
      });
    } catch (_) {}
  }
  return modelStatus;
}

function notifyProgress(pct) {
  if (typeof hooks.onProgress === 'function') {
    try { hooks.onProgress(pct); } catch (_) {}
  }
}

async function updateModelStatus(status) {
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
  return notifyStatus();
}

// ── Transformers.js bootstrap (browser CDN + Node npm, cached) ──────────────
async function configureEnv(transformers) {
  try {
    const env = transformers.env || (transformers.default && transformers.default.env);
    if (!env) return;
    env.allowLocalModels = false;

    if (isBrowser) {
      // Cache API is only defined on secure origins (https / localhost). Where it is
      // missing (plain http to a LAN host, restricted iframes, some remote browsers),
      // leave the browser cache off so transformers.js downloads models per load
      // instead of throwing "Browser cache is not available in this environment."
      env.useBrowserCache = typeof caches !== 'undefined';

      // The deployed Worker proxies Hugging Face model files CORS-open at
      // /api/hub/raw (see worker/index.js). Point the engine's remote host at
      // it so config/tokenizer/weight downloads never hit huggingface.co's
      // redirect chains directly (a redirect target that 404s or drops CORS
      // headers surfaces in the browser as "Cross-Origin Request Blocked …
      // Status code: 404"). Large weight blobs are 302-redirected back to Hugging
      // Face by the proxy and served direct from its LFS/CDN hosts. On bare
      // static hosting (no Worker) the defaults are kept — direct HF downloads.
      if (await hasWorkerHubProxy()) {
        env.remoteHost = window.location.origin;
        env.remotePathTemplate = '/api/hub/raw?path={model}/resolve/{revision}/';
      }
    } else {
      const { mkdirSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
      const cacheDir = join(repoRoot, '.cache', 'transformers');
      try { mkdirSync(cacheDir, { recursive: true }); } catch (_) {}
      env.cacheDir = cacheDir;
      env.useBrowserCache = false;
    }

    if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
      env.backends.onnx.wasm.proxy = false;
      if (typeof WebAssembly !== 'undefined' && WebAssembly.Memory && (state.config && state.config.modelSettings && state.config.modelSettings.memory)) {
        try {
          const sizeMb = state.config.modelSettings.memory.wasmInitialMb || 64;
          env.backends.onnx.wasm.wasmMemory = new WebAssembly.Memory({ initial: sizeMb, maximum: 8192 });
        } catch (_) {}
      }
    }
  } catch (_) {}
}

export function getTransformers() {
  if (transformModule) return Promise.resolve(transformModule);
  if (loadPromise) return loadPromise;
  if (modelsDisabled()) {
    return Promise.reject(new ModelError(
      'E_DISABLED',
      null,
      'On-device models are disabled in this environment.',
      'Unset MODELS_DISABLED (or window.__MODELS_DISABLED__) to enable real model inference.'
    ));
  }

  loadPromise = (async () => {
    if (isBrowser && window.transformers) {
      transformModule = window.transformers;
    } else if (!isBrowser) {
      try {
        const mod = await import('@huggingface/transformers');
        transformModule = (mod && mod.pipeline) ? mod : (mod && mod.default && mod.default.pipeline ? mod.default : null);
      } catch (err) {
        throw new ModelError(
          'E_LOAD_PACKAGE',
          null,
          'Transformers.js is not installed for the Node runtime.',
          'Run `npm install` in the project root (installs @huggingface/transformers), then re-run.',
          null,
          err
        );
      }
    } else {
      try {
        const mod = await import(BUNDLE_URL);
        transformModule = (mod && mod.pipeline) ? mod : (mod && mod.default && mod.default.pipeline ? mod.default : null);
      } catch (err) {
        throw new ModelError(
          'E_LOAD_PACKAGE',
          null,
          `Failed to load Transformers.js from the CDN (${BUNDLE_URL}).`,
          'Check your network connection, or self-host dist/transformers.min.js and expose `window.transformers`.',
          null,
          err
        );
      }
    }

    if (!transformModule || typeof transformModule.pipeline !== 'function') {
      throw new ModelError(
        'E_LOAD_PACKAGE',
        null,
        'Transformers.js loaded but the pipeline API is missing.',
        'Hard-refresh / reinstall to fetch a complete bundle.'
      );
    }

    await configureEnv(transformModule);
    if (!mutedTransformersWarnings) mutedTransformersWarnings = true;
    return transformModule;
  })();

  loadPromise.catch(() => {});
  return loadPromise;
}

export function getStatus() {
  return {
    status: pipelineStatus().status,
    currentStage: active.key,
    currentModel: active.modelId,
    model: modelStatus,
    disabled: modelsDisabled()
  };
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

function toModelError(err, stageDef, modelId) {
  if (err instanceof ModelError) return err;
  return new ModelError(
    'E_LOAD_MODEL',
    stageDef ? stageDef.key : null,
    `Failed to load model "${modelId}"${stageDef ? ` for stage "${stageDef.key}"` : ''}${err && err.message ? `: ${err.message}` : ''}.`,
    'Verify network access to huggingface.co and that the model id is correct. The first load downloads weights; subsequent runs use the local cache.',
    modelId,
    err
  );
}

/**
 * Load failure that happens even though the model's API entry resolved fine —
 * i.e. the Hub listing is reachable but the actual file downloads
 * (huggingface.co/[model]/resolve/main/...) did not. This is almost always a
 * routing/egress problem for the download path, not a missing model.
 */
function hubDownloadError(err, stageDef, modelId) {
  return new ModelError(
    'E_LOAD_MODEL',
    stageDef ? stageDef.key : null,
    `Failed to download model "${modelId}"${stageDef ? ` for stage "${stageDef.key}"` : ''}: ${(err && err.message) || 'network error'}. The Hugging Face API answered, but downloading the model files failed.`,
    'This usually means huggingface.co download requests are being routed to an unreachable mirror/CDN on your network. Test: open https://huggingface.co/' + String(modelId || '') + '/resolve/main/config.json in a new tab — if it 404s while the page loads, switch networks or use a VPN and retry. Once downloaded, the model runs offline.',
    modelId,
    err
  );
}

// ── Hugging Face Hub reachability guard ──────────────────────────────────────
// A catalog id that 404s on the Hub surfaces as baffling CORS noise in the
// browser, because error responses omit `Access-Control-Allow-Origin`. Fetch a
// missing model once before loading it: the JSON API sends CORS headers on
// every response, so a gone model fails fast with a readable ModelError
// instead of a console full of blocked-request errors. Browser-only (Node
// loads from the local cache); results are memoized for the session.
const _hubCheck = new Map();

/** True when the model's files are already in browser Cache Storage. */
async function hubModelCached(modelId) {
  if (typeof caches === 'undefined' || typeof caches.keys !== 'function') return false;
  // With the Worker present, transformers.js caches files under the proxied
  // /api/hub/raw key; on bare static hosting it uses the direct HF URL. Probe
  // whichever applies (both when the Worker is present, cheap and safe).
  const bases = [];
  try {
    if (await hasWorkerHubProxy()) {
      bases.push(window.location.origin + '/api/hub/raw?path=' + modelId + '/resolve/main/config.json');
    }
  } catch (_) {}
  bases.push('https://huggingface.co/' + modelId + '/resolve/main/config.json');
  try {
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      for (const url of bases) {
        if (await cache.match(url)) return true;
      }
    }
  } catch (_) {}
  return false;
}

async function ensureModelReachable(stageKey, modelId) {
  if (!isBrowser) return;
  if (!modelId || typeof modelId !== 'string') return;
  if (!/^[A-Za-z0-9._/-]+$/.test(modelId)) return;
  if (!_hubCheck.has('ok:' + modelId) && await hubModelCached(modelId)) {
    _hubCheck.set('ok:' + modelId, true);
    return;
  }
  const key = stageKey + ':' + modelId;
  if (_hubCheck.has(key)) return _hubCheck.get(key);
  const probe = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      // Route through the same-origin worker proxy when it is present (the Hub
      // API omits CORS headers on 404s, so a direct fetch of a missing model
      // surfaces as "Cross-Origin Request Blocked"); fall back to a direct Hub
      // fetch on bare static hosting.
      const proxied = await hasWorkerHubProxy();
      const base = proxied
        ? '/api/hub/info?path=' + encodeURIComponent(modelId) + '&expand[]=siblings'
        : 'https://huggingface.co/api/models/' + modelId + '?expand[]=siblings';
      const res = await fetch(base, {
        headers: { accept: 'application/json' },
        signal: ctrl.signal
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || typeof body !== 'object') {
        const detail = (body && typeof body.error === 'string') ? ` ${body.error}` : ` (HTTP ${res.status})`;
        throw new ModelError(
          'E_LOAD_MODEL',
          stageKey,
          `Model "${modelId}" is not reachable on Hugging Face.${detail}`,
          'Choose a different model from the Models tab, or check your connection to huggingface.co.',
          modelId
        );
      }
      const files = Array.isArray(body.siblings) ? body.siblings.map((s) => String(s.rfilename || '')) : [];
      if (!files.some((f) => /\.onnx$/i.test(f))) {
        throw new ModelError(
          'E_LOAD_MODEL',
          stageKey,
          `Model "${modelId}" does not ship ONNX weights, so it cannot run in the browser.`,
          'Choose a model that publishes a transformers.js (ONNX) build.',
          modelId
        );
      }
    } catch (err) {
      if (err instanceof ModelError) throw err;
      throw toModelError(err, { key: stageKey }, modelId);
    } finally {
      clearTimeout(timer);
    }
  })();
  _hubCheck.set(key, probe);
  return probe;
}

async function buildPipeline(stageDef, modelId) {
  if (modelsDisabled()) {
    throw new ModelError(
      'E_DISABLED',
      stageDef ? stageDef.key : null,
      'On-device models are disabled in this environment.',
      'Unset MODELS_DISABLED (or window.__MODELS_DISABLED__) to enable real model inference.'
    );
  }
  const status = pipelineStatus();
  status.status = 'loading';
  status.stage = stageDef.key;
  status.model = modelId;
  status.loads++;
  modelStatus.stage = stageDef.key;
  modelStatus.loaded = modelId;
  await updateModelStatus('Model Status: Loading...');
  await ensureModelReachable(stageDef.key, modelId);

  let transformers;
  try {
    transformers = await getTransformers();
  } catch (err) {
    throw toModelError(err, stageDef, modelId);
  }

  const pipeline = transformers.pipeline || ((transformers.default && transformers.default.pipeline) || null);
  if (typeof pipeline !== 'function') {
    throw new ModelError('E_LOAD_PACKAGE', stageDef.key, 'Transformers pipeline API not found.', 'Reinstall / hard-refresh @huggingface/transformers.', modelId);
  }

  const ms = (state.config && state.config.modelSettings) || {};
  const dtype = ms.dtype || 'q8';
  const opts = { dtype };
  // onnxruntime-node accepts 'cpu'; the web (wasm) backend only accepts 'wasm'
  // (plus webgpu/webnn when available). Using the wrong one throws
  // `Unsupported device: "cpu". Should be one of: wasm.` in the browser.
  const device = isBrowser ? 'wasm' : 'cpu';

  let pipe;
  try {
    pipe = await pipeline(stageDef.task, modelId, {
      ...opts,
      device,
      progress_callback: (p) => {
        if (p && p.status === 'progress' && p.progress) {
          notifyProgress(p.progress);
        }
      }
    });
  } catch (err) {
    if (isBrowser && _hubCheck.has(stageDef.key + ':' + modelId)) {
      throw hubDownloadError(err, stageDef, modelId);
    }
    throw toModelError(err, stageDef, modelId);
  }

  active.key = stageDef.key;
  active.modelId = modelId;
  active.pipe = pipe;

  notifyProgress(0);
  modelStatus.loaded = modelId;
  modelStatus.stage = stageDef.key;
  modelStatus.loading = false;
  modelStatus.error = null;
  status.status = 'ready';
  await updateModelStatus('Model Status: Ready');

  if (stageDef.role === 'embedder' && typeof hooks.onEmbedderReady === 'function') {
    try { hooks.onEmbedderReady(); } catch (_) {}
  }
  return pipe;
}

/**
 * Load a pipeline for a stage, guaranteeing at most one model resident.
 * Resolves to the pipeline and RETAINS it until the next stage loads.
 * Rejects with a `ModelError` when the model cannot be loaded.
 */
export function loadStage(key, modelOverride) {
  const stageDef = resolveStage(key);
  if (!stageDef) {
    return Promise.reject(new ModelError('E_UNKNOWN_STAGE', key, `Unknown pipeline stage "${key}".`, 'Use one of: encoder, intent, tagger, dialog.'));
  }
  const modelId = (typeof modelOverride === 'string' && modelOverride)
    ? modelOverride
    : (modelOverride && typeof modelOverride === 'object' && modelOverride.model) || getModelIdForStage(stageDef);

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

export function getModelIdForStage(stageDef) {
  const pipeCfg = (state.config && state.config.modelSettings && state.config.modelSettings.pipeline) || null;
  if (pipeCfg && Array.isArray(pipeCfg.stages)) {
    const match = pipeCfg.stages.find(s => s.key === (stageDef && stageDef.key));
    if (match && match.model) return match.model;
  }
  const ms = state.config && state.config.modelSettings;
  if (ms && stageDef) {
    if (stageDef.key === 'encoder' && ms.embedder) return ms.embedder;
    if (stageDef.key === 'intent' && ms.classifier) return ms.classifier;
    if (stageDef.key === 'dialog' && ms.generator) return ms.generator;
  }
  return null;
}

/**
 * Preload the configured model stages in the background (downloads + caches
 * weights, and leaves the last stage resident). Returns a summary of what
 * succeeded/failed. Failures are recorded, not thrown — a later inferStage
 * call will retry with a typed error.
 */
let preloadPromise = null;

export function preloadModels(opts = {}) {
  if (preloadPromise) return preloadPromise;
  if (modelsDisabled()) {
    preloadPromise = Promise.resolve({ preloaded: 0, errors: [], total: 0, disabled: true });
    return preloadPromise;
  }

  let stageKeys = Array.isArray(opts.stages) && opts.stages.length
    ? opts.stages
    : null;
  if (!stageKeys) {
    const cfg = (state.config && state.config.modelSettings && state.config.modelSettings.pipeline) || null;
    stageKeys = cfg && Array.isArray(cfg.stages)
      ? cfg.stages.map(s => s.key).filter(k => PIPELINE_STAGES[k])
      : null;
  }
  stageKeys = stageKeys && stageKeys.length ? stageKeys : ['encoder', 'intent', 'tagger', 'dialog'];

  preloadPromise = (async () => {
    const errors = [];
    let preloaded = 0;
    for (const key of stageKeys) {
      try {
        await loadStage(key);
        preloaded++;
      } catch (err) {
        const e = err instanceof ModelError
          ? err
          : new ModelError('E_LOAD_MODEL', key, err && err.message ? String(err.message) : String(err), 'Check network access to huggingface.co.');
        errors.push({ code: e.code, stage: e.stage, model: e.model, message: e.message, fix: e.fix });
        if (opts.loud || isBrowser) console.warn(`[preload] ${key} unavailable:`, e.message);
        pipelineStatus().errors.push({ code: e.code, stage: e.stage, message: e.message, fix: e.fix });
      }
    }
    const summary = { preloaded, errors, total: stageKeys.length, disabled: false, cachedStages: stageKeys };
    state.modelPreload = summary;
    return summary;
  })();

  preloadPromise.catch(() => {});
  return preloadPromise;
}

/**
 * Re-run the background preload (needed by the Models tab "Preload all stages"
 * button after weights change). Resets the cached preload promise.
 */
export function forcePreload(opts = {}) {
  preloadPromise = null;
  return preloadModels(opts);
}

// ── LLM backend interface implementation ─────────────────────────────────────
export async function health() {
  if (modelsDisabled()) {
    return { ok: false, detail: 'On-device models are disabled (MODELS_DISABLED / window.__MODELS_DISABLED__).' };
  }
  try {
    await getTransformers();
    return { ok: true, detail: `Transformers.js v${TRANSFORMERS_VERSION} ready` };
  } catch (err) {
    return { ok: false, detail: (err && err.message) ? err.message : 'Transformers.js unavailable' };
  }
}

/**
 * Feature extraction via the configured encoder stage.
 * Returns a raw Float32Array; the coordinator converts it to a plain array.
 */
export async function embed(text, modelOverride) {
  if (!text) return null;
  const ms = (state.config && state.config.modelSettings) || {};
  const modelId = modelOverride || ms.embedder || null;
  if (!modelId) return null;
  const out = await inferStage('encoder', async (pipe) => {
    if (typeof pipe !== 'function') return null;
    const res = await pipe(String(text), { pooling: 'mean', normalize: true });
    return (res && res.data) ? res.data : null;
  }, { retain: false });
  return out || null;
}

/**
 * Streaming text generation via the configured dialog stage.
 * Yields `{ text }` deltas (single-shot for the on-device T5; genuinely
 * token-streamed providers arrive with the local-API backends in Phase 1).
 */
export async function* generate(req = {}, opts = {}) {
  const system = typeof req.system === 'string' ? req.system : '';
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const lines = [];
  if (system) lines.push(system);
  for (const m of messages) {
    const role = (m && String(m.role) === 'user') ? 'User' : 'Assistant';
    const content = (m && m.content) || '';
    if (content) lines.push(`${role}: ${content}`);
  }
  const prompt = lines.join('\n').slice(0, 900);
  const maxTokens = req.maxTokens || 90;

  const text = await inferStage('dialog', async (pipe) => {
    if (typeof pipe !== 'function') return null;
    const out = await pipe(prompt, {
      max_new_tokens: maxTokens,
      repetition_penalty: 1.2,
      no_repeat_ngram_size: 3,
      do_sample: true,
      temperature: 0.6
    });
    const first = Array.isArray(out) ? out[0] : out;
    return (first && (first.generated_text || first.text)) ? String(first.generated_text || first.text).trim() : null;
  }, { retain: opts.retain === true });

  if (!text || text.length < 3 || /^(ok|done|yes|no|\.+)$/i.test(text)) {
    throw new ModelError(
      'E_INFER',
      'dialog',
      'The dialog model produced no usable response.',
      'Retry the request; the reply generator was loaded but returned empty or degenerate output.',
      null
    );
  }
  yield { text };
}

// Self-register as the default provider.
export const transformersBackend = registerBackend(createBackend({
  id: 'transformers',
  label: 'Transformers.js (on-device)',
  kind: 'transformers',
  canTools: false,
  health,
  embed,
  generate
}));

export { formatModelError, ROLE_TO_STAGE, TASK_TO_STAGE };