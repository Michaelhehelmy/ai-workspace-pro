/**
 * app/init.js - Application Bootstrap
 */

import { isBrowser } from '../core/env.js';
import { state } from '../core/state.js';
import { workspaceDB as db } from '../core/db.js';
import { validateConfig, configAPI, applyRuntimeOverrides, collectConfigIssues } from '../core/config.js';
import { toolRegistry } from '../core/tools.js';
import { preloadModels } from './models.js';
import { AgentCommunication } from './agents.js';
import { GoogleAPI } from './google.js';
import { registerAllCoreTools } from './execute.js';
import { extensionRegistry } from '../core/extensions.js';

export const agentComm = new AgentCommunication(state, db);
export const googleAPI = new GoogleAPI(state, db);

export async function loadConfiguration() {
  try {
    // The canonical config always comes from the shipped config.json so
    // catalog additions (new models) reach existing users; the persisted
    // user config (IndexedDB) still wins for every other setting.
    let configData = null;
    if (isBrowser) {
      const resp = await fetch('config.json');
      configData = await resp.json();
    } else {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      try {
        configData = require('../config.json');
      } catch (e) {
        configData = null;
      }
    }

    const saved = await loadSavedConfigSafe();
    if (saved && saved.loaded) {
      // loadSavedConfig assigns the persisted config to state.config
      configData = mergeConfig(configData || state.config, state.config);
    }

    if (configData) {
      await applyRuntimeOverrides(configData);
      validateConfig(configData);
      state.config = configData;
    }

    state.configIssues = state.config ? collectConfigIssues(state.config) : [];
    return state;
  } catch (e) {
    console.warn('Failed to load configuration:', e);
    state.configIssues = state.config ? collectConfigIssues(state.config) : [];
    return state;
  }
}

/**
 * Merge the shipped (disk) config with a persisted user config. User settings
 * win everywhere EXCEPT modelSettings.availableModels, which is a union of the
 * two keyed by model id — shipped entries keep their id, name, and size so
 * freshly-added models (and updated sizes) always appear in the Models tab,
 * while user-added custom models are preserved.
 */
function mergeConfig(disk, saved) {
  if (!disk) return saved;
  if (!saved) return disk;
  const out = deepClone(disk);
  overlay(out, saved);
  const diskModels = (disk.modelSettings && Array.isArray(disk.modelSettings.availableModels)) ? disk.modelSettings.availableModels : [];
  const savedModels = (saved.modelSettings && Array.isArray(saved.modelSettings.availableModels)) ? saved.modelSettings.availableModels : [];
  if (Array.isArray(out.modelSettings)) out.modelSettings = {};
  if (!out.modelSettings || typeof out.modelSettings !== 'object') out.modelSettings = {};
  out.modelSettings.availableModels = unionModels(diskModels, savedModels);
  return out;
}

function deepClone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

async function loadSavedConfigSafe() {
  try {
    return await configAPI.loadSavedConfig();
  } catch (e) {
    console.warn('Ignoring unreadable saved config:', e);
    return { success: true, loaded: false };
  }
}

function overlay(target, patch) {
  if (target == null || typeof target !== 'object') return;
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
      overlay(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

function unionModels(shipped, saved) {
  const byId = new Map();
  for (const m of shipped) if (m && m.id) byId.set(m.id, m);
  for (const m of saved) if (m && m.id && !byId.has(m.id)) byId.set(m.id, m);
  return Array.from(byId.values());
}

export async function init() {
  // Open IndexedDB and replay persisted data into memory BEFORE configuration
  // is resolved, so saved config / history survive a reload (no-op in Node).
  await db.init();

  if (!state.config) {
    await loadConfiguration();
  }
  if (!state.activeCharacterId) {
    state.activeCharacterId = state.config?.app?.defaultCharacter || (state.config?.characters?.[0]?.id) || 'aria';
  }
  if (!state.activeBusinessId) {
    state.activeBusinessId = state.config?.app?.defaultBusiness || (state.config?.businesses?.[0]?.id) || 'personal';
  }

  const { registerAllCoreTools: registerTools } = await import('./execute.js');
  registerTools(toolRegistry, db, state, agentComm, googleAPI);

  // Re-register any dynamic tools the AI created and we persisted in KV, so
  // freshly-created tools survive a page reload / server restart.
  const persistedTools = (await db.getKV('custom_tools')) || [];
  for (const def of persistedTools) {
    if (def && def.name && !toolRegistry.hasTool(def.name)) {
      try {
        await toolRegistry.registerToolFromAI(def, db);
      } catch (e) {
        console.warn('Failed to restore custom tool', def.name, e);
      }
    }
  }

  // Restore which extensions the user disabled (persisted as a KV list).
  const extState = (await db.getKV('extension_state')) || null;
  if (extState && Array.isArray(extState.disabled)) {
    extensionRegistry.restoreState(extState.disabled);
  }

  // Rehydrate the "assistant's folder" handle (Word/Excel output target).
  const { restoreFolder } = await import('../core/files.js');
  restoreFolder().catch(() => {});

  state.configIssues = state.config ? collectConfigIssues(state.config) : [];

  if (isBrowser) {
    // Lazy by default: models load on first use, so opening the page never
    // re-downloads/re-compiles weights. Opt in to warming them via
    // modelSettings.preloadOnOpen or the Models tab "Preload all" button.
    if (state.config?.modelSettings?.preloadOnOpen) {
      preloadModels(); // warm the on-device model cache on page access (background)
    }
    const ui = await import('./ui.js');
    ui.renderExplorer();
    ui.renderConfigIssues();
    ui.applyTheme();
    ui.initTabNavigation();
    ui.initSidebarResize();
    ui.initModelsTab();
    ui.initControls();
    await ui.hydrateChat();

    const characterList = document.getElementById('characterList');
    if (characterList) {
      characterList.addEventListener('click', (e) => {
        const editBtn = e.target.closest('[data-edit-character]');
        const delBtn = e.target.closest('[data-delete-character]');
        const anchor = e.target.closest('a[data-character-id]');
        if (editBtn) {
          e.preventDefault();
          ui.openCharacterModal(editBtn.dataset.editCharacter);
          return;
        }
        if (delBtn) {
          e.preventDefault();
          ui.deleteCharacter(delBtn.dataset.deleteCharacter);
          return;
        }
        if (anchor) {
          e.preventDefault();
          state.activeCharacterId = anchor.dataset.characterId;
          ui.renderExplorer();
        }
      });
    }
    const businessList = document.getElementById('businessList');
    if (businessList) {
      businessList.addEventListener('click', (e) => {
        const editBtn = e.target.closest('[data-edit-business]');
        const delBtn = e.target.closest('[data-delete-business]');
        const anchor = e.target.closest('a[data-business-id]');
        if (editBtn) {
          e.preventDefault();
          ui.openBusinessModal(editBtn.dataset.editBusiness);
          return;
        }
        if (delBtn) {
          e.preventDefault();
          ui.deleteBusiness(delBtn.dataset.deleteBusiness);
          return;
        }
        if (anchor) {
          e.preventDefault();
          state.activeBusinessId = anchor.dataset.businessId;
          ui.renderExplorer();
        }
      });
    }

    document.querySelectorAll('#quickPromptsContainer .quick-prompt').forEach(btn => {
      btn.addEventListener('click', () => {
        ui.sendMessage(btn.dataset.query || btn.textContent);
      });
    });

    const exportConfigBtn = document.getElementById('exportConfigBtn');
    if (exportConfigBtn) {
      exportConfigBtn.addEventListener('click', async () => {
        const json = await configAPI.exportConfig();
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'ai-workspace-config.json';
        a.click();
        URL.revokeObjectURL(a.href);
      });
    }

    const importConfigBtn = document.getElementById('importConfigBtn');
    const importConfigInput = document.getElementById('importConfigInput');
    if (importConfigBtn && importConfigInput) {
      importConfigBtn.addEventListener('click', () => {
        importConfigInput.value = '';
        importConfigInput.click();
      });
      importConfigInput.addEventListener('change', async () => {
        const file = importConfigInput.files && importConfigInput.files[0];
        if (!file) return;
        const text = await file.text();
        const res = await configAPI.importConfig(text);
        if (res && res.success) {
          state.configIssues = collectConfigIssues(state.config);
          ui.renderExplorer();
          ui.renderConfigIssues();
          ui.applyTheme();
        } else {
          window.alert('Config import failed: ' + ((res && res.error) || 'invalid file'));
        }
      });
    }

    const resetConfigBtn = document.getElementById('resetConfigBtn');
    if (resetConfigBtn) {
      resetConfigBtn.addEventListener('click', async () => {
        if (!window.confirm('Reset configuration to defaults? This clears your saved workspace.')) return;
        await configAPI.resetConfig();
        await loadConfiguration();
        ui.renderExplorer();
        ui.renderConfigIssues();
        ui.applyTheme();
      });
    }
  }

  return state;
}

export default init;