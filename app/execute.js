/**
 * app/execute.js - Tool Execution Engine & Core Tool Registrations
 *
 * Tool results and conversational replies are composed by the multi-model
 * pipeline (composeToolText / generateChatResponse). Every user-facing string
 * still has its original template as the deterministic fallback, so the app
 * responds correctly even with zero models loaded (Node tests / offline).
 */

import { isBrowser } from '../core/env.js';
import { state, getActiveCharacter, getActiveBusiness } from '../core/state.js';
import { configAPI } from '../core/config.js';
import { toolRegistry, ToolChain } from '../core/tools.js';
import { cosineSimilarity } from '../core/db.js';
import { getModel, computeEmbedding } from './models.js';
import { detectIntent } from './intent.js';
import { composeToolText, generateChatResponse, routeToAgent } from './pipeline.js';
import { setCharacterEmotion } from './ui.js';

export async function executeTool(toolIdentifier, rawInput, stateInstance = state, registryInstance = toolRegistry) {
  let actualToolName = '';
  let params = {};
  let inputText = '';

  if (typeof toolIdentifier === 'object' && toolIdentifier !== null) {
    actualToolName = toolIdentifier.tool || toolIdentifier.name || '';
    params = { ...(toolIdentifier.params || toolIdentifier.parameters || {}) };
  } else if (typeof toolIdentifier === 'string') {
    actualToolName = toolIdentifier;
  }

  if (typeof rawInput === 'object' && rawInput !== null) {
    params = { ...params, ...rawInput };
    inputText = params.query || params.message || params.task || params.description || '';
  } else if (typeof rawInput === 'string') {
    inputText = rawInput;
  }

  const lower = inputText.toLowerCase();

  // Natural language extraction for core tools
  if (actualToolName === 'add_transaction') {
    if (params.amount === undefined) {
      const amtMatch = inputText.match(/(\d+(\.\d{1,2})?)/);
      if (!amtMatch) {
        return { text: "⚠️ Please specify an amount (e.g. 'Spent $16.50 on lunch at cafe')." };
      }
      params.amount = parseFloat(amtMatch[1]);
    }
    if (!params.type) {
      params.type = /\b(income|earned|salary|deposit|received)\b/i.test(inputText) ? 'income' : 'expense';
    }
    if (!params.description) {
      params.description = inputText
        .replace(/(\$|\bspent\b|\bpaid\b|\bfor\b|\bon\b|\bearned\b|\breceived\b)/gi, '')
        .replace(String(params.amount), '')
        .trim() || 'Transaction';
    }
    if (!params.category) {
      let matchedCategory = 'general';
      for (const [catName, kws] of Object.entries((stateInstance.config && stateInstance.config.categories) || {})) {
        if (kws.some(k => lower.includes(k))) {
          matchedCategory = catName;
          break;
        }
      }
      params.category = matchedCategory;
    }
  } else if (actualToolName === 'add_todo') {
    if (!params.task) {
      params.task = inputText.replace(/\b(add todo|remind me to|task:|new task|need to)\b/gi, '').trim();
    }
    if (!params.priority) {
      params.priority = /\b(urgent|critical)\b/i.test(inputText) ? 'high' :
                        /\b(low|minor)\b/i.test(inputText) ? 'low' : 'normal';
    }
  } else if (actualToolName === 'add_event') {
    if (!params.summary) {
      params.summary = inputText.replace(/\b(schedule|add event|calendar event|meeting with|appointment)\b/gi, '').trim() || 'Scheduled Event';
    }
    if (!params.description) params.description = inputText;
  } else if (actualToolName === 'create_schema') {
    if (!params.name) {
      const match = inputText.match(/create schema\s+([a-zA-Z0-9_-]+)/i);
      if (match) params.name = match[1];
    }
  } else if (actualToolName === 'search' || actualToolName === 'rag_query') {
    actualToolName = 'search';
    if (!params.query) {
      params.query = inputText.replace(/^(search for|search|find|lookup|recall)\s+/i, '').trim();
    }
  } else if (actualToolName === 'change_character_name') {
    if (!params.name) {
      const match = inputText.match(/(?:to|call you|your name is)\s+([a-zA-Z0-9_-]+)/i);
      if (match) params.name = match[1];
    }
  } else if (actualToolName === 'delegate_to_agent' || actualToolName === 'ask_agent') {
    if (!params.message && params.query) {
      params.message = params.query;
    }
  }

  const reg = registryInstance || toolRegistry;
  if (reg.hasTool(actualToolName)) {
    try {
      const result = await reg.execute(actualToolName, params);
      return result;
    } catch (err) {
      return { text: `⚠️ Error executing tool **${actualToolName}**: ${err.message}` };
    }
  }

  // Conversational response handlers
  if (actualToolName === 'chat_greeting') {
    const char = getActiveCharacter(stateInstance);
    if (isBrowser) setCharacterEmotion('happy');
    return {
      text: await generateChatResponse({
        intent: 'chat_greeting',
        message: inputText,
        persona: char.systemPrompt,
        fallback: `Hello! I'm **${char.name}**, your ${char.persona.toLowerCase()}. How can I help you today? You can ask me to log expenses, manage tasks, check your calendar, search records, or consult with other specialists.`
      })
    };
  }
  if (actualToolName === 'chat_identity') {
    const char = getActiveCharacter(stateInstance);
    if (isBrowser) setCharacterEmotion('happy');
    const specs = (char.specialization || []).map(s => `\`${s}\``).join(', ');
    return {
      text: await generateChatResponse({
        intent: 'chat_identity',
        message: inputText,
        persona: char.systemPrompt,
        context: { name: char.name, persona: char.persona, specs },
        fallback: `I am **${char.name}**! ${char.persona}\n\nMy primary specializations include: ${specs || 'general assistance'}. I can operate tools on-device and coordinate with other specialists when needed.`
      })
    };
  }
  if (actualToolName === 'chat_help') {
    const char = getActiveCharacter(stateInstance);
    if (isBrowser) setCharacterEmotion('neutral');
    return {
      text: await generateChatResponse({
        intent: 'chat_help',
        message: inputText,
        persona: char.systemPrompt,
        fallback: `Here are some things I can do for you right now:\n\n` +
          `- 💰 **Financial Tracking**: Say *"Spent $16.50 on lunch"* or *"Analyze expenses"*\n` +
          `- 📋 **Task Management**: Say *"Add todo: review report"* or *"List todos"*\n` +
          `- 📅 **Calendar**: Say *"Schedule meeting tomorrow at 3pm"* or *"Check calendar"*\n` +
          `- 🔍 **Semantic Search**: Say *"Search marketing projects"*\n` +
          `- 👥 **Multi-Agent**: Say *"Ask Marcus about budget"* or *"List agents"*\n` +
          `- 🛠️ **Tools**: Say *"List tools"* to inspect all registered tools.`
      })
    };
  }
  if (actualToolName === 'chat_thanks') {
    const char = getActiveCharacter(stateInstance);
    if (isBrowser) setCharacterEmotion('happy');
    return {
      text: await generateChatResponse({
        intent: 'chat_thanks',
        message: inputText,
        persona: char.systemPrompt,
        fallback: `You're very welcome! Let me know if you need anything else.`
      })
    };
  }
  if (actualToolName === 'small_talk') {
    const char = getActiveCharacter(stateInstance);
    if (isBrowser) setCharacterEmotion('neutral');
    return {
      text: await generateChatResponse({
        intent: 'small_talk',
        message: inputText,
        persona: char.systemPrompt,
        fallback: `I am ${char.name}. I focus on expense tracking, tasks, calendar and searches — but I'm happy to chat. What would you like help with?`
      })
    };
  }

  // Unknown tool/message: compose a reply with the dialog stage, template fallback.
  if (isBrowser) setCharacterEmotion('thinking');
  const char = getActiveCharacter(stateInstance);
  const historyTurns = (stateInstance.chatHistory || [])
    .filter(m => m.content && !m.content.includes('Active Tools') && !m.content.includes('Spreadsheet Data') && !m.content.includes('Permission:'))
    .slice(-3)
    .map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const cleanText = m.content.replace(/[`*#]/g, '').slice(0, 80).trim();
      return `${role}: ${cleanText}`;
    })
    .join('\n');

  const reply = await generateChatResponse({
    intent: 'unknown',
    message: inputText,
    persona: char.systemPrompt,
    context: historyTurns || undefined,
    fallback: `I understood your request, but the requested tool **"${actualToolName}"** is not active. Type "List tools" to see available tools.`
  });
  if (isBrowser) setCharacterEmotion('neutral');
  return { text: reply };
}

export function registerAllCoreTools(registry, dbInstance, stateInstance, agentCommInstance, googleAPIInstance) {
  registry.register({
    name: 'add_transaction',
    description: 'Record an income or expense transaction',
    schema: {
      parameters: {
        amount: { type: 'number', required: true },
        type: { type: 'string', enum: ['expense', 'income'], required: false },
        category: { type: 'string', required: false },
        description: { type: 'string', required: false },
        date: { type: 'string', required: false }
      }
    },
    permissionLevel: registry.permissionLevels.USER_DATA,
    icon: 'bi-cash-coin',
    execute: async (params) => {
      const biz = getActiveBusiness(stateInstance);
      if (isBrowser) setCharacterEmotion('money');
      const rec = {
        type: params.type || 'expense',
        amount: Number(params.amount),
        category: params.category || 'general',
        description: params.description || 'Transaction',
        date: params.date || new Date().toISOString().slice(0, 10)
      };
      const emb = await computeEmbedding('transactions', rec, stateInstance);
      await dbInstance.addRecord(biz.id, 'transactions', rec, emb);
      return {
        text: await composeToolText('add_transaction', {
          message: params.description || inputFor(params, stateInstance),
          params,
          result: rec
        }, `Recorded **${rec.type}** of **$${rec.amount.toFixed(2)}** in *[${rec.category}]* for "${rec.description}".`)
      };
    }
  });

  registry.register({
    name: 'analyze_expenses',
    description: 'Generate charts and analyze spending by category',
    schema: { parameters: {} },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-pie-chart',
    execute: async () => {
      const biz = getActiveBusiness(stateInstance);
      if (isBrowser) setCharacterEmotion('money');
      const records = await dbInstance.getRecords(biz.id, 'transactions');
      if (!records.length) {
        return {
          text: await composeToolText('analyze_expenses', {
            message: '',
            params: {},
            result: { empty: true, workspace: biz.name }
          }, `No transactions recorded yet in workspace "${biz.name}".`)
        };
      }

      let totalExp = 0, totalInc = 0;
      const catTotals = {};
      records.forEach(r => {
        const amt = Number(r.data.amount) || 0;
        if (r.data.type === 'expense') {
          totalExp += amt;
          const c = r.data.category || 'general';
          catTotals[c] = (catTotals[c] || 0) + amt;
        } else {
          totalInc += amt;
        }
      });

      const chartId = 'ch_' + Date.now();
      return {
        text: await composeToolText('analyze_expenses', {
          message: '',
          params: {},
          result: { workspace: biz.name, totalInc, totalExp, net: totalInc - totalExp, byCategory: catTotals }
        }, `### 📊 Financial Breakdown (${biz.name})\n- **Total Income:** $${totalInc.toFixed(2)}\n- **Total Expenses:** $${totalExp.toFixed(2)}\n- **Net Cashflow:** $${(totalInc - totalExp).toFixed(2)}`),
        chart: {
          id: chartId,
          type: 'doughnut',
          labels: Object.keys(catTotals),
          data: Object.values(catTotals)
        }
      };
    }
  });

  registry.register({
    name: 'add_todo',
    description: 'Add a task to the todo list',
    schema: {
      parameters: {
        task: { type: 'string', required: true },
        priority: { type: 'string', enum: ['high', 'normal', 'low'], required: false },
        due_date: { type: 'string', required: false }
      }
    },
    permissionLevel: registry.permissionLevels.USER_DATA,
    icon: 'bi-check2-square',
    execute: async (params) => {
      const biz = getActiveBusiness(stateInstance);
      if (isBrowser) setCharacterEmotion('task');
      const rec = {
        task: params.task,
        status: 'pending',
        priority: params.priority || 'normal',
        due_date: params.due_date || new Date().toISOString().slice(0, 10)
      };
      const emb = await computeEmbedding('todos', rec, stateInstance);
      await dbInstance.addRecord(biz.id, 'todos', rec, emb);
      return {
        text: await composeToolText('add_todo', {
          message: params.task,
          params,
          result: rec
        }, `Added to-do: **"${rec.task}"** [Priority: *${rec.priority}*].`)
      };
    }
  });

  registry.register({
    name: 'list_todos',
    description: 'List current pending or completed todos',
    schema: { parameters: {} },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-list-task',
    execute: async () => {
      const biz = getActiveBusiness(stateInstance);
      if (isBrowser) setCharacterEmotion('task');
      const todos = await dbInstance.getRecords(biz.id, 'todos');
      if (!todos.length) {
        return {
          text: await composeToolText('list_todos', {
            message: '', params: {}, result: { empty: true, workspace: biz.name }
          }, "No todos found in this workspace.")
        };
      }
      const list = todos.map(t => `- [${t.data.status === 'done' ? 'x' : ' '}] **${t.data.task}** *(${t.data.priority || 'normal'})*`).join('\n');
      return {
        text: await composeToolText('list_todos', {
          message: '', params: {}, result: { workspace: biz.name, todos: todos.map(t => t.data) }
        }, `### 📋 Active Tasks (${biz.name}):\n${list}`)
      };
    }
  });

  registry.register({
    name: 'add_event',
    description: 'Schedule a calendar event or meeting',
    schema: {
      parameters: {
        summary: { type: 'string', required: true },
        start: { type: 'string', required: false },
        end: { type: 'string', required: false },
        description: { type: 'string', required: false }
      }
    },
    permissionLevel: registry.permissionLevels.USER_DATA,
    icon: 'bi-calendar-plus',
    execute: async (params) => {
      const biz = getActiveBusiness(stateInstance);
      if (isBrowser) setCharacterEmotion('event');
      const rec = {
        summary: params.summary,
        start: params.start || new Date().toISOString().slice(0, 10),
        end: params.end || new Date().toISOString().slice(0, 10),
        description: params.description || ''
      };
      const emb = await computeEmbedding('calendar_events', rec, stateInstance);
      await dbInstance.addRecord(biz.id, 'calendar_events', rec, emb);
      return {
        text: await composeToolText('add_event', {
          message: params.description || params.summary,
          params,
          result: rec
        }, `Calendar event scheduled: **"${rec.summary}"**.`)
      };
    }
  });

  registry.register({
    name: 'check_calendar',
    description: 'Check upcoming appointments and schedule',
    schema: { parameters: {} },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-calendar-week',
    execute: async () => {
      const biz = getActiveBusiness(stateInstance);
      if (isBrowser) setCharacterEmotion('event');
      const events = await dbInstance.getRecords(biz.id, 'calendar_events');
      if (!events.length) {
        return {
          text: await composeToolText('check_calendar', {
            message: '', params: {}, result: { empty: true }
          }, "Your workspace schedule is clear.")
        };
      }
      const schedule = `### 📅 Upcoming Schedule:\n` + events.map(e => `- **${e.data.summary}** (${e.data.start})`).join('\n');
      return {
        text: await composeToolText('check_calendar', {
          message: '', params: {}, result: { workspace: biz.name, events: events.map(e => e.data) }
        }, schedule)
      };
    }
  });

  registry.register({
    name: 'create_schema',
    description: 'Dynamically create a new data schema with typed fields',
    schema: {
      parameters: {
        name: { type: 'string', required: true },
        fields: { type: 'object', required: false },
        vectorize: { type: 'array', required: false }
      }
    },
    permissionLevel: registry.permissionLevels.CONFIG,
    icon: 'bi-diagram-3',
    execute: async (params) => {
      const biz = getActiveBusiness(stateInstance);
      const name = String(params.name || '').toLowerCase().trim();
      const schemaDef = {
        fields: params.fields || { title: "string", description: "string", status: "string" },
        vectorize: params.vectorize || ["title", "description"]
      };
      await configAPI.addSchema(biz.id, name, schemaDef);
      return {
        text: await composeToolText('create_schema', {
          message: name,
          params,
          result: { schema: name, workspace: biz.name, fields: schemaDef.fields }
        }, `Created dynamic schema **"${name}"** in workspace "${biz.name}".`)
      };
    }
  });

  registry.register({
    name: 'search',
    description: 'Instant semantic search across all indexed data records',
    schema: {
      parameters: { query: { type: 'string', required: true } }
    },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-search',
    execute: async (params) => {
      const biz = getActiveBusiness(stateInstance);
      if (isBrowser) setCharacterEmotion('search');
      const query = params.query;
      const records = await dbInstance.getRecords(biz.id);
      if (!records.length) {
        return {
          text: await composeToolText('search', {
            message: query,
            params: { query },
            result: { empty: true, workspace: biz.name }
          }, "No records found in this workspace.")
        };
      }

      let queryVec = null;
      try {
        const embedder = await getModel('feature-extraction', stateInstance.config && stateInstance.config.modelSettings ? stateInstance.config.modelSettings.embedder : undefined, 'embedder');
        if (embedder) {
          const queryOut = await embedder(query, { pooling: 'mean', normalize: true });
          queryVec = Array.from(queryOut.data);
        }
      } catch (e) {}

      const scored = [];
      for (const rec of records) {
        if (queryVec && rec.embedding) {
          const sim = cosineSimilarity(queryVec, rec.embedding);
          if (sim > 0.15) scored.push({ rec, score: sim });
        } else {
          const matchCount = Object.values(rec.data || {}).filter(val =>
            String(val).toLowerCase().includes(String(query).toLowerCase())
          ).length;
          if (matchCount > 0) scored.push({ rec, score: matchCount * 0.2 });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, 5);
      if (!top.length) {
        return {
          text: await composeToolText('search', {
            message: query,
            params: { query },
            result: { query, matches: 0 }
          }, `No semantic matches found for "${query}".`)
        };
      }

      const items = top.map(m =>
        `- **[${m.rec.schemaName}]** ${JSON.stringify(m.rec.data)} *(Match: ${Math.round(Math.min(m.score, 1) * 100)}%)*`
      ).join('\n');
      return {
        text: await composeToolText('search', {
          message: query,
          params: { query },
          result: { query, matches: top.length, top: top.map(m => ({ schema: m.rec.schemaName, data: m.rec.data, score: m.score })) }
        }, `### 🔍 Semantic Matches:\n${items}`)
      };
    }
  });

  registry.register({
    name: 'update_config',
    description: 'Update a configuration value by path (AI-accessible)',
    schema: {
      parameters: {
        path: { type: 'string', required: true },
        value: { required: true }
      }
    },
    permissionLevel: registry.permissionLevels.CONFIG,
    icon: 'bi-gear',
    execute: async (params) => {
      await configAPI.updateConfig(params.path, params.value);
      return {
        text: await composeToolText('update_config', {
          message: params.path,
          params,
          result: { path: params.path, value: params.value }
        }, `Configuration updated at **${params.path}**.`)
      };
    }
  });

  registry.register({
    name: 'get_config',
    description: 'Get a configuration value by path (AI-accessible)',
    schema: {
      parameters: { path: { type: 'string', required: true } }
    },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-info-circle',
    execute: async (params) => {
      const val = await configAPI.getConfig(params.path);
      return {
        text: await composeToolText('get_config', {
          message: params.path,
          params,
          result: { path: params.path, value: val }
        }, `Config at \`${params.path}\`: \`${JSON.stringify(val)}\``)
      };
    }
  });

  registry.register({
    name: 'add_character',
    description: 'Add a new character/persona to the system (AI-accessible)',
    schema: {
      parameters: { character: { type: 'object', required: true } }
    },
    permissionLevel: registry.permissionLevels.CONFIG,
    icon: 'bi-person-plus',
    execute: async (params) => {
      const res = await configAPI.addCharacter(params.character);
      return {
        text: await composeToolText('add_character', {
          message: params.character && params.character.name,
          params,
          result: res
        }, `Character **"${res.character}"** added successfully.`)
      };
    }
  });

  registry.register({
    name: 'add_business',
    description: 'Add a new business/workspace to the system (AI-accessible)',
    schema: {
      parameters: { business: { type: 'object', required: true } }
    },
    permissionLevel: registry.permissionLevels.CONFIG,
    icon: 'bi-building-add',
    execute: async (params) => {
      const res = await configAPI.addBusiness(params.business);
      return {
        text: await composeToolText('add_business', {
          message: params.business && params.business.name,
          params,
          result: res
        }, `Workspace **"${res.business}"** added successfully.`)
      };
    }
  });

  registry.register({
    name: 'create_tool',
    description: 'Create and register a new tool dynamically (AI-accessible)',
    schema: {
      parameters: { toolDefinition: { type: 'object', required: true } }
    },
    permissionLevel: registry.permissionLevels.SYSTEM,
    icon: 'bi-tools',
    execute: async (params) => {
      const res = await registry.registerToolFromAI(params.toolDefinition, dbInstance);
      return {
        text: await composeToolText('create_tool', {
          message: params.toolDefinition && (params.toolDefinition.name || params.toolDefinition.description),
          params,
          result: res
        }, `Dynamic tool **"${res.tool}"** created and registered.`)
      };
    }
  });

  registry.register({
    name: 'rollback_config',
    description: 'Rollback configuration to a previous state (AI-accessible)',
    schema: {
      parameters: { timestamp: { type: 'number', required: false } }
    },
    permissionLevel: registry.permissionLevels.CONFIG,
    icon: 'bi-arrow-counterclockwise',
    execute: async (params) => {
      let ts = params.timestamp;
      if (!ts) {
        const history = await configAPI.getHistory(2);
        if (history.length > 0) ts = history[0].id;
        else {
          return {
            text: await composeToolText('rollback_config', {
              message: '', params: {}, result: { empty: true }
            }, "No configuration snapshots available for rollback.")
          };
        }
      }
      const res = await configAPI.rollback(ts);
      return {
        text: await composeToolText('rollback_config', {
          message: '', params: { timestamp: ts }, result: res
        }, `Configuration rolled back to state from ${res.rolledBackTo}.`)
      };
    }
  });

  registry.register({
    name: 'list_tools',
    description: 'List all available tools with their schemas (AI-accessible)',
    schema: { parameters: {} },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-list-check',
    execute: async () => {
      const tools = registry.getAllTools();
      const list = tools.map(t => `- **${t.name}**: ${t.description} *(Permission: ${t.permissionLevel})*`).join('\n');
      return {
        text: await composeToolText('list_tools', {
          message: '', params: {},
          result: { count: tools.length, tools: tools.map(t => ({ name: t.name, description: t.description, permissionLevel: t.permissionLevel })) }
        }, `### 🛠️ Active Tools (${tools.length}):\n${list}`)
      };
    }
  });

  registry.register({
    name: 'execute_chain',
    description: 'Execute a chain of tools in sequence (AI-accessible)',
    schema: {
      parameters: { chain: { type: 'object', required: true } }
    },
    permissionLevel: registry.permissionLevels.USER_DATA,
    icon: 'bi-link',
    execute: async (params) => {
      const chainExec = new ToolChain(registry);
      const res = await chainExec.execute(params.chain);
      const summary = res.results.map(r => `- Step ${r.stepIndex + 1} (${r.tool}): ${r.success ? '✓' : '✗ ' + r.error}`).join('\n');
      return {
        text: await composeToolText('execute_chain', {
          message: '', params: { chain: params.chain }, result: res
        }, `### 🔗 Chain Execution Result:\n${summary}`)
      };
    }
  });

  registry.register({
    name: 'delegate_to_agent',
    description: 'Delegate a task to another specialized agent (AI-accessible)',
    schema: {
      parameters: {
        targetAgentId: { type: 'string', required: true },
        message: { type: 'string', required: true },
        context: { type: 'object', required: false }
      }
    },
    permissionLevel: registry.permissionLevels.USER_DATA,
    icon: 'bi-person-workspace',
    execute: async (params) => {
      const target = (stateInstance.config.characters || []).find(c => c.id === params.targetAgentId);
      if (!target) return { text: `Agent "${params.targetAgentId}" not found.` };

      const delegation = await agentCommInstance.delegateToAgent(params.targetAgentId, params.message, params.context);
      if (delegation.success) {
        return {
          text: await composeToolText('delegate_to_agent', {
            message: params.message,
            params,
            result: { agentName: target.name, text: delegation.text }
          }, `Delegated to **${target.name}**:\n\n${agentCommInstance.formatAgentResponse(target.name, delegation.text)}`)
        };
      }
      return { text: `Delegation to ${target.name} failed: ${delegation.error}` };
    }
  });

  registry.register({
    name: 'ask_agent',
    description: 'Ask a specific agent a question for collaboration (AI-accessible)',
    schema: {
      parameters: {
        targetAgentId: { type: 'string', required: true },
        message: { type: 'string', required: true }
      }
    },
    permissionLevel: registry.permissionLevels.USER_DATA,
    icon: 'bi-chat-quote',
    execute: async (params) => {
      const target = (stateInstance.config.characters || []).find(c => c.id === params.targetAgentId);
      if (!target) return { text: `Agent "${params.targetAgentId}" not found.` };

      const answer = await agentCommInstance.askAgent(params.targetAgentId, params.message);
      return {
        text: await composeToolText('ask_agent', {
          message: params.message,
          params,
          result: { agentName: answer.agentName, text: answer.text }
        }, `I consulted with **${answer.agentName}**:\n\n**${answer.agentName}**: ${answer.text}`)
      };
    }
  });

  registry.register({
    name: 'list_agents',
    description: 'List all available agents and their specializations (AI-accessible)',
    schema: { parameters: {} },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-people',
    execute: async () => {
      const chars = stateInstance.config.characters || [];
      const list = chars.map(c => {
        const caps = agentCommInstance.getAgentCapabilities(c).join(', ');
        return `- **${c.name}** (${c.persona}): Specializes in *${caps}*`;
      }).join('\n');
      return {
        text: await composeToolText('list_agents', {
          message: '', params: {},
          result: { count: chars.length, agents: chars.map(c => ({ name: c.name, persona: c.persona, caps: agentCommInstance.getAgentCapabilities(c) })) }
        }, `### 👥 Available Workspace Agents:\n${list}`)
      };
    }
  });

  registry.register({
    name: 'route_to_specialist',
    description: 'Automatically route query to the best specialist agent (AI-accessible)',
    schema: {
      parameters: { query: { type: 'string', required: true } }
    },
    permissionLevel: registry.permissionLevels.USER_DATA,
    icon: 'bi-signpost-split',
    execute: async (params) => {
      const current = getActiveCharacter(stateInstance);
      let specialist = null;
      try {
        const route = await routeToAgent(params.query, {
          state: stateInstance,
          router: agentCommInstance
        });
        if (route && route.agentId) {
          specialist = (stateInstance.config.characters || []).find(c => c.id === route.agentId) || null;
        }
      } catch (_) {}
      if (!specialist) specialist = agentCommInstance.getBestAgentForQuery(params.query);
      if (specialist && specialist.id !== current.id) {
        const delegation = await agentCommInstance.delegateToAgent(specialist.id, params.query);
        if (delegation.success) {
          return {
            text: await composeToolText('route_to_specialist', {
              message: params.query,
              params: { query: params.query },
              result: { specialist: specialist.name, text: delegation.text }
            }, `Routed to specialist **${specialist.name}**:\n\n${agentCommInstance.formatAgentResponse(specialist.name, delegation.text)}`)
          };
        }
        return { text: `Specialist routing to ${specialist.name} failed: ${delegation.error}` };
      }
      const detected = await detectIntent(params.query, stateInstance);
      return await executeTool(detected, params.query, stateInstance);
    }
  });

  registry.register({
    name: 'web_search',
    description: 'Search the internet for information (AI-accessible)',
    schema: {
      parameters: { query: { type: 'string', required: true } }
    },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-globe',
    execute: async (params) => {
      const q = params.query;
      if (!isBrowser) {
        return {
          text: await composeToolText('web_search', {
            message: q,
            params: { query: q },
            result: { offline: true, query: q }
          }, `### 🔍 Web Search for "${q}":\n\nOffline placeholder. [Search directly on DuckDuckGo](https://duckduckgo.com/?q=${encodeURIComponent(q)}).`)
        };
      }
      try {
        const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=0`);
        const data = await res.json();
        const results = [];
        if (data.Abstract) results.push(`**Abstract:** ${data.Abstract}`);
        if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
          const topics = data.RelatedTopics.slice(0, 4)
            .filter(t => t.Text && t.FirstURL)
            .map(t => `- [${t.Text}](${t.FirstURL})`);
          if (topics.length) results.push(`**Related:**\n${topics.join('\n')}`);
        }
        if (results.length === 0) {
          return {
            text: await composeToolText('web_search', {
              message: q,
              params: { query: q },
              result: { query: q, results: 0 }
            }, `### 🔍 Web Search for "${q}":\nNo instant abstract found. [Search directly on DuckDuckGo](https://duckduckgo.com/?q=${encodeURIComponent(q)}).`)
          };
        }
        return {
          text: await composeToolText('web_search', {
            message: q,
            params: { query: q },
            result: { query: q, results }
          }, `### 🔍 Web Results for "${q}":\n\n${results.join('\n\n')}`)
        };
      } catch (err) {
        return {
          text: await composeToolText('web_search', {
            message: q,
            params: { query: q },
            result: { query: q, error: true }
          }, `Web search: [Open "${q}" on DuckDuckGo](https://duckduckgo.com/?q=${encodeURIComponent(q)})`)
        };
      }
    }
  });

  registry.register({
    name: 'google_calendar_list',
    description: 'List Google Calendar events (AI-accessible)',
    schema: { parameters: {} },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-calendar-event',
    execute: async (params) => {
      try {
        const result = await googleAPIInstance.listCalendarEvents();
        return {
          text: await composeToolText('google_calendar_list', { message: '', params: params || {}, result }, result.text)
        };
      } catch (err) {
        return { text: `⚠️ ${err.message}` };
      }
    }
  });

  registry.register({
    name: 'google_drive_list',
    description: 'List Google Drive files (AI-accessible)',
    schema: { parameters: {} },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-google',
    execute: async (params) => {
      try {
        const result = await googleAPIInstance.listDriveFiles();
        return {
          text: await composeToolText('google_drive_list', { message: '', params: params || {}, result }, result.text)
        };
      } catch (err) {
        return { text: `⚠️ ${err.message}` };
      }
    }
  });

  registry.register({
    name: 'google_sheets_read',
    description: 'Read Google Sheets data (AI-accessible)',
    schema: {
      parameters: {
        spreadsheetId: { type: 'string', required: true },
        range: { type: 'string', required: false }
      }
    },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-table',
    execute: async (params) => {
      try {
        const result = await googleAPIInstance.readSheet(params.spreadsheetId, params.range);
        return {
          text: await composeToolText('google_sheets_read', { message: params.range, params, result }, result.text)
        };
      } catch (err) {
        return { text: `⚠️ ${err.message}` };
      }
    }
  });

  registry.register({
    name: 'change_character_name',
    description: "Change the current character's name (AI-accessible)",
    schema: {
      parameters: { name: { type: 'string', required: true } }
    },
    permissionLevel: registry.permissionLevels.CONFIG,
    icon: 'bi-person-badge',
    execute: async (params) => {
      const current = getActiveCharacter(stateInstance);
      const newName = String(params.name || '').trim();
      if (!newName) return { text: "Please provide a valid character name." };
      await configAPI.updateCharacter(current.id, { name: newName });
      return {
        text: await composeToolText('change_character_name', {
          message: newName,
          params,
          result: { old: current.name, name: newName }
        }, `My name has been changed to **${newName}**.`)
      };
    }
  });
}

// Small helper: reconstruct a plausible "message" for response composition.
function inputFor(params, stateInstance) {
  if (params.message) return params.message;
  if (params.description) return params.description;
  if (params.query) return params.query;
  return '';
}