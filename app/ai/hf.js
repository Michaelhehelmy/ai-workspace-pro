// app/ai/hf.js - Hugging Face Hub catalog client (@huggingface/hub surface)
//
// Browser-only counterpart to the @huggingface/hub npm package: search/list
// models, model info (siblings + config), and recursive file trees. The SPA
// mirrors listModels()/getModelInfo()/listModelFiles() behind the Worker's
// /api/hf/* catalog surface (see worker/index.js, Phase B) when present, and
// falls back to direct huggingface.co calls on bare static hosting — the Hub
// API does not send CORS headers on every response, so the worker path is
// preferred whenever the app is hosted on the Worker.
import { isBrowser } from '../../core/env.js';
import { hasWorkerHubProxy } from './hub.js';

const GGUF_RE = /\.gguf$/i;
const ONNX_RE = /\.onnx$/i;
const SAFETENSORS_RE = /\.safetensors$/i;

// Role (modelSettings.availableModels type) → the Hub pipeline_tag that suits
// that stage. Mirrors app/ai/hub.js so searching respects the same mapping.
function matchesType(m, type) {
  if (!type) return true;
  const tag = String((m && m.pipeline_tag) || m && m.tags || '').toLowerCase();
  if (type === 'embedder') return tag === 'feature-extraction';
  if (type === 'classifier') return tag === 'zero-shot-classification';
  if (type === 'ner') return tag === 'token-classification';
  if (type === 'generator') {
    if (tag.startsWith('text2text-') || tag.startsWith('text-generation')) return true;
    const tags = Array.isArray(m.tags) ? m.tags : [];
    return tags.some((t) => /^(t5|mt5|flan|bart|pegasus|prophetnet|led|m2m100|marian|translation)/i.test(t));
  }
  return true;
}

async function fetchApi(url, { signal } = {}) {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('Hugging Face request failed (HTTP ' + res.status + ').');
  return res.json();
}

/**
* Search/list Hub models (listModels equivalent). Returns normalized rows:
  * { id, name, library, pipeline, downloads, likes, gated }. A query performs a
  * real server-side `search`; filter narrows by tag. The app searches the
  * format honestly by tag: the "ONNX" format uses filter=onnx (repos tagged
  * onnx, i.e. Transformers.js conversions) and "GGUF" uses filter=gguf — the
  * library_name= filter alone is too loose (it substring-matches, so
  * library=transformers.js surfaces plain transformers repos that ship no
  * ONNX files). Without any hint it lists the most-downloaded models.
  */
export async function searchHub({ query, library, filter, type, limit = 25, signal } = {}) {
  if (!isBrowser) return [];
  const params = new URLSearchParams();
  if (query) params.set('search', String(query));
  if (library) params.set('library', String(library));
  if (filter) params.set('filter', String(filter));
  if (!query && !library && !filter) {
    params.set('sort', 'downloads');
    params.set('direction', '-1');
  }
  params.set('limit', String(Math.min(Math.max(limit || 25, 1), 100)));
  const proxied = await hasWorkerHubProxy();
  const url = proxied ? '/api/hf/search?' + params : 'https://huggingface.co/api/models?' + params;
  const raw = await fetchApi(url, { signal });
  if (!Array.isArray(raw)) throw new Error('Hugging Face returned an empty model list.');
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object' || !m.id) continue;
    if (type && !matchesType(m, type)) continue;
    out.push({
      id: m.id,
      name: String(m.id).split('/')[1] || m.id,
      library: m.library_name || null,
      pipeline: m.pipeline_tag || null,
      downloads: Number(m.downloads) || 0,
      likes: Number(m.likes) || 0,
      gated: !!m.gated,
      tags: Array.isArray(m.tags) ? m.tags : [],
    });
  }
  return out;
}

/**
 * Model info with siblings + config (getModelInfo equivalent). Sibling sizes
 * come from the `blobs=true` flag both on the worker path (server forwards it)
 * and the direct fallback. Returns normalized { id, gated, pipeline, library,
 * architectures, sizeBytes, files, siblings:[{path,size}] }.
 */
export async function getHubInfo(id, { signal } = {}) {
  if (!isBrowser) return null;
  const proxied = await hasWorkerHubProxy();
  const url = proxied
    ? '/api/hf/info?path=' + encodeURIComponent(String(id))
    : 'https://huggingface.co/api/models/' + String(id) + '?blobs=true&expand%5B%5D=config';
  const body = await fetchApi(url, { signal });
  if (!body || typeof body !== 'object') return null;
  const def = Array.isArray(body.siblings) ? body.siblings : [];
  const siblings = def.map((s) => ({
    path: String(s && s.rfilename || ''),
    size: Number(s && s.size) || 0,
  })).filter((s) => s.path);
  return {
    id,
    gated: !!body.gated,
    pipeline: body.pipeline_tag || null,
    library: body.library_name || null,
    architectures: (body.config && Array.isArray(body.config.architectures)) ? body.config.architectures : [],
    config: body.config || null,
    siblings,
    files: siblings.map((s) => s.path),
    sizeBytes: siblings.reduce((acc, s) => acc + s.size, 0),
  };
}

/**
 * Recursive file tree (`listModelFiles` equivalent). Returns [{ path, size }]
 * for every file, sizes from the Hub tree payload. Revision default "main".
 */
export async function getRepoTree(id, { revision = 'main', signal } = {}) {
  if (!isBrowser) return [];
  const proxied = await hasWorkerHubProxy();
  const query = 'path=' + encodeURIComponent(String(id)) + '&revision=' + encodeURIComponent(String(revision || 'main'));
  const url = proxied
    ? '/api/hf/files?' + query
    : 'https://huggingface.co/api/models/' + String(id) + '/tree/' + encodeURIComponent(String(revision || 'main')) + '?recursive=true';
  const raw = await fetchApi(url, { signal });
  if (!Array.isArray(raw)) throw new Error('Hugging Face returned no file tree.');
  const out = [];
  for (const e of raw) {
    if (!e || e.type !== 'file' || !e.path) continue;
    out.push({ path: e.path, size: Number(e.size) || 0 });
  }
  return out;
}

/** Group a file list into the weight formats the app can run. */
export function categorizeFiles(files) {
  const list = Array.isArray(files) ? files : [];
  const by = (re) => list.filter((f) => f && f.path && re.test(f.path)).sort((a, b) => a.size - b.size);
  return { gguf: by(GGUF_RE), onnx: by(ONNX_RE), safetensors: by(SAFETENSORS_RE) };
}

/** Pick the ONNX file Transformers.js loads: root model.onnx first, then
 * onnx/model.onnx, then the smallest remaining .onnx. */
export function preferredOnnx(onnxFiles) {
  const ranked = (onnxFiles || []).slice().sort((a, b) => {
    const score = (p) => (
      p === 'model.onnx' ? 0 :
      p.endsWith('/model.onnx') ? 1 :
      p.endsWith('.quantized.onnx') ? 2 :
      p.indexOf('.q') !== -1 ? 3 : 4
    );
    return score(a.path) - score(b.path) || a.size - b.size;
  });
  return ranked[0] || null;
}

/** Pick the GGUF quant the app guesses users want: a Q4 file if present
 * (smallest Q4), otherwise the smallest .gguf file. */
export function preferredGguf(ggufFiles) {
  const byQ4 = (ggufFiles || []).filter((f) => /q4_?/i.test(f.path)).sort((a, b) => a.size - b.size);
  return (byQ4[0] || (ggufFiles || [])[0]) || null;
}

/** Bytes → human size label (e.g. "4.2 MB"). */
export function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes >= 1048576) return Math.round((bytes / 1048576) * 10) / 10 + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}