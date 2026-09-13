/**
 * app/coding.js — the in-app coding agent.
 *
 * Two working modes, always honest:
 *
 *  1. Deterministic recognition (`recognizeCodingRequest`) — maps natural
 *     phrasings about the workspace ("list files", "read config.json",
 *     "replace X with Y in app.js") to one of the workspace tools with
 *     extracted arguments. Missing arguments are ASKED for, never guessed.
 *     File content is never fabricated: a create/edit only writes the exact
 *     content the user supplies.
 *
 *  2. Tool-calling agent loop — when the resolved dialog backend supports tool
 *     calls (e.g. Ollama with a tool-capable model), open-ended requests that
 *     the recognizer doesn't match are handed to `agentLoop` with a dedicated
 *     Coder persona and a restricted workspace-only toolset.
 *
 * The module never imports app/ui or app/execute (no cycles): `runCodingAgent`
 * receives the injected `runner` (the same permission-gated executor as the
 * main pipeline).
 */

import { state } from '../core/state.js';
import { toolRegistry } from '../core/tools.js';
import { getWorkspaceAdapter } from '../core/workspace.js';
import { buildSystemPrompt } from '../core/skills.js';
import { agentLoop, buildToolSchemas } from './ai/agent-loop.js';

export const WORKSPACE_TOOLS = [
  'list_workspace',
  'read_workspace_file',
  'write_workspace_file',
  'edit_workspace_file',
  'append_workspace_file',
  'delete_workspace_file'
];

export const CODER_PERSONA = `You are the Coder, a coding agent that lives inside a browser-hosted AI workspace. Your only way to touch the user's files is through the workspace tool calls — never invent file contents, and never claim a change you didn't actually make. Read files before editing them. Prefer matching the existing code style. After each change, report the exact file and what changed (bytes / diff lines). If a value is missing, ask for it.`;

export function buildCoderSystemPrompt(message) {
  return buildSystemPrompt({ name: 'Coder', systemPrompt: CODER_PERSONA }, null, { message, appName: 'AI Workspace Pro' });
}

export function workspaceToolDefs(registry = toolRegistry) {
  const all = registry.getAllTools();
  return all.filter(t => WORKSPACE_TOOLS.includes(t.name)).map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.schema && t.schema.parameters
  }));
}

// ── Natural-language recognition (pure, deterministic) ──────────────────────

const re = {
  list: /\b(list|ls|browse|explore|tree|show files|what('| i)s in|folder contents)\b/i,
  read: /\b(read|open|cat|display|print|show|view)\b/i,
  write: /\b(create|make|add|new|write|generate)\b/i,
  append: /\b(append|add.*\bto\b)\b/i,
  edit: /\b(edit|update|change|replace|fix|swap|modify|find and replace)\b/i,
  remove: /\b(delete|remove|rm)\b/i
};

// Pull a plausible path out of free text: quoted, an extensioned token, or a
// "the <name> file" phrase. Returns null when nothing looks like a path.
export function extractPathToken(text) {
  if (!text) return null;
  const quoted = (text.match(/["'`]([^"'`]+?)["'`]/) || [])[1];
  if (quoted && !/\s/.test(quoted) && !/^(?:file|script|module|config|readme)$/i.test(quoted)) return quoted.trim();
  const ext = text.match(/(?:^|[\s:>])([A-Za-z0-9_@./-]+\.[a-zA-Z0-9]{1,8})(?=[\s,.;:]|$)/);
  if (ext) return ext[1].trim().replace(/[.,;:]+$/, '');
  const phrase = text.match(/(?:the|a) ([\w@./-]+) file\b/i);
  if (phrase && !/^(?:list|show|read|open)/i.test(phrase[1])) return phrase[1].trim();
  return null;
}

// Longest quoted string in the text — the most likely "content" payload.
function extractQuotedContent(text) {
  const matches = Array.from(text.matchAll(/["'`]([^"'`]{2,})["'`]/g)).map(m => m[1]);
  if (!matches.length) return null;
  return matches.sort((a, b) => b.length - a.length)[0].trim();
}

function extractContentArgument(text, path) {
  const quoted = extractQuotedContent(text);
  if (quoted) {
    // A quoted path is not content.
    if (path && quoted === path) {
      const rest = extractQuotedContent(text.replace(quoted, ''));
      if (rest) return rest;
    } else {
      return quoted;
    }
  }
  const afterColon = text.match(/^(?:create|make|add|write|new|generate|append)[\s\S]*?(?:(?:file|script|module|config|readme)|\.[a-zA-Z0-9]{1,8})[^:\n]*:\s*([\s\S]+)$/i);
  if (afterColon && afterColon[1].trim()) return afterColon[1].trim();
  return null;
}

function fileRefText(text, path) {
  return path ? path : extractPathToken(text);
}

// Classify a coding request and extract tool arguments. Returns
//   { intent, tool, params }          — runnable now
//   { intent, ask }                   — needs a missing argument
//   null                              — nothing coding-specific about it
export function recognizeCodingRequest(text) {
  const t = String(text || '').trim();
  if (!t) return null;

  const isWrite = re.write.test(t);
  const isEdit = re.edit.test(t) && !/^\s*(?:create|make|new)\b/i.test(t);
  const isAppend = re.append.test(t);
  const isRemove = re.remove.test(t);
  const isRead = re.read.test(t);
  const isList = re.list.test(t);

  // Reads win over the generic list verb when a path is present.
  if ((isRead || (isAppend && re.edit.test(t))) && !isWrite && !isEdit && !isRemove) {
    let path = extractPathToken(t);
    if (!path) {
      // Verb-adjacent token: "read config.json", "open the readme".
      const verbPath = t.match(/\b(?:read|open|show|cat)\s+(?:the|a|my)?\s*([\w@./-]+)/i);
      if (verbPath && !/^(?:file|files|folder|list|tree|browse)$/i.test(verbPath[1])) path = verbPath[1];
    }
    if (!path && /(file|folder|list|browse|tree)/i.test(t)) {
      return { intent: 'list', tool: 'list_workspace', params: { dir: '.' } };
    }
    if (path && !isList) {
      return { intent: 'read', tool: 'read_workspace_file', params: { path, lines: matchLines(t) } };
    }
    return null;
  }

  if (isRemove) {
    const path = fileRefText(t);
    if (!path) return { intent: 'remove', ask: 'Which file should I delete? (e.g. "delete tmp/scratch.txt"). I’ll ask you to confirm before anything is removed.' };
    return { intent: 'remove', tool: 'delete_workspace_file', params: { path } };
  }

  if (isAppend) {
    const path = fileRefText(t);
    const content = extractContentArgument(t, path);
    if (!path) return { intent: 'append', ask: 'Which file should I append to — and what should I add?' };
    if (!content) return { intent: 'append', ask: `What text should I append to **${path}**?` };
    return { intent: 'append', tool: 'append_workspace_file', params: { path, content } };
  }

  if (isEdit) {
    const r = parseEdit(t);
    if (!r) {
      return {
        intent: 'edit',
        ask: 'Tell me the exact edit, e.g. `replace "callX()" with "callY()" in app.js`, or `in src/utils.js, replace "old" with "new"`.'
      };
    }
    return { intent: 'edit', tool: 'edit_workspace_file', params: r };
  }

  if (isWrite) {
    const path = fileRefText(t);
    const content = isAppend ? null : extractContentArgument(t, path);
    if (!path) return { intent: 'write', ask: 'Which file should I create — and what should it contain?' };
    if (!content) {
      return { intent: 'write', ask: `What content should **${path}** have? I never invent file contents — paste the text you want written.` };
    }
    return { intent: 'write', tool: 'write_workspace_file', params: { path, content } };
  }

  if (isList) {
    return { intent: 'list', tool: 'list_workspace', params: { dir: extractPathToken(t) || '.' } };
  }

  return null;
}

function matchLines(t) {
  const m = t.match(/\b(first|top)\s+(\d+)\s+lines?\b/i);
  return m ? Number(m[2]) : undefined;
}

function parseEdit(text) {
  // 1) replace "OLD" with "NEW" in <path>
  const r1 = text.match(/replace\s+["'`]([\s\S]+?)["'`]\s+with\s+["'`]([\s\S]+?)["'`]\s+(?:in|at|inside)\s+([^\s,.:][\w./-]*)/i);
  if (r1) return { path: r1[3].replace(/[.,;:]+$/, ''), old_text: r1[1], new_text: r1[2] };
  // 2) in <path>, replace "OLD" with "NEW"
  const r2 = text.match(/^(?:in|at|inside)\s+([^\s,:][\w./-]*)[,:]\s*replace\s+["'`]([\s\S]+?)["'`]\s+with\s+["'`]([\s\S]+?)["'`]/i);
  if (r2) return { path: r2[1].replace(/[.,;:]+$/, ''), old_text: r2[2], new_text: r2[3] };
  // 3) change "OLD" to "NEW" in <path>
  const r3 = text.match(/change\s+["'`]([\s\S]+?)["'`]\s+to\s+["'`]([\s\S]+?)["'`]\s+(?:in|at|inside)\s+([^\s,.:][\w./-]*)/i);
  if (r3) return { path: r3[3].replace(/[.,;:]+$/, ''), old_text: r3[1], new_text: r3[2] };
  return null;
}

// ── Agent entry point ───────────────────────────────────────────────────────

export const CODER_HELP = `I can work on files inside the folder you grant me. Try things like:
- "list files"
- "read src/index.html"
- 'create a file notes.md: remember to water the plants'
- 'replace "Version 1" with "Version 2" in config.json'

Connect a folder first (Open folder above), then ask away.`;

export async function runCodingAgent(message, opts = {}) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, response: CODER_HELP, steps: [] };

  if (!getWorkspaceAdapter()) {
    return {
      ok: false,
      requireFolder: true,
      response: 'I can’t touch the filesystem yet — no workspace folder is connected. Click **Open folder** above to grant me read/write access to a directory, and I’ll list, read, and edit real files inside it.'
    };
  }

  const runner = opts.runner;
  const plan = recognizeCodingRequest(text);

  if (plan && plan.tool) {
    const steps = [];
    let result;
    try {
      result = await runner(plan.tool, { ...plan.params, message: text, query: text });
    } catch (err) {
      result = { text: `⚠️ ${err.message}` };
    }
    steps.push({ tool: plan.tool, params: plan.params, result });
    const response = result && typeof result === 'object' && result.text ? result.text : 'Done.';
    return { ok: true, intent: plan.intent, steps, response };
  }

  if (plan && plan.ask) {
    return { ok: false, response: plan.ask, ask: plan.ask, steps: [] };
  }

  // Unrecognized → if a tool-capable dialog backend exists, let the model loop
  // over the workspace tools with the Coder persona.
  if (typeof runner === 'function') {
    const loop = await agentLoop({
      message: text,
      persona: CODER_PERSONA,
      systemPrompt: buildCoderSystemPrompt(text),
      tools: workspaceToolDefs(),
      runner,
      maxIterations: 5,
      maxTokens: 384,
      stateInstance: opts.state || state
    });
    if (loop) {
      if (loop.error) {
        return { ok: false, response: `The coding model stumbled: ${loop.error.message}`, steps: [] };
      }
      if (loop.answer) {
        return {
          ok: true,
          mode: 'agent',
          response: loop.answer,
          steps: (loop.toolCalls || []).map(tc => ({ tool: tc.name, params: tc.args, result: { text: tc.name } }))
        };
      }
    }
  }

  return { ok: false, response: CODER_HELP, steps: [], mode: 'guide' };
}