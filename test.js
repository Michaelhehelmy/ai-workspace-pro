// test.js - Comprehensive Test Suite for AI Workspace Pro

import {
  WorkspaceDB,
  ConfigAPI,
  validateConfig,
  CONFIG_SCHEMA,
  ToolRegistry,
  ToolChain,
  createSandboxedTool,
  AgentCommunication,
  GoogleAPI,
  cosineSimilarity,
  filterRecords,
  escapeHtml,
  detectIntent,
  parseToolCall,
  executeTool,
  registerAllCoreTools,
  getActiveCharacter,
  getActiveBusiness,
  state
} from './app.js';

const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
const isBrowser = typeof window !== 'undefined';

let passCount = 0;
let failCount = 0;
const testResults = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected [${expected}], got [${actual}]`);
  }
}

async function runTest(suite, name, fn) {
  const item = { suite, name, status: 'running', error: null, duration: 0 };
  const start = Date.now();
  try {
    await fn();
    item.status = 'passed';
    item.duration = Date.now() - start;
    passCount++;
    if (isNode) {
      console.log(`  \x1b[32m✔\x1b[0m [${suite}] ${name} (${item.duration}ms)`);
    }
  } catch (err) {
    item.status = 'failed';
    item.error = err.message;
    item.duration = Date.now() - start;
    failCount++;
    if (isNode) {
      console.error(`  \x1b[31m✖\x1b[0m [${suite}] ${name}: ${err.message}`);
    }
  }
  testResults.push(item);
}

// ─────────────────────────────────────────────────────────────
// Test Suite Runner
// ─────────────────────────────────────────────────────────────

async function runAllTests() {
  passCount = 0;
  failCount = 0;
  testResults.length = 0;

  console.log('\n🚀 Starting AI Workspace Pro Test Suite...\n');

  // Load config.json
  let configData;
  if (isNode) {
    const { fileURLToPath } = await import('url');
    const path = await import('path');
    const fs = await import('fs');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8');
    configData = JSON.parse(raw);
  } else {
    const resp = await fetch('config.json');
    configData = await resp.json();
  }

  // Initialize DB and State
  state.config = JSON.parse(JSON.stringify(configData));
  state.activeCharacterId = 'aria';
  state.activeBusinessId = 'personal';

  const testDb = new WorkspaceDB('test-ai-workspace');
  await testDb.init();

  const agentComm = new AgentCommunication(state, testDb);
  const googleAPI = new GoogleAPI(state, testDb);

  // 1. Math & String Utilities
  await runTest('Utils', 'cosineSimilarity with identical vectors returns 1', () => {
    const sim = cosineSimilarity([1, 0, 0], [1, 0, 0]);
    assertEquals(Math.round(sim), 1);
  });

  await runTest('Utils', 'cosineSimilarity with orthogonal vectors returns 0', () => {
    const sim = cosineSimilarity([1, 0, 0], [0, 1, 0]);
    assertEquals(Math.round(sim), 0);
  });

  await runTest('Utils', 'cosineSimilarity with opposite vectors returns -1', () => {
    const sim = cosineSimilarity([1, 0], [-1, 0]);
    assertEquals(Math.round(sim), -1);
  });

  await runTest('Utils', 'cosineSimilarity handles zero vectors safely', () => {
    const sim = cosineSimilarity([0, 0], [1, 1]);
    assertEquals(sim, 0);
  });

  await runTest('Utils', 'filterRecords finds matching substring across fields', () => {
    const records = [
      { id: '1', description: 'Groceries at Safeway', category: 'personal' },
      { id: '2', description: 'AWS Cloud Hosting', category: 'business' },
      { id: '3', description: 'Coffee meeting', category: 'personal' }
    ];
    const filtered = filterRecords(records, 'safeway');
    assertEquals(filtered.length, 1);
    assertEquals(filtered[0].id, '1');
  });

  await runTest('Utils', 'filterRecords returns all records when query is empty', () => {
    const records = [{ id: '1' }, { id: '2' }];
    assertEquals(filterRecords(records, '').length, 2);
  });

  await runTest('Utils', 'escapeHtml prevents XSS injection', () => {
    const input = '<script>alert("xss")</script>&"\'';
    const output = escapeHtml(input);
    assert(!output.includes('<script>'), 'Must escape open script tag');
    assert(output.includes('&lt;script&gt;'), 'Must encode angle brackets');
    assert(output.includes('&amp;'), 'Must encode ampersand');
    assert(output.includes('&quot;'), 'Must encode double quote');
  });

  // 2. WorkspaceDB Storage & Vector Search
  await runTest('WorkspaceDB', 'setKV, getKV, and deleteKV operations', async () => {
    await testDb.setKV('test_key', { foo: 'bar', count: 42 });
    const val = await testDb.getKV('test_key');
    assert(val !== null, 'Value should exist in KV store');
    assertEquals(val.foo, 'bar');
    assertEquals(val.count, 42);

    await testDb.deleteKV('test_key');
    const deletedVal = await testDb.getKV('test_key');
    assertEquals(deletedVal, null);
  });

  await runTest('WorkspaceDB', 'addRecord, getRecords, and deleteRecord', async () => {
    const rec = await testDb.addRecord('personal', 'transactions', {
      type: 'expense',
      description: 'Airport Taxi',
      amount: 45.5,
      category: 'travel'
    }, [0.1, 0.2, 0.3]);

    assert(rec.id && rec.id.startsWith('r_'), 'Record ID should start with r_');

    const records = await testDb.getRecords('personal', 'transactions');
    assert(records.length > 0, 'Should find at least 1 record');
    const found = records.find(r => r.id === rec.id);
    assert(found !== undefined, 'Found newly added record');
    assertEquals(found.data.amount, 45.5);

    await testDb.deleteRecord(rec.id);
    const updated = await testDb.getRecords('personal', 'transactions');
    assert(!updated.some(r => r.id === rec.id), 'Record should be deleted');
  });

  await runTest('WorkspaceDB', 'searchSimilar computes vector similarity ranking', async () => {
    await testDb.addRecord('personal', 'transactions', { description: 'AI Research Paper' }, [0.9, 0.1, 0.0]);
    await testDb.addRecord('personal', 'transactions', { description: 'Cooking Recipe' }, [0.0, 0.1, 0.9]);

    const results = await testDb.searchSimilar('personal', 'transactions', [0.95, 0.05, 0.0], 2);
    assert(results.length === 2, 'Should return both records');
    assertEquals(results[0].data.description, 'AI Research Paper', 'AI Research Paper should rank first');
    assert(results[0]._similarity > results[1]._similarity, 'Top result must have higher similarity');
  });

  await runTest('WorkspaceDB', 'logHistory and getHistory audit trail', async () => {
    await testDb.logHistory('config_change', { detail: 'Updated theme' });
    const history = await testDb.getHistory();
    assert(history.length > 0, 'History should have entries');
    assertEquals(history[0].type, 'config_change');
  });

  // 3. Config & ConfigAPI
  await runTest('Config', 'validateConfig verifies schema constraints', () => {
    validateConfig(configData);

    let threw = false;
    try {
      validateConfig({ app: {} });
    } catch (e) {
      threw = true;
    }
    assert(threw, 'validateConfig should throw for incomplete config');
  });

  await runTest('ConfigAPI', 'getters return valid objects', () => {
    const api = new ConfigAPI(testDb, state);
    assertEquals(api.getAppInfo().name, 'AI Workspace Pro');
    assert(api.getCharacters().length >= 2, 'Should have at least 2 characters');
    assert(api.getBusinesses().length >= 2, 'Should have at least 2 businesses');
    assert(api.getTools().length >= 25, 'Should have at least 25 tools');
  });

  await runTest('ConfigAPI', 'addCharacter adds and updates config', async () => {
    const api = new ConfigAPI(testDb, state);
    const newChar = {
      id: 'tester_bot',
      name: 'Tester Bot',
      persona: 'Automated QA',
      systemPrompt: 'You test things.',
      color: '#ff0000',
      specialization: ['testing'],
      emotions: { neutral: '🤖' }
    };
    await api.addCharacter(newChar);
    const chars = api.getCharacters();
    const found = chars.find(c => c.id === 'tester_bot');
    assert(found !== undefined, 'New character should exist in config');
    assertEquals(found.name, 'Tester Bot');
  });

  await runTest('ConfigAPI', 'addBusiness adds workspace', async () => {
    const api = new ConfigAPI(testDb, state);
    await api.addBusiness({ id: 'test_corp', name: 'Test Corp' });
    const biz = api.getBusinesses().find(b => b.id === 'test_corp');
    assert(biz !== undefined, 'Test Corp should exist');
    assertEquals(biz.name, 'Test Corp');
  });

  await runTest('ConfigAPI', 'addSchema registers new schema table', async () => {
    const api = new ConfigAPI(testDb, state);
    await api.addSchema('personal', 'test_table', {
      fields: { title: 'string', rating: 'number' },
      vectorize: ['title']
    });
    const schemas = api.getSchemas('personal');
    assert(schemas.test_table !== undefined, 'test_table should be registered');
  });

  await runTest('ConfigAPI', 'getActiveCharacter and getActiveBusiness handle empty/custom configs gracefully', () => {
    const mockState = { config: { app: { defaultCharacter: 'custom_bot', defaultBusiness: 'custom_biz' }, characters: [], businesses: [] } };
    const char = getActiveCharacter(mockState);
    assertEquals(char.id, 'custom_bot');
    const biz = getActiveBusiness(mockState);
    assertEquals(biz.id, 'custom_biz');
  });

  // 4. Tool Registry & Sandboxing
  await runTest('ToolRegistry', 'registers all 25 tools from config', () => {
    const registry = new ToolRegistry();
    registerAllCoreTools(registry, testDb, state, agentComm, googleAPI);
    const tools = registry.getAllTools();
    assertEquals(tools.length, 25, `Expected exactly 25 registered tools, got ${tools.length}`);
    assert(registry.hasTool('add_transaction'), 'add_transaction tool should exist');
    assert(registry.hasTool('web_search'), 'web_search tool should exist');
    assert(registry.hasTool('delegate_to_agent'), 'delegate_to_agent tool should exist');
  });

  await runTest('ToolRegistry', 'validates required parameters', () => {
    const registry = new ToolRegistry();
    const schema = {
      parameters: {
        amount: { type: 'number', required: true },
        label: { type: 'string', required: false }
      }
    };

    let threw = false;
    try {
      registry.validateParams(schema, {});
    } catch (e) {
      threw = true;
      assert(e.message.includes('Required parameter "amount" is missing'), 'Proper error message');
    }
    assert(threw, 'Should fail validation on missing parameter');

    assert(registry.validateParams(schema, { amount: 100 }), 'Should pass with valid params');
  });

  await runTest('Sandboxing', 'createSandboxedTool executes safely in sandbox environment', async () => {
    const safeTool = createSandboxedTool(`
      return { sum: params.a + params.b };
    `, testDb);
    const result = await safeTool({ a: 15, b: 27 });
    assertEquals(result.sum, 42);
  });

  // 5. ToolChain
  await runTest('ToolChain', 'chains multiple tools sequentially with nested dot-notation access', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'step1',
      description: 'add 10',
      execute: async (p) => ({ value: p.num + 10 })
    });
    registry.register({
      name: 'step2',
      description: 'multiply by 2',
      execute: async (p) => ({ value: p.prev * 2 })
    });

    const chain = new ToolChain(registry);
    const chainResult = await chain.execute({
      steps: [
        { tool: 'step1', params: { num: 5 }, outputKey: 'res1' },
        { tool: 'step2', params: { prev: '{{res1.value}}' } }
      ]
    });

    assertEquals(chainResult.results.length, 2);
    assertEquals(chainResult.results[1].result.value, 30);
  });

  // 6. Agent Communication
  await runTest('AgentCommunication', 'identifies specialists and routes messages', async () => {
    const finAgent = agentComm.getAgentBySpecialization('finance');
    assert(finAgent !== null, 'Finance agent should be found');
    assertEquals(finAgent.id, 'marcus');

    const taskAgent = agentComm.getBestAgentForQuery('What are my upcoming tasks and todo list?');
    assert(taskAgent !== null, 'Task agent should be matched');
    assertEquals(taskAgent.id, 'aria');
  });

  // 7. Intent Detection & Tool Call Parsing
  await runTest('IntentDetection', 'detects transaction intent', async () => {
    const intent = await detectIntent('Spent $42.50 on dinner with clients', state);
    assertEquals(intent, 'add_transaction');
  });

  await runTest('IntentDetection', 'detects todo intent', async () => {
    const intent = await detectIntent('add todo: buy fresh milk tomorrow', state);
    assertEquals(intent, 'add_todo');
  });

  await runTest('IntentDetection', 'detects calendar event intent', async () => {
    const intent = await detectIntent('schedule meeting with team on Friday', state);
    assertEquals(intent, 'add_event');
  });

  await runTest('IntentDetection', 'detects agent delegation intent with valid parameters', async () => {
    const intent = await detectIntent('delegate to marcus check quarterly expenses', state);
    assert(typeof intent === 'object', 'Intent should be object');
    assertEquals(intent.tool, 'delegate_to_agent');
    assertEquals(intent.params.targetAgentId, 'marcus');
    assert(intent.params.message.includes('quarterly expenses'), 'Param message should be extracted');
  });

  await runTest('ParseToolCall', 'parses JSON tool call syntax', () => {
    const raw = 'I will execute this: ```json\n{"tool": "add_todo", "params": {"task": "Review PR"}}\n```';
    const parsed = parseToolCall(raw);
    assert(parsed !== null, 'Should parse tool call');
    assertEquals(parsed.tool, 'add_todo');
    assertEquals(parsed.params.task, 'Review PR');
  });

  await runTest('ParseToolCall', 'parses XML tool call syntax', () => {
    const raw = '<tool name="search"><query>quarterly profit</query></tool>';
    const parsed = parseToolCall(raw);
    assert(parsed !== null, 'Should parse XML tool call');
    assertEquals(parsed.tool, 'search');
    assertEquals(parsed.params.query, 'quarterly profit');
  });

  // 8. Execution of All 25 Registered Core Tools
  const mainRegistry = new ToolRegistry();
  registerAllCoreTools(mainRegistry, testDb, state, agentComm, googleAPI);

  await runTest('Tools', '1. add_transaction records transaction', async () => {
    const res = await mainRegistry.execute('add_transaction', {
      amount: 25.5,
      type: 'expense',
      category: 'food',
      description: 'Team Lunch'
    });
    assert(res.text.includes('Recorded') && res.text.includes('25.50'), 'Should confirm recorded transaction');
  });

  await runTest('Tools', '2. analyze_expenses summarizes spending', async () => {
    const res = await mainRegistry.execute('analyze_expenses', {});
    assert(res.text.includes('Breakdown') || res.chart !== undefined, 'Should provide analysis report');
  });

  await runTest('Tools', '3. add_todo adds a task', async () => {
    const res = await mainRegistry.execute('add_todo', {
      task: 'Finalize quarterly report',
      priority: 'high'
    });
    assert(res.text.includes('Added to-do') || res.text.includes('Finalize quarterly report'), 'Should confirm added todo');
  });

  await runTest('Tools', '4. list_todos lists tasks', async () => {
    const res = await mainRegistry.execute('list_todos', {});
    assert(res.text.includes('Tasks') || res.text.includes('todos'), 'Should list todos or tasks');
  });

  await runTest('Tools', '5. add_event schedules an event', async () => {
    const res = await mainRegistry.execute('add_event', {
      summary: 'Product Roadmap Review',
      date: '2026-09-15',
      time: '14:00'
    });
    assert(res.text.includes('Scheduled') || res.text.includes('Product Roadmap Review'), 'Should confirm scheduled event');
  });

  await runTest('Tools', '6. check_calendar views upcoming schedule', async () => {
    const res = await mainRegistry.execute('check_calendar', {});
    assert(res.text.includes('Calendar') || res.text.includes('Upcoming') || res.text.includes('No events'), 'Should return calendar schedule');
  });

  await runTest('Tools', '7. create_schema adds custom schema', async () => {
    const res = await mainRegistry.execute('create_schema', {
      name: 'invoices',
      fields: { invoiceNumber: 'string', total: 'number' }
    });
    assert(res.text.includes('Created dynamic schema') && res.text.includes('invoices'), 'Should confirm schema creation');
  });

  await runTest('Tools', '8. search performs vector / keyword search', async () => {
    const res = await mainRegistry.execute('search', { query: 'Team Lunch' });
    assert(res.text.includes('Matches') || res.text.includes('records found') || res.text.includes('Semantic Matches'), 'Should return search results');
  });

  await runTest('Tools', '9. update_config updates configuration property', async () => {
    const res = await mainRegistry.execute('update_config', {
      path: 'app.subtitle',
      value: 'Autonomous Super Assistant'
    });
    assert(res.text.includes('Configuration updated') || res.text.includes('app.subtitle'), 'Should confirm config update');
    assertEquals(state.config.app.subtitle, 'Autonomous Super Assistant');
  });

  await runTest('Tools', '10. get_config retrieves config value', async () => {
    const res = await mainRegistry.execute('get_config', { path: 'app.subtitle' });
    assert(res.text.includes('Autonomous Super Assistant'), 'Should return updated subtitle');
  });

  await runTest('Tools', '11. add_character registers new character', async () => {
    const res = await mainRegistry.execute('add_character', {
      character: {
        id: 'sage',
        name: 'Sage',
        persona: 'Philosophy & Logic AI',
        systemPrompt: 'You are Sage.',
        color: '#10b981',
        specialization: ['logic', 'reasoning']
      }
    });
    assert(res.text.includes('Character') && res.text.includes('Sage'), 'Should confirm character added');
    assert(state.config.characters.some(c => c.id === 'sage'), 'Character should exist in state');
  });

  await runTest('Tools', '12. add_business registers new workspace', async () => {
    const res = await mainRegistry.execute('add_business', {
      business: { id: 'acme', name: 'Acme Enterprises' }
    });
    assert(res.text.includes('Workspace') && res.text.includes('Acme Enterprises'), 'Should confirm business added');
    assert(state.config.businesses.some(b => b.id === 'acme'), 'Business should exist in state');
  });

  await runTest('Tools', '13. create_tool registers dynamic sandboxed tool', async () => {
    const res = await mainRegistry.execute('create_tool', {
      toolDefinition: {
        name: 'dynamic_multiplier',
        description: 'Multiplies two numbers',
        code: 'return { text: `Result: ${params.a * params.b}` };'
      }
    });
    assert(res.text.includes('Dynamic tool') && res.text.includes('dynamic_multiplier'), 'Should confirm tool created');
    assert(mainRegistry.hasTool('dynamic_multiplier'), 'Dynamic tool must be registered in registry');
  });

  await runTest('Tools', '14. rollback_config rolls back to previous state', async () => {
    const res = await mainRegistry.execute('rollback_config', {});
    assert(typeof res.text === 'string' && res.text.length > 0, 'Should return rollback result');
  });

  await runTest('Tools', '15. list_tools displays active tools and schemas', async () => {
    const res = await mainRegistry.execute('list_tools', {});
    assert(res.text.includes('Active Tools') && res.text.includes('add_transaction'), 'Should list active tools');
  });

  await runTest('Tools', '16. execute_chain runs tool sequence', async () => {
    const res = await mainRegistry.execute('execute_chain', {
      chain: {
        steps: [
          { tool: 'list_todos', params: {} }
        ]
      }
    });
    assert(res.text.includes('Chain Execution Result'), 'Chain should succeed');
  });

  await runTest('Tools', '17. delegate_to_agent delegates request to another persona', async () => {
    const res = await mainRegistry.execute('delegate_to_agent', {
      targetAgentId: 'marcus',
      message: 'Analyze recent expenses'
    });
    assert(res.text.includes('Delegated to') || res.text.includes('Marcus'), 'Should confirm delegation');
  });

  await runTest('Tools', '18. ask_agent collaborates with specialist', async () => {
    const res = await mainRegistry.execute('ask_agent', {
      targetAgentId: 'marcus',
      message: 'What is the current balance?'
    });
    assert(res.text.includes('consulted with') || res.text.includes('Marcus'), 'Should include agent response');
  });

  await runTest('Tools', '19. list_agents outputs team directory', async () => {
    const res = await mainRegistry.execute('list_agents', {});
    assert(res.text.includes('Available') && res.text.includes('Agents') && res.text.includes('Aria'), 'Should list team members');
  });

  await runTest('Tools', '20. route_to_specialist finds specialist for query', async () => {
    const res = await mainRegistry.execute('route_to_specialist', {
      query: 'I need financial advice regarding tax write-offs'
    });
    assert(res.text.includes('Routed to') || res.text.includes('Marcus'), 'Should route finance query to Marcus');
  });

  await runTest('Tools', '21. web_search executes web search query', async () => {
    const res = await mainRegistry.execute('web_search', { query: 'WebAssembly browser AI' });
    assert(res.text.includes('Web Search') || res.text.includes('Web Results') || res.text.includes('DuckDuckGo'), 'Should return web search result');
  });

  await runTest('Tools', '22. google_calendar_list handles calendar listing gracefully', async () => {
    const res = await mainRegistry.execute('google_calendar_list', {});
    assert(res.text.includes('Google Calendar') || res.text.includes('Google') || res.text.includes('⚠️'), 'Should handle calendar list');
  });

  await runTest('Tools', '23. google_drive_list handles drive files listing gracefully', async () => {
    const res = await mainRegistry.execute('google_drive_list', {});
    assert(res.text.includes('Google Drive') || res.text.includes('Google') || res.text.includes('⚠️'), 'Should handle drive files list');
  });

  await runTest('Tools', '24. google_sheets_read handles spreadsheet retrieval gracefully', async () => {
    const res = await mainRegistry.execute('google_sheets_read', { spreadsheetId: 'test-sheet-id' });
    assert(res.text.includes('Google Sheet') || res.text.includes('Google') || res.text.includes('⚠️'), 'Should handle sheets read');
  });

  await runTest('Tools', '25. change_character_name renames current persona', async () => {
    const res = await mainRegistry.execute('change_character_name', { name: 'Aria Prime' });
    assert(res.text.includes('My name has been changed to') && res.text.includes('Aria Prime'), 'Should confirm name change');
    assertEquals(state.config.characters.find(c => c.id === 'aria').name, 'Aria Prime');
  });

  // 9. Integration with executeTool engine (validates object/string handling & no crashing)
  await runTest('Integration', 'executeTool safely handles string queries', async () => {
    const res = await executeTool('list_todos', 'show my tasks', state, mainRegistry);
    assert(res.text.includes('Tasks') || res.text.includes('todos'), 'executeTool handles string input without error');
  });

  await runTest('Integration', 'executeTool safely handles parsed tool call objects', async () => {
    const res = await executeTool({ tool: 'list_todos', params: {} }, {}, state, mainRegistry);
    assert(res.text.includes('Tasks') || res.text.includes('todos'), 'executeTool handles object input without error');
  });

  // Summary
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`📊 TEST SUMMARY: ${passCount} Passed, ${failCount} Failed (Total: ${passCount + failCount})`);
  console.log('════════════════════════════════════════════════════════════\n');

  if (isBrowser) {
    updateBrowserUI();
  }

  return { passCount, failCount, results: testResults };
}

function updateBrowserUI() {
  const container = document.getElementById('testResults');
  const totalEl = document.getElementById('totalTests');
  const passEl = document.getElementById('passedTests');
  const failEl = document.getElementById('failedTests');

  if (totalEl) totalEl.textContent = passCount + failCount;
  if (passEl) passEl.textContent = passCount;
  if (failEl) failEl.textContent = failCount;

  if (container) {
    container.innerHTML = testResults.map(r => `
      <div class="d-flex justify-content-between align-items-center border-bottom py-2">
        <div>
          <span class="badge bg-${r.status === 'passed' ? 'success' : 'danger'} me-2">${r.status.toUpperCase()}</span>
          <strong>[${escapeHtml(r.suite)}]</strong> ${escapeHtml(r.name)}
          ${r.error ? `<div class="text-danger small mt-1 font-monospace">${escapeHtml(r.error)}</div>` : ''}
        </div>
        <small class="text-muted">${r.duration}ms</small>
      </div>
    `).join('');
  }
}

// Auto-run when executed
if (isNode) {
  runAllTests().then(({ failCount }) => {
    process.exit(failCount > 0 ? 1 : 0);
  }).catch(err => {
    console.error('Fatal test runner error:', err);
    process.exit(1);
  });
} else if (isBrowser) {
  window.addEventListener('DOMContentLoaded', () => {
    const runBtn = document.getElementById('runAllTests');
    if (runBtn) {
      runBtn.onclick = () => {
        runAllTests();
      };
    }
    runAllTests();
  });
}

export { runAllTests };
