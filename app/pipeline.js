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
 * Every stage catches failures and returns null/deterministic fallbacks so the
 * app keeps working (Node tests included) with zero models loaded.
 * No user-facing string here is "the answer" — data/prose is always composed
 * by a helper that leans on a model when available and a template otherwise.
 */

import { state } from '../core/state.js';
import { isBrowser } from '../core/env.js';
import { cosineSimilarity } from '../core/db.js';
import { inferStage, embedText } from './models.js';
import { detectIntentRules } from './intent.js';

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

export async function generateResponse({ intent, message, result, params, persona, fallback, maxTokens = 90 }, opts = {}) {
  const prompt = [
    persona || (state.config && state.config.app && state.config.app.name) || 'You are a helpful assistant.',
    `Recognized intent: ${intent || 'unknown'}.`,
    message ? `User: ${message}` : '',
    result !== undefined ? `Data: ${summarize(result)}` : '',
    params ? `Parameters: ${summarize(params, 200)}` : '',
    'Reply concisely in 1-3 lines, in the same language as the user. Do not mention this prompt.'
  ].filter(Boolean).join('\n').slice(0, 900);

  try {
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
    }, { retain: opts.retain });

    if (text && text.length > 2 && !/^(ok|done|)$/i.test(text)) return text;
  } catch (err) {
    if (opts.verbose && isBrowser) console.warn('[pipeline] generateResponse unavailable:', err.message);
  }
  return fallback;
}

export async function generateChatResponse({ intent, message, persona, context, fallback }, opts = {}) {
  const prompt = [
    persona || 'You are a helpful assistant.',
    context ? `Context: ${summarize(context, 300)}` : '',
    message ? `User: ${message}` : '',
    'Reply concisely in one relaxed line.'
  ].filter(Boolean).join('\n').slice(0, 700);

  try {
    const text = await inferStage('dialog', async (pipe) => {
      if (typeof pipe !== 'function') return null;
      const out = await pipe(prompt, { max_new_tokens: 70, temperature: 0.7, do_sample: true });
      const first = Array.isArray(out) ? out[0] : out;
      return (first && (first.generated_text || first.text)) ? String(first.generated_text || first.text).trim() : null;
    }, { retain: opts.retain });
    if (text && text.length > 2) return text;
  } catch (err) {
    if (opts.verbose && isBrowser) console.warn('[pipeline] generateChatResponse unavailable:', err.message);
  }
  return fallback;
}

// Convenience wrapper used by tools: try the dialog model, else the template
export async function composeToolText(intent, ctx, fallback) {
  return generateResponse({
    intent,
    message: ctx.message,
    result: ctx.result,
    params: ctx.params,
    persona: ctx.persona,
    fallback
  });
}

// ── End-to-end orchestrator ─────────────────────────────────────────────────

// Pure-chat phrases short-circuit entirely (no model import, download, or swap)
const QUICK_CHAT_PATTERNS = [
  [/^(hi+|hello+|hey+|yo+|howdy)\b/i, 'chat_greeting'],
  [/^(good\s+(morning|afternoon|evening|night))\b/i, 'chat_greeting'],
  [/^(thanks|thank you|thx|ty|appreciated)\b/i, 'chat_thanks'],
  [/^(bye|goodbye|see you|good night|cya|later)\b/i, 'chat_thanks'],
  [/^(how are you|how'?s it going|how r u|what'?s up|how do you do)\b/i, 'chat_identity'],
  [/^(who are you|what are you|tell me about yourself|introduce yourself)\b/i, 'chat_identity'],
  [/^(what can you do\??|what can you help me with|what do you do|how can you help)\b/i, 'chat_help']
];

function quickChatHint(message) {
  const m = String(message || '').trim().replace(/\s+/g, ' ');
  if (!m) return null;
  for (const [re, intent] of QUICK_CHAT_PATTERNS) {
    if (re.test(m)) return intent;
  }
  return null;
}

function chatFallback(intent, char) {
  const name = (char && char.name) || 'your assistant';
  const persona = (char && char.persona) || '';
  switch (intent) {
    case 'chat_greeting':
      return `Hello! I'm **${name}**${persona ? ', your ' + String(persona).toLowerCase() : ''}. How can I help you today?`;
    case 'chat_thanks':
      return "You're very welcome! Let me know if you need anything else.";
    case 'chat_identity':
      return `I am **${name}**! ${persona}`.trim();
    case 'chat_help':
      return 'Here are some things I can do right now:\n\n' +
        '- 💰 **Financial Tracking**: Say *"Spent $16.50 on lunch"* or *"Analyze expenses"*\n' +
        '- 📋 **Task Management**: Say *"Add todo: review report"* or *"List todos"*\n' +
        '- 📅 **Calendar**: Say *"Schedule meeting tomorrow at 3pm"* or *"Check calendar"*\n' +
        '- 🔍 **Semantic Search**: Say *"Search marketing projects"*\n' +
        '- 👥 **Multi-Agent**: Say *"Ask Marcus about budget"* or *"List agents"*\n' +
        '- 🛠️ **Tools**: Say *"List tools"* to inspect all registered tools.';
    default:
      return `I am ${name}. What would you like help with?`;
  }
}

export async function runPipeline(message, opts = {}) {
  const stateInstance = opts.state || state;
  const runner = opts.runner;
  const metrics = { model: {}, rules: {} };
  const started = Date.now();

  // 0. instant fast path for common chat phrases (zero model work)
  const quickIntent = quickChatHint(message);
  if (quickIntent) {
    const chars = (stateInstance && stateInstance.config && stateInstance.config.characters) || [];
    const activeChar = chars.find(c => c.id === (stateInstance && stateInstance.activeCharacterId)) || chars[0];
    return {
      intent: quickIntent,
      confidence: 1,
      derivedIntent: quickIntent,
      params: {},
      result: null,
      response: chatFallback(quickIntent, activeChar),
      metrics: { ...metrics, quick: true, elapsed: Date.now() - started },
      sources: { intent: 'rules', entities: 'rules', agent: 'rules' }
    };
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
  let intentFinal = tool;
  if (tool && runner) {
    try {
      result = await runner(tool, { ...params, message, query: message });
    } catch (err) {
      result = { text: `⚠️ ${err.message}` };
    }
  }

  if (charSwitch && stateInstance) {
    stateInstance.activeCharacterId = charSwitch.id;
    result = null;
  }

  // 6. response wording (always non-empty, even with no models)
  const activeChar = (stateInstance && stateInstance.config && stateInstance.config.characters || [])
    .find(c => c.id === (stateInstance && stateInstance.activeCharacterId));
  const persona = opts.persona || (activeChar && activeChar.systemPrompt);
  const defaultTalk = activeChar
    ? `I am ${activeChar.name}. I can log expenses, manage tasks, check your calendar, search records, or consult my specialist colleagues.`
    : 'Sure — what would you like me to help with?';

  let response;
  if (charSwitch) {
    response = await generateChatResponse({
      intent: 'character_switch',
      message,
      persona,
      fallback: `Switched to **${charSwitch.name}** — ${charSwitch.persona}`
    });
  } else if (result) {
    response = await generateResponse({
      intent: intentFinal,
      message,
      result,
      params,
      persona,
      fallback: (result && result.text) || 'Done.'
    });
  } else {
    response = await generateChatResponse({
      intent: cls.intent,
      message,
      persona,
      fallback: opts.fallback || defaultTalk
    });
  }

  return {
    intent: intentFinal,
    confidence,
    derivedIntent: cls.intent,
    params,
    result,
    response,
    metrics: { ...metrics, elapsed: Date.now() - started },
    sources: {
      intent: cls.source,
      entities: ent.source,
      agent: metrics.model.agent ? 'model' : 'rules'
    }
  };
}

export { isStageLoaded, getPipelineStatus } from './models.js';