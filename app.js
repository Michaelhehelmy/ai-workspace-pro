/**
 * app.js - Application Bootstrap & Public API
 * Re-exports the modular core/app layers for browser and test consumption.
 */

import { isBrowser } from './core/env.js';
import { state, getActiveCharacter, getActiveBusiness } from './core/state.js';
import { workspaceDB as db, WorkspaceDB, cosineSimilarity } from './core/db.js';
import { configAPI, ConfigAPI, validateConfig, CONFIG_SCHEMA, CONFIG_SCHEMA_VERSION, migrateLegacyModelCatalog, collectConfigIssues, isPlaceholder, applyRuntimeOverrides } from './core/config.js';
import { toolRegistry, ToolRegistry, ToolChain, createSandboxedTool } from './core/tools.js';
import { Extension, ExtensionRegistry, extensionRegistry, BUILTIN_EXTENSIONS, applyBuiltinExtensions, permissionMeta } from './core/extensions.js';
import { filterRecords, escapeHtml } from './core/utils.js';
import { AgentCommunication } from './app/agents.js';
import { GoogleAPI } from './app/google.js';
import { getModel, computeEmbedding, embedText, unloadAll, isStageLoaded, getPipelineStatus, PIPELINE_STAGES, ModelError, formatModelError, preloadModels, forcePreload, getTransformers, resolveStage, getModelCatalog, getModelsForStage, getModelMeta, getStageOptions, applyStageModel, defaultModelSettings, getDeviceRecommendations, buildRecommendedModelSettings } from './app/models.js';
import { createBackend, registerBackend, getBackend, listBackends, ROLE_TO_STAGE, TASK_TO_STAGE } from './app/ai/backend.js';
import { resolveBackendForStage, setStageBackend, probeAllBackends, resetHealthCache } from './app/ai/routing.js';
import { agentLoop } from './app/ai/agent-loop.js';
import './app/ai/llamacpp-backend.js';
import './app/ai/ollama-backend.js';
import './app/ai/cfai-backend.js';
import { detectIntent, parseToolCall } from './app/intent.js';
import { executeTool, registerAllCoreTools } from './app/execute.js';
import { runPipeline, classifyIntent, extractEntities, generateResponse, generateChatResponse, composeToolText, rankTools, routeToAgent, INTENT_LABELS } from './app/pipeline.js';
import { loadConfiguration, init, agentComm, googleAPI } from './app/init.js';
import { Skill, SkillLibrary, skillLibrary, BUILTIN_SKILLS, buildSystemPrompt } from './core/skills.js';
import { compactChat, buildDigestSummary } from './core/compaction.js';
import { detectDevice, defaultProbes, deviceMemoryToMb, estimateMemoryMb, classifyFormFactor, getModelFit, recommendModelSet, describeDevice, DEVICE_TIERS } from './core/device.js';
import { crc32, zipBytes, inspectZip, buildDocx, buildXlsx, saveFile, requestFolder, restoreFolder, hasFolderHandle, getFolderName, setFolderHandle, clearFolderHandle, getFolderHandle } from './core/files.js';
import { setWorkspaceAdapter, getWorkspaceAdapter, createFsAdapter, createMemAdapter, listWorkspace, readWorkspaceFile, writeWorkspaceFile, editWorkspaceFile, appendWorkspaceFile, deleteWorkspaceFile, makePatch, renderPatch, WorkspaceError, assertSafeRelPath, normalizeRelPath, WORKSPACE_MAX_FILE_BYTES, WORKSPACE_MAX_TREE_ENTRIES } from './core/workspace.js';
import { runCodingAgent, recognizeCodingRequest, CODER_HELP, WORKSPACE_TOOLS, CODER_PERSONA, buildCoderSystemPrompt } from './app/coding.js';
import { startPiRpc, createPiClient, createPiServer, PiRpcError, PI_NODE, buildRequest, defaultMethods } from './app/pi/pi-rpc.js';

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
  CONFIG_SCHEMA_VERSION,
  migrateLegacyModelCatalog,
  collectConfigIssues,
  isPlaceholder,
  applyRuntimeOverrides,
  toolRegistry,
  ToolRegistry,
  ToolChain,
  createSandboxedTool,
  Extension,
  ExtensionRegistry,
  ROLE_TO_STAGE,
  TASK_TO_STAGE,
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
  generateChatResponse,
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
  buildSystemPrompt,
  compactChat,
  buildDigestSummary,
  startPiRpc,
  createPiClient,
  createPiServer,
  PiRpcError,
  PI_NODE,
  buildRequest,
  defaultMethods,
  detectDevice,
  defaultProbes,
  deviceMemoryToMb,
  estimateMemoryMb,
  classifyFormFactor,
  getModelFit,
  recommendModelSet,
  describeDevice,
  DEVICE_TIERS,
  crc32,
  zipBytes,
  inspectZip,
  buildDocx,
  buildXlsx,
  saveFile,
  requestFolder,
  restoreFolder,
  hasFolderHandle,
  getFolderName,
  setFolderHandle,
  clearFolderHandle,
  getFolderHandle,
  setWorkspaceAdapter,
  getWorkspaceAdapter,
  createFsAdapter,
  createMemAdapter,
  listWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile,
  editWorkspaceFile,
  appendWorkspaceFile,
  deleteWorkspaceFile,
  makePatch,
  renderPatch,
  WorkspaceError,
  assertSafeRelPath,
  normalizeRelPath,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_TREE_ENTRIES,
  runCodingAgent,
  recognizeCodingRequest,
  CODER_HELP,
  WORKSPACE_TOOLS,
  CODER_PERSONA,
  buildCoderSystemPrompt
};

// Abort controller for an in-flight agent run (Stop button). Cleared when the
// handler settles so a stale abort never cancels a later request.
let activeAgentController = null;

if (isBrowser && !window.__DISABLE_AUTO_INIT__) {
  init().then(() => {
    const uiPromise = import('./app/ui.js');
    uiPromise.then(async ui => {
      ui.registerAgentStop(() => {
        // Mid-agent-run Stop: abort the loop's AbortController; the loop calls
        // a halt at the next iteration boundary and reports an interrupted run.
        if (activeAgentController && !activeAgentController.signal.aborted) {
          activeAgentController.abort();
        }
      });
      ui.registerSendHandler(async (text) => {
        // The busy/typing lifecycle is owned by ui.sendMessage's setBusy().
        // Real-model pipeline: data tools succeed honestly; chat-only paths
        // require a working dialog model or surface a typed, actionable error.
        const runner = (tool, params) => executeTool(tool, params, state);
        let res = null;
        let fatal = null;
        const opts = { state, router: agentComm, runner };

        // Agent mode (Phase C): opt-in multi-turn tool loop with live progress,
        // a verbosity knob, and a Stop button backed by an AbortController.
        if (ui.agentModeEnabled()) {
          const verbosity = ui.agentVerbosity();
          const controller = new AbortController();
          activeAgentController = controller;
          ui.refreshAgentControls();
          const snippet = (s) => {
            const t = String(s || '');
            return t.length > 110 ? t.slice(0, 107) + '…' : t;
          };
          opts.agent = {
            enabled: true,
            signal: controller.signal,
            maxIterations: 5,
            onStep: (step) => {
              if (!step || typeof step !== 'object') return;
              if (step.type === 'tool_start') {
                if (verbosity === 'details') {
                  let argsText = '';
                  try { argsText = JSON.stringify(step.args || {}); } catch (_) {}
                  ui.appendAgentStep(
                    `<span class="text-body-secondary">Agent · turn ${Number(step.iteration) + 1} —</span> ` +
                    `<strong>${escapeHtml(String(step.name))}</strong>` +
                    (argsText && argsText !== '{}' ? ` <span class="text-body-secondary">${escapeHtml(snippet(argsText))}</span>` : '')
                  );
                }
              } else if (step.type === 'tool_end') {
                if (verbosity === 'details' || verbosity === 'summary') {
                  const ok = step.ok !== false;
                  const rl = snippet(String(step.result || ''));
                  ui.appendAgentStep(
                    `<span class="${ok ? 'text-success' : 'text-danger'}">${ok ? '✔' : '✖'} ${escapeHtml(String(step.name))}</span>` +
                    (verbosity === 'details' ? ` <span class="text-body-secondary">→ ${escapeHtml(rl)}</span>` : '')
                  );
                }
              }
            }
          };
        }

        try {
          res = await runPipeline(text, opts);
        } catch (err) {
          fatal = err;
        } finally {
          activeAgentController = null;
          ui.refreshAgentControls();
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
          const reply = String(res.response || '').trim();
          if (reply) {
            ui.appendChatMessage('assistant', reply, {
              name: char.name,
              emotion: ui.emotionFor(res),
              animate: true,
              ts,
              persist: true
            });
            ui.maybeReadAloud(reply);
          } else {
            // Verified live: the dialog model occasionally returns a blank
            // reply. Never stay silent — surface an honest, actionable note.
            ui.appendChatMessage('system', '⚠️ The model returned an empty reply. Try rephrasing, or switch the dialog model in Settings.', { ts, persist: true });
          }
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

      // ── Coder panel: the in-app coding agent ────────────────────────────
      const coderRunner = (tool, params) => executeTool(tool, params, state);

      const codingList = async (dir = '.') => {
        try {
          const res = await listWorkspace(dir || '.');
          ui.renderCodingExplorer(res.entries, res.dir);
        } catch (err) {
          ui.setCoderStatus(err.message, 'warn');
        }
      };

      ui.registerCodingHandler({
        run: async (text) => {
          try {
            return await runCodingAgent(text, { state, runner: coderRunner });
          } catch (err) {
            return { ok: false, response: `⚠️ The coding agent hit an error: ${formatModelError(err)}` };
          }
        },
        list: codingList,
        openFolder: async () => {
          if (typeof window.showDirectoryPicker !== 'function') {
            ui.setCoderStatus('Folder access (File System Access API) is not supported in this browser. Try Chrome or Edge.', 'warn');
            return;
          }
          const name = await requestFolder().catch(() => null);
          if (!name) return;
          const h = getFolderHandle();
          if (!h) return;
          setWorkspaceAdapter(createFsAdapter(h));
          const refreshBtn = document.getElementById('coderRefreshBtn');
          if (refreshBtn) refreshBtn.disabled = false;
          ui.setCoderStatus(`Connected to <strong>${name}</strong> — the coding agent can read and (with your consent) write files here.`, 'ok');
          await codingList('.');
        }
      });

      // If a folder grant survived from a previous session, reconnect it.
      if (hasFolderHandle() && getFolderHandle()) {
        try {
          setWorkspaceAdapter(createFsAdapter(getFolderHandle()));
          const refreshBtn = document.getElementById('coderRefreshBtn');
          if (refreshBtn) refreshBtn.disabled = false;
          ui.setCoderStatus(`Reconnected to <strong>${getFolderName()}</strong>.`, 'ok');
          await codingList('.');
        } catch (_) { /* fall through: user picks a folder when needed */ }
      }
      ui.initCodingPanel();
    });
    console.log('[AI Workspace Pro] Ready.');
  }).catch(err => {
    console.error('[AI Workspace Pro] Init failed:', err);
  });
}

export default state;