/**
 * core/device.js - Device Profiling & Model Recommendation
 * Pure logic: detect form factor, GPU, cores, memory, network → tier → recommend models.
 * All probes are injectable for hermetic testing.
 */

export const DEVICE_TIERS = Object.freeze({ LOW: 'low', MID: 'mid', HIGH: 'high', ULTRA: 'ultra' });

const TIER_ORDER = [DEVICE_TIERS.LOW, DEVICE_TIERS.MID, DEVICE_TIERS.HIGH, DEVICE_TIERS.ULTRA];

/** Approximate size multiplier vs listed q8 size (listed = q8 baseline) */
const DTYPE_MEM_FACTOR = Object.freeze({ q8: 1.0, int8: 0.55, uint8: 0.55, fp16: 1.6, fp32: 3.2 });

/** Memory budget per tier for fit verdict thresholds (MB) */
const TIER_BUDGET_MB = Object.freeze({
  low:  { ideal: 200, heavy: 400 },
  mid:  { ideal: 350, heavy: 700 },
  high: { ideal: 1000, heavy: 2400 },
  ultra:{ ideal: 3500, heavy: 8000 },
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
    intent:  'Xenova/distilbert-base-uncased-mnli',
    tagger:  'Xenova/bert-base-NER',
    dialog:  'Xenova/TinyLlama-1.1B-Chat-v1.0',
    dtype:   'q8',
  },
  ultra: {
    encoder: 'Xenova/bge-large-en-v1.5',
    intent:  'Xenova/deberta-v3-large-mnli',
    tagger:  'Xenova/bert-large-NER',
    dialog:  'Xenova/llama-3.2-3B-Instruct',
    dtype:   'q8',
  },
});

/**
 * Convert navigator.deviceMemory (reported in GB) to MB. The scoring and
 * budgets across this module use MB everywhere, and Chrome reports GB, so
 * previously an 8 GB machine looked like 8 MB and scored as the weakest tier.
 */
export function deviceMemoryToMb(reportedGb) {
  const gb = parseInt(reportedGb, 10);
  if (!Number.isFinite(gb) || gb <= 0) return null;
  return gb * 1024;
}

/**
 * Estimate total RAM in MB. In browsers the only disclosure is
 * navigator.deviceMemory (GB, capped at 8); Firefox/Safari disclose nothing,
 * so we fall back to a conservative core-count-based estimate there.
 */
export function estimateMemoryMb({ deviceMemory, hardwareConcurrency, formFactor }) {
  const reported = deviceMemoryToMb(deviceMemory);
  if (reported !== null) return reported;
  const cores = parseInt(hardwareConcurrency, 10) || 0;
  if (formFactor === 'desktop') {
    if (cores >= 8) return 16384;
    if (cores >= 4) return 8192;
    return 4096;
  }
  if (formFactor === 'tablet') {
    if (cores >= 8) return 8192;
    if (cores >= 4) return 4096;
    return 2048;
  }
  if (cores >= 4) return 4096;
  if (cores >= 2) return 2048;
  return null;
}

/**
 * Classify a device form factor from browser signals. Pure: receives
 * extracted signals so it is testable and safe to run in Node.
 */
export function classifyFormFactor({ mobile, touchPoints, width, ua } = {}) {
  if (!ua) return null;
  if (/^Node\.js/i.test(ua)) return null;
  const isMobile = !!mobile;
  if (isMobile && width > 0) return width > 800 ? 'tablet' : 'phone';
  if (/Tablet|iPad|PlayBook|Silk/i.test(ua)) return 'tablet';
  if (isMobile) return 'phone';
  if (width > 0) {
    if (touchPoints > 0 && width >= 1024) return 'tablet';
    if (width >= 1440) return 'desktop';
    return 'laptop';
  }
  if (ua.includes('Windows') || ua.includes('Macintosh') || ua.includes('X11') || ua.includes('CrOS')) return 'laptop';
  return null;
}

/** Best-effort GPU string for parseGpuKind (browser only, never throws). */
export function defaultGpuLabel() {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    const gl2 = canvas.getContext('webgl2');
    if (gl2) {
      const info = gl2.getExtension('WEBGL_debug_renderer_info');
      const renderer = info ? String(gl2.getParameter(info.UNMASKED_RENDERER_WEBGL) || '') : '';
      return renderer ? `WebGL 2.0 (${renderer})` : 'WebGL 2.0';
    }
    if (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) return 'WebGL 1.0';
    return null;
  } catch { return null; }
}

/** Default probes object. Each key is a function returning a value (or null/undefined if unavailable). */
export function defaultProbes() {
  return {
    formFactor: () => {
      if (typeof navigator === 'undefined') return null;
      return classifyFormFactor({
        mobile: typeof navigator.userAgentData !== 'undefined' && navigator.userAgentData ? !!navigator.userAgentData.mobile : null,
        touchPoints: typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0,
        width: typeof window !== 'undefined' && window.screen && window.screen.width ? window.screen.width : 0,
        ua: (typeof navigator.userAgent === 'string' && navigator.userAgent) || ''
      });
    },
    gpu: defaultGpuLabel,
    cores: () => (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null),
    memoryMb: () => {
      if (typeof navigator === 'undefined') return null;
      let formFactor = null;
      if (navigator.userAgent) {
        formFactor = classifyFormFactor({
          mobile: typeof navigator.userAgentData !== 'undefined' && navigator.userAgentData ? !!navigator.userAgentData.mobile : null,
          touchPoints: typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0,
          width: typeof window !== 'undefined' && window.screen && window.screen.width ? window.screen.width : 0,
          ua: navigator.userAgent
        });
      }
      return estimateMemoryMb({
        deviceMemory: navigator.deviceMemory,
        hardwareConcurrency: navigator.hardwareConcurrency,
        formFactor
      });
    },
    wasmSimd: () => {
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
  if (score < 90) return DEVICE_TIERS.HIGH;
  return DEVICE_TIERS.ULTRA;
}

/** Grade a model against device budget. Returns { score, verdict, reason } */
export function getModelFit(profile, meta) {
  if (!profile || !meta) return { score: 0, verdict: 'unknown', reason: 'Missing profile or model metadata' };
  const tier = profile.tier || DEVICE_TIERS.MID;
  const budget = TIER_BUDGET_MB[tier] || TIER_BUDGET_MB.mid;
  // Real RAM beats generic tier caps: a 4GB+ device can host meaningfully
  // more than the conservative tier defaults, so grade against the actual
  // disclosed memory (a 1B q8 generator is ~2.3GB resident, not "too heavy"
  // on every machine with 8GB+).
  let ideal = budget.ideal;
  let heavy = budget.heavy;
  if (profile.memoryMb && profile.memoryMb >= 4096) {
    ideal = Math.max(ideal, Math.round(profile.memoryMb * 0.25));
    heavy = Math.max(heavy, Math.round(profile.memoryMb * 0.5));
  }
  const dtypeFactor = DTYPE_MEM_FACTOR[profile.dtype] || 1.0;
  const effectiveMb = (meta.sizeMb || 0) * dtypeFactor;
  let verdict, score;

  if (effectiveMb <= ideal) {
    verdict = 'ideal';
    score = 100;
  } else if (effectiveMb <= heavy) {
    verdict = 'ok';
    score = 70 - Math.round(((effectiveMb - ideal) / (heavy - ideal)) * 30);
  } else {
    const excess = effectiveMb - heavy;
    verdict = excess > 200 ? 'too-heavy' : 'heavy';
    score = Math.max(10, 40 - Math.round(excess / 20));
  }

  const reason = formatFitReason(meta, effectiveMb, { ideal, heavy }, tier, verdict);
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
    memory: Object.freeze({
      wasmThreads: profile.tier === DEVICE_TIERS.ULTRA ? 16 : profile.tier === DEVICE_TIERS.HIGH ? 8 : profile.tier === DEVICE_TIERS.MID ? 4 : 2
    }),
    notes: `Recommended for ${tier}-tier (${profile.cores} cores${profile.memoryMb ? ', ' + (profile.memoryMb / 1024).toFixed(0) + ' GB' : ''}${profile.gpuKind !== 'none' ? ', ' + profile.gpuKind : ''})`,
  });
}

/** Human-readable device summary */
export function describeDevice(profile) {
  if (!profile) return 'Unknown device';
  const ff = profile.formFactor && profile.formFactor !== 'unknown' ? profile.formFactor : 'unknown device';
  const parts = [ff.charAt(0).toUpperCase() + ff.slice(1)];
  if (profile.cores) parts.push(`${profile.cores} cores`);
  if (profile.memoryMb) {
    const gb = Math.round(profile.memoryMb / 1024);
    parts.push(profile.memoryMb >= 8192 ? `≥${gb} GB` : `${gb} GB`);
  }
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
