/**
 * core/config.js - Configuration Management Layer
 * State-driven ConfigAPI bound to the shared `state` singleton
 */

import { workspaceDB } from './db.js';
import { state } from './state.js';

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
        defaultCharacter: { type: 'string' },
        defaultBusiness: { type: 'string' }
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

  if (!config.app.theme) config.app.theme = { mode: 'light' };
  if (!config.app.theme.mode) config.app.theme.mode = 'light';

  if (!config.app.ui) config.app.ui = { sidebar: { minWidth: 200, maxWidth: 500 }, chartColors: [] };
  if (!config.app.google) config.app.google = { clientId: '', scopes: [] };

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

  async getConfig(path) {
    if (!this.state.config) return null;
    if (!path) return this.state.config;
    const keys = path.split('.');
    let target = this.state.config;
    for (const key of keys) {
      if (target === undefined || target === null || !(key in target)) return undefined;
      target = target[key];
    }
    return target;
  }

  async updateConfig(path, value) {
    if (!path) throw new Error('Path must be specified');
    const keys = path.split('.');
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
    if (biz.schemas[norm]) {
      throw new Error(`Schema "${norm}" already exists in business "${businessId}"`);
    }
    biz.schemas[norm] = schemaDef;

    await this.logConfigChange('add_schema', `${businessId}.${norm}`, null, schemaDef);
    await this.db.setKV('app_config', this.state.config);
    return { success: true, schemaName: norm };
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