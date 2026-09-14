/**
 * app/ui.js - DOM Rendering & UI Wiring
 * Must never import app modules (avoid circular imports); core imports only.
 */

import { isBrowser } from '../core/env.js';
import { state, getActiveCharacter, getActiveBusiness } from '../core/state.js';
import { toolRegistry } from '../core/tools.js';
import { extensionRegistry, permissionMeta } from '../core/extensions.js';
import { escapeHtml } from '../core/utils.js';
import { configAPI } from '../core/config.js';
import { workspaceDB as db } from '../core/db.js';
import { detectDevice, describeDevice, getModelFit, DEVICE_TIERS } from '../core/device.js';
import { hasFolderHandle, getFolderName, requestFolder } from '../core/files.js';

// ── Toasts ──────────────────────────────────────────────────────────────────
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
    const t = new bootstrap.Toast(el, { delay: 3200 });
    t.show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  } else {
    setTimeout(() => el.remove(), 3200);
  }
}

// ── Character emotion (header avatar) ───────────────────────────────────────
const EMOTIONS = { happy: '😊', neutral: '🙂', thinking: '🤔', task: '✅', money: '💰', event: '📅', search: '🔍' };

export function setCharacterEmotion(emotion) {
  if (!isBrowser) return;
  const avatarEl = document.getElementById('current-avatar');
  if (!avatarEl) return;
  const wrap = document.getElementById('current-avatar-wrap');
  avatarEl.textContent = EMOTIONS[emotion] || '🤖';
  if (wrap) {
    wrap.classList.remove('pulsed');
    void wrap.offsetWidth; // restart animation
    wrap.classList.add('pulsed');
  }
}

// ── Markdown rendering (assistant bubbles) ──────────────────────────────────
function mdLibsReady() {
  return isBrowser && typeof window.marked !== 'undefined' && typeof window.DOMPurify !== 'undefined';
}

export function renderMarkdown(content) {
  const raw = mdLibsReady() ? window.marked.parse(String(content)) : escapeHtml(String(content));
  const sanitized = mdLibsReady() ? window.DOMPurify.sanitize(raw) : raw;
  return sanitized.split('\n').join('\n');
}

// Heavy content (tables, code blocks) renders instantly; light prose gets a reveal.
function shouldReveal(content) {
  const text = String(content || '');
  if (text.length > 500) return false;
  return !(text.includes('|') && text.split('\n').length > 1) && !text.includes('`');
}

function prefersReducedMotion() {
  return isBrowser && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollChatToBottom() {
  if (!isBrowser) return;
  const chatMessages = document.getElementById('chatMessages');
  if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
}

function currentBizId() {
  return (state && state.activeBusinessId) || (state.config && state.config.app && state.config.app.defaultBusiness) || 'personal';
}

// ── Chat message rendering ──────────────────────────────────────────────────
/**
 * Append a chat message.
 * opts: { name, emotion, ts, animate, persist, markdown }
 */
export function appendChatMessage(role, content, opts = {}) {
  if (!isBrowser) return;
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;

  // Backwards-compatible call: appendChatMessage(role, content, agentName)
  if (typeof opts === 'string') opts = { name: opts };

  const isUser = role === 'user';
  const isAssistant = role === 'assistant';
  const name = opts.name || (isUser ? 'You' : isAssistant ? (getActiveCharacter(state).name || 'Assistant') : 'System');
  const ts = opts.ts || Date.now();
  const emotion = opts.emotion || '';

  const row = document.createElement('div');
  row.className = `msg-row ${isUser ? 'from-user' : 'from-bot'}`;
  if (opts.msgId) row.dataset.msgId = opts.msgId;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  const char = isUser ? {} : getActiveCharacter(state);
  avatar.textContent = isUser ? '🙂' : (char.avatar || '🤖');

  const body = document.createElement('div');
  body.className = 'msg-body';

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.innerHTML = `<span class="msg-name">${escapeHtml(name)}</span><span class="msg-time">${formatClock(ts)}</span>`;
  const showMarkdown = (isAssistant || role === 'system');
  if (showMarkdown) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'msg-copy btn btn-sm btn-link px-1 py-0';
    copyBtn.title = 'Copy message';
    copyBtn.setAttribute('aria-label', 'Copy message');
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
    copyBtn.addEventListener('click', e => {
      e.stopPropagation();
      copyTextToClipboard(contentStr);
    });
    meta.appendChild(copyBtn);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  if (isAssistant || role === 'system') bubble.classList.add('chat-md');

  row.appendChild(avatar);
  body.appendChild(meta);
  body.appendChild(bubble);
  row.appendChild(body);
  chatMessages.appendChild(row);

  const contentStr = String(content || '');
  const reveal = showMarkdown && shouldReveal(contentStr) && opts.animate !== false && !prefersReducedMotion();

  const emojiEl = emotion ? `<span class="emoji-badge" aria-hidden="true">${escapeHtml(emotion)}</span>` : '';
  const finalize = () => {
    if (showMarkdown) {
      bubble.innerHTML = emojiEl + renderMarkdown(contentStr);
    } else {
      bubble.textContent = emojiEl ? emotion + ' ' + contentStr : contentStr;
    }
    scrollChatToBottom();
  };

  if (reveal) {
    revealInto(bubble, contentStr, emojiEl, finalize);
  } else {
    finalize();
  }

  scrollChatToBottom();

  if (isUser || isAssistant) {
    state.chatHistory = state.chatHistory || [];
    state.chatHistory.push({ role, content: contentStr, name, timestamp: ts, emotion });
    if (opts.persist !== false) persistMessage({ role, content: contentStr, name, emotion, timestamp: ts });
  }
}

// Word-by-word reveal, then swap in the rendered markdown.
function revealInto(bubble, content, emojiEl, finalize) {
  const words = content.split(/(\s+)/);
  let i = 0;
  const caret = '<span class="msg-caret"></span>';
  bubble.innerHTML = `<span class="emoji-badge">${emojiEl || ''}</span>${caret}`;
  const step = () => {
    if (!bubble.isConnected) return;
    if (i >= words.length) { finalize(); return; }
    bubble.innerHTML = `<span class="emoji-badge">${emojiEl || ''}</span>` + escapeHtml(words.slice(0, ++i).join('')) + caret;
    scrollChatToBottom();
    setTimeout(step, 14);
  };
  step();
}

function formatClock(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

function copyTextToClipboard(text) {
  const t = String(text || '');
  const ok = () => showToast('Copied to clipboard.', 'success');
  const legacy = () => {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); ok(); } catch (e) { showToast('Copy failed.', 'error'); }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(ok).catch(legacy);
  } else {
    legacy();
  }
}

// Floating "jump to latest" button for long conversations.
function setupJumpToLatestBtn() {
  if (!isBrowser) return;
  const chatMessages = document.getElementById('chatMessages');
  const pane = document.getElementById('pane-chat');
  if (!chatMessages || !pane || pane.dataset.jumpWired) return;
  pane.dataset.jumpWired = '1';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'jumpToLatestBtn';
  btn.className = 'btn btn-sm btn-primary chat-jump d-none';
  btn.title = 'Jump to latest message';
  btn.setAttribute('aria-label', 'Jump to latest message');
  btn.innerHTML = '<i class="bi bi-arrow-down"></i>';
  btn.addEventListener('click', () => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
    btn.classList.add('d-none');
  });
  pane.appendChild(btn);
  chatMessages.addEventListener('scroll', () => {
    const nearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 90;
    btn.classList.toggle('d-none', nearBottom);
  });
}

function persistMessage(msg) {
  db.addChatMessage({
    id: 'm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    businessId: currentBizId(),
    role: msg.role,
    content: msg.content,
    agentName: msg.name,
    emotion: msg.emotion,
    timestamp: msg.timestamp
  }).catch(() => {});
}

// ── Typing indicator ────────────────────────────────────────────────────────
export function showTypingIndicator() {
  if (!isBrowser) return;
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;
  if (document.getElementById('typingIndicator')) return;
  const el = document.createElement('div');
  el.id = 'typingIndicator';
  el.className = 'msg-row from-bot msg-typing';
  el.innerHTML = `
    <div class="msg-avatar">${escapeHtml((getActiveCharacter(state).avatar) || '🤖')}</div>
    <div class="msg-body">
      <div class="msg-meta"><span class="msg-name">${escapeHtml(getActiveCharacter(state).name)}</span><span class="msg-time">now</span></div>
      <div class="msg-bubble bg-body border typing-dots"><span style="--i:0"></span><span style="--i:1"></span><span style="--i:2"></span></div>
    </div>`;
  chatMessages.appendChild(el);
  scrollChatToBottom();
}

export function hideTypingIndicator() {
  if (!isBrowser) return;
  document.getElementById('typingIndicator')?.remove();
}

let busy = false;

export function isBusy() { return busy; }

export function setBusy(value) {
  busy = value;
  if (!isBrowser) return;
  const btn = document.getElementById('sendBtn');
  const spinner = document.getElementById('sendSpinner');
  const icon = document.getElementById('sendIcon');
  const label = document.getElementById('sendLabel');
  const hint = document.getElementById('chatComposerHint');
  const avatarWrap = document.getElementById('current-avatar-wrap');
  const sendInput = document.getElementById('chatInput');
  if (btn) btn.classList.toggle('processing', value);
  if (spinner) spinner.classList.toggle('d-none', !value);
  if (icon) icon.className = value ? 'bi bi-stars' : 'bi bi-send-fill';
  if (label) label.textContent = value ? 'Thinking' : 'Send';
  if (sendInput) sendInput.disabled = value;
  if (hint) hint.textContent = value ? 'Thinking…' : '';
  if (avatarWrap) avatarWrap.classList.toggle('talking', value);
  setCharacterEmotion(value ? 'thinking' : 'neutral');
  if (value) showTypingIndicator();
  else hideTypingIndicator();
  refreshAgentControls();
}

// Map a pipeline result to a conversational emoji.
const EMOJI = {
  add_transaction: '💰', spend: '💰', analyze_expenses: '📊', add_todo: '✅', list_todos: '📋',
  add_event: '📅', check_calendar: '📅', create_schema: '🗂️', search: '🔍', web_search: '🌐',
  add_character: '🧑‍🚀', add_business: '🏢', create_tool: '🧰', update_config: '⚙️', get_config: '⚙️',
  rollback_config: '🔄', list_tools: '🧰', execute_chain: '🔗', delegate_to_agent: '🤖', ask_agent: '🤖',
  list_agents: '🤖', route_to_specialist: '🧭', character_switch: '🔄', change_character_name: '✏️',
  google_calendar_list: '📅', google_drive_list: '🗂️', google_sheets_read: '📊',
  create_document: '📄', create_spreadsheet: '📊'
};

export function emotionFor(res) {
  if (!res) return '💬';
  const key = res.intent || res.derivedIntent;
  if (key && EMOJI[key]) return EMOJI[key];
  return res.ok ? '✅' : '⚠️';
}

// ── Message send lifecycle ──────────────────────────────────────────────────
const COMPOSER_IDS = ['sendBtn', 'sendChatBtn'];

let sendHandler = null;

function autoResize(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

export function sendMessage(text) {
  if (!sendHandler || busy || !text || !text.trim()) {
    const input = document.getElementById('chatInput');
    if (input) input.focus();
    return;
  }
  const input = document.getElementById('chatInput');
  if (input) { input.value = ''; autoResize(input); }
  appendChatMessage('user', text, { name: 'You' });
  setBusy(true);
  Promise.resolve()
    .then(() => sendHandler(text.trim()))
    .catch(err => appendChatMessage('system', 'Something went wrong: ' + (err && err.message ? err.message : String(err))))
    .finally(() => setBusy(false));
}

export function registerSendHandler(handler) {
  sendHandler = handler;
  if (!isBrowser) return;

  const send = () => sendMessage(document.getElementById('chatInput')?.value || '');

  for (const id of COMPOSER_IDS) {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', send);
  }

  const input = document.getElementById('chatInput');
  if (input) {
    input.addEventListener('input', () => autoResize(input));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
  }
}

// ── Agent mode controls (Phase C) ───────────────────────────────────────────
let agentStopHandler = null;

export function agentModeEnabled() {
  if (!isBrowser) return false;
  const t = document.getElementById('agentModeToggle');
  return !!t && t.checked;
}

export function agentVerbosity() {
  if (!isBrowser) return 'details';
  const s = document.getElementById('agentVerbosity');
  return s ? s.value : 'details';
}

// Render one intermediate agent step as an interstitial system message (never
// persisted to chat history or across sessions).
export function appendAgentStep(html) {
  appendChatMessage('system', html, {});
}

// Show the Stop button while an agent run is busy, and lock the toggle so the
// mode can't change mid-run.
export function refreshAgentControls() {
  if (!isBrowser) return;
  const stop = document.getElementById('agentStopBtn');
  if (stop) stop.classList.toggle('d-none', !busy || !agentModeEnabled());
  const t = document.getElementById('agentModeToggle');
  if (t) t.disabled = busy;
}

export function registerAgentStop(handler) {
  agentStopHandler = handler;
  if (!isBrowser) return;
  const stop = document.getElementById('agentStopBtn');
  if (stop) stop.addEventListener('click', () => { if (typeof agentStopHandler === 'function') agentStopHandler(); });
}

// ── Voice input ─────────────────────────────────────────────────────────────
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
    sendMessage(text);
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

// ── Text-to-speech (read-aloud) ─────────────────────────────────────────────
async function voiceAutoEnabled() {
  if (!isBrowser) return false;
  try {
    const cfg = state.config?.app?.voice || {};
    return !!cfg.autoSpeak;
  } catch (e) { return false; }
}

export function speakAssistantMessage(text) {
  if (!isBrowser || !window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(String(text || ''));
  utterance.rate = 1.02;
  utterance.pitch = 1.05;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  if (isBrowser && window.speechSynthesis) window.speechSynthesis.cancel();
}

// Call after an assistant bubble renders (if read-aloud is on).
export function maybeReadAloud(content) {
  return voiceAutoEnabled().then(on => { if (on && isBrowser && content && !`${content}`.includes('|')) speakAssistantMessage(content); });
}

// ── Greeting / empty state ──────────────────────────────────────────────────
export function showGreeting({ persist = false, short = false } = {}) {
  if (!isBrowser) return;
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;
  const char = getActiveCharacter(state);
  const hour = new Date().getHours();
  const part = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const greeting = short
    ? `${part}! I'm ${char.name}. ${char.persona ? char.persona + '.' : ''} What can I help with?`
    : `${part}! I'm ${char.name}${char.persona ? ', ' + char.persona.toLowerCase() : ''}. You can ask me to do real tasks–try phrases like:\n- "Log an expense of $20 on lunch"\n- "What did I spend this week?"\n- "Add a todo: book flights"\n- "Search marketing projects"`;
  appendChatMessage('assistant', greeting, { name: char.name, emotion: '🙂', ts: Date.now(), animate: false, persist });
  scrollChatToBottom();
}

export function renderEmptyState() {
  if (!isBrowser) return;
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;
  const char = getActiveCharacter(state);
  chatMessages.innerHTML = `
    <div id="chatEmptyState">
      <div class="emblem bg-primary-subtle text-primary mb-3">${escapeHtml(char.avatar || '🤖')}</div>
      <h5 class="mb-1">How can I help, ${escapeHtml(char.name)} at your service.</h5>
      <p class="text-body-secondary mb-0">Type below or pick a quick prompt to get started.</p>
    </div>`;
}

// ── Models tab (unchanged behavior) ─────────────────────────────────────────
const STAGE_SELECT_IDS = { encoder: 'embedderModelSelect', intent: 'classifierModelSelect', tagger: 'taggerModelSelect', dialog: 'generatorModelSelect' };
const STAGE_HINT_IDS = { encoder: 'embedderModelHint', intent: 'classifierModelHint', tagger: 'taggerModelHint', dialog: 'generatorModelHint' };
const STAGE_LABELS = { encoder: 'Embedder', intent: 'Classifier', tagger: 'NER Tagger', dialog: 'Generator' };

let detectedDevice = null;

const FIT_BADGES = {
  ideal: '<span class="badge text-bg-success" title="">ideal</span>',
  ok: '<span class="badge text-bg-info">ok</span>',
  heavy: '<span class="badge text-bg-warning">heavy</span>',
  'too-heavy': '<span class="badge text-bg-danger">too-heavy</span>',
  unknown: '<span class="badge bg-body-secondary text-body-secondary border">—</span>',
};

function renderFitBadge(fit) {
  if (!fit || !fit.verdict) return FIT_BADGES.unknown;
  const cls = FIT_BADGES[fit.verdict] || FIT_BADGES.unknown;
  return fit.reason ? cls.replace(' title=""', ` title="${escapeHtml(fit.reason)}"`) : cls;
}

export function populateModelSelects() {
  if (!isBrowser) return;
  void (async () => {
    try {
      const M = await import('./models.js');
      const stages = await M.getStageOptions();
      const ms = state.config?.modelSettings || {};
      const dtypeSel = document.getElementById('dtypeSelect');
      if (dtypeSel) dtypeSel.value = ms.dtype || 'q8';
      const preloadChk = document.getElementById('modelPreloadOnOpenChk');
      if (preloadChk) preloadChk.checked = !!ms.preloadOnOpen;
      for (const stage of stages) {
        const sel = document.getElementById(STAGE_SELECT_IDS[stage.key]);
        const hint = document.getElementById(STAGE_HINT_IDS[stage.key]);
        if (!sel) continue;
        sel.innerHTML = '';
        for (const m of stage.options) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.sizeMb ? `${m.name} (${m.sizeMb}MB)` : m.name;
          if (m.current) opt.selected = true;
          sel.appendChild(opt);
        }
        if (hint) {
          const cur = stage.options.find(o => o.current);
          hint.textContent = cur ? `${cur.name}${cur.sizeMb ? ' · ' + cur.sizeMb + 'MB' : ''}` : '';
        }
      }
      await renderModelsPanel();
    } catch (e) {}
  })();
}

export function renderModelsPanel() {
  if (!isBrowser) return Promise.resolve();
  return (async () => {
    try {
      const M = await import('./models.js');
      const ms = state.config?.modelSettings || {};
      const policyEl = document.getElementById('modelPolicyInfo');
      const stagesList = document.getElementById('modelStagesList');
      const errList = document.getElementById('modelErrorList');
      const catalogBody = document.getElementById('modelCatalogBody');
      const status = M.getPipelineStatus();

      detectedDevice = detectDevice();
      const tierEl = document.getElementById('deviceTierBadge');
      const profileEl = document.getElementById('deviceProfileText');
      const recListEl = document.getElementById('deviceRecList');
      const applyBtn = document.getElementById('deviceApplyRecsBtn');
      if (tierEl) {
        tierEl.style.display = '';
        tierEl.textContent = `${String(detectedDevice.tier).toUpperCase()} device · ${detectedDevice.score}`;
        tierEl.className = `badge text-bg-${detectedDevice.tier === 'low' ? 'warning' : detectedDevice.tier === 'mid' ? 'info' : detectedDevice.tier === 'ultra' ? 'primary' : 'success'}`;
      }
      if (profileEl) profileEl.textContent = describeDevice(detectedDevice);
      if (recListEl) {
        const rec = M.getDeviceRecommendations(detectedDevice);
        recListEl.innerHTML = rec.stages.map(s => {
          const diff = s.recommended && s.recommended !== s.current;
          const badge = !s.recommended ? '<span class="text-body-secondary"> · no model</span>' : (diff ? ' <span class="text-warning-emphasis">recommended</span>' : ' <span class="text-success-emphasis">current</span>');
          return `<li class="pe-2"><span class="badge bg-body-secondary text-body-secondary border me-1">${escapeHtml(s.stage)}</span>${escapeHtml(s.name)}${s.sizeMb ? ` (${s.sizeMb}MB)` : ''}${badge}</li>`;
        }).join('');
      }
      if (applyBtn) applyBtn.disabled = false;
      if (profileEl && recListEl && recListEl.children.length === 0) profileEl.textContent += ' — no recommendations.';

      if (policyEl) {
        const mem = ms.pipeline?.memory || {};
        policyEl.textContent = `policy: ${ms.pipeline?.policy || 'swap'} · threshold: ${ms.pipeline?.threshold ?? 0.35} · wasm heap: ${mem.wasmInitialMb ?? 64}MB · dtype: ${ms.dtype || 'q8'}`;
      }

      const stages = await M.getStageOptions();
      if (stagesList) {
        stagesList.innerHTML = stages.map(s => {
          const cur = s.options.find(o => o.current);
          const label = escapeHtml((cur && cur.name) || s.model || '—');
          return s.loaded
            ? `<li class="badge bg-success"><i class="bi bi-asterisk"></i> ${escapeHtml(STAGE_LABELS[s.key] || s.label)}: ${label} (resident)</li>`
            : `<li class="badge bg-body-secondary text-body-secondary border">${escapeHtml(STAGE_LABELS[s.key] || s.label)}: ${label}</li>`;
        }).join('');
      }

      if (errList) {
        const errors = [];
        if (status.model && status.model.error) errors.push(status.model.error);
        for (const e of (state.pipeline?.errors || [])) {
          if (e && e.message) errors.push(`${e.message}${e.fix ? ' — ' + e.fix : ''}`);
        }
        errList.innerHTML = errors.length
          ? errors.map(msg => `<li class="mb-1">⚠️ ${escapeHtml(String(msg))}</li>`).join('')
          : '';
      }

      if (catalogBody) {
        const list = M.getModelCatalog();
        if (!list.length) {
          catalogBody.innerHTML = `<tr><td colspan="6" class="small text-body-secondary py-2">No models in the catalog yet — the catalog is discovered at runtime. Use <strong>Browse Hugging Face</strong> above (or it auto-scans on first load).</td></tr>`;
        } else {
        catalogBody.innerHTML = list.map(m => {
          const meta = M.getModelMeta(m.id) || m;
          const typeBadge = { embedder: 'info', classifier: 'warning', ner: 'danger', generator: 'success' }[meta.type] || 'secondary';
          return `<tr>
            <td class="fw-semibold">${meta.id}</td>
            <td><span class="badge text-bg-${typeBadge}">${escapeHtml(meta.type)}</span></td>
            <td class="small text-body-secondary">${escapeHtml(meta.description || '')}</td>
            <td class="text-end small">${meta.sizeMb ? meta.sizeMb + 'MB' : '—'}</td>
            <td class="text-end">${renderFitBadge(getModelFit(detectedDevice, { ...meta, sizeMb: meta.sizeMb }))}</td>
            <td class="text-end">
              <button class="btn btn-sm btn-outline-secondary py-0" type="button" data-use-model="${meta.id}" data-use-type="${escapeHtml(meta.type)}">Use</button>
              <button class="btn btn-sm btn-outline-info py-0" type="button" data-model-detail="${meta.id}" title="Model details"><i class="bi bi-info-circle"></i></button>
            </td>
          </tr>`;
        }).join('');
        }
      }

      for (const s of stages) {
        const sel = document.getElementById(STAGE_SELECT_IDS[s.key]);
        const btn = document.querySelector(`button[data-apply-stage="${s.key}"]`);
        const unloadBtn = document.querySelector(`button[data-unload-stage="${s.key}"]`);
        if (sel && btn) {
          const m = sel.options[sel.selectedIndex];
          btn.disabled = !m || m.value === s.model;
        }
        if (unloadBtn) {
          unloadBtn.disabled = !s.loaded;
        }
      }

      maybeBootstrapDynamicCatalog({ auto: true }).catch(() => {});
    } catch (e) {}
  })();
}

// ── First-run dynamic catalog bootstrap ──────────────────────────────────────
// The shipped catalog is empty by design (config.json has no hardcoded
// models). On first load in the real UI we seed it from Hugging Face (top
// transformers.js models per role), then apply the best-fit recommendation for
// the detected device. `{ auto: true }` only attempts a scan once per session;
// explicit calls (Apply Recommendations button) may retry.
let hubAutoScanDone = false;
let hubBootstrapActive = false;

export async function maybeBootstrapDynamicCatalog(opts = {}) {
  if (!isBrowser) return false;
  if (hubBootstrapActive) return false;
  if (window.__MODELS_DISABLED__ === true) return false;
  if (!document.getElementById('hubResults')) return false; // real Models tab DOM only
  const M = await import('./models.js');
  if (M.getModelCatalog().length > 0) { if (opts.auto) hubAutoScanDone = true; return false; }
  if (opts.auto && hubAutoScanDone) return false;

  hubBootstrapActive = true;
  try {
    const HUB = await import('./ai/hub.js');
    const entries = await HUB.bootstrapCatalog({ limit: 5 });
    if (!entries.length) {
      const hubStatus = document.getElementById('hubStatus');
      if (hubStatus) hubStatus.textContent = 'Hugging Face unreachable — no models yet. Retry: Search above.';
      return false;
    }
    const ms = state.config?.modelSettings || {};
    const newList = Array.isArray(ms.availableModels) ? [...ms.availableModels] : [];
    for (const e of entries) if (!newList.some(m => m.id === e.id)) newList.push(e);
    await configAPI.updateConfig('modelSettings.availableModels', newList);

    const profile = detectedDevice || detectDevice();
    const next = M.buildRecommendedModelSettings(profile);
    if (next) {
      await configAPI.updateConfig('modelSettings', next);
      await db.setKV('deviceRecApplied', JSON.stringify({ tier: profile.tier, at: Date.now() }));
    }
    populateModelSelects();
    renderConfigEditor();
    await renderModelsPanel();
    showToast(`Discovered ${newList.length} models from Hugging Face and applied the best fit for your device.`, 'success');
    return true;
  } catch (err) {
    const hubStatus = document.getElementById('hubStatus');
    if (hubStatus) hubStatus.textContent = 'Hugging Face unreachable — no models loaded yet. Retry: Search above.';
    if (opts.auto) console.warn('catalog bootstrap failed:', err && err.message ? err.message : err);
    return false;
  } finally {
    hubBootstrapActive = false;
    if (opts.auto) hubAutoScanDone = true;
  }
}

async function applyStageSelection(stageKey, modelId) {
  if (!modelId) return;
  const M = await import('./models.js');
  if (!state.config?.modelSettings) {
    showToast('Configuration not loaded — cannot apply a model.', 'error');
    return;
  }
  try {
    M.applyStageModel(stageKey, modelId);
    await configAPI.updateConfig('modelSettings', state.config.modelSettings);
    const meta = M.getModelMeta(modelId);
    await M.loadStage(stageKey, modelId);
    populateModelSelects();
    renderConfigEditor();
    await renderModelsPanel();
    showToast(`Loaded "${(meta && meta.name) || modelId}" for ${stageKey}.`, 'success');
  } catch (err) {
    populateModelSelects();
    await renderModelsPanel();
    showToast(M.formatModelError ? M.formatModelError(err) : String(err), 'error');
  }
}

let modelsPanelWired = false;

export function initModelsTab() {
  if (!isBrowser || modelsPanelWired) return;
  modelsPanelWired = true;

  const pane = document.getElementById('pane-models');
  if (!pane) return;

  pane.querySelectorAll('button[data-apply-stage]').forEach(btn => {
    btn.addEventListener('click', () => {
      const stageKey = btn.getAttribute('data-apply-stage');
      const sel = document.getElementById(STAGE_SELECT_IDS[stageKey]);
      if (sel && sel.value) applyStageSelection(stageKey, sel.value);
    });
  });

  pane.querySelectorAll('button[data-unload-stage]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const stageKey = btn.getAttribute('data-unload-stage');
      const M = await import('./models.js');
      try {
        await M.unloadStage(stageKey);
        showToast(`${STAGE_LABELS[stageKey] || stageKey} model unloaded from memory.`, 'success');
      } catch (err) {
        showToast(err && err.message ? err.message : String(err), 'error');
      }
      await renderModelsPanel();
    });
  });

  pane.addEventListener('click', async (e) => {
    const use = e.target && e.target.closest('button[data-use-model]');
    if (use) {
      const modelId = use.getAttribute('data-use-model');
      const type = use.getAttribute('data-use-type');
      const stageKey = { embedder: 'encoder', classifier: 'intent', ner: 'tagger', generator: 'dialog' }[type];
      if (stageKey && document.getElementById(STAGE_SELECT_IDS[stageKey])) {
        document.getElementById(STAGE_SELECT_IDS[stageKey]).value = modelId;
        await renderModelsPanel();
      }
      return;
    }
    const detail = e.target && e.target.closest('button[data-model-detail]');
    if (detail) openModelDetail(detail.getAttribute('data-model-detail'));
  });

  const dtypeSel = document.getElementById('dtypeSelect');
  if (dtypeSel) {
    dtypeSel.addEventListener('change', async () => {
      try {
        await configAPI.updateConfig('modelSettings.dtype', dtypeSel.value);
        showToast(`Data type set to ${dtypeSel.value}.`, 'success');
        renderConfigEditor();
      } catch (err) {
        showToast(err && err.message ? err.message : String(err), 'error');
      }
    });
  }

  const preloadOnOpenChk = document.getElementById('modelPreloadOnOpenChk');
  if (preloadOnOpenChk) {
    preloadOnOpenChk.addEventListener('change', async () => {
      try {
        await configAPI.updateConfig('modelSettings.preloadOnOpen', preloadOnOpenChk.checked);
        showToast(preloadOnOpenChk.checked ? 'Models will preload on page open.' : 'Models now load lazily on first use.', 'success');
      } catch (err) {
        showToast(err && err.message ? err.message : String(err), 'error');
      }
    });
  }

  const preloadBtn = document.getElementById('modelPreloadAllBtn');
  if (preloadBtn) {
    preloadBtn.addEventListener('click', async () => {
      const M = await import('./models.js');
      preloadBtn.disabled = true;
      try {
        const summary = await M.forcePreload({ loud: true });
        showToast(`Preload finished: ${summary.preloaded}/${summary.total} stages ready.`, summary.errors && summary.errors.length ? 'error' : 'success');
      } catch (err) {
        showToast(M.formatModelError ? M.formatModelError(err) : String(err), 'error');
      } finally {
        preloadBtn.disabled = false;
      }
      populateModelSelects();
      renderConfigEditor();
      await renderModelsPanel();
    });
  }

  const resetBtn = document.getElementById('modelResetDefaultsBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!window.confirm('Reset model settings to defaults? Downloaded weights are kept in the cache.')) return;
      const M = await import('./models.js');
      const defaults = M.defaultModelSettings();
      try {
        await configAPI.updateConfig('modelSettings', defaults);
        populateModelSelects();
        renderConfigEditor();
        await renderModelsPanel();
        showToast('Model settings reset to defaults.', 'success');
      } catch (err) {
        showToast(err && err.message ? err.message : String(err), 'error');
      }
    });
  }

  populateModelSelects();

  // ── Device & model recommendations ──────────────────────────────────────
  const applyRecsBtn = document.getElementById('deviceApplyRecsBtn');
  if (applyRecsBtn) {
    applyRecsBtn.addEventListener('click', async () => {
      const statusEl = document.getElementById('deviceRecStatus');
      const M = await import('./models.js');
      const profile = detectedDevice || detectDevice();
      try {
        if (!M.getModelCatalog().length) {
          showToast('No models in the catalog yet — scanning Hugging Face…', 'info');
          const ok = await maybeBootstrapDynamicCatalog();
          if (!ok) { showToast('Could not load models from Hugging Face. Check the network and try Browse again.', 'error'); return; }
        }
        const next = M.buildRecommendedModelSettings(profile);
        if (!next) throw new Error('Configuration not loaded — cannot apply recommendations.');
        if (statusEl) statusEl.textContent = 'Applying…';
        applyRecsBtn.disabled = true;
        await configAPI.updateConfig('modelSettings', next);
        await db.setKV('deviceRecApplied', JSON.stringify({ tier: profile.tier, at: Date.now() }));
        const rec = M.getDeviceRecommendations(profile);
        showToast(`Applied recommended setup for ${profile.tier}-tier device (${rec.stages.filter(s => s.recommended !== s.current).length} changes).`, 'success');
        populateModelSelects();
        renderConfigEditor();
        await renderModelsPanel();
      } catch (err) {
        showToast(err && err.message ? err.message : String(err), 'error');
      } finally {
        if (statusEl) statusEl.textContent = '';
        if (applyRecsBtn) applyRecsBtn.disabled = false;
      }
    });
  }

  const refreshBtn = document.getElementById('deviceRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      detectedDevice = null;
      await renderModelsPanel();
      showToast('Device re-detected.', 'success');
    });
  }

  void (async () => {
    try {
      const saved = await db.getKV('deviceRecApplied');
      if (saved) return;
      const profile = detectedDevice || detectDevice();
      const M = await import('./models.js');
      const rec = M.getDeviceRecommendations(profile);
      const ms = state.config?.modelSettings || {};
      const differs = rec.stages.some(s => s.recommended && s.recommended !== s.current) || (ms.dtype && ms.dtype !== rec.dtype);
      if (differs) showToast(`Detected ${profile.tier}-tier device (${profile.cores} cores). Check Model Recommendations below.`, 'info');
    } catch (e) {}
  })();

  populateModelSelects();

  // ── Backend routing pickers ──────────────────────────────────────────────
  async function syncBackendPickersFromConfig() {
    const ai = state.config && state.config.app && state.config.app.ai && state.config.app.ai.routing || {};
    const dialogSel = document.getElementById('dialogBackendSelect');
    const embedderSel = document.getElementById('embedderBackendSelect');
    if (dialogSel) dialogSel.value = ai.dialog || 'auto';
    if (embedderSel) embedderSel.value = ai.embedder || 'auto';
  }
  syncBackendPickersFromConfig();

  async function applyBackendPicker(stageKey, value) {
    try {
      const R = await import('./ai/routing.js');
      await R.setStageBackend(stageKey, value || 'auto');
      showToast(`${stageKey} backend → ${value || 'auto'}`, 'success');
    } catch (err) {
      showToast(err && err.message ? err.message : String(err), 'error');
    }
  }

  const dialogSel = document.getElementById('dialogBackendSelect');
  if (dialogSel) {
    dialogSel.addEventListener('change', () => applyBackendPicker('dialog', dialogSel.value));
  }
  const embedderSel = document.getElementById('embedderBackendSelect');
  if (embedderSel) {
    embedderSel.addEventListener('change', () => applyBackendPicker('embedder', embedderSel.value));
  }

  const probeBtn = document.getElementById('backendHealthProbeBtn');
  if (probeBtn) {
    probeBtn.addEventListener('click', async () => {
      const statusEl = document.getElementById('backendHealthStatus');
      if (statusEl) statusEl.textContent = 'Probing…';
      probeBtn.disabled = true;
      try {
        const R = await import('./ai/routing.js');
        const results = await R.probeAllBackends();
        const parts = results.map(b => `${b.label}: ${b.ok ? 'OK' : 'DOWN'}${b.detail ? ' (' + b.detail.slice(0, 60) + ')' : ''}`);
        if (statusEl) statusEl.textContent = parts.join(' | ') || 'No remote backends configured.';
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Probe failed: ' + (err.message || String(err));
      } finally {
        probeBtn.disabled = false;
      }
    });
  }

  // ── Backend URL configuration ───────────────────────────────────────────
  syncBackendUrlInputs();
  const saveBackendUrlsBtn = document.getElementById('saveBackendUrlsBtn');
  if (saveBackendUrlsBtn) {
    saveBackendUrlsBtn.addEventListener('click', async () => {
      const llamacppUrl = document.getElementById('llamacppUrlInput')?.value?.trim();
      const ollamaUrl = document.getElementById('ollamaUrlInput')?.value?.trim();
      const llamacppEnabled = document.getElementById('llamacppEnabledChk')?.checked;
      const ollamaEnabled = document.getElementById('ollamaEnabledChk')?.checked;
      try {
        await configAPI.updateConfig('app.ai.backends.llamacpp', { url: llamacppUrl || 'http://localhost:8080/v1', enabled: !!llamacppEnabled });
        await configAPI.updateConfig('app.ai.backends.ollama', { url: ollamaUrl || 'http://localhost:11434', enabled: !!ollamaEnabled });
        renderConfigEditor();
        showToast('Backend URLs saved.', 'success');
      } catch (err) {
        showToast(err && err.message ? err.message : String(err), 'error');
      }
    });
  }

  // ── WASM memory & pipeline settings ─────────────────────────────────────
  syncMemorySettingsInputs();
  const saveMemoryBtn = document.getElementById('saveMemorySettingsBtn');
  if (saveMemoryBtn) {
    saveMemoryBtn.addEventListener('click', async () => {
      const wasmMb = parseInt(document.getElementById('wasmHeapMbInput')?.value) || 64;
      const maxSim = parseInt(document.getElementById('maxSimultaneousInput')?.value) || 1;
      const threshold = parseFloat(document.getElementById('swapThresholdInput')?.value) || 0.35;
      try {
        const ms = state.config?.modelSettings || {};
        const pipeline = ms.pipeline || {};
        await configAPI.updateConfig('modelSettings.pipeline', {
          ...pipeline,
          memory: { ...(pipeline.memory || {}), wasmInitialMb: wasmMb },
          maxSimultaneous: maxSim,
          threshold
        });
        renderConfigEditor();
        showToast('Memory settings saved.', 'success');
      } catch (err) {
        showToast(err && err.message ? err.message : String(err), 'error');
      }
    });
  }

  // ── Custom model add ────────────────────────────────────────────────────
  const addCustomModelBtn = document.getElementById('addCustomModelBtn');
  if (addCustomModelBtn) {
    addCustomModelBtn.addEventListener('click', async () => {
      const id = document.getElementById('customModelIdInput')?.value?.trim();
      const type = document.getElementById('customModelTypeSelect')?.value;
      const description = document.getElementById('customModelDescInput')?.value?.trim() || '';
      const sizeMb = parseInt(document.getElementById('customModelSizeInput')?.value) || undefined;
      if (!id) { showToast('Model ID is required.', 'error'); return; }
      try {
        let onnx = false;
        let finalSize = sizeMb;
        if (!sizeMb && id.includes('/')) {
          try {
            const HUB = await import('./ai/hub.js');
            const info = await HUB.getHubModelInfo(id);
            if (info) { onnx = info.hasOnnx; finalSize = info.sizeMb || undefined; }
          } catch (_) {}
        }
        const ms = state.config?.modelSettings || {};
        const avail = Array.isArray(ms.availableModels) ? [...ms.availableModels] : [];
        if (avail.some(m => m.id === id)) { showToast('Model already exists in catalog.', 'error'); return; }
        avail.push({ id, type: type || 'embedder', description, sizeMb: finalSize, custom: true, source: 'custom' });
        await configAPI.updateConfig('modelSettings.availableModels', avail);
        document.getElementById('customModelIdInput').value = '';
        document.getElementById('customModelDescInput').value = '';
        document.getElementById('customModelSizeInput').value = '';
        renderConfigEditor();
        await populateModelSelects();
        await renderModelsPanel();
        showToast(onnx ? `Model "${id}" added to catalog.` : `Model "${id}" added — couldn't confirm ONNX weights on Hugging Face; it will be validated on load.`, onnx ? 'success' : 'warning');
      } catch (err) {
        showToast(err && err.message ? err.message : String(err), 'error');
      }
    });
  }

  wireHubDiscovery();
}

// ── Browse Hugging Face (runtime model discovery) ──────────────────────────
function wireHubDiscovery() {
  if (!isBrowser) return;
  const searchBtn = document.getElementById('hubSearchBtn');
  const clearBtn = document.getElementById('hubClearBtn');
  const typeSel = document.getElementById('hubTypeSelect');
  const formatSel = document.getElementById('hubFormatSelect');
  const searchInput = document.getElementById('hubSearchInput');
  const results = document.getElementById('hubResults');
  const statusEl = document.getElementById('hubStatus');
  if (!searchBtn || !typeSel || !results) return;

  const setBusy = (t) => { if (statusEl) statusEl.textContent = t || ''; };
  let fmtSize = (_n) => '';

  async function addCatalogEntry(entry) {
    const ms = state.config?.modelSettings || {};
    const avail = Array.isArray(ms.availableModels) ? [...ms.availableModels] : [];
    if (avail.some(m => m.id === entry.id)) throw new Error('Model already exists in catalog.');
    avail.push({ ...entry });
    await configAPI.updateConfig('modelSettings.availableModels', avail);
  }

  function sizeMb(bytes) {
    const n = Number(bytes) || 0;
    return n >= 1048576 ? Math.max(1, Math.round(n / 1048576)) : undefined;
  }

  async function runSearch() {
    const type = typeSel.value || 'embedder';
    const format = (formatSel && formatSel.value) || 'transformers.js';
    const q = (searchInput ? searchInput.value : '').trim();
    try {
      setBusy('searching…');
      const HUB = await import('./ai/hf.js');
      fmtSize = HUB.formatBytes;
      const list = await HUB.searchHub({
        query: q || undefined,
        type,
        filter: format === 'transformers.js' ? 'onnx' : format === 'gguf' ? 'gguf' : undefined,
        limit: 25,
      });
      if (!list.length) {
        const note = format === 'gguf'
          ? 'No GGUF (llama.cpp / Ollama) models found for these filters.'
          : format === 'transformers.js'
            ? 'No ONNX (transformers.js) models found for these filters. Try a different type, format, or search term.'
            : 'No models found for these filters. Try a different type, format, or search term.';
        results.innerHTML = `<div class="small text-body-secondary py-2">${escapeHtml(note)}</div>`;
        setBusy('0 models');
        return;
      }
      results.innerHTML = list.map(m => {
        const tags = m.tags || [];
        const fmt = (m.library === 'transformers.js' || tags.includes('transformers.js') || tags.includes('onnx'))
          ? '<span class="badge text-bg-info">ONNX</span>'
          : tags.some(t => /gguf/i.test(t))
            ? '<span class="badge text-bg-warning">GGUF</span>'
            : '';
        const gatedTag = m.gated ? ' <span class="badge text-bg-secondary" title="Gated — request access on Hugging Face">gated</span>' : '';
        return `
        <div class="d-flex justify-content-between align-items-center small py-1 border-bottom">
          <div class="me-2 text-truncate">
            <span class="fw-semibold">${escapeHtml(m.id)}</span>${fmt}${gatedTag}
            <span class="text-body-secondary"> · ${Number(m.downloads || 0).toLocaleString()} downloads</span>
          </div>
          <button class="btn btn-sm btn-outline-primary py-0 flex-shrink-0" type="button" data-hub-add="${escapeHtml(m.id)}" data-hub-type="${escapeHtml(type)}" data-hub-dl="${Number(m.downloads || 0)}" ${m.gated ? 'disabled title="Gated model"' : ''}>Add</button>
        </div>`;
      }).join('');
      results.querySelectorAll('[data-hub-add]').forEach(btn => {
        btn.addEventListener('click', () => addHubModel(
          btn.getAttribute('data-hub-add'),
          btn.getAttribute('data-hub-type'),
          Number(btn.getAttribute('data-hub-dl') || 0)
        ));
      });
      setBusy(String(list.length) + ' models');
    } catch (err) {
      results.innerHTML = `<div class="small text-danger py-2">${escapeHtml(err && err.message ? err.message : String(err))}</div>`;
      setBusy('error');
    }
  }

  function renderGgufPicker(id, type, downloads, ggufFiles) {
    const row = results.querySelector(`[data-hub-add="${CSS.escape(id)}"]`);
    if (!row) return;
    const wrap = document.createElement('div');
    wrap.className = 'small py-1';
    wrap.innerHTML = `
      <div class="d-flex flex-wrap align-items-center gap-1">
        <span class="text-body-secondary">GGUF weights — pick a quant:</span>
        <select class="form-select form-select-sm w-auto d-inline-block gguf-pick" data-gguf-id="${escapeHtml(id)}">
          ${ggufFiles.slice(0, 30).map(f => `<option value="${escapeHtml(f.path)}" data-size="${f.size || 0}">${escapeHtml(f.path)}</option>`).join('')}
        </select>
        <button class="btn btn-sm btn-outline-primary py-0" type="button" data-gguf-confirm="${escapeHtml(id)}">Add</button>
        <button class="btn btn-sm btn-outline-secondary py-0" type="button" data-gguf-cancel="${escapeHtml(id)}">Cancel</button>
      </div>`;
    row.replaceWith(wrap);
    const pick = results.querySelector(`select.gguf-pick[data-gguf-id="${CSS.escape(id)}"]`);
    const confirmBtn = results.querySelector(`[data-gguf-confirm="${CSS.escape(id)}"]`);
    if (pick && confirmBtn) {
      const label = document.createElement('span');
      label.className = 'text-body-secondary small ms-1';
      const paint = () => {
        const opt = pick.selectedOptions[0];
        label.textContent = opt && opt.dataset.size ? ' · ' + fmtSize(Number(opt.dataset.size)) : '';
      };
      pick.after(label);
      pick.addEventListener('change', paint);
      paint();
      confirmBtn.addEventListener('click', async () => {
        const opt = pick.selectedOptions[0];
        if (!opt) return;
        confirmBtn.disabled = true;
        confirmBtn.textContent = '…';
        try {
          await addHubModel(id, type, downloads, { file: opt.value, sizeBytes: Number(opt.dataset.size || 0), format: 'gguf' });
        } catch (err) {
          showToast(err && err.message ? err.message : String(err), 'error');
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Add';
        }
      });
    }
    const cancelBtn = results.querySelector(`[data-gguf-cancel="${CSS.escape(id)}"]`);
    if (cancelBtn) cancelBtn.addEventListener('click', () => runSearch());
  }

  async function addHubModel(id, type, downloads, opts = {}) {
    const btn = results.querySelector(`[data-hub-add="${CSS.escape(id)}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      const HUB = await import('./ai/hf.js');
      fmtSize = HUB.formatBytes;
      // A quant already chosen in the GGUF picker — persist directly.
      if (opts.file) {
        await addCatalogEntry({
          id,
          type: type || 'generator',
          description: `Added from Hugging Face · GGUF · ${Number(downloads || 0).toLocaleString()} downloads`,
          sizeMb: sizeMb(opts.sizeBytes),
          file: opts.file,
          format: opts.format || 'gguf',
          custom: true,
          source: 'hub',
        });
        await renderConfigEditor();
        await populateModelSelects();
        await renderModelsPanel();
        showToast(`Model "${id}" (${opts.file}) added to catalog.`, 'success');
        runSearch();
        return;
      }

      const info = await HUB.getHubInfo(id);
      if (!info) throw new Error('Model "' + id + '" not found on Hugging Face.');
      if (info.gated) throw new Error('"' + id + '" is gated — request access on Hugging Face, then retry.');

      const tree = await HUB.getRepoTree(id);
      const cats = HUB.categorizeFiles(tree);
      const onnxPick = HUB.preferredOnnx(cats.onnx);
      if (onnxPick) {
        await addCatalogEntry({
          id,
          type: type || 'embedder',
          description: `Added from Hugging Face · Transformers.js (ONNX) · ${Number(downloads || 0).toLocaleString()} downloads`,
          sizeMb: sizeMb(onnxPick.size),
          file: onnxPick.path,
          format: 'onnx',
          custom: true,
          source: 'hub',
        });
        await renderConfigEditor();
        await populateModelSelects();
        await renderModelsPanel();
        showToast(`Model "${id}" added to catalog (${onnxPick.path}).`, 'success');
        runSearch();
        return;
      }

      if (cats.gguf.length) {
        // No ONNX weights but GGUF quants exist (llama.cpp / Ollama target).
        renderGgufPicker(id, type, downloads, cats.gguf);
        if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
        return;
      }

      if (cats.safetensors.length) {
        throw new Error('"' + id + '" ships only PyTorch (.safetensors) weights — the app needs ONNX or GGUF files.');
      }
      throw new Error('No runnable weight files (.onnx or .gguf) found in "' + id + '".');
    } catch (err) {
      showToast(err && err.message ? err.message : String(err), 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
    }
  }

  if (clearBtn && searchInput) {
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      if (formatSel) formatSel.value = 'transformers.js';
      results.innerHTML = '';
      setBusy('');
    });
  }
  if (searchInput) searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  searchBtn.addEventListener('click', runSearch);
}

// ── Backend URL & memory settings sync helpers ────────────────────────────────
function syncBackendUrlInputs() {
  const ai = state.config?.app?.ai?.backends || {};
  const llamacpp = ai.llamacpp || {};
  const ollama = ai.ollama || {};
  const llamacppUrl = document.getElementById('llamacppUrlInput');
  const ollamaUrl = document.getElementById('ollamaUrlInput');
  const llamacppEnabled = document.getElementById('llamacppEnabledChk');
  const ollamaEnabled = document.getElementById('ollamaEnabledChk');
  if (llamacppUrl) llamacppUrl.value = llamacpp.url || 'http://localhost:8080/v1';
  if (ollamaUrl) ollamaUrl.value = ollama.url || 'http://localhost:11434';
  if (llamacppEnabled) llamacppEnabled.checked = !!llamacpp.enabled;
  if (ollamaEnabled) ollamaEnabled.checked = !!ollama.enabled;
}

function syncMemorySettingsInputs() {
  const ms = state.config?.modelSettings || {};
  const pipeline = ms.pipeline || {};
  const mem = pipeline.memory || {};
  const wasmInput = document.getElementById('wasmHeapMbInput');
  const maxSimInput = document.getElementById('maxSimultaneousInput');
  const thresholdInput = document.getElementById('swapThresholdInput');
  if (wasmInput) wasmInput.value = mem.wasmInitialMb ?? 64;
  if (maxSimInput) maxSimInput.value = pipeline.maxSimultaneous ?? 1;
  if (thresholdInput) thresholdInput.value = pipeline.threshold ?? 0.35;
}

export async function renderConfigEditor() {
  if (!isBrowser) return;
  const container = document.getElementById('configEditor');
  if (!container) return;
  container.textContent = JSON.stringify(state.config || {}, null, 2);
  try {
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
        <span>${escapeHtml(c.avatar || '🤖')} ${escapeHtml(c.name)}</span>
        <span class="d-flex align-items-center gap-1">
          <small class="opacity-75">${escapeHtml(c.persona || '')}</small>
          <button class="btn btn-sm btn-outline-info py-0 px-1" data-character-detail="${c.id}" title="Character details"><i class="bi bi-info-circle"></i></button>
          <button class="btn btn-sm btn-outline-secondary py-0 px-1" data-edit-character="${c.id}" title="Edit"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-outline-danger py-0 px-1" data-delete-character="${c.id}" title="Delete"><i class="bi bi-trash"></i></button>
        </span>
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
        <span>${escapeHtml(b.name)}</span>
        <span class="d-flex align-items-center gap-1">
          <small class="opacity-75">${escapeHtml(b.industry || '')}</small>
          <button class="btn btn-sm btn-outline-info py-0 px-1" data-business-detail="${b.id}" title="Workspace details"><i class="bi bi-info-circle"></i></button>
          <button class="btn btn-sm btn-outline-secondary py-0 px-1" data-edit-business="${b.id}" title="Edit"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-outline-danger py-0 px-1" data-delete-business="${b.id}" title="Delete"><i class="bi bi-trash"></i></button>
        </span>
      </div>
    </a>`).join('') || '<div class="list-group-item text-muted">No workspaces configured.</div>';
}

export function renderTools() {
  if (!isBrowser) return;
  const list = document.getElementById('toolsList');
  if (!list) return;
  const tools = toolRegistry.getAllTools();
  const extensions = extensionRegistry.listExtensions();
  const enabledIds = new Set(extensions.filter(e => e.enabled).map(e => e.id));

  const byExt = new Map(extensions.map(e => [e.id, { ...e, items: [] }]));
  const orphans = [];
  for (const t of tools) {
    const ext = byExt.get(t.extensionId);
    if (ext) ext.items.push(t);
    else orphans.push(t);
  }

  const cards = [...byExt.values()]
    .filter(ext => ext.items.length > 0)
    .map(ext => renderExtensionCard(ext, enabledIds.has(ext.id)))
    .join('');

  const orphanCard = orphans.length
    ? `<div class="border rounded mb-3 overflow-hidden">
         <div class="d-flex align-items-center gap-2 px-3 py-2 bg-body-tertiary">
           <i class="bi bi-question-diamond me-1"></i><strong>Ungrouped</strong>
           <small class="text-body-secondary text-truncate">Tools not assigned to an extension</small>
         </div>
         <ul class="list-group list-group-flush">${orphans.map(t => renderToolItem(t, true)).join('')}</ul>
       </div>`
    : '';

  const stats = `<div class="d-flex flex-wrap align-items-center gap-2 mb-3 small text-body-secondary">
      <span><i class="bi bi-box me-1"></i><strong>${extensions.length}</strong> extensions</span>
      <span class="mx-1">·</span>
      <span><i class="bi bi-tools me-1"></i><strong>${tools.length}</strong> tools</span>
      <span class="mx-1">·</span>
      <span><i class="bi bi-shield-check me-1"></i><strong>${enabledIds.size}</strong> enabled</span>
    </div>`;

  list.innerHTML = docsCard() + stats + (cards || '<div class="alert alert-info">No tools registered.</div>') + orphanCard;
}

// Status card for the "assistant's folder" — where Word/Excel files are saved.
function docsCard() {
  const folderName = getFolderName();
  const supported = typeof window.showDirectoryPicker === 'function';
  const status = folderName
    ? `<strong class="text-success"><i class="bi bi-check-circle me-1"></i>${escapeHtml(folderName)}</strong>
       <small class="text-body-secondary d-block">Word &amp; Excel files will be saved here.</small>`
    : supported
      ? `<span class="text-body-secondary">No folder chosen yet — files are downloaded instead.</span>
         <small class="text-body-secondary d-block">Pick a folder and the assistant can save Word/Excel files straight into it.</small>`
      : `<span class="text-body-secondary">Download mode — this browser can't pick a folder.</span>
         <small class="text-body-secondary d-block">Generated Word and Excel files are downloaded to your device.</small>`;
  const button = supported
    ? `<button type="button" class="btn btn-sm ${folderName ? 'btn-outline-secondary' : 'btn-outline-primary'} d-flex align-items-center gap-1" id="chooseFolderBtn">
         <i class="bi ${folderName ? 'bi-folder2-x' : 'bi-folder2-open'}"></i> ${folderName ? 'Change folder' : 'Choose folder'}
       </button>`
    : '';
  return `<div class="border rounded mb-3 overflow-hidden shadow-sm documents-card">
    <div class="d-flex flex-wrap align-items-center gap-2 px-3 py-2 bg-body-tertiary">
      <i class="bi bi-folder2-open fs-5 text-primary"></i>
      <strong>Assistant's Folder</strong>
      <span class="badge text-bg-secondary">Documents</span>
      <span class="ms-auto">${button}</span>
    </div>
    <div class="px-3 py-2 small">${status}</div>
  </div>`;
}

function renderExtensionCard(ext, enabled) {
  const toolItems = ext.items.map(t => renderToolItem(t, enabled)).join('');
  return `
  <div class="border rounded mb-3 overflow-hidden shadow-sm extension-card">
    <div class="d-flex flex-wrap align-items-center gap-2 px-3 py-2 bg-body-tertiary">
      <i class="bi ${ext.icon} fs-5 text-primary"></i>
      <strong>${escapeHtml(ext.name)}</strong>
      <span class="badge text-bg-secondary">v${escapeHtml(ext.version)}</span>
      <small class="text-body-secondary d-none d-md-inline text-truncate" style="max-width:340px">${escapeHtml(ext.description)}</small>
      <span class="ms-auto d-flex align-items-center gap-2">
        <span class="small text-body-secondary">${ext.items.length} tools</span>
        <div class="form-check form-switch mb-0">
          <input class="form-check-input" type="checkbox" role="switch" id="extToggle-${ext.id}" data-ext-toggle="${ext.id}" ${enabled ? 'checked' : ''} title="${enabled ? 'Disable' : 'Enable'} extension">
        </div>
        <button class="btn btn-sm btn-outline-secondary py-0 px-1" data-ext-detail="${ext.id}" title="Extension details"><i class="bi bi-info-circle"></i></button>
      </span>
    </div>
    <ul class="list-group list-group-flush">
      ${toolItems || '<li class="list-group-item text-muted">No tools yet.</li>'}
    </ul>
  </div>`;
}

function renderToolItem(t, extEnabled) {
  const meta = permissionMeta(t.permissionLevel);
  return `
  <li class="list-group-item d-flex justify-content-between align-items-center py-2 tool-item${extEnabled ? '' : ' opacity-50'}">
    <button class="btn btn-link p-0 text-start text-decoration-none" data-tool-detail="${escapeHtml(t.name)}">
      <i class="bi ${t.icon || 'bi-tools'} me-2"></i><strong>${escapeHtml(t.name)}</strong>
      <small class="text-muted ms-1 d-none d-md-inline">${escapeHtml(t.description || '')}</small>
    </button>
    <span class="d-flex align-items-center gap-2 flex-shrink-0">
      ${extEnabled ? '' : '<span class="badge text-bg-danger">disabled</span>'}
      <span class="badge ${meta.badge}">${meta.label}</span>
      <span class="badge text-bg-secondary d-none d-sm-inline">${t.type || 'internal'}</span>
    </span>
  </li>`;
}

export function openToolDetail(toolName) {
  if (!isBrowser) return;
  const tool = toolRegistry.getTool(toolName);
  if (!tool) return;
  const gate = toolRegistry._extensionRegistry ? toolRegistry._extensionRegistry.gateFor(toolName) : null;
  const meta = permissionMeta(tool.permissionLevel);
  const params = (tool.schema && tool.schema.parameters) ? Object.entries(tool.schema.parameters) : [];
  const body = document.getElementById('toolDetailBody');
  if (!body) return;
  body.innerHTML = `
    <div class="d-flex align-items-center gap-2 mb-2">
      <i class="bi ${tool.icon || 'bi-tools'} fs-3 text-primary"></i>
      <div>
        <h6 class="mb-0">${escapeHtml(tool.name)} <span class="badge text-bg-secondary ms-1">${tool.type || 'internal'}</span></h6>
        <small class="text-body-secondary">${escapeHtml(tool.description || 'No description')}</small>
      </div>
    </div>
    <div class="d-flex flex-wrap gap-2 mb-3">
      <span class="badge ${meta.badge}">${meta.label}</span>
      ${gate ? `<span class="badge text-bg-primary"><i class="bi ${gate.icon} me-1"></i>${escapeHtml(gate.name)} ${gate.enabled ? '' : '(disabled)'}</span>` : ''}
      <span class="badge text-bg-success">registered</span>
    </div>
    <h6 class="small fw-semibold text-uppercase text-body-secondary">Parameters</h6>
    ${params.length ? `<table class="table table-sm table-striped mt-1 mb-0">
      <thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
      <tbody>${params.map(([name, p]) => `<tr>
        <td><code>${escapeHtml(name)}</code></td>
        <td>${escapeHtml(p.type || 'any')}</td>
        <td>${p.required ? '<span class="text-danger">yes</span>' : '<span class="text-body-secondary">no</span>'}</td>
        <td>${escapeHtml(p.description || '')}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<p class="text-body-secondary small">No parameters.</p>'}
    ${gate ? `<div class="alert alert-light border small mb-0 mt-3"><i class="bi ${gate.icon} me-1"></i><strong>Extension:</strong> ${escapeHtml(gate.name)} · nominal permission: <span class="badge ${permissionMeta(gate.nominalLevel).badge}">${permissionMeta(gate.nominalLevel).label}</span>${gate.enabled ? '' : ' · <span class="text-danger">extension disabled</span>'}</div>` : ''}
  `;
  openModal('toolDetailModal');
}

export function openExtensionDetail(extId) {
  if (!isBrowser) return;
  const ext = extensionRegistry.getExtension(extId);
  if (!ext) return;
  const tools = ext.tools()
    .map(name => {
      const t = toolRegistry.getTool(name);
      if (!t) return null;
      const meta = permissionMeta(ext.nominalLevel(name, t.permissionLevel));
      return `<li class="list-group-item d-flex justify-content-between align-items-center py-2">
        <span><i class="bi ${t.icon || 'bi-tools'} me-2"></i><code>${escapeHtml(name)}</code></span>
        <span class="badge ${meta.badge}">${meta.label}</span>
      </li>`;
    })
    .filter(Boolean)
    .join('') || '<li class="list-group-item text-muted">No tools.</li>';
  const title = document.getElementById('extensionDetailTitle');
  const body = document.getElementById('extensionDetailBody');
  if (title) title.innerHTML = `<i class="bi ${ext.icon} me-2"></i>${escapeHtml(ext.name)}`;
  if (!body) return;
  body.innerHTML = `
    <div class="mb-3">
      <h6 class="mb-1">${escapeHtml(ext.name)} <span class="badge text-bg-secondary">v${escapeHtml(ext.version)}</span>
        ${ext.enabled ? '<span class="badge text-bg-success">enabled</span>' : '<span class="badge text-bg-danger">disabled</span>'}</h6>
      <p class="text-body-secondary mb-0">${escapeHtml(ext.description || 'No description.')}</p>
    </div>
    <div class="d-flex align-items-center gap-2 mb-3">
      <div class="form-check form-switch mb-0">
        <input class="form-check-input" type="checkbox" role="switch" data-ext-toggle="${ext.id}" ${ext.enabled ? 'checked' : ''}>
      </div>
      <span class="small text-body-secondary">Disabling this extension makes every tool below refuse to execute.</span>
    </div>
    <h6 class="small fw-semibold text-uppercase text-body-secondary mb-2">Tools (${ext.tools().length})</h6>
    <ul class="list-group">${tools}</ul>`;
  openModal('extensionDetailModal');
}

export async function toggleExtension(extId, enabled) {
  if (!isBrowser) return;
  const ok = extensionRegistry.setEnabled(extId, enabled);
  if (!ok) return;
  try {
    await db.setKV('extension_state', extensionRegistry.saveState());
  } catch (e) {
    console.warn('Could not persist extension state:', e);
  }
  renderTools();
  const ext = extensionRegistry.getExtension(extId);
  showToast(enabled ? 'Extension enabled.' : `Extension "${ext ? ext.name : extId}" disabled.`, enabled ? 'success' : 'warning');
}

export function renderConfigIssues() {
  if (!isBrowser) return;
  const banner = document.getElementById('configIssuesBanner');
  if (!banner) return;
  const issues = state.configIssues || [];
  if (!issues.length) {
    banner.classList.add('d-none');
    banner.innerHTML = '';
    return;
  }
  const items = issues.map(i => {
    const code = i.code ? ` <span class="badge text-bg-danger">${escapeHtml(i.code)}</span>` : '';
    const fix = i.fix ? `<small class="d-block opacity-75 mt-1">Fix: ${escapeHtml(i.fix)}</small>` : '';
    return `<li class="mb-1">⚠️ <strong>${escapeHtml(i.message)}</strong>${code}${fix}</li>`;
  }).join('');
  banner.classList.remove('d-none');
  banner.innerHTML = `<div class="fw-semibold small mb-1">Configuration needs attention:</div><ul class="mb-0">${items}</ul>`;
}

export function renderQuickPrompts() {
  if (!isBrowser) return;
  const container = document.getElementById('quickPromptsContainer');
  if (!container) return;
  const prompts = (state.config?.quickPrompts) || [
    'How are you today?', 'Spent $16.50 on lunch', 'Analyze expenses',
    'Add todo: write report', 'Search marketing projects', 'List agents', 'List tools'
  ];
  container.innerHTML = prompts.map(p => {
    const label = typeof p === 'string' ? p : (p.label || p.query || '');
    const query = typeof p === 'string' ? p : (p.query || p.label || '');
    return `
    <button class="btn btn-outline-secondary btn-sm quick-prompt" type="button" data-query="${escapeHtml(query)}">${escapeHtml(label)}</button>`;
  }).join('');
}

function updateHeaderUI() {
  if (!isBrowser) return;
  const char = getActiveCharacter(state);
  const nameEl = document.getElementById('current-name');
  const personaEl = document.getElementById('current-persona');
  const avatarEl = document.getElementById('current-avatar');
  const avatarWrap = document.getElementById('current-avatar-wrap');
  const brandEl = document.getElementById('appBrandName');
  const mobileBrand = document.getElementById('mobileBrandName');
  const persona = char.persona || state.config?.app?.subtitle || 'Assistant';

  if (brandEl) brandEl.textContent = char.name;
  if (mobileBrand) mobileBrand.textContent = char.name;
  if (nameEl) nameEl.textContent = char.name;
  if (personaEl) personaEl.textContent = persona;
  if (avatarEl) avatarEl.textContent = char.avatar || '🤖';
  if (avatarWrap) {
    avatarWrap.style.background = char.color || '#4f46e5';
    avatarWrap.style.boxShadow = `0 6px 18px -8px ${char.color || '#4f46e5'}`;
  }

  const biz = getActiveBusiness(state);
  const badge = document.getElementById('activeBizBadge');
  if (badge) badge.textContent = biz.name;
  const mobileBizBadge = document.getElementById('activeBizBadgeMobile');
  if (mobileBizBadge) mobileBizBadge.textContent = biz.name;
  const bizLabel = document.getElementById('activeBizLabel');
  if (bizLabel) bizLabel.textContent = biz.name;
}

// ── Switch menus (character + business) ─────────────────────────────────────
function populateSwitchMenus() {
  if (!isBrowser) return;

  const bizMenu = document.getElementById('bizSwitchMenu');
  if (bizMenu) {
    const bizs = state.config?.businesses || [];
    bizMenu.innerHTML = bizs.map(b => `
      <li><button class="dropdown-item ${b.id === state.activeBusinessId ? 'active' : ''}" type="button" data-biz-id="${b.id}">
        <i class="bi bi-buildings me-2"></i>${escapeHtml(b.name)}</button></li>
    `).join('') || '<li><span class="dropdown-item-text text-muted">No workspaces</span></li>';
  }

  const charMenu = document.getElementById('charSwitchMenu');
  if (charMenu) {
    const chars = state.config?.characters || [];
    charMenu.innerHTML = chars.map(c => `
      <li><button class="dropdown-item ${c.id === state.activeCharacterId ? 'active' : ''}" type="button" data-char-id="${c.id}">
        <span class="me-2">${escapeHtml(c.avatar || '🤖')}</span>${escapeHtml(c.name)}</button></li>
    `).join('') || '<li><span class="dropdown-item-text text-muted">No characters</span></li>';
  }
}

function switchCharacter(id, { viaChat = false } = {}) {
  if (!state.config?.characters?.some(c => c.id === id)) return;
  state.activeCharacterId = id;
  updateHeaderUI();
  populateSwitchMenus();
  renderExplorer();
  if (viaChat) showGreeting({ persist: true, short: true });
}

function switchBusiness(id) {
  const biz = state.config?.businesses?.find(b => b.id === id);
  if (!biz) return;
  state.activeBusinessId = id;
  updateHeaderUI();
  populateSwitchMenus();
  renderExplorer();
}

// ── Character & business edit/delete ────────────────────────────────────────
export function openCharacterModal(id = null) {
  if (!isBrowser) return;
  const char = id ? state.config?.characters?.find(c => c.id === id) : null;
  const delBtn = document.getElementById('deleteCharacterBtn');
  const title = document.getElementById('characterModalTitle');
  const idHint = document.getElementById('charIdInput');
  const nameInput = document.getElementById('charNameInput');
  if (char) {
    if (title) title.textContent = 'Edit Character';
    if (delBtn) delBtn.classList.remove('d-none');
    idHint.value = char.id; idHint.disabled = true;
    nameInput.value = char.name || '';
    document.getElementById('charPersonaInput').value = char.persona || '';
    document.getElementById('charPromptInput').value = char.systemPrompt || '';
    document.getElementById('charColorInput').value = char.color || '#6366f1';
    document.getElementById('charAvatarInput').value = char.avatar || '🤖';
    document.getElementById('charSpecInput').value = Array.isArray(char.specialization) ? char.specialization.join(', ') : (Array.isArray(char.specs) ? char.specs.join(', ') : '');
    document.getElementById('charEditIdInput').value = char.id;
  } else {
    if (title) title.textContent = 'Create New Character';
    if (delBtn) delBtn.classList.add('d-none');
    idHint.value = ''; idHint.disabled = false;
    nameInput.value = '';
    document.getElementById('charPersonaInput').value = '';
    document.getElementById('charPromptInput').value = '';
    document.getElementById('charColorInput').value = '#6366f1';
    document.getElementById('charAvatarInput').value = '🤖';
    document.getElementById('charSpecInput').value = '';
    document.getElementById('charEditIdInput').value = '';
  }
  const modal = bootstrap.Modal.getInstance(document.getElementById('characterModal')) || new bootstrap.Modal(document.getElementById('characterModal'));
  modal.show();
}

export async function deleteCharacter(id) {
  if (!isBrowser) return;
  const char = state.config?.characters?.find(c => c.id === id);
  if (!char) return;
  if (!confirm(`Delete character "${char.name}"? This cannot be undone.`)) return;
  try {
    await configAPI.deleteCharacter(id);
    if (state.activeCharacterId === id) state.activeCharacterId = state.config?.characters?.[0]?.id || null;
    renderExplorer();
    showToast(`Character "${char.name}" deleted.`, 'success');
  } catch (err) {
    showToast(err && err.message ? err.message : String(err), 'error');
  }
}

export function openBusinessModal(id = null) {
  if (!isBrowser) return;
  const biz = id ? state.config?.businesses?.find(b => b.id === id) : null;
  const delBtn = document.getElementById('deleteBusinessBtn');
  const title = document.getElementById('businessModalTitle');
  const idInput = document.getElementById('bizIdInput');
  const nameInput = document.getElementById('bizNameInput');
  if (biz) {
    if (title) title.textContent = 'Edit Workspace';
    if (delBtn) delBtn.classList.remove('d-none');
    idInput.value = biz.id; idInput.disabled = true;
    nameInput.value = biz.name || '';
    document.getElementById('bizEditIdInput').value = biz.id;
  } else {
    if (title) title.textContent = 'Create New Workspace';
    if (delBtn) delBtn.classList.add('d-none');
    idInput.value = ''; idInput.disabled = false;
    nameInput.value = '';
    document.getElementById('bizEditIdInput').value = '';
  }
  const modal = bootstrap.Modal.getInstance(document.getElementById('businessModal')) || new bootstrap.Modal(document.getElementById('businessModal'));
  modal.show();
}

export async function deleteBusiness(id) {
  if (!isBrowser) return;
  const biz = state.config?.businesses?.find(b => b.id === id);
  if (!biz) return;
  if (!confirm(`Delete workspace "${biz.name}"? Its data and chat history will also be removed.`)) return;
  try {
    await configAPI.deleteBusiness(id);
    if (state.activeBusinessId === id) state.activeBusinessId = state.config?.businesses?.[0]?.id || null;
    renderExplorer();
    showToast(`Workspace "${biz.name}" deleted.`, 'success');
  } catch (err) {
    showToast(err && err.message ? err.message : String(err), 'error');
  }
}

// ── Entity detail views ─────────────────────────────────────────────────────

let detailCharId = null;
let detailBizId = null;

export function openCharacterDetail(id) {
  if (!isBrowser) return;
  const char = state.config?.characters?.find(c => c.id === id);
  if (!char) return;
  detailCharId = id;
  const active = char.id === state.activeCharacterId;
  const title = document.getElementById('characterDetailTitle');
  if (title) title.innerHTML = `<i class="bi bi-person-badge me-2"></i>${escapeHtml(char.name)}`;
  const body = document.getElementById('characterDetailBody');
  if (!body) return;

  const specs = Array.isArray(char.specialization)
    ? char.specialization.map(s => `<span class="badge text-bg-light border">${escapeHtml(s)}</span>`).join('')
    : (Array.isArray(char.specs) ? char.specs.map(s => `<span class="badge text-bg-light border">${escapeHtml(s)}</span>`).join('') : '');

  const emotions = (char.emotions && typeof char.emotions === 'object')
    ? `<div class="d-flex flex-wrap gap-2 mt-1">${Object.entries(char.emotions).map(([k, v]) =>
        `<span class="badge bg-body-secondary text-body-secondary border d-inline-flex align-items-center gap-1"><span class="small text-uppercase">${escapeHtml(k)}</span> ${escapeHtml(v)}</span>`).join('')}</div>`
    : '<div class="text-muted small">No emotions configured.</div>';

  body.innerHTML = `
    <div class="d-flex align-items-start gap-3 mb-3">
      <span class="display-5">${escapeHtml(char.avatar || '🤖')}</span>
      <div>
        <h5 class="mb-1">${escapeHtml(char.name)}
          <span class="badge text-bg-secondary ms-1">${escapeHtml(char.id)}</span>
          ${active ? '<span class="badge text-bg-success">active</span>' : ''}
        </h5>
        <p class="text-body-secondary mb-1">${escapeHtml(char.persona || 'No persona set.')}</p>
        ${char.color ? `<span class="d-inline-flex align-items-center gap-2 small"><span class="d-inline-block rounded-circle" style="width:14px;height:14px;background:${escapeHtml(char.color)}"></span>${escapeHtml(char.color)}</span>` : ''}
      </div>
    </div>
    <div class="mb-3">${specs ? `<h6 class="small fw-semibold text-uppercase text-body-secondary mb-1">Specializations</h6><div class="d-flex flex-wrap gap-1">${specs}</div>` : ''}</div>
    <div class="mb-3">
      <h6 class="small fw-semibold text-uppercase text-body-secondary mb-1">Voice</h6>
      <div class="small text-body-secondary">Pitch ${char.voicePitch ?? '1.0'} · Rate ${char.voiceRate ?? '1.0'}</div>
    </div>
    <div class="mb-3">
      <h6 class="small fw-semibold text-uppercase text-body-secondary mb-1">Emotions</h6>
      ${emotions}
    </div>
    <div>
      <h6 class="small fw-semibold text-uppercase text-body-secondary mb-1">System Prompt</h6>
      <pre class="bg-body-tertiary border rounded p-2 small mb-0" style="white-space:pre-wrap;max-height:220px;overflow:auto">${escapeHtml(char.systemPrompt || 'No system prompt set.')}</pre>
    </div>`;
  openModal('characterDetailModal');
}

export function openBusinessDetail(id) {
  if (!isBrowser) return;
  const biz = state.config?.businesses?.find(b => b.id === id);
  if (!biz) return;
  detailBizId = id;
  const active = biz.id === state.activeBusinessId;
  const title = document.getElementById('businessDetailTitle');
  if (title) title.innerHTML = `<i class="bi bi-buildings me-2"></i>${escapeHtml(biz.name)}`;
  const body = document.getElementById('businessDetailBody');
  if (!body) return;

  const schemas = Object.entries(biz.schemas || {});
  const schemaRows = schemas.map(([name, def]) => {
    const fields = Object.entries(def.fields || {});
    return `
    <li class="list-group-item">
      <div class="d-flex justify-content-between align-items-center">
        <strong>${escapeHtml(name)}</strong>
        <span class="small text-body-secondary">${fields.length} field${fields.length === 1 ? '' : 's'}${(def.vectorize || []).length ? ` · ${def.vectorize.length} embedded` : ''}</span>
      </div>
      <div class="d-flex flex-wrap gap-1 mt-1">${fields.map(([f, t]) =>
        `<code class="small bg-body-tertiary border rounded px-1">${escapeHtml(f)}:${escapeHtml(t)}</code>`).join('')}
        ${(def.vectorize || []).length ? `<span class="badge text-bg-info">vector: ${def.vectorize.map(escapeHtml).join(', ')}</span>` : ''}
      </div>
    </li>`;
  }).join('') || '<li class="list-group-item text-muted">No schemas.</li>';

  body.innerHTML = `
    <div class="d-flex align-items-start gap-3 mb-3">
      <span class="display-6"><i class="bi bi-buildings text-primary"></i></span>
      <div>
        <h5 class="mb-1">${escapeHtml(biz.name)}
          <span class="badge text-bg-secondary ms-1">${escapeHtml(biz.id)}</span>
          ${active ? '<span class="badge text-bg-success">active</span>' : ''}
        </h5>
        <p class="text-body-secondary mb-0">${escapeHtml(biz.industry || 'No industry set.')}</p>
      </div>
    </div>
    <div>
      <h6 class="small fw-semibold text-uppercase text-body-secondary mb-2">Schemas (${schemas.length})</h6>
      <ul class="list-group">${schemaRows}</ul>
    </div>`;
  openModal('businessDetailModal');
}

export async function openSchemaDetail(schemaName) {
  if (!isBrowser) return;
  const schema = schemaName || currentSchema();
  if (!schema) { showToast('Create a schema first.', 'error'); return; }
  const biz = state.config?.businesses?.find(b => b.id === state.activeBusinessId);
  const def = biz?.schemas?.[schema];
  const records = await db.getRecords(state.activeBusinessId, schema);
  const title = document.getElementById('schemaDetailTitle');
  if (title) title.innerHTML = `<i class="bi bi-diagram-3 me-2"></i>${escapeHtml(schema)}`;
  const body = document.getElementById('schemaDetailBody');
  if (!body) return;

  const fields = def ? Object.entries(def.fields || {}) : [];
  const vector = def ? (def.vectorize || []) : [];

  body.innerHTML = `
    <div class="d-flex align-items-start gap-3 mb-3">
      <span class="display-6"><i class="bi bi-diagram-3 text-primary"></i></span>
      <div>
        <h5 class="mb-1">${escapeHtml(schema)}
          <span class="badge text-bg-secondary ms-1">${escapeHtml(biz?.name || state.activeBusinessId)}</span>
        </h5>
        <p class="text-body-secondary mb-0">
          <span class="bi bi-database me-1"></span>${records.length} record${records.length === 1 ? '' : 's'} ·
          <span class="bi bi-tags me-1"></span>${fields.length} field${fields.length === 1 ? '' : 's'} ·
          <span class="bi bi-vector-pen me-1"></span>${vector.length} embedded
        </p>
      </div>
    </div>
    <div>
      <h6 class="small fw-semibold text-uppercase text-body-secondary mb-2">Fields</h6>
      <table class="table table-sm table-striped mb-0">
        <thead><tr><th>Field</th><th>Type</th><th>Embedded</th></tr></thead>
        <tbody>${fields.length ? fields.map(([f, t]) => `<tr>
          <td><code>${escapeHtml(f)}</code></td>
          <td>${escapeHtml(t || 'any')}</td>
          <td>${vector.includes(f) ? '<span class="bi bi-check2 text-success"></span>' : ''}</td>
        </tr>`).join('') : '<tr><td colspan="3" class="text-muted">No fields.</td></tr>'}</tbody>
      </table>
    </div>`;
  openModal('schemaDetailModal');
}

function handleCharacterDetailAction(action, id) {
  const char = state.config?.characters?.find(c => c.id === id);
  if (!char) return;
  if (action === 'setActive') {
    closeModal('characterDetailModal');
    switchCharacter(id);
    showToast(`Character "${char.name}" is now active.`, 'success');
  } else if (action === 'preview') {
    closeModal('characterDetailModal');
    previewPrompt(id);
  } else if (action === 'edit') {
    closeModal('characterDetailModal');
    openCharacterModal(id);
  } else if (action === 'delete') {
    closeModal('characterDetailModal');
    deleteCharacter(id);
  }
}

function handleBusinessDetailAction(action, id) {
  const biz = state.config?.businesses?.find(b => b.id === id);
  if (!biz) return;
  if (action === 'setActive') {
    closeModal('businessDetailModal');
    switchBusiness(id);
    showToast(`Workspace "${biz.name}" is now active.`, 'success');
  } else if (action === 'explore') {
    closeModal('businessDetailModal');
    switchBusiness(id);
    const tab = document.getElementById('tab-explorer-btn');
    if (tab && typeof bootstrap !== 'undefined') bootstrap.Tab.getOrCreateInstance(tab).show();
    const select = document.getElementById('explorerSchemaSelect');
    const first = fieldList()[0];
    if (select && first) { select.value = first; renderExplorerTable(first); }
    showToast(`Opened "${biz.name}" in the Data Explorer.`, 'success');
  } else if (action === 'edit') {
    closeModal('businessDetailModal');
    openBusinessModal(id);
  } else if (action === 'delete') {
    closeModal('businessDetailModal');
    deleteBusiness(id);
  }
}

function handleSchemaDetailAction(action) {
  const schema = currentSchema();
  if (!schema) { showToast('Create a schema first.', 'error'); return; }
  if (action === 'edit') {
    closeModal('schemaDetailModal');
    openEditSchemaModal();
  } else if (action === 'add') {
    closeModal('schemaDetailModal');
    const tab = document.getElementById('tab-explorer-btn');
    if (tab && typeof bootstrap !== 'undefined') bootstrap.Tab.getOrCreateInstance(tab).show();
    const addBtn = document.getElementById('addRecordBtn');
    if (addBtn) addBtn.click();
  } else if (action === 'export') {
    closeModal('schemaDetailModal');
    exportFlowData();
  }
}

// ── Model detail view ──────────────────────────────────────────────────────

let detailModelId = null;

export async function openModelDetail(id) {
  if (!isBrowser) return;
  const title = document.getElementById('modelDetailTitle');
  const body = document.getElementById('modelDetailBody');
  if (!body) return;
  let meta;
  try {
    const M = await import('./models.js');
    meta = M.getModelMeta(id);
    if (!meta) { showToast(`Model "${id}" not found in the catalog.`, 'error'); return; }
    detailModelId = id;
    if (title) title.innerHTML = `<i class="bi bi-cpu me-2"></i>${escapeHtml(meta.name || meta.id)}`;

    const typeBadge = { embedder: 'info', classifier: 'warning', ner: 'danger', generator: 'success' }[meta.type] || 'secondary';
    const stageKey = { embedder: 'encoder', classifier: 'intent', ner: 'tagger', generator: 'dialog' }[meta.type];
    const stageLabel = stageKey ? (STAGE_LABELS[stageKey] || stageKey) : null;
    const stages = M.getStageOptions();
    const usedBy = stages.filter(s => s.model === id);

    body.innerHTML = `
      <div class="d-flex align-items-start gap-3 mb-3">
        <span class="display-6"><i class="bi bi-cpu text-primary"></i></span>
        <div>
          <h5 class="mb-1">${escapeHtml(meta.name || meta.id)}
            <span class="badge text-bg-secondary ms-1">${escapeHtml(meta.id)}</span>
            <span class="badge text-bg-${typeBadge}">${escapeHtml(meta.type)}</span>
            ${renderFitBadge(getModelFit(detectedDevice, { ...meta, sizeMb: meta.sizeMb }))}
          </h5>
          <p class="text-body-secondary mb-1">${escapeHtml(meta.description || 'No description.')}</p>
          ${stageLabel ? '<span class="badge text-bg-light border">stage: ' + escapeHtml(stageLabel.toLowerCase()) + '</span>' : ''}
        </div>
      </div>
      <div class="row g-2 mb-3">
        <div class="col-md-4"><div class="border rounded p-2"><div class="small text-uppercase text-body-secondary">Size (q8)</div><div class="fw-semibold">${meta.sizeMb ? meta.sizeMb + ' MB' : '—'}</div></div></div>
        <div class="col-md-4"><div class="border rounded p-2"><div class="small text-uppercase text-body-secondary">Role</div><div class="fw-semibold text-capitalize">${escapeHtml(meta.type)}</div></div></div>
        <div class="col-md-4"><div class="border rounded p-2"><div class="small text-uppercase text-body-secondary">Stage</div><div class="fw-semibold text-capitalize">${escapeHtml(stageLabel || '—')}</div></div></div>
      </div>
      <div>
        <h6 class="small fw-semibold text-uppercase text-body-secondary mb-2">Currently used by</h6>
        ${usedBy.length
          ? usedBy.map(s => `<span class="badge bg-body-secondary text-body-secondary border me-1 mb-1">${escapeHtml(STAGE_LABELS[s.key] || s.label)}${s.loaded ? ' · resident' : ''}</span>`).join('')
          : '<span class="text-muted small">Not assigned to any pipeline stage.</span>'}
      </div>`;
    openModal('modelDetailModal');
  } catch (err) {
    showToast(err && err.message ? err.message : String(err), 'error');
  }
}

async function handleModelDetailAction(action) {
  const id = detailModelId;
  if (!id) return;
  if (action === 'select') {
    closeModal('modelDetailModal');
    const M = await import('./models.js');
    const meta = M.getModelMeta(id);
    const stageKey = { embedder: 'encoder', classifier: 'intent', ner: 'tagger', generator: 'dialog' }[meta.type];
    const sel = document.getElementById(stageKey && STAGE_SELECT_IDS[stageKey]);
    if (sel) {
      sel.value = id;
      showToast(`Selected "${meta.name || id}" in the ${STAGE_LABELS[stageKey] || stageKey} picker.`, 'success');
      await renderModelsPanel();
    }
  } else if (action === 'apply') {
    closeModal('modelDetailModal');
    const M = await import('./models.js');
    const meta = M.getModelMeta(id);
    const stageKey = { embedder: 'encoder', classifier: 'intent', ner: 'tagger', generator: 'dialog' }[meta.type];
    if (stageKey) {
      try {
        M.applyStageModel(stageKey, id);
        await configAPI.updateConfig('modelSettings', state.config.modelSettings);
        await M.loadStage(stageKey, id);
        populateModelSelects();
        renderConfigEditor();
        await renderModelsPanel();
        showToast(`Loaded "${(meta && meta.name) || id}" for ${STAGE_LABELS[stageKey] || stageKey}.`, 'success');
      } catch (err) {
        populateModelSelects();
        await renderModelsPanel();
        showToast(M.formatModelError ? M.formatModelError(err) : String(err), 'error');
      }
    }
  }
}

export async function previewPrompt(characterId = null) {
  if (!isBrowser) return;
  const char = characterId
    ? state.config?.characters?.find(c => c.id === characterId)
    : state.config?.characters?.find(c => c.id === state.activeCharacterId);
  const biz = state.config?.businesses?.find(b => b.id === state.activeBusinessId);
  try {
    const skills = await import('../core/skills.js');
    const prompt = skills.buildSystemPrompt(char, biz, { appName: state.config?.app?.name });
    const el = document.getElementById('promptPreviewContent');
    if (el) el.textContent = prompt || '';
    const modal = bootstrap.Modal.getInstance(document.getElementById('promptPreviewModal')) || new bootstrap.Modal(document.getElementById('promptPreviewModal'));
    modal.show();
  } catch {
    const el = document.getElementById('promptPreviewContent');
    if (el) el.textContent = (char ? char.systemPrompt : '') || 'No system prompt set.';
    const modal = bootstrap.Modal.getInstance(document.getElementById('promptPreviewModal')) || new bootstrap.Modal(document.getElementById('promptPreviewModal'));
    modal.show();
  }
}

// ── Chat history (persist + hydrate) ────────────────────────────────────────
let chatHydrated = false;

export async function hydrateChat(bizId) {
  if (!isBrowser || chatHydrated) return;
  chatHydrated = true;
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;
  try {
    const msgs = await db.getChat(bizId || currentBizId());
    if (!msgs || !msgs.length) {
      renderEmptyState();
      showGreeting({ persist: false });
      return;
    }
    chatMessages.innerHTML = '';
    for (const m of msgs) {
      appendChatMessage(m.role || 'assistant', m.content || '', {
        name: m.agentName,
        emotion: m.emotion,
        ts: m.timestamp,
        animate: false,
        persist: false
      });
    }
  } catch (e) {
    renderEmptyState();
    showGreeting({ persist: false });
  }
}

export function clearChatUI() {
  if (!isBrowser) return;
  state.chatHistory = [];
  const chatMessages = document.getElementById('chatMessages');
  if (chatMessages) chatMessages.innerHTML = '';
  db.clearChat(currentBizId()).then(() => {
    renderEmptyState();
    showGreeting({ persist: false });
    showToast('Conversation cleared.', 'success');
  }).catch(() => {
    renderEmptyState();
    showGreeting({ persist: false });
  });
}

// ── Data Explorer ───────────────────────────────────────────────────────────
function fieldList() {
  const biz = state.config?.businesses?.find(b => b.id === state.activeBusinessId);
  return Object.keys(biz?.schemas || {});
}

export async function renderExplorerSchemas() {
  if (!isBrowser) return;
  const select = document.getElementById('explorerSchemaSelect');
  if (!select) return;
  const schemas = fieldList();
  select.innerHTML = schemas.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('') || '<option value="">No schemas</option>';
  renderDataStats();
  await renderExplorerTable(select.value);
}

export async function renderExplorerSchema(schemaName) {
  if (!isBrowser) return;
  const head = document.getElementById('explorerTableHead');
  const body = document.getElementById('explorerTableBody');
  const countEl = document.getElementById('tableRecordCount');
  if (!head || !body || !schemaName) return;
  const records = await db.getRecords(state.activeBusinessId, schemaName);
  const biz = state.config?.businesses?.find(b => b.id === state.activeBusinessId);
  const schema = biz?.schemas?.[schemaName];
  const fields = schema ? (schema.vectorize || Object.keys(schema.fields || {})) : [];
  head.innerHTML = '<tr>' + fields.map(f => `<th>${escapeHtml(f)}</th>`).join('') + '<th class="text-end">Actions</th></tr>';
  if (countEl) countEl.textContent = `${records.length} record${records.length === 1 ? '' : 's'}`;
  body.innerHTML = records.length
    ? records.map(r => '<tr>' + fields.map(f => `<td>${escapeHtml(String(r.data[f] ?? ''))}</td>`).join('')
        + `<td class="text-end">
            <button class="btn btn-sm btn-outline-secondary py-0 px-1" data-edit-record="${r.id}" title="Edit"><i class="bi bi-pencil"></i></button>
            <button class="btn btn-sm btn-outline-danger py-0 px-1" data-delete-record="${r.id}" title="Delete"><i class="bi bi-trash"></i></button>
          </td></tr>`).join('')
    : '<tr><td colspan="' + ((fields.length || 1) + 1) + '" class="text-muted">No records.</td></tr>';
  renderDataStats();
}

export async function renderExplorerTable(schemaName) {
  return renderExplorerSchema(schemaName);
}

async function renderDataStats() {
  if (!isBrowser) return;
  const records = await db.getRecords(state.activeBusinessId);
  const embedded = records.filter(r => r.embedding && r.embedding.length).length;
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(v);
  };
  const biz = state.config?.businesses?.find(b => b.id === state.activeBusinessId);
  set('dataStatRecords', records.length);
  set('dataStatSchemas', Object.keys(biz?.schemas || {}).length);
  set('dataStatEmbedded', embedded);
}

async function deleteSchemaFromExplorer(schemaName) {
  if (!schemaName) return;
  if (!confirm(`Delete schema "${schemaName}" and all its records? This cannot be undone.`)) return;
  try {
    const records = await db.getRecords(state.activeBusinessId, schemaName);
    for (const r of records) await db.deleteRecord(r.id);
    await configAPI.deleteSchema(state.activeBusinessId, schemaName);
    renderExplorerSchemas();
    renderConfigEditor();
    showToast(`Schema "${schemaName}" deleted.`, 'success');
  } catch (err) {
    showToast(err && err.message ? err.message : String(err), 'error');
  }
}

function resetSchemaModal() {
  const editInput = document.getElementById('schemaEditNameInput');
  const delBtn = document.getElementById('deleteSchemaFromModalBtn');
  const title = document.getElementById('schemaModalTitle');
  if (editInput) editInput.value = '';
  if (delBtn) delBtn.classList.add('d-none');
  if (title) title.textContent = 'Create New Data Schema';
  document.getElementById('schemaNameInput').value = '';
  document.getElementById('schemaFieldsInput').value = '';
}

async function openEditSchemaModal() {
  const schema = currentSchema();
  if (!schema) { showToast('Create a schema first.', 'error'); return; }
  const biz = state.config?.businesses?.find(b => b.id === state.activeBusinessId);
  const def = biz?.schemas?.[schema];
  const editInput = document.getElementById('schemaEditNameInput');
  const delBtn = document.getElementById('deleteSchemaFromModalBtn');
  const title = document.getElementById('schemaModalTitle');
  if (editInput) editInput.value = schema;
  if (delBtn) delBtn.classList.remove('d-none');
  if (title) title.textContent = `Edit Schema — ${schema}`;
  const nameInput = document.getElementById('schemaNameInput');
  const fieldsInput = document.getElementById('schemaFieldsInput');
  if (nameInput) { nameInput.value = schema; nameInput.disabled = true; }
  if (fieldsInput) fieldsInput.value = def ? Object.entries(def.fields || {}).map(([k, v]) => `${k}:${v}`).join(', ') : '';
  openModal('schemaModal');
}

async function exportFlowData() {
  if (!isBrowser) return;
  const biz = state.config?.businesses?.find(b => b.id === state.activeBusinessId);
  if (!biz) return;
  const records = await db.getRecords(state.activeBusinessId);
  const blob = new Blob([JSON.stringify({ business: biz.id, schemas: biz.schemas || {}, records }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${biz.id}-data-export.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Data exported.', 'success');
}

async function importFlowData(file) {
  if (!isBrowser || !file) return;
  try {
    const obj = JSON.parse(await file.text());
    if (obj.business && obj.business !== state.activeBusinessId) {
      showToast('Data is for a different workspace.', 'error');
      return;
    }
    const biz = state.config?.businesses?.find(b => b.id === state.activeBusinessId);
    // Recreate schemas
    for (const [name, def] of Object.entries(obj.schemas || {})) {
      if (!biz?.schemas?.[name]) await configAPI.addSchema(state.activeBusinessId, name, def);
    }
    // Recreate records
    for (const r of obj.records || []) {
      await db.addRecord(state.activeBusinessId, r.schemaName, r.data || {}, r.embedding || null);
    }
    renderExplorerSchemas();
    renderConfigEditor();
    showToast(`Imported ${(obj.records || []).length} records.`, 'success');
  } catch (err) {
    showToast('Import failed: ' + (err && err.message ? err.message : String(err)), 'error');
  }
}

function applyTableFilter() {
  if (!isBrowser) return;
  const q = (document.getElementById('tableFilterInput')?.value || '').toLowerCase();
  document.querySelectorAll('#explorerTableBody tr').forEach(tr => {
    tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

function currentSchema() {
  return document.getElementById('explorerSchemaSelect')?.value || '';
}

// ── Theme ───────────────────────────────────────────────────────────────────
function themeMode() {
  const t = state.config?.app?.theme;
  if (typeof t === 'string') return t;
  return (t && t.mode) || 'light';
}

// ── Coder panel (in-app coding agent) ───────────────────────────────────────
let coderHandler = null;
let coderBusy = false;

function coderEl(id) {
  return document.getElementById(id);
}

function scrollCoderBottom() {
  const t = coderEl('coderTranscript');
  if (t) t.scrollTop = t.scrollHeight;
}

function coderMarkdown(text) {
  return `<div class="chat-md coder-md">${renderMarkdown(text)}</div>`;
}

export function setCoderStatus(text, level = 'info') {
  if (!isBrowser) return;
  const el = coderEl('coderStatusText');
  if (!el) return;
  el.innerHTML = text;
  const card = coderEl('coderStatusCard');
  if (card) {
    card.className = `alert border d-flex align-items-center gap-2 py-2 mb-0 ${level === 'ok' ? 'alert-soft-success' : level === 'warn' ? 'alert-soft-warning' : 'alert-soft-info'}`;
  }
}

export function appendCodingMessage(role, content, opts = {}) {
  if (!isBrowser) return;
  const t = coderEl('coderTranscript');
  if (!t) return;
  const isUser = role === 'user';
  const row = document.createElement('div');
  row.className = `msg-row ${isUser ? 'from-user' : 'from-bot'} mb-2`;
  if (opts.animate !== false && !prefersReducedMotion()) row.classList.add('msg-in-coder');

  const bubble = document.createElement('div');
  bubble.className = isUser ? 'coder-bubble coder-user' : 'coder-bubble coder-bot';
  if (!isUser) bubble.classList.add('chat-md');

  if (isUser) {
    bubble.textContent = String(content || '');
  } else {
    const label = opts.label ? `<span class="coder-role coder-label">${escapeHtml(opts.label)}</span>` : '';
    let steps = '';
    if (opts.steps && opts.steps.length) {
      const chips = opts.steps.map(s =>
        `<span class="chip coder-chip" title="${escapeHtml(s.result && s.result.text ? s.result.text.replace(/["'<>]/g, '') : '')}">${escapeHtml(s.tool.replace(/_/g, ' '))}</span>`
      ).join(' ');
      if (chips) steps = `<div class="mb-2 d-flex flex-wrap gap-1 align-items-center"><i class="bi bi-terminal me-1 small text-body-secondary"></i>${chips}</div>`;
    }
    bubble.innerHTML = label + steps + coderMarkdown(content);
  }
  row.appendChild(bubble);
  t.appendChild(row);
  scrollCoderBottom();
}

export function clearCodingTranscript() {
  if (!isBrowser) return;
  const t = coderEl('coderTranscript');
  if (t) t.innerHTML = '';
}

export function renderCodingExplorer(entries, dir = '.') {
  if (!isBrowser) return;
  const list = coderEl('coderExplorer');
  if (!list) return;
  list.innerHTML = '';
  const prefix = dir && dir !== '.' ? dir.replace(/\/+$/, '') + '/' : '';
  if (!entries.length) {
    const li = document.createElement('div');
    li.className = 'list-group-item small text-body-secondary';
    li.textContent = dir && dir !== '.' ? `${dir}/ is empty` : 'Empty workspace';
    list.appendChild(li);
    return;
  }
  for (const e of entries) {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'list-group-item list-group-item-action d-flex align-items-center gap-2 py-1 px-2 coder-file-row';
    const path = prefix + e.name;
    a.dataset.path = path;
    a.innerHTML = `<i class="bi ${e.kind === 'dir' ? 'bi-folder-fill text-warning' : 'bi-file-earmark-code text-primary'} flex-shrink-0"></i><span class="text-truncate small">${escapeHtml(e.name)}</span>${e.kind !== 'dir' && e.size != null ? `<span class="ms-auto small text-body-secondary">${fmtSize(e.size)}</span>` : ''}`;
    if (e.kind === 'dir') {
      a.addEventListener('click', ev => {
        ev.preventDefault();
        if (coderHandler && coderHandler.list) coderHandler.list(path);
      });
    } else {
      a.addEventListener('click', ev => {
        ev.preventDefault();
        const msg = `read open "${path}"`;
        sendCodingMessage(msg);
      });
    }
    list.appendChild(a);
  }
}

function fmtSize(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function registerCodingHandler(handler) {
  coderHandler = handler || null;
}

export function sendCodingMessage(text) {
  const input = coderEl('coderInput');
  const q = String(text == null ? '' : text).trim();
  if (!q || coderBusy) return;
  if (!coderHandler || coderHandler.run == null) return;
  appendCodingMessage('user', q);
  if (input) input.value = '';
  coderBusy = true;
  const send = coderEl('coderSendBtn');
  if (send) send.disabled = true;
  appendCodingMessage('assistant', '<span class="spinner-border spinner-border-sm me-2"></span>working…', { label: 'Coder', animate: false });
  Promise.resolve()
    .then(() => coderHandler.run(q))
    .then(res => {
      const t = coderEl('coderTranscript');
      if (t && t.lastElementChild && t.lastElementChild.textContent.includes('working')) t.lastElementChild.remove();
      if (!res || typeof res !== 'object') {
        appendCodingMessage('assistant', 'I did not get a useful reply. Try again?', { label: 'Coder' });
        return;
      }
      if (res.requireFolder) setCoderStatus('No folder connected — click <strong>Open folder</strong>.', 'warn');
      appendCodingMessage('assistant', res.response || res.ask || 'Done.', {
        label: 'Coder',
        steps: res.steps || []
      });
      if (res.steps && res.steps.some(s => s && s.tool && s.tool.includes('write'))) {
        setCoderStatus('Last change: a real file write in the granted folder (see the diff above).', 'ok');
      }
    })
    .catch(err => {
      const t = coderEl('coderTranscript');
      if (t && t.lastElementChild && t.lastElementChild.textContent.includes('working')) t.lastElementChild.remove();
      appendCodingMessage('assistant', `⚠️ The coding agent hit an error: ${err.message}`, { label: 'Coder' });
    })
    .finally(() => {
      coderBusy = false;
      const sendBtn = coderEl('coderSendBtn');
      if (sendBtn) sendBtn.disabled = false;
    });
}

export function initCodingPanel(handlers = {}) {
  if (!isBrowser) return;

  const openBtn = coderEl('coderOpenFolderBtn');
  if (openBtn && !openBtn.dataset.bound) {
    openBtn.dataset.bound = '1';
    openBtn.addEventListener('click', () => {
      if (handlers.openFolder) handlers.openFolder();
    });
  }

  const refreshBtn = coderEl('coderRefreshBtn');
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = '1';
    refreshBtn.addEventListener('click', () => {
      if (handlers.list) handlers.list('.');
    });
  }

  const clearBtn = coderEl('coderClearBtn');
  if (clearBtn && !clearBtn.dataset.bound) {
    clearBtn.dataset.bound = '1';
    clearBtn.addEventListener('click', () => clearCodingTranscript());
  }

  const form = coderEl('coderForm');
  if (form && !form.dataset.bound) {
    form.dataset.bound = '1';
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const input = coderEl('coderInput');
      sendCodingMessage(input ? input.value : '');
    });
  }
}

export function applyTheme() {
  if (!isBrowser) return;
  const dark = themeMode() === 'dark';
  const root = document.documentElement;
  root.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
  document.body.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
  const icon = document.getElementById('themeIcon');
  const label = document.getElementById('themeLabel');
  if (icon) icon.className = dark ? 'bi bi-sun-fill' : 'bi bi-moon-stars';
  if (label) label.textContent = dark ? 'Light Mode' : 'Dark Mode';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#111318' : (state.config?.app?.theme?.primary || '#4f46e5');
}

// ── Sidebar & tab navigation ────────────────────────────────────────────────
export function initTabNavigation() {
  if (!isBrowser) return;
  const chatTab = document.getElementById('tab-chat-btn');
  if (chatTab) {
    chatTab.addEventListener('shown.bs.tab', () => {
      const el = document.getElementById('chatMessages');
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
}

export function initSidebarResize() {
  if (!isBrowser) return;
  const handle = document.getElementById('resizeHandle');
  const sidebarEl = document.getElementById('sidebar');
  if (!handle || !sidebarEl) return;
  const uiCfg = () => state.config?.app?.ui?.sidebar || {};
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarEl.getBoundingClientRect().width;
    const onMove = (ev) => {
      const min = uiCfg().minWidth || 200;
      const max = uiCfg().maxWidth || 500;
      const w = Math.min(max, Math.max(min, startWidth + (ev.clientX - startX)));
      sidebarEl.style.width = w + 'px';
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (ev.type !== 'pointerup') return;
      const w = sidebarEl.getBoundingClientRect().width;
      configAPI.updateConfig('app.ui.sidebar', { ...uiCfg(), width: Math.round(w) }).catch(() => {});
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

async function toggleTheme() {
  const dark = themeMode() === 'dark';
  const next = dark ? 'light' : 'dark';
  try {
    await configAPI.updateConfig('app.theme', { ...(state.config?.app?.theme || {}), mode: next });
    applyTheme();
    showToast(next === 'dark' ? 'Dark mode on.' : 'Light mode on.', 'success');
  } catch (err) {
    showToast(err && err.message ? err.message : String(err), 'error');
  }
}

// ── Global control wiring (once) ────────────────────────────────────────────
let controlsWired = false;

export function initControls() {
  if (!isBrowser || controlsWired) return;
  controlsWired = true;

  // Sidebar interactions
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) themeToggle.addEventListener('click', toggleTheme);

  const voiceAutoToggle = document.getElementById('voiceAutoToggle');
  if (voiceAutoToggle) {
    voiceAutoToggle.addEventListener('click', async () => {
      try {
        const current = !!state.config?.app?.voice?.autoSpeak;
        await configAPI.updateConfig('app.voice', { ...(state.config?.app?.voice || {}), autoSpeak: !current });
        voiceAutoToggle.classList.toggle('active', !current);
        showToast(!current ? 'Read-aloud enabled — replies will be spoken.' : 'Read-aloud disabled.', 'success');
      } catch (err) {
        showToast(err.message || String(err), 'error');
      }
    });
  }

  // Microphone button
  const micBtn = document.getElementById('micBtn');
  if (micBtn) micBtn.addEventListener('click', toggleVoiceInput);

  // Clear conversation
  const clearChatBtn = document.getElementById('clearChatBtn');
  if (clearChatBtn) clearChatBtn.addEventListener('click', clearChatUI);

  // Character + business switch menus (event delegation, single listener)
  const charMenu = document.getElementById('charSwitchMenu');
  if (charMenu) {
    charMenu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-char-id]');
      if (item) switchCharacter(item.dataset.charId, { viaChat: true });
    });
  }
  const bizMenu = document.getElementById('bizSwitchMenu');
  if (bizMenu) {
    bizMenu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-biz-id]');
      if (item) switchBusiness(item.dataset.bizId);
    });
  }

  // Data Explorer
  const schemaSelect = document.getElementById('explorerSchemaSelect');
  if (schemaSelect) schemaSelect.addEventListener('change', () => renderExplorerTable(schemaSelect.value));
  const filterInput = document.getElementById('tableFilterInput');
  if (filterInput) filterInput.addEventListener('input', applyTableFilter);
  const tableBody = document.getElementById('explorerTableBody');
  if (tableBody) {
    tableBody.addEventListener('click', async (e) => {
      const editBtn = e.target.closest('[data-edit-record]');
      const delBtn = e.target.closest('[data-delete-record]');
      if (editBtn) {
        const r = await db.getRecordById(editBtn.dataset.editRecord);
        if (r) openRecordModal(r);
      } else if (delBtn) {
        const id = delBtn.dataset.deleteRecord;
        if (!confirm('Delete this record?')) return;
        await db.deleteRecord(id).catch(err => showToast(err && err.message ? err.message : String(err), 'error'));
        renderExplorerTable(currentSchema());
        showToast('Record deleted.', 'success');
      }
    });
  }
  const newSchemaBtn = document.getElementById('newSchemaBtn');
  if (newSchemaBtn) newSchemaBtn.addEventListener('click', () => {
    resetSchemaModal();
    openModal('schemaModal');
  });
  const editSchemaBtn = document.getElementById('editSchemaBtn');
  if (editSchemaBtn) editSchemaBtn.addEventListener('click', openEditSchemaModal);
  const deleteSchemaBtn = document.getElementById('deleteSchemaBtn');
  if (deleteSchemaBtn) deleteSchemaBtn.addEventListener('click', () => deleteSchemaFromExplorer(currentSchema()));
  const addRecordBtn = document.getElementById('addRecordBtn');
  if (addRecordBtn) addRecordBtn.addEventListener('click', () => openRecordModal());
  const exportDataBtn = document.getElementById('exportDataBtn');
  if (exportDataBtn) exportDataBtn.addEventListener('click', exportFlowData);
  const importDataBtn = document.getElementById('importDataBtn');
  if (importDataBtn) importDataBtn.addEventListener('click', () => document.getElementById('importDataInput')?.click());
  const importDataInput = document.getElementById('importDataInput');
  if (importDataInput) importDataInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importFlowData(file);
    e.target.value = '';
  });

  // Modals: characters & businesses
  const newCharacterBtn = document.getElementById('newCharacterBtn');
  if (newCharacterBtn) newCharacterBtn.addEventListener('click', () => openCharacterModal());
  const saveCharacterBtn = document.getElementById('saveCharacterBtn');
  if (saveCharacterBtn) saveCharacterBtn.addEventListener('click', saveCharacterFromModal);

  const newBusinessBtn = document.getElementById('newBusinessBtn');
  if (newBusinessBtn) newBusinessBtn.addEventListener('click', () => openBusinessModal());
  const saveBusinessBtn = document.getElementById('saveBusinessBtn');
  if (saveBusinessBtn) saveBusinessBtn.addEventListener('click', saveBusinessFromModal);

  const saveSchemaBtn = document.getElementById('saveSchemaBtn');
  if (saveSchemaBtn) saveSchemaBtn.addEventListener('click', saveSchemaFromModal);
  const saveRecordBtn = document.getElementById('saveRecordBtn');
  if (saveRecordBtn) saveRecordBtn.addEventListener('click', saveRecordFromModal);

  // Modal delete / preview / copy buttons
  const deleteCharacterBtn = document.getElementById('deleteCharacterBtn');
  if (deleteCharacterBtn) deleteCharacterBtn.addEventListener('click', () => {
    const id = document.getElementById('charEditIdInput')?.value;
    closeModal('characterModal');
    if (id) deleteCharacter(id);
  });
  const deleteBusinessBtn = document.getElementById('deleteBusinessBtn');
  if (deleteBusinessBtn) deleteBusinessBtn.addEventListener('click', () => {
    const id = document.getElementById('bizEditIdInput')?.value;
    closeModal('businessModal');
    if (id) deleteBusiness(id);
  });
  const deleteSchemaFromModalBtn = document.getElementById('deleteSchemaFromModalBtn');
  if (deleteSchemaFromModalBtn) deleteSchemaFromModalBtn.addEventListener('click', () => {
    const id = document.getElementById('schemaEditNameInput')?.value;
    closeModal('schemaModal');
    if (id) deleteSchemaFromExplorer(id);
  });
  const previewBtn = document.getElementById('charPreviewPromptBtn');
  if (previewBtn) previewBtn.addEventListener('click', () => previewPrompt(document.getElementById('charEditIdInput')?.value || state.activeCharacterId));
  const copyPromptBtn = document.getElementById('copyPromptBtn');
  if (copyPromptBtn) copyPromptBtn.addEventListener('click', () => {
    const el = document.getElementById('promptPreviewContent');
    if (el && navigator.clipboard) {
      navigator.clipboard.writeText(el.textContent || '').then(() => showToast('Prompt copied to clipboard.', 'success')).catch(() => showToast('Copy failed.', 'error'));
    }
  });

  // Config editor
  const saveConfigBtn = document.getElementById('saveConfigBtn');
  if (saveConfigBtn) saveConfigBtn.addEventListener('click', saveConfigFromEditor);
  const historyList = document.getElementById('configHistoryList');
  if (historyList) {
    historyList.addEventListener('click', async (e) => {
      const item = e.target && e.target.closest('[data-ts]');
      if (!item) return;
      e.preventDefault();
      if (!window.confirm('Roll back configuration to this point?')) return;
      try {
        await configAPI.rollback(item.dataset.ts);
        await configAPI.loadSavedConfig();
        renderExplorer();
        renderConfigIssues();
        applyTheme();
        showToast('Configuration rolled back.', 'success');
      } catch (err) {
        showToast(err && err.message ? err.message : String(err), 'error');
      }
    });
  }

  // Tools tab: extension toggles + tool/extension detail views (delegated)
  const toolsList = document.getElementById('toolsList');
  if (toolsList) {
    toolsList.addEventListener('change', (e) => {
      const toggle = e.target.closest('[data-ext-toggle]');
      if (toggle) toggleExtension(toggle.dataset.extToggle, toggle.checked);
    });
    toolsList.addEventListener('click', (e) => {
      const extBtn = e.target.closest('[data-ext-detail]');
      if (extBtn) {
        openExtensionDetail(extBtn.dataset.extDetail);
        return;
      }
      const toolBtn = e.target.closest('[data-tool-detail]');
      if (toolBtn) openToolDetail(toolBtn.dataset.toolDetail);
    });
  }

  // Documents: choose the "assistant's folder" for Word/Excel output
  const chooseFolderBtn = document.getElementById('chooseFolderBtn');
  if (chooseFolderBtn) {
    chooseFolderBtn.addEventListener('click', async () => {
      const name = await requestFolder();
      if (name) {
        showToast(`Assistant's folder set to "${name}".`, 'success');
        renderTools();
      }
    });
  }

  // Character / business list detail buttons (delegated)
  const charList = document.getElementById('characterList');
  if (charList) {
    charList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-character-detail]');
      if (btn) openCharacterDetail(btn.dataset.characterDetail);
    });
  }
  const bizList = document.getElementById('businessList');
  if (bizList) {
    bizList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-business-detail]');
      if (btn) openBusinessDetail(btn.dataset.businessDetail);
    });
  }

  // Schema detail
  const schemaDetailBtn = document.getElementById('schemaDetailBtn');
  if (schemaDetailBtn) schemaDetailBtn.addEventListener('click', () => openSchemaDetail());

  // Detail modal footer actions (delegated, so re-renders stay wired)
  document.addEventListener('click', (e) => {
    const charAction = e.target.closest('[data-char-action]');
    if (charAction) {
      handleCharacterDetailAction(charAction.dataset.charAction, detailCharId);
      return;
    }
    const bizAction = e.target.closest('[data-biz-action]');
    if (bizAction) {
      handleBusinessDetailAction(bizAction.dataset.bizAction, detailBizId);
      return;
    }
    const schemaAction = e.target.closest('[data-schema-action]');
    if (schemaAction) handleSchemaDetailAction(schemaAction.dataset.schemaAction);
    const modelAction = e.target.closest('[data-model-action]');
    if (modelAction) handleModelDetailAction(modelAction.dataset.modelAction);
  });

  setupJumpToLatestBtn();
  populateSwitchMenus();
  updateHeaderUI();
}

async function saveConfigFromEditor() {
  const editor = document.getElementById('configEditor');
  if (!editor) return;
  let parsed;
  try {
    parsed = JSON.parse(editor.value);
  } catch (err) {
    showToast('Invalid JSON: ' + err.message, 'error');
    return;
  }
  const res = await configAPI.importConfig(JSON.stringify(parsed));
  if (res && res.success) {
    state.configIssues = (await import('../core/config.js')).collectConfigIssues(state.config);
    renderExplorer();
    renderConfigIssues();
    applyTheme();
    showToast('Configuration saved.', 'success');
  } else {
    showToast('Config import failed: ' + ((res && res.error) || 'invalid file'), 'error');
  }
}

// ── Modal helpers ───────────────────────────────────────────────────────────
function openModal(id) {
  if (isBrowser && typeof bootstrap !== 'undefined') {
    const modal = document.getElementById(id);
    if (modal) bootstrap.Modal.getOrCreateInstance(modal).show();
  }
}

function closeModal(id) {
  if (isBrowser && typeof bootstrap !== 'undefined') {
    const modal = document.getElementById(id);
    if (modal) bootstrap.Modal.getOrCreateInstance(modal).hide();
  }
}

function slugify(text) {
  return String(text || '').toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseSchemaFields(raw) {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed);
    const fields = {};
    for (const [k, v] of Object.entries(obj)) fields[k] = valueKey(trimmed, k);
    return { fields, vectorize: Object.keys(fields).slice(0, 2) };
  }
  const fields = {};
  const vectorize = [];
  trimmed.split(',').forEach(part => {
    const [name, type] = part.split(':').map(s => s.trim());
    if (!name) return;
    fields[name] = (type || 'string');
    if (vectorize.length < 2) vectorize.push(name);
  });
  return { fields, vectorize };
}

function saveSchemaFromModal() {
  const name = document.getElementById('schemaNameInput')?.value?.toLowerCase().trim();
  const raw = document.getElementById('schemaFieldsInput')?.value || '';
  const editName = document.getElementById('schemaEditNameInput')?.value || '';
  if (!name) { showToast('Schema name is required.', 'error'); return; }
  let schemaDef;
  try {
    schemaDef = parseSchemaFields(raw) || { fields: { title: 'string', description: 'string', category: 'string' }, vectorize: ['title', 'description'] };
  } catch (err) {
    showToast('Could not parse fields: ' + err.message, 'error');
    return;
  }
  const done = () => {
    closeModal('schemaModal');
    renderExplorerSchemas();
    renderConfigEditor();
    showToast(editName ? `Schema "${editName}" updated.` : `Schema "${name}" created.`, 'success');
  };
  if (editName && editName !== name) {
    // Rename: create new schema, copy records is out of scope; update fields, drop old key.
    configAPI.deleteSchema(state.activeBusinessId, editName)
      .then(() => configAPI.addSchema(state.activeBusinessId, name, schemaDef))
      .then(done)
      .catch(err => showToast(err && err.message ? err.message : String(err), 'error'));
  } else if (editName) {
    configAPI.updateSchema(state.activeBusinessId, editName, schemaDef)
      .then(done)
      .catch(err => showToast(err && err.message ? err.message : String(err), 'error'));
  } else {
    configAPI.addSchema(state.activeBusinessId, name, schemaDef)
      .then(done)
      .catch(err => showToast(err && err.message ? err.message : String(err), 'error'));
  }
}

let recordEditId = null;

function openRecordModal(record = null) {
  const schema = currentSchema();
  if (!schema) { showToast('Create a schema first.', 'error'); return; }
  const biz = state.config?.businesses?.find(b => b.id === state.activeBusinessId);
  const schemaDef = biz?.schemas?.[schema];
  const fields = schemaDef ? (schemaDef.vectorize || Object.keys(schemaDef.fields || {})) : [];

  const titleEl = document.getElementById('recordModalTitle');
  const bodyEl = document.getElementById('recordModalBody');
  if (!titleEl || !bodyEl) return;
  recordEditId = record ? record.id : null;
  titleEl.textContent = record ? `Edit Record — ${schema}` : `Add Record — ${schema}`;
  if (!fields.length) {
    bodyEl.innerHTML = '<div class="text-muted">This schema has no visible fields.</div>';
  } else {
    bodyEl.innerHTML = fields.map(f => {
      const fieldType = String(biz?.schemas?.[schema]?.fields?.[f] || 'string');
      const current = record ? record.data?.[f] ?? '' : '';
      const inputType = fieldType === 'number' ? 'type="number"' : fieldType === 'boolean' ? 'type="checkbox"' : '';
      const valueAttr = fieldType === 'boolean'
        ? (current ? 'checked' : '')
        : `value="${escapeHtml(String(current))}"`;
      return `
      <div>
        <label class="form-label small fw-semibold">${escapeHtml(f)}</label>
        <input class="form-control" data-record-field="${escapeHtml(f)}" ${inputType} ${valueAttr}>
      </div>`;
    }).join('');
  }
  openModal('recordModal');
}

function saveRecordFromModal() {
  const schema = currentSchema();
  if (!schema) { closeModal('recordModal'); return; }
  const data = {};
  document.querySelectorAll('#recordModalBody [data-record-field]').forEach(el => {
    const name = el.dataset.recordField;
    let val = el.value;
    if (el.type === 'number') val = val === '' ? null : Number(val);
    if (el.type === 'checkbox') val = el.checked;
    data[name] = val;
  });
  const btn = document.getElementById('saveRecordBtn');
  if (btn) btn.disabled = true;
  const wasEdit = !!recordEditId;
  const done = (embedding, warn) => {
    const action = wasEdit
      ? db.updateRecord(recordEditId, data, embedding || null)
      : db.addRecord(state.activeBusinessId, schema, data, embedding || null);
    action
      .then(() => {
        closeModal('recordModal');
        recordEditId = null;
        renderExplorerTable(schema);
        if (warn) showToast(`${wasEdit ? 'Record updated' : 'Record added'} (embedding skipped: ${warn}).`, 'error');
        else showToast(wasEdit ? 'Record updated.' : 'Record added.', 'success');
      })
      .catch(err => showToast(err && err.message ? err.message : String(err), 'error'))
      .finally(() => { if (btn) btn.disabled = false; });
  };
  // Lazy semantic embedding; never blocks saving a record.
  import('./models.js').then(M => {
    M.embedText(JSON.stringify(data)).then(emb => done(emb)).catch(err => done(null, err && err.message ? err.message : 'embedder unavailable'));
  }).catch(() => done(null, 'embeddings unavailable'));
}

function saveCharacterFromModal() {
  const name = document.getElementById('charNameInput')?.value?.trim();
  if (!name) { showToast('Character name is required.', 'error'); return; }
  const editId = document.getElementById('charEditIdInput')?.value || '';
  const character = {
    id: document.getElementById('charIdInput')?.value?.trim() || slugify(name),
    name,
    persona: document.getElementById('charPersonaInput')?.value?.trim() || 'Workspace Assistant',
    systemPrompt: document.getElementById('charPromptInput')?.value?.trim() || `You are ${name}.`,
    color: document.getElementById('charColorInput')?.value || '#6366f1',
    avatar: document.getElementById('charAvatarInput')?.value?.trim() || '🤖',
    specialization: (document.getElementById('charSpecInput')?.value || '').split(',').map(s => s.trim()).filter(Boolean)
  };
  const action = editId
    ? configAPI.updateCharacter(editId, character)
    : configAPI.addCharacter(character);
  action.then(() => {
    closeModal('characterModal');
    renderCharacters();
    populateSwitchMenus();
    updateHeaderUI();
    renderConfigEditor();
    showToast(editId ? `Character "${name}" updated.` : `Character "${name}" added.`, 'success');
  }).catch(err => showToast(err && err.message ? err.message : String(err), 'error'));
}

function saveBusinessFromModal() {
  const name = document.getElementById('bizNameInput')?.value?.trim();
  if (!name) { showToast('Workspace name is required.', 'error'); return; }
  const editId = document.getElementById('bizEditIdInput')?.value || '';
  const action = editId
    ? configAPI.editBusiness(editId, { name })
    : configAPI.addBusiness({
        id: document.getElementById('bizIdInput')?.value?.trim() || slugify(name),
        name
      });
  action.then(() => {
    closeModal('businessModal');
    renderBusinesses();
    populateSwitchMenus();
    updateHeaderUI();
    renderConfigEditor();
    showToast(editId ? `Workspace "${name}" updated.` : `Workspace "${name}" created.`, 'success');
  }).catch(err => showToast(err && err.message ? err.message : String(err), 'error'));
}

// ── Top-level render ────────────────────────────────────────────────────────
export function renderExplorer() {
  renderExplorerSchemas();
  renderTools();
  renderCharacters();
  renderBusinesses();
  renderQuickPrompts();
  renderConfigEditor();
  populateModelSelects();
  populateSwitchMenus();
  updateHeaderUI();
}