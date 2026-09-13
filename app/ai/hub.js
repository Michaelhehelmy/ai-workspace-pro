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

export async function discoverModels(type, { limit = 25, signal } = {}) {
  if (!isBrowser) return [];
  const max = Math.min(Math.max(limit || 25, 1), 100);
  const params = new URLSearchParams();
  params.set('library', 'transformers.js');
  params.set('sort', 'downloads');
  params.set('direction', '-1');
  params.set('limit', '100');
  const base = 'https://huggingface.co/api/models?' + params.toString();
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
  const res = await fetch('https://huggingface.co/api/models/' + String(id) + '?blobs=true', {
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