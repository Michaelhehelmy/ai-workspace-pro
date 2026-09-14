/**
 * app/ai/agent-loop.js - Multi-turn tool-calling agent loop
 *
 * Activates only when the resolved dialog backend supports tool calling
 * (`backend.canTools === true`, e.g. Ollama with a tool-capable model). It
 * drives an OpenAI-style conversation: the backend may respond with tool calls,
 * which we execute through the same runner as the single-shot pipeline, feeding
 * results back until the backend returns a natural-language answer.
 *
 * When no tool-capable backend is configured, `agentLoop` returns `null` and
 * callers keep using the existing single-shot pipeline (classify → rank →
 * execute → compose) — a pure fallback, no behavior lost.
 *
 * The runner is injected to avoid circular imports (same pattern as runPipeline).
 */

import { state } from '../../core/state.js';
import { resolveBackendForStage } from './routing.js';
import { ModelError } from './backend.js';
import { buildSystemPrompt } from '../../core/skills.js';

const DEFAULT_MAX_ITERATIONS = 5;

/**
 * Build OpenAI-style tool schemas from the registered tool list (name,
 * description, parameters) for the backend request.
 */
export function buildToolSchemas(tools) {
  if (!Array.isArray(tools) || !tools.length) return [];
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: (t.description || '').slice(0, 1024),
      parameters: (t.parameters && { type: 'object', properties: t.parameters.properties || {}, required: t.parameters.required }) || { type: 'object', properties: {} }
    }
  }));
}

/**
 * Normalize a yielded toolCall into `{ name, args }` (args already parsed).
 * Falls back to text-only routing if the tool call is unusable.
 */
function normalizeToolCall(tc) {
  if (!tc || !tc.function) return null;
  const name = tc.function.name || '';
  if (!name) return null;
  let args = {};
  const raw = tc.function.arguments;
  if (typeof raw === 'string' && raw.trim()) {
    try { args = JSON.parse(raw); } catch (_) { args = {}; }
  } else if (raw && typeof raw === 'object') {
    args = raw;
  }
  return { name, args };
}

/**
 * Run the multi-turn agent loop.
 *
 * `onStep` (optional) is invoked as the loop works so callers can render
 * intermediate progress: `{ type: 'tool_start', name, args, iteration }` then
 * `{ type: 'tool_end', name, result, iteration, ok }`.
 *
 * `signal` (optional): when aborted the loop stops cleanly at the next
 * iteration boundary and returns `{ interrupted: true, ... }`.
 *
 * Returns:
 *   null            — no tool-capable backend → caller falls back to single-shot
 *   { answer, text, iterations, toolCalls, steps } — completed agent conversation
 *   { interrupted, iterations, toolCalls, steps }  — stopped via `signal`
 *   { error }       — model/inference failure, caller decides how to handle
 */
export async function agentLoop({
  message,
  persona,
  maxTokens = 256,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  runner,
  query = message,
  stateInstance = state,
  systemPrompt,
  tools,
  onStep,
  signal
} = {}) {
  if (typeof runner !== 'function') return null;

  const backend = resolveBackendForStage('dialog');
  if (!backend || backend.id === 'transformers' || backend.canTools !== true) return null;

  const halted = () => !!(signal && signal.aborted);

  // Identity-first system prompt built from the active character (name, persona,
  // workspace, matching skill directives) so the model can answer "what is your
  // name?", accept renames, and apply persona consistently across turns. Callers
  // may override it entirely (e.g. the dedicated coding-agent persona).
  let systemPromptResolved = systemPrompt;
  if (!systemPromptResolved) {
    const activeChar = (stateInstance.config && Array.isArray(stateInstance.config.characters))
      ? stateInstance.config.characters.find(c => c.id === stateInstance.activeCharacterId) || null
      : null;
    const activeBiz = (stateInstance.config && Array.isArray(stateInstance.config.businesses))
      ? stateInstance.config.businesses.find(b => b.id === stateInstance.activeBusinessId) || null
      : null;
    const char = activeChar || (persona ? { name: 'Assistant', systemPrompt: persona } : null);
    systemPromptResolved = buildSystemPrompt(char, activeBiz, {
      message,
      appName: stateInstance.config && stateInstance.config.app && stateInstance.config.app.name
    });
  }

  // Tools available to the backend: callers may inject a restricted set (e.g.
  // the coding agent only exposes workspace tools); otherwise all config tools.
  const toolDefs = tools || ((stateInstance.config && stateInstance.config.tools) || []).map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const toolSchemas = buildToolSchemas(toolDefs);

  const messages = [];
  const allToolCalls = [];
  const steps = [];

  // Turn 0 — seed recent conversation so the model has memory, then the task.
  const history = (stateInstance.chatHistory || []).slice(-8);
  for (const h of history) {
    if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim()) {
      messages.push({ role: h.role, content: h.content.slice(0, 2000) });
    }
  }
  messages.push({
    role: 'user',
    content: `Task: ${String(message || '').slice(0, 2000)}`
  });

  let answer = null;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (halted()) return { interrupted: true, iterations: iteration, toolCalls: allToolCalls, steps };

    const toolCalls = [];
    const textChunks = [];

    try {
      for await (const chunk of backend.generate({
        system: systemPromptResolved,
        messages,
        tools: toolSchemas,
        maxTokens
      })) {
        if (chunk && chunk.toolCall) {
          const tc = normalizeToolCall(chunk.toolCall);
          if (tc) {
            tc.id = (chunk.toolCall && chunk.toolCall.id) || `call_${iteration}_${toolCalls.length}`;
            toolCalls.push(tc);
          }
        } else if (chunk && chunk.text) {
          textChunks.push(chunk.text);
        }
      }
    } catch (err) {
      if (err instanceof ModelError) {
        return { error: { code: err.code, stage: err.stage, message: err.message, fix: err.fix } };
      }
      throw err;
    }

    // No tool calls → the model answered in prose (or produced nothing usable).
    if (!toolCalls.length) {
      const text = textChunks.join('').trim();
      answer = text.length >= 3 ? text : null;
      return { answer, text, iterations: iteration + 1, toolCalls: allToolCalls, steps };
    }

    // Execute each tool call and feed the result back into the conversation.
    const assistantContent = textChunks.join('').trim();
    const assistantMsg = { role: 'assistant', content: assistantContent || null };
    if (toolCalls.length) {
      assistantMsg.tool_calls = toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) }
      }));
    }
    messages.push(assistantMsg);

    for (const tc of toolCalls) {
      allToolCalls.push({ name: tc.name, args: tc.args, id: tc.id, iteration });
      if (typeof onStep === 'function') {
        onStep({ type: 'tool_start', name: tc.name, args: tc.args, iteration });
      }
      let result;
      let ok = true;
      try {
        result = await runner(tc.name, { ...tc.args, query: query || message });
      } catch (err) {
        ok = false;
        result = { text: `⚠️ ${err.message}` };
      }
      const resultText = (result && typeof result === 'object' && (result.text || result.error))
        ? (result.text || result.error)
        : (typeof result === 'string' ? result : JSON.stringify(result || {}));
      const content = String(resultText).slice(0, 4000);
      steps.push({ name: tc.name, args: tc.args, result: content, iteration, ok });
      if (typeof onStep === 'function') {
        onStep({ type: 'tool_end', name: tc.name, result: content, iteration, ok });
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content });
    }
  }

  // Ran out of iterations without a natural-language answer.
  return { answer: null, text: null, iterations: maxIterations, toolCalls: allToolCalls, steps };
}