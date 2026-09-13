// Hugging Face Hub discovery — fetch runnable transformers.js models at
// runtime so the catalog is not limited to what we hardcode in config.json.
// Browser-only; Node never talks to the Hub.
import { isBrowser } from '../../core/env.js';

// Role (as used by modelSettings.availableModels and the pipeline stages) →
// the HF pipeline_tag that produces models usable for that stage's task.
const TYPE_TO_TAG = {
  embedder: 'feature-extraction',
  classifier: 'zero-shot-classification',
  ner: 'token-classification',
};
const T2T_RE = /^(t5|mt5|flan|bart|pegasus|prophetnet|led|m2m100|marian|translation)[_\-0-9a-z]*$/i;

export function typeToTask(type) {
  return TYPE_TO_TAG[type] || null;
}

function isText2Text(m) {
  if ((m.pipeline_tag || '') === 'text2text-generation') return true;
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const arch = tags.find((t) => /^(t5|mt5|flan|bart|pegasus|prophetnet|led|m2m100|marian|translation)/i.test(t));
  return !!arch || (m.pipeline_tag || '').toLowerCase().includes('text2text');
}

// The deployed Worker proxies the Hub API CORS-open (/api/hub/*). Detect it
// once so we prefer the same-origin proxy (HF error pages carry no CORS
// headers, so direct browser fetches can be blocked) and fall back to a direct
// Hub fetch on bare static hosting where no Worker is present.
let workerProbe = null;
export function hasWorkerHubProxy() {
  if (!isBrowser) return Promise.resolve(false);
  if (!workerProbe) {
    workerProbe = fetch('/api/health', { cache: 'no-store' })
      .then(r => r.ok)
      .catch(() => false);
  }
  return workerProbe;
}

async function modelsUrl(params) {
  const query = params.toString();
  return (await hasWorkerHubProxy())
    ? `/api/hub/models?${query}`
    : `https://huggingface.co/api/models?${query}`;
}

export async function discoverModels(type, { limit = 25, signal } = {}) {
  if (!isBrowser) return [];
  const max = Math.min(Math.max(limit || 25, 1), 100);
  const params = new URLSearchParams();
  params.set('library', 'transformers.js');
  params.set('sort', 'downloads');
  params.set('direction', '-1');
  params.set('limit', '100');
  const base = await modelsUrl(params);
  const res = await fetch(base, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('Hugging Face search failed (HTTP ' + res.status + ').');
  const all = await res.json();
  if (!Array.isArray(all)) throw new Error('Hugging Face returned an empty model list.');

  const want = typeToTask(type);
  const matched = [];
  for (const m of all) {
    if (!m || m.gated || !m.id) continue;
    if (type === 'generator' ? isText2Text(m) : (m.pipeline_tag || '') === want) {
      matched.push(m);
    }
    if (matched.length >= max) break;
  }
  return matched.map((m) => ({
    id: m.id,
    name: String(m.id).split('/')[1] || m.id,
    type,
    downloads: Number(m.downloads) || 0,
    tags: Array.isArray(m.tags) ? m.tags : [],
  }));
}

export async function getHubModelInfo(id, { signal } = {}) {
  if (!isBrowser) return null;
  const base = (await hasWorkerHubProxy())
    ? '/api/hub/info?path=' + encodeURIComponent(String(id)) + '&blobs=true'
    : 'https://huggingface.co/api/models/' + String(id) + '?blobs=true';
  const res = await fetch(base, {
    signal,
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error('Model "' + id + '" not found on Hugging Face (HTTP ' + res.status + ').');
  }
  const body = await res.json();
  const siblings = Array.isArray(body.siblings) ? body.siblings : [];
  const sizeBytes = siblings
    .filter((s) => /\.onnx$/i.test(String(s.rfilename || '')))
    .reduce((acc, s) => acc + (Number(s.size) || 0), 0);
  return {
    id,
    gated: !!body.gated,
    hasOnnx: siblings.some((s) => /\.onnx$/i.test(String(s.rfilename || ''))),
    sizeMb: sizeBytes ? Math.round((sizeBytes / 1048576) * 10) / 10 : undefined,
  };
}

const ROLES = ['embedder', 'classifier', 'ner', 'generator'];

/**
 * Seed the catalog from the Hub: the top transformers.js models for each of
 * the four roles, deduped by repo id. Returns catalog-shaped entries
 * ({ id, type, name, sizeMb, downloads, custom, source:'hub' }) ready to be
 * persisted as modelSettings.availableModels. Browser-only — returns [] in
 * Node. Every role fetch is independent so one failure doesn't kill the rest;
 * throws only when every role produced nothing.
 */
export async function bootstrapCatalog({ limit = 5, signal } = {}) {
  if (!isBrowser) return [];
  const perRole = Math.min(Math.max(limit || 5, 1), 15);
  const byId = new Map();
  const errors = [];
  await Promise.all(ROLES.map(async (role) => {
    try {
      const rows = await discoverModels(role, { limit: perRole, signal });
      for (const r of rows) {
        if (byId.has(r.id)) {
          const existing = byId.get(r.id);
          if (r.type === 'generator' && existing.type !== 'generator') byId.set(r.id, r);
          continue;
        }
        byId.set(r.id, r);
      }
    } catch (err) {
      errors.push(err);
    }
  }));
  if (byId.size === 0 && errors.length === ROLES.length) {
    throw new Error('Hugging Face is unreachable — no models could be fetched. Check the network and try again.');
  }
  const out = [];
  for (const r of byId.values()) {
    let sizeMb;
    try {
      const info = await getHubModelInfo(r.id, { signal });
      if (!info || !info.hasOnnx) continue;
      sizeMb = info.sizeMb;
    } catch { sizeMb = undefined; }
    out.push({
      id: r.id,
      type: r.type,
      name: r.name,
      description: `Discovered from Hugging Face · ${Number(r.downloads || 0).toLocaleString()} downloads`,
      sizeMb,
      downloads: Number(r.downloads) || 0,
      custom: true,
      source: 'hub',
    });
  }
  return out;
}