/**
 * app.js - Application Bootstrap & Public API
 * Re-exports the modular core/app layers for browser and test consumption.
 */

import { isBrowser } from './core/env.js';
import { state, getActiveCharacter, getActiveBusiness } from './core/state.js';
import { workspaceDB as db, WorkspaceDB, cosineSimilarity } from './core/db.js';
import { configAPI, ConfigAPI, validateConfig, CONFIG_SCHEMA } from './core/config.js';
import { toolRegistry, ToolRegistry, ToolChain, createSandboxedTool } from './core/tools.js';
import { filterRecords, escapeHtml } from './core/utils.js';
import { AgentCommunication } from './app/agents.js';
import { GoogleAPI } from './app/google.js';
import { getModel, computeEmbedding, embedText, unloadAll, isStageLoaded, getPipelineStatus, PIPELINE_STAGES } from './app/models.js';
import { detectIntent, parseToolCall } from './app/intent.js';
import { executeTool, registerAllCoreTools } from './app/execute.js';
import { runPipeline, classifyIntent, extractEntities, generateResponse, composeToolText, rankTools, routeToAgent, INTENT_LABELS } from './app/pipeline.js';
import { loadConfiguration, init, agentComm, googleAPI } from './app/init.js';

export {
  state,
  getActiveCharacter,
  getActiveBusiness,
  db,
  WorkspaceDB,
  cosineSimilarity,
  configAPI,
  ConfigAPI,
  validateConfig,
  CONFIG_SCHEMA,
  toolRegistry,
  ToolRegistry,
  ToolChain,
  createSandboxedTool,
  filterRecords,
  escapeHtml,
  AgentCommunication,
  GoogleAPI,
  getModel,
  computeEmbedding,
  embedText,
  unloadAll,
  isStageLoaded,
  getPipelineStatus,
  PIPELINE_STAGES,
  detectIntent,
  parseToolCall,
  executeTool,
  registerAllCoreTools,
  runPipeline,
  classifyIntent,
  extractEntities,
  generateResponse,
  composeToolText,
  rankTools,
  routeToAgent,
  INTENT_LABELS,
  loadConfiguration,
  init,
  agentComm,
  googleAPI
};

if (isBrowser && !window.__DISABLE_AUTO_INIT__) {
  init().then(() => {
    const uiPromise = import('./app/ui.js');
    uiPromise.then(ui => {
      ui.registerSendHandler(async (text) => {
        ui.appendChatMessage('user', text);
        ui.showTypingIndicator();

        // Multi-model pipeline first: one small model at a time.
        const runner = (tool, params) => executeTool(tool, params, state);
        let res = null;
        try {
          res = await runPipeline(text, { state, router: agentComm, runner });
        } catch (_) {}

        // Deterministic fallback when no model produced a response (offline/Node).
        if (!res || !res.response) {
          const detected = await detectIntent(text, state);
          const result = await executeTool(detected, text, state);
          res = { response: (result && result.text) || JSON.stringify(result) };
        }

        ui.hideTypingIndicator();
        ui.appendChatMessage('assistant', res.response);
      });
    });
    console.log('[AI Workspace Pro] Ready.');
  }).catch(err => {
    console.error('[AI Workspace Pro] Init failed:', err);
  });
}

export default state;