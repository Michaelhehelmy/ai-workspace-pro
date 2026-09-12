/**
 * app.js - Application Bootstrap & Public API
 * Re-exports the modular core/app layers for browser and test consumption.
 */

import { isBrowser } from './core/env.js';
import { state, getActiveCharacter, getActiveBusiness } from './core/state.js';
import { workspaceDB as db, WorkspaceDB, cosineSimilarity } from './core/db.js';
import { configAPI, ConfigAPI, validateConfig, CONFIG_SCHEMA, collectConfigIssues, isPlaceholder, applyRuntimeOverrides } from './core/config.js';
import { toolRegistry, ToolRegistry, ToolChain, createSandboxedTool } from './core/tools.js';
import { Extension, ExtensionRegistry, extensionRegistry, BUILTIN_EXTENSIONS, applyBuiltinExtensions, permissionMeta } from './core/extensions.js';
import { filterRecords, escapeHtml } from './core/utils.js';
import { AgentCommunication } from './app/agents.js';
import { GoogleAPI } from './app/google.js';
import { getModel, computeEmbedding, embedText, unloadAll, isStageLoaded, getPipelineStatus, PIPELINE_STAGES, ModelError, formatModelError, preloadModels, forcePreload, getTransformers, resolveStage, getModelCatalog, getModelsForStage, getModelMeta, getStageOptions, applyStageModel, defaultModelSettings, getDeviceRecommendations, buildRecommendedModelSettings } from './app/models.js';
import { createBackend, registerBackend, getBackend, listBackends } from './app/ai/backend.js';
import { resolveBackendForStage, setStageBackend, probeAllBackends, resetHealthCache } from './app/ai/routing.js';
import { agentLoop } from './app/ai/agent-loop.js';
import './app/ai/llamacpp-backend.js';
import './app/ai/ollama-backend.js';
import { detectIntent, parseToolCall } from './app/intent.js';
import { executeTool, registerAllCoreTools } from './app/execute.js';
import { runPipeline, classifyIntent, extractEntities, generateResponse, composeToolText, rankTools, routeToAgent, INTENT_LABELS } from './app/pipeline.js';
import { loadConfiguration, init, agentComm, googleAPI } from './app/init.js';
import { Skill, SkillLibrary, skillLibrary, BUILTIN_SKILLS } from './core/skills.js';
import { compactChat, buildDigestSummary } from './core/compaction.js';
import { detectDevice, defaultProbes, getModelFit, recommendModelSet, describeDevice, DEVICE_TIERS } from './core/device.js';
import { startPiRpc, createPiClient, createPiServer, PiRpcError } from './app/pi/pi-rpc.js';

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
  collectConfigIssues,
  isPlaceholder,
  applyRuntimeOverrides,
  toolRegistry,
  ToolRegistry,
  ToolChain,
  createSandboxedTool,
  Extension,
  ExtensionRegistry,
  extensionRegistry,
  BUILTIN_EXTENSIONS,
  applyBuiltinExtensions,
  permissionMeta,
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
  ModelError,
  formatModelError,
  preloadModels,
  forcePreload,
  getTransformers,
  resolveStage,
  getModelCatalog,
  getModelsForStage,
  getModelMeta,
  getStageOptions,
  applyStageModel,
  defaultModelSettings,
  getDeviceRecommendations,
  buildRecommendedModelSettings,
  createBackend,
  registerBackend,
  getBackend,
  listBackends,
  resolveBackendForStage,
  setStageBackend,
  probeAllBackends,
  resetHealthCache,
  agentLoop,
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
  googleAPI,
  Skill,
  SkillLibrary,
  skillLibrary,
  BUILTIN_SKILLS,
  compactChat,
  buildDigestSummary,
  startPiRpc,
  createPiClient,
  createPiServer,
  PiRpcError,
  detectDevice,
  defaultProbes,
  getModelFit,
  recommendModelSet,
  describeDevice,
  DEVICE_TIERS
};

if (isBrowser && !window.__DISABLE_AUTO_INIT__) {
  init().then(() => {
    const uiPromise = import('./app/ui.js');
    uiPromise.then(ui => {
      ui.registerSendHandler(async (text) => {
        // The busy/typing lifecycle is owned by ui.sendMessage's setBusy().
        // Real-model pipeline: data tools succeed honestly; chat-only paths
        // require a working dialog model or surface a typed, actionable error.
        const runner = (tool, params) => executeTool(tool, params, state);
        let res = null;
        let fatal = null;
        try {
          res = await runPipeline(text, { state, router: agentComm, runner });
        } catch (err) {
          fatal = err;
        }

        const char = getActiveCharacter(state);
        const ts = Date.now();

        if (fatal) {
          ui.appendChatMessage('system', formatModelError(fatal), { ts, persist: true });
          console.error('[AI Workspace Pro] Pipeline error:', fatal);
          return;
        }
        if (res && res.ok) {
          if (res.warning) ui.appendChatMessage('system', formatModelError(res.warning), { ts, persist: true });
          ui.appendChatMessage('assistant', res.response, {
            name: char.name,
            emotion: ui.emotionFor(res),
            animate: true,
            ts,
            persist: true
          });
          if (res.response) ui.maybeReadAloud(res.response);
        } else {
          if (res && res.error) ui.appendChatMessage('system', formatModelError(res.error), { ts, persist: true });
          if (res && res.response) ui.appendChatMessage('assistant', res.response, {
            name: char.name,
            emotion: ui.emotionFor(res),
            animate: true,
            ts,
            persist: true
          });
        }
      });
    });
    console.log('[AI Workspace Pro] Ready.');
  }).catch(err => {
    console.error('[AI Workspace Pro] Init failed:', err);
  });
}

export default state;