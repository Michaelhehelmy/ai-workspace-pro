/**
 * app/init.js - Application Bootstrap
 */

import { isBrowser } from '../core/env.js';
import { state } from '../core/state.js';
import { workspaceDB as db } from '../core/db.js';
import { validateConfig, configAPI } from '../core/config.js';
import { toolRegistry } from '../core/tools.js';
import { AgentCommunication } from './agents.js';
import { GoogleAPI } from './google.js';
import { registerAllCoreTools } from './execute.js';

export const agentComm = new AgentCommunication(state, db);
export const googleAPI = new GoogleAPI(state, db);

export async function loadConfiguration() {
  try {
    const saved = await configAPI.loadSavedConfig();
    if (saved && saved.loaded) {
      return state;
    }
  } catch (e) {
    console.warn('Failed to load saved config:', e);
  }

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

  if (configData) {
    validateConfig(configData);
    state.config = configData;
  }

  return state;
}

export async function init() {
  // Replay any persisted IndexedDB data into memory BEFORE configuration is
  // resolved, so saved config / history survive a reload (no-op in Node).
  await db.hydrate();

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

  if (isBrowser) {
    const ui = await import('./ui.js');
    ui.renderExplorer();
    ui.applyTheme();
    ui.initTabNavigation();
    ui.initSidebarResize();

    document.querySelectorAll('#characterList a[data-character-id]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        state.activeCharacterId = el.dataset.characterId;
        ui.renderExplorer();
      });
    });
    document.querySelectorAll('#businessList a[data-business-id]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        state.activeBusinessId = el.dataset.businessId;
        ui.renderExplorer();
      });
    });

    document.querySelectorAll('#quickPromptsContainer .quick-prompt').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('chatInput');
        if (input) {
          input.value = btn.textContent;
          input.focus();
        }
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
          ui.renderExplorer();
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
        ui.applyTheme();
      });
    }
  }

  return state;
}

export default init;