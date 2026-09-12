/**
 * app/intent.js - Message Intent Detection & Tool Call Parsing
 *
 * detectIntent is now model-first: the zero-shot classifier stage (one small
 * model, swapped in via the ModelScheduler) proposes an intent, and the
 * deterministic rule engine (`detectIntentRules`) is the always-available
 * fallback so behavior stays identical when models are unavailable (Node/offline).
 */

import { state } from '../core/state.js';

const VOLATILE_TOOLS = new Set([
  'add_transaction', 'analyze_expenses', 'add_todo', 'list_todos', 'add_event',
  'check_calendar', 'create_schema', 'search', 'update_config', 'get_config',
  'add_character', 'add_business', 'create_tool', 'rollback_config', 'list_tools',
  'execute_chain', 'delegate_to_agent', 'ask_agent', 'list_agents',
  'route_to_specialist', 'web_search', 'google_calendar_list', 'google_drive_list',
  'google_sheets_read', 'change_character_name'
]);

function resolveAgentId(token, config) {
  const normalized = String(token || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const characters = (config && config.characters) || [];
  const match = characters.find(c =>
    (c.id || '').toLowerCase() === normalized ||
    (c.name || '').toLowerCase() === normalized
  );
  return match ? match.id : (normalized || null);
}

export function parseToolCall(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;
  let trimmed = rawInput.trim();
  if (!trimmed) return null;

  // 1. JSON tool call (optionally wrapped in markdown code fences / text)
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0].replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, ''));
      if (parsed && (parsed.tool || parsed.name)) {
        return {
          tool: parsed.tool || parsed.name,
          params: parsed.params || parsed.parameters || {}
        };
      }
    } catch (_) {}
  }

  // 2. XML tool call: <tool name="search"><query>quarterly profit</query></tool>
  const xmlMatch = trimmed.match(/<tool\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/tool>/i);
  if (xmlMatch) {
    const params = {};
    const tagRe = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = tagRe.exec(xmlMatch[2])) !== null) {
      params[m[1]] = m[2].trim();
    }
    return { tool: xmlMatch[1], params };
  }

  // 3. Decorator syntax: @toolName(k1=v1, k2=v2) or @toolName {json}
  const decoratorMatch = trimmed.match(/^@([a-zA-Z0-9_-]+)\s*(?:\(([\s\S]*)\)|\{([\s\S]*)\})?/);
  if (decoratorMatch) {
    const [, name, parenBody, braceBody] = decoratorMatch;
    const params = {};
    const body = (braceBody !== undefined ? braceBody : parenBody) || '';
    if (body.trim()) {
      let parsedParams = null;
      if (braceBody !== undefined) {
        try {
          parsedParams = JSON.parse(braceBody);
        } catch (_) {}
      }
      if (parsedParams) {
        Object.assign(params, parsedParams);
      } else {
        const pairs = body.match(/([a-zA-Z0-9_-]+)\s*=\s*("[^"]*"|'[^']*'|[^,\}\{]+)/g) || [];
        for (const pair of pairs) {
          const eq = pair.indexOf('=');
          const key = pair.slice(0, eq).trim();
          let value = pair.slice(eq + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          } else if (value === 'true') value = true;
          else if (value === 'false') value = false;
          else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
          params[key] = value;
        }
      }
    }
    return { tool: name, params };
  }

  // 4. "use <tool>" prefix
  const useMatch = trimmed.match(/^use\s+(?:the\s+)?([a-zA-Z0-9_-]+)\b/i);
  if (useMatch) {
    return { tool: useMatch[1].toLowerCase(), params: {} };
  }

  return null;
}

export function detectIntentRules(message, stateInstance = state) {
  if (!message || typeof message !== 'string') return null;
  const raw = message.trim();
  if (!raw) return null;
  const value = raw.toLowerCase();
  const config = stateInstance.config;

  // 1. Explicit tool call syntax
  const pc = parseToolCall(raw);
  if (pc && VOLATILE_TOOLS.has(String(pc.tool).toLowerCase())) {
    return { tool: String(pc.tool).toLowerCase(), params: pc.params || {} };
  }

  // 2. Delegation / Agent questions
  const delegateMatch = raw.match(/^delegate\s+(?:to\s+)?([a-zA-Z0-9_.-]+)[\s:]+([\s\S]+)$/i);
  if (delegateMatch) {
    return {
      tool: 'delegate_to_agent',
      params: {
        targetAgentId: resolveAgentId(delegateMatch[1], config),
        message: delegateMatch[2].trim()
      }
    };
  }
  const askMatch = raw.match(/^ask\s+([a-zA-Z0-9_.-]+)[\s:]+([\s\S]+)$/i);
  if (askMatch) {
    return {
      tool: 'ask_agent',
      params: {
        targetAgentId: resolveAgentId(askMatch[1], config),
        message: askMatch[2].trim()
      }
    };
  }

  // 2b. Character name changes (deterministic so weak models can't misroute)
  const nameChange = raw.match(
    /(?:change|rename|set)\s+(?:your(?:self)?'?s?)?\s*name\s*(?:to|as)?\s+([a-z][a-z0-9 _-]{1,32})/i
  ) || raw.match(
    /(?:call yourself|rename yourself|your name is now|you(?:'re| are) now (?:called|known as)|you shall (?:be|henceforth be) known as|from now on (?:your name is|call you|be called))\s+([a-z][a-z0-9 _-]{1,32})/i
  );
  if (nameChange) {
    return { tool: 'change_character_name', params: { name: nameChange[1].trim() } };
  }

  // 3. Character / business switching
  if (/switch (to )?character|set character|use character|switch to /.test(value) && config) {
    const ch = (config.characters || []).find(c => value.includes((c.name || '').toLowerCase()));
    if (ch) return ch;
  }

  // 4. Keyword phrase routing
  const phraseMap = [
    { tool: 'web_search', keys: ['search the web', 'web search', 'search online', 'search the internet', 'search internet'] },
    { tool: 'list_todos', keys: ['list todos', 'show todos', 'my todos', 'todo list', 'list tasks', 'show tasks', 'what tasks', 'show my tasks', 'show me my tasks'] },
    { tool: 'check_calendar', keys: ['check calendar', 'show calendar', 'my calendar', 'list events', 'show events', 'upcoming events', 'upcoming schedule', 'calendar events'] },
    { tool: 'analyze_expenses', keys: ['analyze expenses', 'analyze spending', 'spending analysis', 'financial analysis', 'expense report', 'budget report'] },
    { tool: 'route_to_specialist', keys: ['route to specialist', 'route to an expert', 'route to the best', 'route this to', 'best specialist for', 'who should handle'] },
    { tool: 'create_schema', keys: ['create schema', 'new schema', 'make a schema', 'define schema', 'new table schema'] },
    { tool: 'add_character', keys: ['add character', 'new character', 'create character', 'create persona'] },
    { tool: 'add_business', keys: ['add business', 'new business', 'create business', 'new workspace', 'create workspace', 'add workspace'] },
    { tool: 'create_tool', keys: ['create tool', 'add tool', 'new tool', 'make a tool', 'register tool'] },
    { tool: 'update_config', keys: ['update config', 'change config', 'modify config', 'set config', 'edit config'] },
    { tool: 'rollback_config', keys: ['rollback config', 'undo config', 'revert config', 'restore config'] },
    { tool: 'list_agents', keys: ['list agents', 'show agents', 'team members', 'list specialists', 'list characters'] },
    { tool: 'list_tools', keys: ['list tools', 'show tools', 'available tools', 'list schemas', 'what tools', 'list capabilities'] },
    { tool: 'get_config', keys: ['get config', 'show config', 'read config', 'what is my config'] },
    { tool: 'add_event', keys: ['add event', 'new event', 'create event', 'schedule ', 'remind me', 'set a reminder', 'set reminder', 'book a meeting', 'book meeting'] },
    { tool: 'add_todo', keys: ['add todo', 'new todo', 'create todo', 'add task', 'new task', 'create task', 'todo:'] },
    { tool: 'add_transaction', keys: ['add transaction', 'record transaction', 'log expense', 'record expense', 'log a transaction'] },
    { tool: 'create_document', keys: ['create document', 'make a document', 'write a document', 'create a word file', 'make a word file', 'write a word file', 'create a word document', 'make a word document', 'docx'] },
    { tool: 'create_spreadsheet', keys: ['create spreadsheet', 'make a spreadsheet', 'create excel file', 'create an excel', 'make an excel', 'make a excel', 'spreadsheet file', 'xlsx'] },
    { tool: 'search', keys: ['search for ', 'search ', 'find ', 'look up ', 'query ', 'retrieve ', 'fetch '] }
  ];

  // 5. Money / spending detector
  const hasMoney = /(\bspent\b|\bspend\b|\bbought\b|\bpaid\b|\bcost\b|\breceived\b|\bincome\b)\s*[:$-]?\s*[\$€£]?\s*\d/.test(value) ||
                   /\$\s?\d/.test(value);

  // 6. Plain tool name mentions mapped to intent
  for (const entry of phraseMap) {
    if (entry.keys.some(k => value.includes(k))) {
      return entry.tool;
    }
  }

  if (hasMoney) {
    return 'add_transaction';
  }

  // Money keywords without an amount still hint at transactions
  if (/(expense|transaction|purchase|spending|spent|pay for )/.test(value)) {
    return 'add_transaction';
  }

  return null;
}

/**
 * Model-first intent detection.
 *   - Asks the zero-shot classifier stage for the most likely intent label.
 *   - Label maps to a tool name / structured delegation call.
 *   - Any hiccup (Node, offline, low confidence) falls back to the rules.
 * Returns the same shapes as before: string, {tool, params}, character, or null.
 */
export async function detectIntent(message, stateInstance = state, opts = {}) {
  if (!message || typeof message !== 'string') return null;
  const raw = message.trim();
  if (!raw) return null;

  try {
    if (opts.allowModel !== false) {
      const { classifyIntent } = await import('./pipeline.js');
      const cls = await classifyIntent(raw, stateInstance, { threshold: opts.threshold });
      if (cls.intent && cls.confidence > 0) {
        const label = cls.intent;
        if (label === 'small_talk') return 'small_talk';
        if (label === 'delegate_to_agent' || label === 'ask_agent') {
          const ruleRes = detectIntentRules(raw, stateInstance);
          if (ruleRes && ruleRes.tool) return ruleRes;
        }
        if (VOLATILE_TOOLS.has(label)) return label;
      }
    }
  } catch (_) {}

  return detectIntentRules(raw, stateInstance);
}

export default detectIntent;