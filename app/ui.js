/**
 * app/ui.js - DOM Rendering & UI Wiring
 * Must never import app modules (avoid circular imports); core imports only.
 */

import { isBrowser } from '../core/env.js';
import { state } from '../core/state.js';
import { toolRegistry } from '../core/tools.js';

export function showToast(message, type = 'info') {
  if (!isBrowser) return;
  const container = document.getElementById('toastContainer');
  if (!container) {
    alert(message);
    return;
  }
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${type === 'error' ? 'danger' : type === 'success' ? 'success' : 'primary'} border-0`;
  el.setAttribute('role', 'alert');
  el.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${message}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>`;
  container.appendChild(el);
  if (typeof bootstrap !== 'undefined') {
    const t = new bootstrap.Toast(el, { delay: 3000 });
    t.show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  } else {
    setTimeout(() => el.remove(), 3000);
  }
}

export function setCharacterEmotion(emotion) {
  if (!isBrowser) return;
  const avatarEl = document.getElementById('characterAvatar');
  if (!avatarEl) return;
  const emotions = { happy: '😊', neutral: '🙂', thinking: '🤔', task: '✅', money: '💰', event: '📅', search: '🔍' };
  avatarEl.textContent = emotions[emotion] || '🤖';
}

export function appendChatMessage(role, content, agentName = null) {
  if (!isBrowser) return;
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;
  const wrapper = document.createElement('div');
  const isUser = role === 'user';
  wrapper.className = `chat-message d-flex flex-column ${isUser ? 'align-items-end' : 'align-items-start'} mb-3 px-1`;
  if (agentName) {
    const label = document.createElement('small');
    label.className = 'text-muted mb-1 px-2';
    label.textContent = agentName;
    wrapper.appendChild(label);
  }
  const bubble = document.createElement('div');
  bubble.className = `rounded-3 px-3 py-2 ${isUser ? 'bg-primary text-white' : 'bg-white border'}`;
  bubble.style.maxWidth = '85%';
  bubble.textContent = content;
  wrapper.appendChild(bubble);
  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

export function showTypingIndicator() {
  if (!isBrowser) return;
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;
  if (document.getElementById('typingIndicator')) return;
  const el = document.createElement('div');
  el.id = 'typingIndicator';
  el.className = 'chat-message align-self-start mb-3 px-1';
  el.innerHTML = '<div class="bg-white border rounded-3 px-3 py-2 typing-dots"><span></span><span></span><span></span></div>';
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

export function hideTypingIndicator() {
  if (!isBrowser) return;
  document.getElementById('typingIndicator')?.remove();
}

export function populateModelSelects() {
  if (!isBrowser) return;
  const select = document.getElementById('dtypeSelect');
  if (select) select.value = 'cpu';
  const modelCategories = { embedder: [], classifier: [], generator: [] };
  for (const id of Object.keys(modelCategories)) {
    const sel = document.getElementById(id + 'ModelSelect');
    if (!sel) continue;
    if (sel.options.length === 0) {
      const current = state.config?.modelSettings?.[id];
      const cur = typeof current === 'object' ? current.model : current;
      const opt = document.createElement('option');
      opt.value = cur || '';
      opt.textContent = (cur || id);
      sel.appendChild(opt);
    }
  }
}

export async function renderConfigEditor() {
  if (!isBrowser) return;
  const container = document.getElementById('configEditor');
  if (!container) return;
  container.textContent = JSON.stringify(state.config || {}, null, 2);
  try {
    const db = (await import('../core/db.js')).workspaceDB;
    const history = await db.getHistory(10);
    const list = document.getElementById('configHistoryList');
    if (list) {
      list.innerHTML = history.length
        ? history.map(h => `<a href="#" class="list-group-item list-group-item-action" data-ts="${h.id}">
            <div class="d-flex justify-content-between">
              <span>${h.type}</span><small class="text-muted">${new Date(h.timestamp).toLocaleString()}</small>
            </div></a>`).join('')
        : '<div class="list-group-item text-muted">No history yet.</div>';
    }
  } catch (e) {}
}

export function renderCharacters() {
  if (!isBrowser) return;
  const list = document.getElementById('characterList');
  if (!list) return;
  const chars = state.config?.characters || [];
  const activeId = state.activeCharacterId;
  list.innerHTML = chars.map(c => `
    <a href="#" class="list-group-item list-group-item-action ${c.id === activeId ? 'active' : ''}" data-character-id="${c.id}">
      <div class="d-flex justify-content-between align-items-center">
        <span>${c.name}</span>
        <small class="opacity-75">${c.persona}</small>
      </div>
    </a>`).join('') || '<div class="list-group-item text-muted">No characters configured.</div>';
}

export function renderBusinesses() {
  if (!isBrowser) return;
  const list = document.getElementById('businessList');
  if (!list) return;
  const bizs = state.config?.businesses || [];
  const activeId = state.activeBusinessId;
  list.innerHTML = bizs.map(b => `
    <a href="#" class="list-group-item list-group-item-action ${b.id === activeId ? 'active' : ''}" data-business-id="${b.id}">
      <div class="d-flex justify-content-between align-items-center">
        <span>${b.name}</span>
        <small class="opacity-75">${b.industry || ''}</small>
      </div>
    </a>`).join('') || '<div class="list-group-item text-muted">No workspaces configured.</div>';
}

export function renderTools() {
  if (!isBrowser) return;
  const list = document.getElementById('toolsList');
  if (!list) return;
  const tools = toolRegistry.getAllTools();
  list.innerHTML = tools.map(t => `
    <li class="list-group-item d-flex justify-content-between align-items-center">
      <div><i class="bi ${t.icon} me-2"></i><strong>${t.name}</strong> <small class="text-muted">${t.description}</small></div>
      <span class="badge text-bg-secondary">${t.type || 'internal'}</span>
    </li>`).join('') || '<li class="list-group-item text-muted">No tools registered.</li>';
}

export function renderQuickPrompts() {
  if (!isBrowser) return;
  const container = document.getElementById('quickPromptsContainer');
  if (!container) return;
  const prompts = (state.config?.quickPrompts) || [
    'How are you today?', 'Spent $16.50 on lunch', 'Analyze expenses',
    'Add todo: write report', 'Search marketing projects', 'List agents', 'List tools'
  ];
  container.innerHTML = prompts.map(p => `
    <button class="btn btn-outline-secondary btn-sm quick-prompt">${p}</button>`).join('');
}

export function initTabNavigation() {
  if (!isBrowser) return;
  const tabs = document.querySelectorAll('#workspaceTabs .nav-link');
  tabs.forEach(tab => tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
  }));
}

export function initSidebarResize() {
  if (!isBrowser) return;
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('resizeHandle');
  if (!sidebar || !handle) return;
  let dragging = false;
  handle.addEventListener('mousedown', e => {
    dragging = true;
    e.preventDefault();
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const width = Math.min(Math.max(e.clientX, 220), 420);
    sidebar.style.width = width + 'px';
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.userSelect = '';
  });
}

export async function renderExplorerSchemas() {
  if (!isBrowser) return;
  const select = document.getElementById('explorerSchemaSelect');
  if (!select) return;
  const biz = state.config?.businesses?.find(b => b.id === state.activeBusinessId);
  const schemas = Object.keys(biz?.schemas || {});
  select.innerHTML = schemas.map(s => `<option value="${s}">${s}</option>`).join('') || '<option value="">No schemas</option>';
  await renderExplorerTable(select.value);
}

export async function renderExplorerTable(schemaName) {
  if (!isBrowser) return;
  const head = document.getElementById('explorerTableHead');
  const body = document.getElementById('explorerTableBody');
  const countEl = document.getElementById('recordCount');
  if (!head || !body || !schemaName) return;
  const db = (await import('../core/db.js')).workspaceDB;
  const records = await db.getRecords(state.activeBusinessId, schemaName);
  const biz = state.config?.businesses?.find(b => b.id === state.activeBusinessId);
  const schema = biz?.schemas?.[schemaName];
  const fields = schema ? (schema.vectorize || Object.keys(schema.fields || {})) : [];
  head.innerHTML = '<tr>' + fields.map(f => `<th>${f}</th>`).join('') + '</tr>';
  if (countEl) countEl.textContent = `${records.length} record(s)`;
  body.innerHTML = records.length
    ? records.map(r => '<tr>' + fields.map(f => `<td>${String(r.data[f] ?? '')}</td>`).join('') + '</tr>').join('')
    : '<tr><td colspan="' + (fields.length || 1) + '" class="text-muted">No records.</td></tr>';
}

export function updateHeaderUI() {
  if (!isBrowser) return;
  const char = state.config?.characters?.find(c => c.id === state.activeCharacterId);
  if (char) {
    if (document.getElementById('appBrandName')) document.getElementById('appBrandName').textContent = char.name;
  }
}

export function applyTheme() {
  if (!isBrowser) return;
  const dark = state.config?.app?.theme === 'dark';
  document.body.classList.toggle('dark-theme', dark);
  document.body.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
  const icon = document.getElementById('themeIcon');
  const label = document.getElementById('themeLabel');
  if (icon) icon.className = dark ? 'bi bi-sun' : 'bi bi-moon';
  if (label) label.textContent = dark ? 'Light Mode' : 'Dark Mode';
}

let sendHandler = null;

export function registerSendHandler(handler) {
  sendHandler = handler;
  if (!isBrowser) return;
  const btn = document.getElementById('sendChatBtn');
  const input = document.getElementById('chatInput');
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (sendHandler) sendHandler(text);
  };
  if (btn) btn.addEventListener('click', send);
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}

let voiceRecognition = null;
let voiceActive = false;
export function initSpeechRecognition() {
  if (!isBrowser) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  voiceRecognition = new SR();
  voiceRecognition.continuous = false;
  voiceRecognition.interimResults = false;
  voiceRecognition.lang = 'en-US';
  voiceRecognition.onresult = (e) => {
    const text = e.results[0][0].transcript;
    const input = document.getElementById('chatInput');
    if (input) input.value = text;
    if (sendHandler && text) sendHandler(text);
  };
  voiceRecognition.onend = () => {
    voiceActive = false;
    const btn = document.getElementById('micBtn');
    if (btn) btn.classList.remove('active');
  };
}

export function toggleVoiceInput() {
  if (!isBrowser || !voiceRecognition) {
    if (isBrowser) showToast('Speech recognition not supported in this browser.', 'error');
    return;
  }
  const btn = document.getElementById('micBtn');
  if (voiceActive) {
    voiceRecognition.stop();
    voiceActive = false;
    if (btn) btn.classList.remove('active');
  } else {
    voiceActive = true;
    voiceRecognition.start();
    if (btn) btn.classList.add('active');
  }
}

export function renderExplorer() {
  renderExplorerSchemas();
  renderTools();
  renderCharacters();
  renderBusinesses();
  renderQuickPrompts();
  renderConfigEditor();
  populateModelSelects();
  updateHeaderUI();
}