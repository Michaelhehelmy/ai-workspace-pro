/**
 * app/pipeline.js - Multi-Model Message Pipeline
 *
 * Breaks every user message into specialist stages. Each stage is handled by a
 * SMALL on-device model swapped in via the ModelScheduler (one at a time):
 *
 *   classifyIntent  → zero-shot classifier  → which intent / tool
 *   extractEntities → NER (token-classifier) → params (amount, date, targets)
 *   rankTools       → embeddings            → similar tools / records scoring
 *   routeToAgent    → zero-shot + embeddings → best specialist persona
 *   generateResponse→ small T5              → natural language reply
 *
 * Real-models-only: enrichment stages (classify/extract/rank/route) degrade
 * gracefully to their deterministic rule fallbacks, but the *reply* stages
 * (generateResponse / generateChatResponse) never fabricate text — they throw
 * a typed `ModelError` when the dialog model cannot produce a usable output.
 * The orchestrator surfaces that as `ok:false` (with code/fix guidance) for
 * chat-only paths, or falls back to honest data-derived tool text plus a
 * `warning` for paths where a real data operation already succeeded.
 */

import { state } from '../core/state.js';
import { isBrowser } from '../core/env.js';
import { cosineSimilarity } from '../core/db.js';
import { inferStage, embedText, ModelError } from './models.js';
import { detectIntentRules } from './intent.js';
import { resolveBackendForStage } from './ai/routing.js';
import { agentLoop } from './ai/agent-loop.js';
import { buildSystemPrompt } from '../core/skills.js';

export const INTENT_LABELS = [
  'add_transaction', 'analyze_expenses', 'add_todo', 'list_todos', 'add_event',
  'check_calendar', 'create_schema', 'search', 'update_config', 'get_config',
  'add_character', 'add_business', 'create_tool', 'rollback_config', 'list_tools',
  'execute_chain', 'delegate_to_agent', 'ask_agent', 'list_agents',
  'route_to_specialist', 'web_search', 'google_calendar_list', 'google_drive_list',
  'google_sheets_read', 'change_character_name', 'small_talk'
];

function pipelineConf() {
  return state.config && state.config.modelSettings && state.config.modelSettings.pipeline;
}

// ── Stage 1: intent classification ──────────────────────────────────────────
export async function classifyIntent(message, stateInstance = state, opts = {}) {
  const cfg = pipelineConf();
  const threshold = (opts.threshold !== undefined ? opts.threshold : cfg && cfg.threshold) || 0.35;

  try {
    const res = await inferStage('intent', async (pipe) => {
      if (typeof pipe !== 'function') return null;
      let out;
      if (typeof pipe.classify === 'function') {
        out = await pipe.classify(message, INTENT_LABELS, { multi_label: false });
      } else {
        out = await pipe(message, INTENT_LABELS, { multi_label: false });
      }
      const first = Array.isArray(out) ? out[0] : out;
      if (!first) return null;
      const labels = first.labels || [];
      const scores = first.scores || [];
      let best = null;
      for (let i = 0; i < labels.length; i++) {
        if (!best || scores[i] > best.score) best = { label: labels[i], score: scores[i] };
      }
      return best;
    }, { retain: opts.retain });

    if (res && res.label && res.score >= threshold) {
      return { intent: String(res.label), confidence: res.score, source: 'model' };
    }
  } catch (err) {
    if (opts.verbose && isBrowser) console.warn('[pipeline] classifyIntent unavailable:', err.message);
  }
  return { intent: null, confidence: 0, source: 'model' };
}

// ── Stage 2: entity / parameter extraction ──────────────────────────────────
export async function extractEntities(message, stateInstance = state, opts = {}) {
  const out = { params: {}, source: 'rules' };
  const msg = String(message || '').trim();
  if (!msg) return out;

  // NER path (token-classification)
  try {
    const spans = await inferStage('tagger', async (pipe) => {
      if (typeof pipe !== 'function') return null;
      try {
        return await pipe(msg, { aggregation_strategy: 'simple' });
      } catch (_) {
        return (await pipe(msg)) || null;
      }
    }, { retain: opts.retain });

    if (Array.isArray(spans) && spans.length) {
      for (const s of spans) {
        const group = String(s.entity_group || s.entity || s.label || '').toUpperCase();
        const score = s.score || 0;
        if (score < 0.4) continue;
        const value = String(s.word || '').trim();
        if (!value) continue;
        if (group.includes('MONEY') && out.params.amount === undefined) {
          const m = value.replace(/[^0-9.]/g, '') || msg.match(/\$?\s?(\d+(?:\.\d{1,2})?)/)?.[1];
          if (m && !isNaN(parseFloat(m))) out.params.amount = parseFloat(m);
          out.source = 'model';
        } else if (group.includes('DATE') && out.params.date === undefined) {
          const d = value.match(/\d{4}-\d{2}-\d{2}/)?.[0] || value;
          out.params.date = d;
          out.source = 'model';
        } else if ((group.includes('PER') || group.includes('ORG')) ) {
          out.params.target = (out.params.target ? out.params.target + ' ' : '') + value;
          out.source = 'model';
        }
      }
    }
  } catch (err) {
    if (opts.verbose && isBrowser) console.warn('[pipeline] extractEntities unavailable:', err.message);
  }

  // Rule fallbacks merge in
  const amtMatch = msg.match(/\$?\s?(\d+(?:\.\d{1,2})?)/);
  if (out.params.amount === undefined && amtMatch && msg.includes('$')) {
    out.params.amount = parseFloat(amtMatch[1]);
  }
  const dateMatch = msg.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (out.params.date === undefined && dateMatch) out.params.date = dateMatch[1];
  const targetMatch = msg.match(/^(?:delegate|ask)\s+(?:to\s+)?([a-zA-Z0-9_.-]+)[\s:]+/i);
  if (out.params.target === undefined && targetMatch) out.params.target = targetMatch[1];

  return out;
}

// ── Stage 3: tool ranking by semantic similarity ────────────────────────────
const toolEmbeddingCache = { key: null, vecs: null };

async function buildToolVectors(stateInstance) {
  const ms = stateInstance.config && stateInstance.config.modelSettings;
  const all = (stateInstance.config && stateInstance.config.tools) || [];
  const cacheKey = JSON.stringify(
    (ms && ms.pipeline && ms.pipeline.stages) || (ms && { e: ms.embedder })
  ) + '|tools:' + all.map(t => t.name).join(',');
  try {
    if (toolEmbeddingCache.key !== cacheKey) {
      const vecs = [];
      for (const t of all) {
        const text = `${t.name}: ${t.description}`;
        const v = await embedText(text);
        if (v) vecs.push({ name: t.name, vec: v });
      }
      toolEmbeddingCache.key = cacheKey;
      toolEmbeddingCache.vecs = vecs;
    }
  } catch (_) {
    toolEmbeddingCache.key = cacheKey;
    toolEmbeddingCache.vecs = [];
  }
  return toolEmbeddingCache.vecs || [];
}

export async function rankTools(message, stateInstance = state, opts = {}) {
  try {
    const qv = await embedText(String(message || ''));
    if (!qv) return [];
    const vecs = await buildToolVectors(stateInstance);
    const scored = vecs
      .map(t => ({ name: t.name, score: cosineSimilarity(qv, t.vec) }))
      .filter(t => t.score > (opts.minScore || 0.12))
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.topN || 5);
  } catch (err) {
    if (opts.verbose && isBrowser) console.warn('[pipeline] rankTools unavailable:', err.message);
    return [];
  }
}

// ── Stage 4: route to specialist agent ──────────────────────────────────────
export async function routeToAgent(message, opts = {}) {
  const stateInstance = opts.state || state;
  const chars = (stateInstance.config && stateInstance.config.characters) || [];
  if (!chars.length) return { agentId: null, source: 'none' };

  const label = opts.preferredAgentId ||
    (opts.router && typeof opts.router.getBestAgentForQuery === 'function'
      ? (opts.router.getBestAgentForQuery(message) || {}).id
      : null);

  if (label) return { agentId: label, source: 'rules', agent: chars.find(c => c.id === label) || null };

  const candidateLabels = chars.map(c => c.name + ' - ' + (c.persona || ''));
  try {
    const res = await inferStage('intent', async (pipe) => {
      if (typeof pipe !== 'function') {
        return null;
      }
      const out = await pipe(message, candidateLabels, { multi_label: false });
      const first = Array.isArray(out) ? out[0] : out;
      if (!first || !Array.isArray(first.labels)) return null;
      let bestLabel = null, bestScore = -1;
      for (let i = 0; i < first.labels.length; i++) {
        const s = first.scores ? first.scores[i] : 0;
        if (s > bestScore) { bestScore = s; bestLabel = first.labels[i]; }
      }
      return { label: bestLabel, confidence: bestScore };
    }, { retain: opts.retain });

    if (res && res.label) {
      const match = chars.find(c => res.label.toLowerCase().includes(c.name.toLowerCase()));
      if (match) return { agentId: match.id, agent: match, source: 'model', confidence: res.confidence };
    }
  } catch (err) {
    if (opts.verbose && isBrowser) console.warn('[pipeline] routeToAgent unavailable:', err.message);
  }
  return { agentId: null, source: 'none', agent: null };
}

// ── Stage 5: natural-language response generation ───────────────────────────
function summarize(obj, maxLen = 500) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj === 'string') return obj.slice(0, maxLen);
  if (Array.isArray(obj)) return JSON.stringify(obj.slice(0, 8)).slice(0, maxLen);
  if (typeof obj === 'object') {
    try { return JSON.stringify(obj).slice(0, maxLen); } catch (_) { return ''; }
  }
  return String(obj).slice(0, maxLen);
}

const DEGENERATE_OUTPUT = /^(ok|done|yes|no|\.+)$/i;

/**
 * Try to generate via the resolved remote backend for the dialog stage.
 * Returns the text string on success, or null to signal fallback to inferStage.
 */
async function tryRoutedDialog(userContent, maxTokens = 90, { system = '', history = [] } = {}) {
  try {
    const backend = resolveBackendForStage('dialog');
    if (!backend || backend.id === 'transformers') return null;
    const messages = [];
    if (Array.isArray(history)) {
      for (const m of history.slice(-10)) {
        if (m && (m.role === 'user' || m.role === 'assistant') && m.content) {
          messages.push({ role: m.role, content: String(m.content).slice(0, 2000) });
        }
      }
    }
    messages.push({ role: 'user', content: String(userContent || '').slice(0, 3000) });
    const chunks = [];
    for await (const chunk of backend.generate({
      system: String(system || '').slice(0, 3000),
      messages,
      maxTokens
    })) {
      if (chunk && chunk.text) chunks.push(chunk.text);
    }
    return chunks.join('').trim() || null;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve the active character + business into a proper system prompt and a
 * bounded slice of recent chat history for the dialog model. Falls back to the
 * raw `persona` string when no character is configured (tests, bare calls).
 */
function dialogContext(message, persona) {
  const activeChar = (state.config && Array.isArray(state.config.characters))
    ? state.config.characters.find(c => c.id === state.activeCharacterId) || null
    : null;
  const activeBiz = (state.config && Array.isArray(state.config.businesses))
    ? state.config.businesses.find(b => b.id === state.activeBusinessId) || null
    : null;
  const char = activeChar || (persona ? { name: 'Assistant', systemPrompt: persona } : null);
  const system = buildSystemPrompt(char, activeBiz, {
    message,
    appName: state.config && state.config.app && state.config.app.name
  });
  const history = Array.isArray(state.chatHistory) ? state.chatHistory.slice(-10) : [];
  return { system, history };
}

/**
 * Compose a natural-language reply from a completed tool result. This method
 * NEVER fabricates text: if the dialog stage fails to produce a usable output
 * it throws a typed `ModelError` (callers decide fallback vs. honest failure).
 */
export async function generateResponse({ intent, message, result, params, persona, maxTokens = 90 }, opts = {}) {
  const { system, history } = dialogContext(message, persona);
  const userContent = [
    message ? `User: ${message}` : '',
    intent ? `[intent: ${intent}]` : '',
    result !== undefined ? `Data: ${summarize(result)}` : '',
    params ? `Parameters: ${summarize(params, 200)}` : ''
  ].filter(Boolean).join('\n');

  // On-device models get one combined prompt (no system channel).
  const fallbackPrompt = [
    system,
    userContent,
    'Reply concisely in 1-3 lines, in the same language as the user.'
  ].filter(Boolean).join('\n').slice(0, 900);

  // Try the resolved backend (llamacpp / ollama) before falling back to on-device
  let text = await tryRoutedDialog(userContent, maxTokens, { system, history });

  if (!text) {
    text = await inferStage('dialog', async (pipe) => {
      if (typeof pipe !== 'function') return null;
      const out = await pipe(fallbackPrompt, {
        max_new_tokens: maxTokens,
        repetition_penalty: 1.2,
        no_repeat_ngram_size: 3,
        do_sample: true,
        temperature: 0.6
      });
      const first = Array.isArray(out) ? out[0] : out;
      return (first && (first.generated_text || first.text)) ? String(first.generated_text || first.text).trim() : null;
    }, { retain: opts.retain });
  }

  if (!text || text.length < 3 || DEGENERATE_OUTPUT.test(text)) {
    throw new ModelError(
      'E_INFER',
      'dialog',
      'The dialog model produced no usable response.',
      'Retry the request; the reply generator was loaded but returned empty or degenerate output.',
      null
    );
  }
  return text;
}

/**
 * Compose a casual one-line reply for chat-only intents (small talk, unknown).
 * Same contract as generateResponse: throws `ModelError` instead of inventing text.
 */
export async function generateChatResponse({ intent, message, persona, context }, opts = {}) {
  const { system, history } = dialogContext(message, persona);
  const userContent = [
    message ? `User: ${message}` : '',
    context ? `Context: ${summarize(context, 300)}` : ''
  ].filter(Boolean).join('\n');

  const fallbackPrompt = [
    system,
    userContent ? `${userContent}\n` : '',
    'Reply concisely in one relaxed line, in the same language as the user.'
  ].filter(Boolean).join('\n').slice(0, 700);

  let text = await tryRoutedDialog(userContent.slice(0, 300), 70, { system, history });

  if (!text) {
    text = await inferStage('dialog', async (pipe) => {
      if (typeof pipe !== 'function') return null;
      const out = await pipe(fallbackPrompt, { max_new_tokens: 70, temperature: 0.7, do_sample: true });
      const first = Array.isArray(out) ? out[0] : out;
      return (first && (first.generated_text || first.text)) ? String(first.generated_text || first.text).trim() : null;
    }, { retain: opts.retain });
  }

  if (!text || text.length < 3 || DEGENERATE_OUTPUT.test(text)) {
    throw new ModelError(
      'E_INFER',
      'dialog',
      'The dialog model produced no usable response.',
      'Retry the request; the reply generator was loaded but returned empty or degenerate output.',
      null
    );
  }
  return text;
}

/**
 * Convenience wrapper used by tools: try the dialog model for a graceful
 * wording of a REAL data result; if that fails, return the honest
 * data-derived text (`fallback`) instead of inventing anything. Non-model
 * errors propagate so real bugs are never masked.
 */
export async function composeToolText(intent, ctx, fallback) {
  try {
    return await generateResponse({
      intent,
      message: ctx.message,
      result: ctx.result,
      params: ctx.params,
      persona: ctx.persona
    });
  } catch (err) {
    if (err instanceof ModelError) return fallback;
    throw err;
  }
}

// ── End-to-end orchestrator ─────────────────────────────────────────────────
export async function runPipeline(message, opts = {}) {
  const stateInstance = opts.state || state;
  const runner = opts.runner;
  const metrics = { model: {}, rules: {} };
  const started = Date.now();

  // 0. Tool-calling agent loop — activates only when the resolved dialog backend
  //    supports tools (e.g. Ollama). Falls back silently to the single-shot
  //    pipeline below when no tool-capable backend is configured/reachable.
  if (runner) {
    const loop = await agentLoop({
      message,
      persona: opts.persona,
      maxTokens: opts.maxTokens,
      runner,
      query: message,
      stateInstance
    });
    if (loop) {
      if (loop.error) {
        // Model failure → fall through to the single-shot path (honest failure handling)
        metrics.model.loopError = loop.error;
      } else if (loop.answer) {
        return {
          ok: true,
          intent: 'agent_loop',
          confidence: 1,
          derivedIntent: 'agent_loop',
          params: {},
          result: { text: loop.answer },
          response: loop.answer,
          error: null,
          warning: null,
          metrics: { model: { loop: true, iterations: loop.iterations, toolCalls: loop.toolCalls.length }, rules: {}, elapsed: Date.now() - started },
          sources: { intent: 'model', entities: 'rules', agent: 'rules' }
        };
      }
      // loop returned with no answer (max iterations) → fall through
    }
  }

  // 1. classify
  const cls = await classifyIntent(message, stateInstance);
  metrics.model.intent = cls.source === 'model';

  // 2. entities (NER is skippable for social chat)
  const ent = cls.intent === 'small_talk'
    ? { params: {}, source: 'rules' }
    : await extractEntities(message, stateInstance);
  let params = { ...ent.params };

  // 3. tool resolution (model first, embeddings second, rules last)
  let tool = cls.intent && !['small_talk', 'route_to_specialist'].includes(cls.intent) ? cls.intent : null;
  let confidence = cls.confidence;
  let charSwitch = null;

  // 3a. A weak classifier often labels explicit tool/identity requests as
  //     'small_talk'. When a deterministic rule clearly matches a real tool or
  //     character, trust the rule instead of the classifier's small talk.
  if (cls.intent === 'small_talk' && !tool) {
    const rule = detectIntentRules(message, stateInstance);
    if (typeof rule === 'string' && rule) {
      tool = rule;
      metrics.rules.tool = true;
    } else if (rule && typeof rule === 'object' && rule.tool) {
      tool = rule.tool;
      params = { ...params, ...(rule.params || {}) };
      metrics.rules.tool = true;
    } else if (rule && typeof rule === 'object' && rule.id) {
      charSwitch = rule;
    }
  }

  if (!tool && cls.intent !== 'small_talk') {
    const ranked = await rankTools(message, stateInstance, { topN: 3 });
    metrics.model.tool = ranked.length > 0;
    tool = ranked[0] ? ranked[0].name : null;
    if (tool) confidence = ranked[0].score;
  }

  if (!tool && cls.intent !== 'small_talk') {
    const rule = detectIntentRules(message, stateInstance);
    if (typeof rule === 'string' && rule) {
      tool = rule;
      metrics.rules.tool = true;
    } else if (rule && typeof rule === 'object' && rule.tool) {
      tool = rule.tool;
      params = { ...params, ...(rule.params || {}) };
      metrics.rules.tool = true;
    } else if (rule && typeof rule === 'object' && rule.id) {
      charSwitch = rule;
    } else {
      tool = null;
    }
  }

  // 4. delegation targets
  if (tool === 'delegate_to_agent' || tool === 'ask_agent') {
    const route = await routeToAgent(message, {
      state: stateInstance,
      router: opts.router,
      preferredAgentId: params.target
    });
    if (route.agentId) params.targetAgentId = route.agentId;
    metrics.model.agent = route.source === 'model';
  }

  // 5. execute (runner injected to avoid circular imports)
  let result = null;
  if (tool && runner) {
    try {
      result = await runner(tool, { ...params, message, query: message });
    } catch (err) {
      result = { text: `⚠️ ${err.message}` };
    }
  }

  // 6. character switch is a REAL state change → data-derived result text.
  if (charSwitch && stateInstance) {
    stateInstance.activeCharacterId = charSwitch.id;
    const name = charSwitch.name || charSwitch.id;
    result = { text: `Switched active assistant to **${name}**${charSwitch.persona ? ', ' + charSwitch.persona : ''}` };
  }

  // 7. persona for reply composition
  const activeChar = (stateInstance && stateInstance.config && stateInstance.config.characters || [])
    .find(c => c.id === (stateInstance && stateInstance.activeCharacterId));
  const persona = opts.persona || (activeChar && activeChar.systemPrompt);

  const sources = {
    intent: cls.source,
    entities: ent.source,
    agent: metrics.model.agent ? 'model' : 'rules'
  };

  let intentFinal = tool;
  let response = null;
  let warning = null;
  let error = null;

  if (charSwitch) {
    // Data result — no model required, nothing to fabricate.
    intentFinal = 'character_switch';
    response = result.text;
  } else if (result) {
    // A real data operation succeeded → its text is the honest fallback.
    try {
      response = await generateResponse({ intent: intentFinal, message, result, params, persona });
    } catch (err) {
      if (err instanceof ModelError) {
        warning = { code: err.code, stage: err.stage, model: err.model, message: err.message, fix: err.fix };
        response = (result && result.text) ? result.text : null;
      } else {
        throw err;
      }
    }
  } else {
    // Pure chat path (small talk / unknown) — reply must come from the model.
    intentFinal = cls.intent || 'small_talk';
    try {
      response = await generateChatResponse({ intent: intentFinal, message, persona });
    } catch (err) {
      if (err instanceof ModelError) {
        error = { code: err.code, stage: err.stage, model: err.model, message: err.message, fix: err.fix };
        response = null;
      } else {
        throw err;
      }
    }
  }

  return {
    ok: !error,
    intent: intentFinal,
    confidence,
    derivedIntent: cls.intent,
    params,
    result,
    response,
    error,
    warning,
    metrics: { ...metrics, elapsed: Date.now() - started },
    sources
  };
}

export { isStageLoaded, getPipelineStatus } from './models.js';