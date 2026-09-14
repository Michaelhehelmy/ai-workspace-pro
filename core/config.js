/**
 * core/config.js - Configuration Management Layer
 * State-driven ConfigAPI bound to the shared `state` singleton
 */

import { workspaceDB } from './db.js';
import { state } from './state.js';

// Bumped whenever the representation of persisted configuration changes in a
// way that makes old stored configs incompatible. version 3 = fully dynamic
// model catalog: no hardcoded model ids, stage targets, or sizes are shipped.
export const CONFIG_SCHEMA_VERSION = 3;

export const CONFIG_SCHEMA = {
  type: 'object',
  required: ['app', 'quickPrompts', 'categories', 'characters', 'businesses', 'tools', 'modelSettings'],
  properties: {
    app: {
      type: 'object',
      required: ['name', 'version', 'defaultCharacter', 'defaultBusiness'],
      properties: {
        name: { type: 'string', minLength: 1 },
        subtitle: { type: 'string' },
        version: { type: 'string' },
        schemaVersion: { type: 'integer' },
        defaultCharacter: { type: 'string' },
        defaultBusiness: { type: 'string' },
        ai: {
          type: 'object',
          properties: {
            backends: {
              type: 'object',
              properties: {
                llamacpp: { type: 'object', properties: { url: { type: 'string' }, enabled: { type: 'boolean' } } },
                ollama:   { type: 'object', properties: { url: { type: 'string' }, enabled: { type: 'boolean' } } }
              }
            },
            routing: {
              type: 'object',
              properties: {
                dialog:   { type: 'string' },
                embedder: { type: 'string' }
              }
            }
          }
        }
      }
    },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'persona', 'systemPrompt']
      }
    },
    businesses: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'schemas']
      }
    },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'type', 'description']
      }
    },
    modelSettings: {
      type: 'object',
      required: ['embedder', 'classifier', 'generator']
    }
  }
};

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Config must be a valid JSON object');
  }
  if (!config.app || typeof config.app !== 'object') {
    throw new Error('Config missing required "app" configuration');
  }
  if (!config.app.name || typeof config.app.name !== 'string') {
    throw new Error('Config missing required string "app.name"');
  }

  if (!config.app.voice) config.app.voice = { autoSpeak: false, lang: 'en-US' };
  if (typeof config.app.voice.autoSpeak !== 'boolean') config.app.voice.autoSpeak = false;
  if (typeof config.app.voice.lang !== 'string') config.app.voice.lang = 'en-US';

  if (!config.app.theme) config.app.theme = { mode: 'dark' };
  if (!config.app.theme.mode) config.app.theme.mode = 'dark';

  if (!config.app.ui) config.app.ui = { sidebar: { minWidth: 200, maxWidth: 500 }, chartColors: [] };
  if (!config.app.google) config.app.google = { clientId: '', scopes: [] };

  if (!config.app.ai) config.app.ai = {};
  if (!config.app.ai.backends) config.app.ai.backends = {};
  if (!config.app.ai.backends.llamacpp) config.app.ai.backends.llamacpp = { url: 'http://localhost:8080/v1', enabled: false };
  if (!config.app.ai.backends.llamacpp.url) config.app.ai.backends.llamacpp.url = 'http://localhost:8080/v1';
  if (typeof config.app.ai.backends.llamacpp.enabled !== 'boolean') config.app.ai.backends.llamacpp.enabled = false;
  if (!config.app.ai.backends.ollama) config.app.ai.backends.ollama = { url: 'http://localhost:11434', enabled: false };
  if (!config.app.ai.backends.ollama.url) config.app.ai.backends.ollama.url = 'http://localhost:11434';
  if (typeof config.app.ai.backends.ollama.enabled !== 'boolean') config.app.ai.backends.ollama.enabled = false;
  if (!config.app.ai.routing) config.app.ai.routing = {};
  if (typeof config.app.ai.routing.dialog !== 'string') config.app.ai.routing.dialog = 'auto';
  if (typeof config.app.ai.routing.embedder !== 'string') config.app.ai.routing.embedder = 'auto';

  if (!Array.isArray(config.businesses) || config.businesses.length === 0) {
    throw new Error('Config must contain at least one business definition');
  }
  for (let i = 0; i < config.businesses.length; i++) {
    const b = config.businesses[i];
    if (!b.id || !b.name) {
      throw new Error(`Business at index ${i} must have "id" and "name"`);
    }
    if (!b.schemas || typeof b.schemas !== 'object') b.schemas = {};
    for (const [schemaName, schema] of Object.entries(b.schemas)) {
      if (!schema.fields || typeof schema.fields !== 'object') {
        schema.fields = { title: 'string', description: 'string' };
      }
      if (!schema.vectorize || !Array.isArray(schema.vectorize)) {
        schema.vectorize = Object.keys(schema.fields).filter(k => schema.fields[k] === 'string');
      }
    }
  }

  if (!Array.isArray(config.characters) || config.characters.length === 0) {
    throw new Error('Config must contain at least one character definition');
  }
  for (let i = 0; i < config.characters.length; i++) {
    const c = config.characters[i];
    if (!c.id || !c.name) {
      throw new Error(`Character at index ${i} must have "id" and "name"`);
    }
    c.emotions = c.emotions || { neutral: '🤖', thinking: '🤔', happy: '😊', error: '⚠️' };
    c.specialization = c.specialization || ['general'];
  }

  if (!Array.isArray(config.tools)) {
    throw new Error('Config must contain a "tools" array');
  }

  if (!config.modelSettings || typeof config.modelSettings !== 'object') {
    throw new Error('Config must contain a "modelSettings" object');
  }
  if (!Array.isArray(config.modelSettings.availableModels)) {
    config.modelSettings.availableModels = [];
  }
  return true;
}

/**
 * One-time migration for configs persisted before the fully-dynamic catalog
 * (schemaVersion < current). Those saved configs embedded the old hardcoded
 * model table — ids, sizes, helper assignments, and default stage targets —
 * which unionModels would otherwise resurrect into a "still has hardcoded
 * models" frontend forever. Wipe the whole model subsystem back to the dynamic
 * empty state (catalog [], helpers null, stage models null) and stamp the
 * current version so it only ever runs once. Returns true when it migrated.
 */
export function migrateLegacyModelCatalog(disk, saved) {
  const version = Number((disk && disk.app && disk.app.schemaVersion) || 0);
  const savedVersion = Number((saved && saved.app && saved.app.schemaVersion) || 0);
  if (!saved || typeof saved !== 'object' || !version || savedVersion >= version) return false;
  const ms = saved.modelSettings || (saved.modelSettings = {});
  ms.availableModels = [];
  ms.embedder = null;
  ms.classifier = null;
  ms.generator = null;
  const stages = Array.isArray(ms.pipeline)
    ? ms.pipeline
    : (ms.pipeline && Array.isArray(ms.pipeline.stages) ? ms.pipeline.stages : []);
  for (const s of stages) if (s && typeof s === 'object') s.model = null;
  if (!saved.app || typeof saved.app !== 'object') saved.app = {};
  saved.app.schemaVersion = version;
  return true;
}

// ── Strict secrets / model audit ─────────────────────────────────────────────
const PLACEHOLDER_RE = /^(YOUR_|CHANGE_ME|CHANGEME|INSERT_|REPLACE_|TODO|TOKEN_|API_KEY|ILLEGAL_)/i;

// Configuration subtrees that must never be handed to the AI tools (get_config /
// update_config). They hold OAuth and credential material — environment-injected,
// not model-editable.
const PROTECTED_PATHS = ['app.google'];
const SECRET_KEY_RE = /(clientid|secret|token|api[_ ]?key|password|private)/i;

export function isPlaceholder(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  if (!s) return false;
  if (PLACEHOLDER_RE.test(s)) return true;
  if (/^<[a-z0-9_ -]+>$/i.test(s)) return true;
  return false;
}

/**
 * Audit a config for the things that must never ship or silently fail:
 * structural validity, real model ids, and real OAuth secrets. Returns an
 * array of `{ path, code, message, fix }` issues (empty when all good).
 * Issue codes: E_CONFIG, E_MODEL_MISSING, E_SECRET_MISSING, E_SECRET_PLACEHOLDER.
 */
export function collectConfigIssues(config) {
  const issues = [];

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    issues.push({ path: '$', code: 'E_CONFIG', message: 'Configuration must be a JSON object.', fix: 'Provide a valid config.json, or inject one via AIWS_CONFIG_JSON / AIWS_CONFIG_FILE.' });
    return issues;
  }

  try {
    validateConfig(config);
  } catch (err) {
    issues.push({ path: '$', code: 'E_CONFIG', message: err.message, fix: 'Fix the reported field, or inject a valid configuration at runtime.' });
  }

  const ms = config.modelSettings;
  if (!ms || typeof ms !== 'object') {
    issues.push({ path: 'modelSettings', code: 'E_MODEL_MISSING', message: 'modelSettings is missing — no AI models configured.', fix: 'Add modelSettings.embedder/classifier/generator and modelSettings.pipeline.stages with real model ids.' });
  } else {
    for (const key of ['embedder', 'classifier', 'generator']) {
      const v = ms[key];
      if (!v || !String(v).trim()) {
        issues.push({ path: `modelSettings.${key}`, code: 'E_MODEL_MISSING', message: `No model id configured for "${key}".`, fix: `Set modelSettings.${key} to a Hugging Face model id (e.g. Xenova/all-MiniLM-L6-v2).` });
      } else if (isPlaceholder(v)) {
        issues.push({ path: `modelSettings.${key}`, code: 'E_MODEL_MISSING', message: `"${key}" model id is a placeholder, not a real model.`, fix: 'Replace it with a real Hugging Face model id.' });
      }
    }
    const stages = ms.pipeline && Array.isArray(ms.pipeline.stages) ? ms.pipeline.stages : null;
    if (!stages || !stages.length) {
      issues.push({ path: 'modelSettings.pipeline.stages', code: 'E_MODEL_MISSING', message: 'No pipeline stages defined.', fix: 'List encoder/intent/tagger/dialog stages with real model ids.' });
    } else {
      for (let i = 0; i < stages.length; i++) {
        const st = stages[i];
        if (!st || !st.key) {
          issues.push({ path: `modelSettings.pipeline.stages[${i}]`, code: 'E_MODEL_MISSING', message: 'A pipeline stage is missing its "key".', fix: 'Each stage needs a key (encoder/intent/tagger/dialog) and a model id.' });
        } else if (st.model && isPlaceholder(st.model)) {
          issues.push({ path: `modelSettings.pipeline.stages[${i}].model`, code: 'E_MODEL_MISSING', message: `Stage "${st.key}" uses a placeholder model id.`, fix: 'Set a real Hugging Face model id for this stage.' });
        }
      }
    }
  }

  const google = config.app && config.app.google;
  const clientId = google ? google.clientId : null;
  if (!clientId || !String(clientId).trim()) {
    issues.push({ path: 'app.google.clientId', code: 'E_SECRET_MISSING', message: 'Google OAuth client id is not configured.', fix: 'Set GOOGLE_CLIENT_ID (env) or app.google.clientId so Drive/Sheets/Calendar can connect.' });
  } else if (isPlaceholder(clientId)) {
    issues.push({ path: 'app.google.clientId', code: 'E_SECRET_PLACEHOLDER', message: `Google OAuth client id looks like a placeholder ("${String(clientId).slice(0, 32)}...").`, fix: 'Provide a real OAuth client id via GOOGLE_CLIENT_ID (env) or app.google.clientId.' });
  }

  return issues;
}

// ── Runtime overrides (secrets & per-deployment config, injected, not committed) ──
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, source) {
  for (const key of Object.keys(source || {})) {
    const src = source[key];
    const tgt = target[key];
    if (isPlainObject(src) && isPlainObject(tgt)) {
      deepMerge(tgt, src);
    } else {
      target[key] = src; // arrays and scalars are replaced outright, never merged
    }
  }
  return target;
}

/**
 * Apply server/injected overrides on top of the shipped config, deepest last:
 *   window.__APP_CONFIG__  (browser: config JSON injected into index.html)
 *   AIWS_CONFIG_JSON       (Node env: raw JSON string)
 *   AIWS_CONFIG_FILE       (Node env: path to a JSON config file)
 *   GOOGLE_CLIENT_ID       (Node env: plain string, always wins for OAuth)
 * Returns the merged config object (mutates `config` in place).
 */
export async function applyRuntimeOverrides(config) {
  const cfg = isPlainObject(config) ? config : {};
  const sources = [];

  if (typeof window !== 'undefined' && isPlainObject(window.__APP_CONFIG__)) {
    sources.push(window.__APP_CONFIG__);
  }

  const env = (typeof process !== 'undefined' && process.env) || {};
  if (env.AIWS_CONFIG_JSON) {
    try { sources.push(JSON.parse(env.AIWS_CONFIG_JSON)); } catch (_) {}
  }
  if (env.AIWS_CONFIG_FILE) {
    try {
      const { readFile } = await import('node:fs/promises');
      sources.push(JSON.parse(await readFile(env.AIWS_CONFIG_FILE, 'utf8')));
    } catch (_) {}
  }

  for (const src of sources) {
    if (isPlainObject(src)) deepMerge(cfg, src);
  }

  if (env.GOOGLE_CLIENT_ID) {
    if (!isPlainObject(cfg.app)) cfg.app = {};
    if (!isPlainObject(cfg.app.google)) cfg.app.google = {};
    cfg.app.google.clientId = env.GOOGLE_CLIENT_ID;
  }

  return cfg;
}

export class ConfigAPI {
  constructor(db, stateInstance) {
    this.db = db;
    this.state = stateInstance;
  }

  getAppInfo() {
    return this.state.config?.app || {};
  }

  getCharacters() {
    return this.state.config?.characters || [];
  }

  getBusinesses() {
    return this.state.config?.businesses || [];
  }

  getTools() {
    return this.state.config?.tools || [];
  }

  getSchemas(businessId) {
    const biz = (this.state.config?.businesses || []).find(b => b.id === businessId);
    return biz?.schemas || {};
  }

  isProtectedPath(keys) {
    return PROTECTED_PATHS.some(p => {
      const pk = p.split('.');
      return pk.every((k, i) => keys[i] === k);
    });
  }

  // Deep-copy a value, masking anything that smells like a secret so AI-facing
  // reads (get_config) never leak OAuth/credential material into model prompts.
  redactValue(value, key = '') {
    if (SECRET_KEY_RE.test(key)) return '[redacted]';
    if (Array.isArray(value)) return value.map((v, i) => this.redactValue(v, String(i)));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactValue(v, k);
      return out;
    }
    return value;
  }

  async getConfig(path) {
    if (!this.state.config) return null;
    if (!path) return this.redactValue(this.state.config);
    const keys = path.split('.');
    if (this.isProtectedPath(keys)) return { redacted: true };
    let target = this.state.config;
    for (const key of keys) {
      if (target === undefined || target === null || !(key in target)) return undefined;
      target = target[key];
    }
    return this.redactValue(target, keys[keys.length - 1]);
  }

  async updateConfig(path, value) {
    if (!path) throw new Error('Path must be specified');
    const keys = path.split('.');
    if (this.isProtectedPath(keys)) {
      throw new Error(`Configuration path "${path}" is protected and cannot be modified via update_config`);
    }
    let target = this.state.config;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in target) || typeof target[k] !== 'object') {
        target[k] = {};
      }
      target = target[k];
    }

    const lastKey = keys[keys.length - 1];
    const oldValue = target[lastKey];
    target[lastKey] = value;

    validateConfig(this.state.config);

    await this.logConfigChange('update', path, oldValue, value);
    await this.db.setKV('app_config', this.state.config);

    return { success: true, path, oldValue, newValue: value };
  }

  async addCharacter(character) {
    if (!character || !character.id || !character.name) {
      throw new Error('Character must have id and name');
    }
    const exists = this.state.config.characters.find(c => c.id === character.id);
    if (exists) {
      throw new Error(`Character with id "${character.id}" already exists`);
    }

    const charObj = {
      id: character.id,
      name: character.name,
      persona: character.persona || 'Workspace Assistant',
      systemPrompt: character.systemPrompt || `You are ${character.name}.`,
      color: character.color || '#4f46e5',
      specialization: character.specialization || ['general'],
      emotions: character.emotions || { neutral: '🤖', thinking: '🤔', happy: '😊', error: '⚠️' },
      voicePitch: character.voicePitch !== undefined ? Number(character.voicePitch) : 1.0,
      voiceRate: character.voiceRate !== undefined ? Number(character.voiceRate) : 1.0
    };

    this.state.config.characters.push(charObj);
    await this.logConfigChange('add_character', charObj.id, null, charObj);
    await this.db.setKV('app_config', this.state.config);
    return { success: true, character: charObj.name };
  }

  async updateCharacter(characterId, updates) {
    const idx = this.state.config.characters.findIndex(c => c.id === characterId);
    if (idx === -1) throw new Error(`Character "${characterId}" not found`);

    const oldChar = { ...this.state.config.characters[idx] };
    this.state.config.characters[idx] = { ...oldChar, ...updates };

    await this.logConfigChange('update_character', characterId, oldChar, this.state.config.characters[idx]);
    await this.db.setKV('app_config', this.state.config);
    return { success: true, character: characterId };
  }

  async deleteCharacter(characterId) {
    if (this.state.config.characters.length <= 1) {
      throw new Error('Cannot delete the only remaining character');
    }
    const idx = this.state.config.characters.findIndex(c => c.id === characterId);
    if (idx === -1) throw new Error(`Character "${characterId}" not found`);

    const deleted = this.state.config.characters.splice(idx, 1)[0];
    if (this.state.activeCharacterId === characterId) {
      this.state.activeCharacterId = this.state.config.characters[0].id;
    }
    await this.logConfigChange('delete_character', characterId, deleted, null);
    await this.db.setKV('app_config', this.state.config);
    return { success: true, characterId };
  }

  async addBusiness(business) {
    if (!business || !business.id || !business.name) {
      throw new Error('Business must have id and name');
    }
    const exists = this.state.config.businesses.find(b => b.id === business.id);
    if (exists) {
      throw new Error(`Business with id "${business.id}" already exists`);
    }

    const bizObj = {
      id: business.id,
      name: business.name,
      schemas: business.schemas || {
        transactions: {
          fields: { type: 'string', amount: 'number', category: 'string', description: 'string', date: 'string' },
          vectorize: ['description', 'category']
        },
        todos: {
          fields: { task: 'string', due_date: 'string', priority: 'string', status: 'string' },
          vectorize: ['task']
        }
      }
    };

    this.state.config.businesses.push(bizObj);
    await this.logConfigChange('add_business', bizObj.id, null, bizObj);
    await this.db.setKV('app_config', this.state.config);
    return { success: true, business: bizObj.name };
  }

  async addSchema(businessId, schemaName, schemaDef) {
    const biz = this.state.config.businesses.find(b => b.id === businessId);
    if (!biz) throw new Error(`Business "${businessId}" not found`);
    if (!biz.schemas) biz.schemas = {};
    const norm = (schemaName || '').toLowerCase().trim();
    if (!norm) throw new Error('Schema name must be specified');
    if (biz.schemas[norm]) {
      throw new Error(`Schema "${norm}" already exists in business "${businessId}"`);
    }
    biz.schemas[norm] = schemaDef;

    await this.logConfigChange('add_schema', `${businessId}.${norm}`, null, schemaDef);
    await this.db.setKV('app_config', this.state.config);
    return { success: true, schemaName: norm };
  }

  async updateSchema(businessId, schemaName, schemaDef) {
    const biz = this.state.config.businesses.find(b => b.id === businessId);
    if (!biz) throw new Error(`Business "${businessId}" not found`);
    if (!biz.schemas) biz.schemas = {};
    const norm = (schemaName || '').toLowerCase().trim();
    if (!biz.schemas[norm]) {
      throw new Error(`Schema "${norm}" not found in business "${businessId}"`);
    }
    const oldDef = biz.schemas[norm];
    biz.schemas[norm] = { ...oldDef, ...schemaDef };

    await this.logConfigChange('update_schema', `${businessId}.${norm}`, oldDef, biz.schemas[norm]);
    await this.db.setKV('app_config', this.state.config);
    return { success: true, schemaName: norm };
  }

  async deleteSchema(businessId, schemaName) {
    const biz = this.state.config.businesses.find(b => b.id === businessId);
    if (!biz) throw new Error(`Business "${businessId}" not found`);
    if (!biz.schemas) biz.schemas = {};
    const norm = (schemaName || '').toLowerCase().trim();
    if (!biz.schemas[norm]) {
      throw new Error(`Schema "${norm}" not found in business "${businessId}"`);
    }
    const deleted = biz.schemas[norm];
    delete biz.schemas[norm];

    await this.logConfigChange('delete_schema', `${businessId}.${norm}`, deleted, null);
    await this.db.setKV('app_config', this.state.config);
    return { success: true, schemaName: norm };
  }

  async editBusiness(businessId, updates) {
    const idx = this.state.config.businesses.findIndex(b => b.id === businessId);
    if (idx === -1) throw new Error(`Business "${businessId}" not found`);
    const oldBiz = { ...this.state.config.businesses[idx] };
    if (updates.id && updates.id !== businessId) {
      throw new Error('Business id cannot be changed');
    }
    this.state.config.businesses[idx] = { ...oldBiz, ...updates, id: businessId };

    await this.logConfigChange('update_business', businessId, oldBiz, this.state.config.businesses[idx]);
    await this.db.setKV('app_config', this.state.config);
    return { success: true, business: businessId };
  }

  async deleteBusiness(businessId) {
    if (this.state.config.businesses.length <= 1) {
      throw new Error('Cannot delete the only remaining workspace');
    }
    const idx = this.state.config.businesses.findIndex(b => b.id === businessId);
    if (idx === -1) throw new Error(`Business "${businessId}" not found`);

    const deleted = this.state.config.businesses.splice(idx, 1)[0];
    if (this.state.activeBusinessId === businessId) {
      this.state.activeBusinessId = this.state.config.businesses[0].id;
    }
    // Remove associated records and chat from the workspace DB.
    try {
      await this.db.deleteRecordsByBusiness?.(businessId);
      await this.db.clearChat?.(businessId);
    } catch { /* best-effort cleanup */ }

    await this.logConfigChange('delete_business', businessId, deleted, null);
    await this.db.setKV('app_config', this.state.config);
    return { success: true, businessId };
  }

  async addTool(tool) {
    if (!tool || !tool.name || !tool.type) {
      throw new Error('Tool must have name and type');
    }
    const existing = this.state.config.tools.find(t => t.name === tool.name);
    if (existing) {
      throw new Error(`Tool "${tool.name}" already exists`);
    }
    this.state.config.tools.push(tool);
    await this.logConfigChange('add_tool', tool.name, null, tool);
    await this.db.setKV('app_config', this.state.config);
    return { success: true, tool: tool.name };
  }

  async logConfigChange(action, target, oldValue, newValue) {
    const history = (await this.db.getKV('config_history')) || [];
    history.push({
      id: 'cfg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
      timestamp: Date.now(),
      action,
      target,
      oldValue: oldValue ? JSON.parse(JSON.stringify(oldValue)) : null,
      newValue: newValue ? JSON.parse(JSON.stringify(newValue)) : null,
      configSnapshot: JSON.parse(JSON.stringify(this.state.config))
    });
    if (history.length > 50) history.shift();
    await this.db.setKV('config_history', history);
  }

  async getHistory(limit = 20) {
    const history = (await this.db.getKV('config_history')) || [];
    return history.slice(-limit).reverse();
  }

  async rollback(historyId) {
    const history = (await this.db.getKV('config_history')) || [];
    const entry = history.find(h => h.id === historyId || h.timestamp === Number(historyId));
    if (!entry) {
      throw new Error(`No config change found with id/timestamp ${historyId}`);
    }
    this.state.config = JSON.parse(JSON.stringify(entry.configSnapshot));
    await this.db.setKV('app_config', this.state.config);
    return { success: true, rolledBackTo: new Date(entry.timestamp).toISOString() };
  }

  async loadSavedConfig() {
    const saved = await this.db.getKV('app_config');
    if (saved) {
      validateConfig(saved);
      this.state.config = saved;
      return { success: true, loaded: true };
    }
    return { success: true, loaded: false };
  }

  async persistConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('A config object is required to persist');
    }
    this.state.config = config;
    await this.db.setKV('app_config', config);
    return { success: true };
  }

  async exportConfig() {
    return JSON.stringify(this.state.config, null, 2);
  }

  async importConfig(jsonString) {
    try {
      const config = JSON.parse(jsonString);
      validateConfig(config);
      this.state.config = config;
      await this.db.setKV('app_config', this.state.config);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async resetConfig() {
    this.state.config = null;
    await this.db.deleteKV('app_config');
    return { success: true };
  }
}

// Export singleton instance bound to shared state
export const configAPI = new ConfigAPI(workspaceDB, state);