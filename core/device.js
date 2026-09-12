/**
 * core/device.js - Device Profiling & Model Recommendation
 * Pure logic: detect form factor, GPU, cores, memory, network → tier → recommend models.
 * All probes are injectable for hermetic testing.
 */

export const DEVICE_TIERS = Object.freeze({ LOW: 'low', MID: 'mid', HIGH: 'high' });

const TIER_ORDER = [DEVICE_TIERS.LOW, DEVICE_TIERS.MID, DEVICE_TIERS.HIGH];

/** Approximate size multiplier vs listed q8 size (listed = q8 baseline) */
const DTYPE_MEM_FACTOR = Object.freeze({ q8: 1.0, int8: 0.55, uint8: 0.55, fp16: 1.6, fp32: 3.2 });

/** Memory budget per tier for fit verdict thresholds (MB) */
const TIER_BUDGET_MB = Object.freeze({
  low:  { ideal: 200, heavy: 400 },
  mid:  { ideal: 350, heavy: 700 },
  high: { ideal: 800, heavy: 1200 },
});

/** Default catalog recommendation table keyed by tier + pipeline stage */
const RECOMMENDATION_TABLE = Object.freeze({
  low: {
    encoder: 'Xenova/all-MiniLM-L6-v2',
    intent:  'Xenova/mobilebert-uncased-mnli',
    tagger:  'Xenova/bert-base-NER',
    dialog:  'Xenova/LaMini-Flan-T5-248M',
    dtype:   'q8',
  },
  mid: {
    encoder: 'Xenova/bge-small-en-v1.5',
    intent:  'Xenova/mobilebert-uncased-mnli',
    tagger:  'Xenova/bert-base-NER',
    dialog:  'Xenova/LaMini-Flan-T5-248M',
    dtype:   'q8',
  },
  high: {
    encoder: 'Xenova/bge-base-en-v1.5',
    intent:  'Xenova/mobilebert-uncased-mnli',
    tagger:  'Xenova/bert-base-NER',
    dialog:  'Xenova/LaMini-Flan-T5-248M',
    dtype:   'q8',
  },
});

/**
 * Default probes object. Each key is a function returning a value (or null/undefined if unavailable).
 * Probes are synchronous and use browser globals; inject fakes in tests.
 */
export function defaultProbes() {
  return {
    formFactor: () => null,
    gpu:        () => null,
    cores:      () => (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null),
    memoryMb:   () => (typeof navigator !== 'undefined' ? (navigator.deviceMemory || null) : null),
    wasmSimd:   () => {
      try {
        if (typeof WebAssembly === 'undefined') return false;
        const mod = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]));
        return WebAssembly.Module.exports(mod).some(e => e.name === 'f32x4_as_bool');
      } catch { return false; }
    },
    wasm:       () => (typeof WebAssembly !== 'undefined'),
    network:    () => {
      try {
        const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!c) return null;
        return { effectiveType: c.effectiveType, downlink: c.downlink, saveData: !!c.saveData };
      } catch { return null; }
    },
    battery:    () => null,
  };
}

/**
 * Detect device profile from probes (all injectable).
 * @param {object} [probes] - Probe functions; defaults to browser probes.
 * @returns {object} DeviceProfile
 */
export function detectDevice(probes) {
  const p = probes || defaultProbes();
  const ff = (typeof p.formFactor === 'function' ? p.formFactor() : null) || 'unknown';
  const gpuRaw = typeof p.gpu === 'function' ? p.gpu() : null;
  const gpuKind = parseGpuKind(gpuRaw);
  const cores = clampInt(typeof p.cores === 'function' ? p.cores() : null, 1, 128);
  const memoryMb = clampInt(typeof p.memoryMb === 'function' ? p.memoryMb() : null, 0, 102400);
  const wasmSimd = typeof p.wasmSimd === 'function' ? !!p.wasmSimd() : false;
  const wasm = typeof p.wasm === 'function' ? !!p.wasm() : false;
  const net = typeof p.network === 'function' ? p.network() : null;
  const battery = typeof p.battery === 'function' ? p.battery() : null;

  const score = scoreDeviceRaw(ff, gpuKind, cores, memoryMb, wasmSimd, wasm);
  const tier = scoreToTier(score);
  const summary = describeDevice({ formFactor: ff, gpuKind, cores, memoryMb, wasmSimd, wasm, network: net, battery, score, tier });

  return Object.freeze({
    formFactor: ff,
    gpuKind,
    gpuLabel: gpuLabelFromRaw(gpuRaw),
    cores,
    memoryMb,
    wasm,
    wasmSimd,
    network: net ? Object.freeze({ ...net }) : null,
    battery: battery ? Object.freeze({ ...battery }) : null,
    score,
    tier,
    summary,
  });
}

/** Score a raw device (internal). Returns 0-100. */
function scoreDeviceRaw(formFactor, gpuKind, cores, memoryMb, wasmSimd, wasm) {
  let s = 0;
  // form factor (0-34)
  if (formFactor === 'desktop') s += 34;
  else if (formFactor === 'laptop') s += 24;
  else if (formFactor === 'tablet') s += 18;
  else if (formFactor === 'phone') s += 10;
  else s += 14; // unknown/other
  // cores (0-22)
  if (cores <= 4) s += 6;
  else if (cores <= 8) s += 14;
  else s += 22;
  // memory (0-32)
  if (memoryMb > 0) {
    if (memoryMb <= 2048) s += 6;
    else if (memoryMb <= 4096) s += 14;
    else if (memoryMb <= 8192) s += 22;
    else s += 32;
  } else {
    s += 14; // unknown memory — assume mid-range
  }
  // GPU (0-22); software renderers (SwiftShader) count as none
  if (gpuKind === 'webgpu') s += 22;
  else if (gpuKind === 'webgl2') s += 12;
  else if (gpuKind === 'webgl1') s += 6;
  else if (gpuKind === 'swiftshader') s += 0;
  else s += 0;
  return Math.min(100, Math.max(0, s));
}

function scoreToTier(score) {
  if (score < 45) return DEVICE_TIERS.LOW;
  if (score < 70) return DEVICE_TIERS.MID;
  return DEVICE_TIERS.HIGH;
}

/** Grade a model against device budget. Returns { score, verdict, reason } */
export function getModelFit(profile, meta) {
  if (!profile || !meta) return { score: 0, verdict: 'unknown', reason: 'Missing profile or model metadata' };
  const tier = profile.tier || DEVICE_TIERS.MID;
  const budget = TIER_BUDGET_MB[tier] || TIER_BUDGET_MB.mid;
  const dtypeFactor = DTYPE_MEM_FACTOR[profile.dtype] || 1.0;
  const effectiveMb = (meta.sizeMb || 0) * dtypeFactor;
  let verdict, score;

  if (effectiveMb <= budget.ideal) {
    verdict = 'ideal';
    score = 100;
  } else if (effectiveMb <= budget.heavy) {
    verdict = 'ok';
    score = 70 - Math.round(((effectiveMb - budget.ideal) / (budget.heavy - budget.ideal)) * 30);
  } else {
    const excess = effectiveMb - budget.heavy;
    verdict = excess > 200 ? 'too-heavy' : 'heavy';
    score = Math.max(10, 40 - Math.round(excess / 20));
  }

  const reason = formatFitReason(meta, effectiveMb, budget, tier, verdict);
  return Object.freeze({ score, verdict, reason });
}

/** Recommend model set for a device profile. Returns { tier, dtype, stages, notes } */
export function recommendModelSet(profile, catalog) {
  if (!profile) return { tier: DEVICE_TIERS.MID, dtype: 'q8', stages: {}, notes: 'No profile; using mid defaults' };
  const tier = profile.tier || DEVICE_TIERS.MID;
  const table = RECOMMENDATION_TABLE[tier] || RECOMMENDATION_TABLE.mid;
  const catMap = Array.isArray(catalog) ? catalog.reduce((m, e) => { m[e.id] = e; return m; }, {}) : {};
  const stages = {};

  for (const key of ['encoder', 'intent', 'tagger', 'dialog']) {
    const modelId = table[key];
    const meta = catMap[modelId] || null;
    stages[key] = Object.freeze({
      model: modelId,
      name: meta ? meta.name : modelId,
      sizeMb: meta ? meta.sizeMb : null,
      reason: meta
        ? `${meta.name} (${meta.sizeMb} MB) — best for ${tier}-tier devices`
        : `${modelId} — default for ${tier}`,
    });
  }

  return Object.freeze({
    tier,
    dtype: table.dtype,
    stages: Object.freeze(stages),
    memory: Object.freeze({ wasmThreads: profile.tier === DEVICE_TIERS.HIGH ? 8 : profile.tier === DEVICE_TIERS.MID ? 4 : 2 }),
    notes: `Recommended for ${tier}-tier (${profile.cores} cores${profile.memoryMb ? ', ' + (profile.memoryMb / 1024).toFixed(0) + ' GB' : ''}${profile.gpuKind !== 'none' ? ', ' + profile.gpuKind : ''})`,
  });
}

/** Human-readable device summary */
export function describeDevice(profile) {
  if (!profile) return 'Unknown device';
  const ff = profile.formFactor && profile.formFactor !== 'unknown' ? profile.formFactor : 'unknown device';
  const parts = [ff.charAt(0).toUpperCase() + ff.slice(1)];
  if (profile.cores) parts.push(`${profile.cores} cores`);
  if (profile.memoryMb) parts.push(`${(profile.memoryMb / 1024).toFixed(0)} GB`);
  if (profile.gpuKind && profile.gpuKind !== 'none') parts.push(profile.gpuKind.toUpperCase());
  else parts.push('integrated GPU');
  if (profile.wasmSimd) parts.push('WASM SIMD');
  const net = profile.network;
  if (net && net.effectiveType) parts.push(net.effectiveType);
  return parts.join(' · ');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseGpuKind(raw) {
  if (!raw) return 'none';
  const s = typeof raw === 'string' ? raw.toLowerCase() : String(raw).toLowerCase();
  if (s.includes('swiftshader')) return 'swiftshader';
  if (s.includes('webgpu')) return 'webgpu';
  if (s.includes('webgl2') || s.includes('webgl 2')) return 'webgl2';
  if (s.includes('webgl')) return 'webgl1';
  return 'none';
}

function gpuLabelFromRaw(raw) {
  if (!raw) return 'No GPU detected';
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') return raw.renderer || raw.vendor || 'GPU detected';
  return String(raw);
}

function clampInt(v, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function formatFitReason(meta, effectiveMb, budget, tier, verdict) {
  const sizeStr = effectiveMb > 0 ? `${Math.round(effectiveMb)} MB` : 'unknown size';
  const budgetStr = `${Math.round(budget.ideal)} MB ideal / ${Math.round(budget.heavy)} MB max`;
  if (verdict === 'ideal') return `${sizeStr} fits ${tier}-budget (${budgetStr})`;
  if (verdict === 'ok') return `${sizeStr} within ${tier}-budget (${budgetStr})`;
  if (verdict === 'heavy') return `${sizeStr} exceeds ${tier}-budget (${budgetStr}) — may be slow`;
  return `${sizeStr} far exceeds ${tier}-budget (${budgetStr}) — not recommended`;
}
