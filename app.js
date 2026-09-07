I'll provide the complete `app.js` with the necessary improvements:

1. **Graceful handling of model loading failures** – if a model returns 401 (unauthorized) or other errors, it will be removed from `availableModels` and the user will be notified.
2. **Always include the currently selected model** in dropdowns, even if it's missing from the list.
3. **Ability to browse/add different models** via a new "Add Model" button in the Models tab (using a simple prompt for model ID and type). This lets you try other models from Hugging Face if you know their ID.
4. **Persistent saving** of the updated model list to IndexedDB.

Below is the full `app.js`. You can replace your existing file with this. No changes to `config.json` are strictly necessary, but you may want to remove the problematic `Xenova/flan-t5-large` entry if it remains; the code will also remove it automatically after the first failed attempt.

```javascript
/**
 * AI Workspace Pro - Modular Application Architecture
 * Autonomous On-Device Agent with Dynamic Tools & Hybrid Intent Routing
 */

/* ==========================================================================
   1. Environment & Diagnostics
   ========================================================================== */
export const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

let transformersModule = null;

export async function getTransformers() {
  if (transformersModule) return transformersModule;
  if (isBrowser && window.transformers) {
    transformersModule = window.transformers;
    return transformersModule;
  }
  if (isBrowser) {
    try {
      const mod = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js');
      transformersModule = mod;
      if (mod.env) mod.env.allowLocalModels = false;
      return transformersModule;
    } catch (err1) {
      try {
        const mod2 = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
        transformersModule = mod2;
        if (mod2.env) mod2.env.allowLocalModels = false;
        return transformersModule;
      } catch (err2) {
        console.warn('Transformers.js CDN unavailable. Operating in rule-based mode.');
        return null;
      }
    }
  }
  return null;
}

/* ==========================================================================
   2. Storage Engine (WorkspaceDB)
   ========================================================================== */
export class WorkspaceDB {
  constructor(name = 'AIWorkspacePro_DB', version = 2) {
    this.name = name;
    this.version = version;
    this.db = null;
    this.memoryStores = {
      kv: new Map(),
      records: new Map(),
      chat: new Map()
    };
  }

  async init() {
    if (!isBrowser || typeof indexedDB === 'undefined') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(this.name, this.version);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('kv')) {
            db.createObjectStore('kv', { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains('records')) {
            const store = db.createObjectStore('records', { keyPath: 'id' });
            store.createIndex('by_biz_schema', ['businessId', 'schemaName'], { unique: false });
            store.createIndex('by_biz', 'businessId', { unique: false });
          }
          if (!db.objectStoreNames.contains('chat')) {
            const chat = db.createObjectStore('chat', { keyPath: 'id' });
            chat.createIndex('by_biz', 'businessId', { unique: false });
          }
        };
        req.onsuccess = () => {
          this.db = req.result;
          resolve();
        };
        req.onerror = () => {
          console.warn('IndexedDB failed to open, using memory store fallback:', req.error);
          resolve();
        };
      } catch (e) {
        console.warn('IndexedDB exception, falling back to memory store:', e);
        resolve();
      }
    });
  }

  async getKV(key) {
    if (!this.db) {
      return this.memoryStores.kv.get(key) || null;
    }
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction('kv', 'readonly');
        const req = tx.objectStore('kv').get(key);
        req.onsuccess = () => resolve(req.result ? req.result.value : null);
        req.onerror = () => resolve(this.memoryStores.kv.get(key) || null);
      } catch (e) {
        resolve(this.memoryStores.kv.get(key) || null);
      }
    });
  }

  async setKV(key, value) {
    this.memoryStores.kv.set(key, value);
    if (!this.db) return Promise.resolve();
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key, value });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async deleteKV(key) {
    this.memoryStores.kv.delete(key);
    if (!this.db) return Promise.resolve();
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async addRecord(businessId, schemaName, data, embedding = null) {
    const record = {
      id: 'r_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      businessId,
      schemaName,
      data: { ...data },
      embedding: embedding ? Array.from(embedding) : null,
      createdAt: Date.now()
    };
    this.memoryStores.records.set(record.id, record);

    if (!this.db) return Promise.resolve(record);
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction('records', 'readwrite');
        tx.objectStore('records').add(record);
        tx.oncomplete = () => resolve(record);
        tx.onerror = () => resolve(record);
      } catch (e) {
        resolve(record);
      }
    });
  }

  async updateRecord(id, data, embedding = null) {
    const existing = await this.getRecordById(id);
    if (!existing) throw new Error(`Record with ID ${id} not found`);
    const updated = {
      ...existing,
      data: { ...existing.data, ...data },
      embedding: embedding ? Array.from(embedding) : existing.embedding,
      updatedAt: Date.now()
    };
    this.memoryStores.records.set(id, updated);

    if (!this.db) return Promise.resolve(updated);
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction('records', 'readwrite');
        tx.objectStore('records').put(updated);
        tx.oncomplete = () => resolve(updated);
        tx.onerror = () => resolve(updated);
      } catch (e) {
        resolve(updated);
      }
    });
  }

  async getRecordById(id) {
    if (!this.db) {
      return this.memoryStores.records.get(id) || null;
    }
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction('records', 'readonly');
        const req = tx.objectStore('records').get(id);
        req.onsuccess = () => resolve(req.result || this.memoryStores.records.get(id) || null);
        req.onerror = () => resolve(this.memoryStores.records.get(id) || null);
      } catch (e) {
        resolve(this.memoryStores.records.get(id) || null);
      }
    });
  }

  async getRecords(businessId, schemaName = null) {
    if (!this.db) {
      const all = Array.from(this.memoryStores.records.values());
      return all.filter(r => r.businessId === businessId && (!schemaName || r.schemaName === schemaName));
    }
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction('records', 'readonly');
        const store = tx.objectStore('records');
        let req;
        if (schemaName) {
          req = store.index('by_biz_schema').getAll(IDBKeyRange.only([businessId, schemaName]));
        } else {
          req = store.index('by_biz').getAll(IDBKeyRange.only(businessId));
        }
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => {
          const all = Array.from(this.memoryStores.records.values());
          resolve(all.filter(r => r.businessId === businessId && (!schemaName || r.schemaName === schemaName)));
        };
      } catch (e) {
        const all = Array.from(this.memoryStores.records.values());
        resolve(all.filter(r => r.businessId === businessId && (!schemaName || r.schemaName === schemaName)));
      }
    });
  }

  async deleteRecord(id) {
    this.memoryStores.records.delete(id);
    if (!this.db) return Promise.resolve();
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction('records', 'readwrite');
        tx.objectStore('records').delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async addChatMessage(msg) {
    const chatMsg = {
      id: msg.id || 'm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      ...msg,
      timestamp: msg.timestamp || Date.now()
    };
    this.memoryStores.chat.set(chatMsg.id, chatMsg);
    if (!this.db) return Promise.resolve(chatMsg);
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction('chat', 'readwrite');
        tx.objectStore('chat').add(chatMsg);
        tx.oncomplete = () => resolve(chatMsg);
        tx.onerror = () => resolve(chatMsg);
      } catch (e) {
        resolve(chatMsg);
      }
    });
  }

  async getChat(businessId) {
    if (!this.db) {
      const all = Array.from(this.memoryStores.chat.values());
      return all.filter(m => m.businessId === businessId).sort((a, b) => a.timestamp - b.timestamp);
    }
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction('chat', 'readonly');
        const req = tx.objectStore('chat').index('by_biz').getAll(IDBKeyRange.only(businessId));
        req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.timestamp - b.timestamp));
        req.onerror = () => {
          const all = Array.from(this.memoryStores.chat.values());
          resolve(all.filter(m => m.businessId === businessId).sort((a, b) => a.timestamp - b.timestamp));
        };
      } catch (e) {
        const all = Array.from(this.memoryStores.chat.values());
        resolve(all.filter(m => m.businessId === businessId).sort((a, b) => a.timestamp - b.timestamp));
      }
    });
  }

  async clearChat(businessId) {
    for (const [id, m] of this.memoryStores.chat.entries()) {
      if (m.businessId === businessId) {
        this.memoryStores.chat.delete(id);
      }
    }
    if (!this.db) return Promise.resolve();
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction('chat', 'readwrite');
        const store = tx.objectStore('chat');
        const idx = store.index('by_biz');
        const req = idx.openKeyCursor(IDBKeyRange.only(businessId));
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            store.delete(cursor.primaryKey);
            cursor.continue();
          } else {
            resolve();
          }
        };
        req.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async searchSimilar(businessId, schemaName = null, queryEmbedding = null, topK = 5) {
    const records = await this.getRecords(businessId, schemaName);
    if (!queryEmbedding || !queryEmbedding.length) return records.slice(0, topK);
    const scored = [];
    for (const rec of records) {
      if (rec.embedding && rec.embedding.length === queryEmbedding.length) {
        const sim = cosineSimilarity(queryEmbedding, rec.embedding);
        scored.push({ ...rec, _similarity: sim });
      } else {
        scored.push({ ...rec, _similarity: 0 });
      }
    }
    scored.sort((a, b) => b._similarity - a._similarity);
    return scored.slice(0, topK);
  }

  async logHistory(type, data = {}) {
    const entry = {
      id: 'h_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      timestamp: Date.now(),
      type,
      data
    };
    const history = (await this.getKV('audit_history')) || [];
    history.push(entry);
    if (history.length > 100) history.shift();
    await this.setKV('audit_history', history);
    return entry;
  }

  async getHistory(limit = 50) {
    const history = (await this.getKV('audit_history')) || [];
    return history.slice(-limit).reverse();
  }
}

/* ==========================================================================
   3. Search & Mathematical Utilities
   ========================================================================== */
export function filterRecords(records, query) {
  if (!query || !query.trim()) return records;
  const q = query.toLowerCase().trim();
  return records.filter(r => {
    const targetObj = r.data || r;
    return Object.values(targetObj).some(val => {
      if (val === null || val === undefined) return false;
      return String(val).toLowerCase().includes(q);
    });
  });
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, mA = 0, mB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    mA += a[i] * a[i];
    mB += b[i] * b[i];
  }
  const denom = Math.sqrt(mA) * Math.sqrt(mB);
  return denom === 0 ? 0 : dot / denom;
}

/* ==========================================================================
   4. Config API & Schema Validation
   ========================================================================== */
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
  // Ensure app.voice exists with defaults
  if (!config.app.voice) config.app.voice = { autoSpeak: false, lang: 'en-US' };
  if (typeof config.app.voice.autoSpeak !== 'boolean') config.app.voice.autoSpeak = false;
  if (typeof config.app.voice.lang !== 'string') config.app.voice.lang = 'en-US';

  // Ensure app.theme exists
  if (!config.app.theme) config.app.theme = { mode: 'light' };
  if (!config.app.theme.mode) config.app.theme.mode = 'light';

  // Ensure app.ui exists (optional but used)
  if (!config.app.ui) config.app.ui = { sidebar: { minWidth: 200, maxWidth: 500 }, chartColors: [] };

  // Ensure app.google exists (optional)
  if (!config.app.google) config.app.google = { clientId: '', scopes: [] };

  // Validate businesses and their schemas
  if (!Array.isArray(config.businesses) || config.businesses.length === 0) {
    throw new Error('Config must contain at least one business definition');
  }
  for (let i = 0; i < config.businesses.length; i++) {
    const b = config.businesses[i];
    if (!b.id || !b.name) {
      throw new Error(`Business at index ${i} must have "id" and "name"`);
    }
    if (!b.schemas || typeof b.schemas !== 'object') b.schemas = {};
    // Ensure each schema has a fields object
    for (const [schemaName, schema] of Object.entries(b.schemas)) {
      if (!schema.fields || typeof schema.fields !== 'object') {
        schema.fields = { title: 'string', description: 'string' };
      }
      if (!schema.vectorize || !Array.isArray(schema.vectorize)) {
        schema.vectorize = Object.keys(schema.fields).filter(k => schema.fields[k] === 'string');
      }
    }
  }

  // Validate characters
  if (!Array.isArray(config.characters) || config.characters.length === 0) {
    throw new Error('Config must contain at least one character definition');
  }
  for (let i = 0; i < config.characters.length; i++) {
    const c = config.characters[i];
    if (!c.id || !c.name) {
      throw new Error(`Character at index ${i} must have "id" and "name"`);
    }
    // Ensure emotions and other optional properties
    c.emotions = c.emotions || { neutral: '🤖', thinking: '🤔', happy: '😊', error: '⚠️' };
    c.specialization = c.specialization || ['general'];
  }

  // Validate tools array exists
  if (!Array.isArray(config.tools)) {
    throw new Error('Config must contain a "tools" array');
  }

  // Validate modelSettings exists
  if (!config.modelSettings || typeof config.modelSettings !== 'object') {
    throw new Error('Config must contain a "modelSettings" object');
  }
  // Ensure availableModels array exists (for UI selection)
  if (!Array.isArray(config.modelSettings.availableModels)) {
    config.modelSettings.availableModels = [];
  }
  return true;
}

export class ConfigAPI {
  constructor(db, state) {
    this.db = db;
    this.state = state;
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
    const norm = schemaName.toLowerCase().trim();
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
}

/* ==========================================================================
   5. Tool Registry & Sandboxing
   ========================================================================== */
export class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.permissionLevels = {
      READ_ONLY: 'read_only',
      USER_DATA: 'user_data',
      CONFIG: 'config',
      SYSTEM: 'system'
    };
  }

  register(tool) {
    if (!tool || !tool.name || typeof tool.execute !== 'function') {
      throw new Error('Invalid tool definition: missing name or execute function');
    }
    this.tools.set(tool.name, {
      name: tool.name,
      description: tool.description || '',
      execute: tool.execute,
      schema: tool.schema || { parameters: {} },
      permissionLevel: tool.permissionLevel || this.permissionLevels.USER_DATA,
      icon: tool.icon || 'bi-gear'
    });
  }

  getTool(name) {
    return this.tools.get(name);
  }

  hasTool(name) {
    return this.tools.has(name);
  }

  getAllTools() {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      schema: t.schema,
      permissionLevel: t.permissionLevel,
      icon: t.icon
    }));
  }

  validateParams(schema, params = {}) {
    if (!schema || !schema.parameters) return true;
    for (const [key, paramSchema] of Object.entries(schema.parameters)) {
      const val = params[key];
      if (paramSchema.required && (val === undefined || val === null || val === '')) {
        throw new Error(`Required parameter "${key}" is missing`);
      }
      if (val !== undefined && val !== null) {
        if (paramSchema.type === 'number') {
          if (typeof val !== 'number' || isNaN(val)) {
            throw new Error(`Parameter "${key}" must be a number`);
          }
        } else if (paramSchema.type === 'string') {
          if (typeof val !== 'string') {
            throw new Error(`Parameter "${key}" must be a string`);
          }
        } else if (paramSchema.type === 'boolean') {
          if (typeof val !== 'boolean') {
            throw new Error(`Parameter "${key}" must be a boolean`);
          }
        } else if (paramSchema.type === 'object') {
          if (typeof val !== 'object' || Array.isArray(val)) {
            throw new Error(`Parameter "${key}" must be an object`);
          }
        } else if (paramSchema.type === 'array') {
          if (!Array.isArray(val)) {
            throw new Error(`Parameter "${key}" must be an array`);
          }
        }
        if (paramSchema.enum && !paramSchema.enum.includes(val)) {
          throw new Error(`Parameter "${key}" must be one of: ${paramSchema.enum.join(', ')}`);
        }
      }
    }
    return true;
  }

  async requestPermission(toolName, level) {
    if (level === this.permissionLevels.READ_ONLY || level === this.permissionLevels.USER_DATA) {
      return true;
    }
    if (!isBrowser) return true;

    return new Promise(resolve => {
      const modal = document.getElementById('permissionModal');
      if (!modal) return resolve(true);

      // Check if Bootstrap is available
      if (typeof bootstrap === 'undefined') {
        console.warn('Bootstrap not loaded; auto-approving permission for', toolName);
        return resolve(true);
      }

      const toolEl = document.getElementById('permToolName');
      const levelEl = document.getElementById('permLevelName');
      if (toolEl) toolEl.textContent = toolName;
      if (levelEl) levelEl.textContent = level;

      const bsModal = bootstrap.Modal.getOrCreateInstance(modal);
      const approveBtn = document.getElementById('approvePermissionBtn');
      const denyBtn = document.getElementById('denyPermissionBtn');

      const onApprove = () => {
        cleanup();
        bsModal.hide();
        resolve(true);
      };

      const onDeny = () => {
        cleanup();
        bsModal.hide();
        resolve(false);
      };

      const cleanup = () => {
        if (approveBtn) approveBtn.removeEventListener('click', onApprove);
        if (denyBtn) denyBtn.removeEventListener('click', onDeny);
      };

      if (approveBtn) approveBtn.addEventListener('click', onApprove);
      if (denyBtn) denyBtn.addEventListener('click', onDeny);
      bsModal.show();
    });
  }

  async execute(toolName, params = {}, permissionLevel = null, context = {}) {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool "${toolName}" not found in registry`);
    }

    const effectiveLevel = permissionLevel || tool.permissionLevel;
    if (effectiveLevel === this.permissionLevels.CONFIG || effectiveLevel === this.permissionLevels.SYSTEM) {
      const allowed = await this.requestPermission(toolName, effectiveLevel);
      if (!allowed) {
        throw new Error(`Permission denied for execution of ${toolName} (${effectiveLevel})`);
      }
    }

    this.validateParams(tool.schema, params);
    return await tool.execute(params, context);
  }

  async registerToolFromAI(toolDefinition, db) {
    if (!toolDefinition || !toolDefinition.name || !toolDefinition.code) {
      throw new Error('Tool definition must specify name and code');
    }
    // Check for existing tool with same name
    if (this.getTool(toolDefinition.name)) {
      throw new Error(`Tool "${toolDefinition.name}" already exists in registry`);
    }
    const sandboxedFn = createSandboxedTool(toolDefinition.code, db);
    const safeTool = {
      name: toolDefinition.name,
      description: toolDefinition.description || 'Custom dynamic tool',
      execute: sandboxedFn,
      schema: toolDefinition.schema || { parameters: {} },
      permissionLevel: toolDefinition.permissionLevel || this.permissionLevels.USER_DATA,
      icon: toolDefinition.icon || 'bi-gear'
    };
    this.register(safeTool);

    if (db) {
      const existing = (await db.getKV('custom_tools')) || [];
      existing.push(toolDefinition);
      await db.setKV('custom_tools', existing);
    }
    return { success: true, tool: safeTool.name };
  }
}

export function createSandboxedTool(code, dbInstance = null) {
  const allowedAPIs = {
    db: dbInstance ? {
      getRecords: dbInstance.getRecords.bind(dbInstance),
      addRecord: dbInstance.addRecord.bind(dbInstance),
      getKV: dbInstance.getKV.bind(dbInstance),
      setKV: dbInstance.setKV.bind(dbInstance)
    } : null,
    Math,
    JSON,
    Date,
    console: { log: (...args) => console.log('[SandboxedTool]:', ...args) }
  };

  try {
    const fn = new Function('API', 'params', `
      "use strict";
      const { db, Math, JSON, Date, console } = API;
      ${code}
    `);
    return async (params) => {
      return await fn(allowedAPIs, params);
    };
  } catch (err) {
    throw new Error(`Sandboxed tool compilation failed: ${err.message}`);
  }
}

export class ToolChain {
  constructor(toolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  async execute(chain, initialContext = {}) {
    if (!chain || !Array.isArray(chain.steps) || chain.steps.length === 0) {
      throw new Error('ToolChain requires a "steps" array with at least one step');
    }

    const results = [];
    const context = { ...initialContext };

    for (let i = 0; i < chain.steps.length; i++) {
      const step = chain.steps[i];
      try {
        const stepParams = {};
        for (const [k, v] of Object.entries(step.params || {})) {
          if (typeof v === 'string' && v.startsWith('{{') && v.endsWith('}}')) {
            const varKey = v.slice(2, -2).trim();
            const parts = varKey.split('.');
            let resolved = context;
            for (const p of parts) {
              if (resolved !== null && resolved !== undefined && typeof resolved === 'object') {
                resolved = resolved[p];
              } else {
                resolved = undefined;
                break;
              }
            }
            stepParams[k] = resolved !== undefined ? resolved : v;
          } else {
            stepParams[k] = v;
          }
        }

        const res = await this.toolRegistry.execute(step.tool, stepParams, step.permissionLevel, context);
        results.push({ stepIndex: i, tool: step.tool, success: true, result: res });

        if (step.outputKey) {
          context[step.outputKey] = res;
        }

        if (step.stopOnError && res && res.error) {
          break;
        }
      } catch (err) {
        results.push({ stepIndex: i, tool: step.tool, success: false, error: err.message });
        if (step.stopOnError !== false) {
          throw new Error(`Chain failed at step ${i} (${step.tool}): ${err.message}`);
        }
      }
    }
    return { results, context };
  }
}

/* ==========================================================================
   6. Agent Communication & Routing
   ========================================================================== */
export class AgentCommunication {
  constructor(state, db) {
    this.state = state;
    this.db = db;
    this.messageQueue = [];
  }

  getOtherAgents(currentAgentId) {
    return (this.state.config?.characters || []).filter(c => c.id !== currentAgentId);
  }

  getAgentBySpecialization(specialization) {
    const spec = specialization.toLowerCase();
    return (this.state.config?.characters || []).find(c =>
      c.specialization && c.specialization.some(s => s.toLowerCase() === spec)
    );
  }

  getBestAgentForQuery(query) {
    const q = query.toLowerCase();
    const chars = this.state.config?.characters || [];

    if (/\b(expense|spending|cost|budget|money|income|cashflow|financial|accounting|invest)\b/.test(q)) {
      const finAgent = chars.find(c => c.specialization && c.specialization.some(s => ['finance', 'expenses', 'budgeting', 'accounting'].includes(s.toLowerCase())));
      if (finAgent) return finAgent;
    }

    if (/\b(task|todo|schedule|calendar|agenda|meeting|reminder|plan|roadmap)\b/.test(q)) {
      const taskAgent = chars.find(c => c.specialization && c.specialization.some(s => ['tasks', 'calendar', 'coordination', 'task'].includes(s.toLowerCase())));
      if (taskAgent) return taskAgent;
    }

    if (/\b(analytics|report|metrics|dataset|charts|breakdown)\b/.test(q)) {
      const dataAgent = chars.find(c => c.specialization && c.specialization.some(s => ['analytics', 'finance', 'data'].includes(s.toLowerCase())));
      if (dataAgent) return dataAgent;
    }

    for (const c of chars) {
      if (c.specialization && c.specialization.some(s => q.includes(s.toLowerCase()))) {
        return c;
      }
    }
    return null;
  }

  async delegateToAgent(fromAgentId, toAgentId, message, context = null) {
    const fromAgent = this.state.config.characters.find(c => c.id === fromAgentId);
    const toAgent = this.state.config.characters.find(c => c.id === toAgentId);
    if (!fromAgent || !toAgent) {
      throw new Error(`Delegation failed: agent not found (from: ${fromAgentId}, to: ${toAgentId})`);
    }

    const delegation = {
      id: 'del_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      from: fromAgentId,
      to: toAgentId,
      message,
      context,
      timestamp: Date.now(),
      status: 'pending'
    };

    const previousActive = this.state.activeCharacterId;
    this.state.activeCharacterId = toAgentId;

    try {
      const detected = await detectIntent(message, this.state);
      const res = await executeTool(detected, message, this.state);
      delegation.status = 'completed';
      delegation.result = res;
      delegation.completedAt = Date.now();
    } catch (e) {
      delegation.status = 'failed';
      delegation.error = e.message;
    } finally {
      this.state.activeCharacterId = previousActive;
      this.messageQueue.push(delegation);
      if (this.db) {
        await this.db.setKV('agent_delegations', this.messageQueue);
      }
    }
    return delegation;
  }

  async askAgent(fromAgentId, toAgentId, message) {
    const toAgent = this.state.config.characters.find(c => c.id === toAgentId);
    if (!toAgent) throw new Error(`Agent "${toAgentId}" not found`);

    const prevActive = this.state.activeCharacterId;
    this.state.activeCharacterId = toAgentId;
    let res;
    try {
      const detected = await detectIntent(message, this.state);
      res = await executeTool(detected, message, this.state);
    } finally {
      this.state.activeCharacterId = prevActive;
    }
    return {
      text: res.text,
      agentName: toAgent.name,
      agentId: toAgent.id
    };
  }

  getAgentCapabilities(agent) {
    const caps = [];
    if (agent.specialization) {
      if (agent.specialization.includes('finance')) {
        caps.push('expense tracking', 'budgeting', 'financial analytics');
      }
      if (agent.specialization.includes('tasks') || agent.specialization.includes('calendar')) {
        caps.push('task management', 'calendar scheduling');
      }
      if (agent.specialization.includes('analytics')) {
        caps.push('data analysis', 'reporting');
      }
      if (agent.specialization.includes('coordination')) {
        caps.push('agent coordination');
      }
    }
    return caps.length > 0 ? caps : ['general assistance'];
  }

  formatAgentResponse(agentName, text) {
    return `**${agentName}**: ${text}`;
  }
}

/* ==========================================================================
   7. Google API Integration
   ========================================================================== */
export class GoogleAPI {
  constructor(state, db) {
    this.state = state;
    this.db = db;
    this.tokenClient = null;
    this.accessToken = null;
    this.isSignedIn = false;
  }

  async init() {
    if (!isBrowser || typeof google === 'undefined' || !google.accounts) {
      return;
    }
    const clientId = this.state?.config?.app?.google?.clientId;
    if (!clientId || clientId === 'YOUR_GOOGLE_CLIENT_ID_HERE') {
      return;
    }

    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: (this.state.config.app.google.scopes || []).join(' '),
      callback: (resp) => {
        if (resp.access_token) {
          this.accessToken = resp.access_token;
          this.isSignedIn = true;
          this.updateUI(true);
          if (this.db) {
            this.db.setKV('google_token', { token: this.accessToken, expires: Date.now() + 3500 * 1000 });
          }
        }
      }
    });

    const stored = await this.db.getKV('google_token');
    if (stored && stored.expires > Date.now()) {
      this.accessToken = stored.token;
      this.isSignedIn = true;
      this.updateUI(true);
    }
  }

  signIn() {
    if (this.tokenClient) this.tokenClient.requestAccessToken();
  }

  async signOut() {
    this.accessToken = null;
    this.isSignedIn = false;
    if (this.db) await this.db.deleteKV('google_token');
    this.updateUI(false);
  }

  updateUI(signedIn) {
    if (!isBrowser) return;
    const btn = document.getElementById('googleSignInBtn');
    const info = document.getElementById('googleSignedInInfo');
    if (!btn || !info) return;
    if (signedIn) {
      btn.classList.add('d-none');
      info.classList.remove('d-none');
    } else {
      btn.classList.remove('d-none');
      info.classList.add('d-none');
    }
  }

  async makeRequest(url) {
    if (!this.accessToken) {
      throw new Error('Please sign in with Google in the sidebar first to access Google services.');
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    if (!res.ok) {
      throw new Error(`Google API request failed with status: ${res.status}`);
    }
    return await res.json();
  }

  async listCalendarEvents() {
    const data = await this.makeRequest('https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=10&singleEvents=true&orderBy=startTime');
    if (!data.items || data.items.length === 0) {
      return { text: '📅 No upcoming Google Calendar events found.' };
    }
    const events = data.items.map(e => {
      const dt = e.start.dateTime || e.start.date;
      return `- **${e.summary || 'Untitled Event'}** (${new Date(dt).toLocaleString()})`;
    }).join('\n');
    return { text: `### 📅 Upcoming Google Calendar Events:\n${events}` };
  }

  async listDriveFiles() {
    const data = await this.makeRequest('https://www.googleapis.com/drive/v3/files?pageSize=10&fields=files(id,name,mimeType,modifiedTime)');
    if (!data.files || data.files.length === 0) {
      return { text: '📁 No files found in Google Drive.' };
    }
    const files = data.files.map(f => {
      const icon = f.mimeType && f.mimeType.includes('folder') ? '📁' : '📄';
      return `${icon} **${f.name}** (${new Date(f.modifiedTime).toLocaleDateString()})`;
    }).join('\n');
    return { text: `### 📁 Google Drive Files:\n${files}` };
  }

  async readSheet(spreadsheetId, range = 'Sheet1!A1:Z50') {
    const data = await this.makeRequest(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
    if (!data.values || data.values.length === 0) {
      return { text: 'No data found in the specified sheet range.' };
    }
    const header = data.values[0];
    const rows = data.values.slice(1);
    const mdHeader = `| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |`;
    const mdRows = rows.map(r => `| ${r.join(' | ')} |`).join('\n');
    return { text: `### 📊 Google Sheets Data:\n\n${mdHeader}\n${mdRows}` };
  }
}

/* ==========================================================================
   8. Tool Call Parser
   ========================================================================== */
export function parseToolCall(text) {
  if (!text || typeof text !== 'string') return null;

  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      if (parsed && parsed.tool) return parsed;
    } catch (e) {}
  }

  const startIdx = text.indexOf('{');
  if (startIdx !== -1) {
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          const candidate = text.slice(startIdx, endIdx + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && parsed.tool) {
              return { tool: parsed.tool, params: parsed.params || {} };
            }
          } catch (e) {}
        }
      }
    }
  }

  const fnMatch = text.match(/(?:(?:call|execute|tool):\s*)?([a-zA-Z0-9_]{3,30})\s*\(([\s\S]*?)\)/i);
  if (fnMatch) {
    const candidateTool = fnMatch[1].toLowerCase();
    const isExplicitCall = /(?:call|execute|tool):\s*/i.test(text);
    const isValidRegisteredTool = typeof toolRegistry !== 'undefined' && toolRegistry.hasTool && toolRegistry.hasTool(candidateTool);

    if (isExplicitCall || isValidRegisteredTool) {
      const rawParams = fnMatch[2].trim();
      try {
        const params = rawParams ? JSON.parse(rawParams) : {};
        return { tool: candidateTool, params };
      } catch (e) {
        if (isExplicitCall || (rawParams && !rawParams.includes('Permission:'))) {
          return { tool: candidateTool, params: { query: rawParams } };
        }
      }
    }
  }

  const xmlMatch = text.match(/<tool\s+name=["']([a-zA-Z0-9_-]+)["']>([\s\S]*?)<\/tool>/i);
  if (xmlMatch) {
    const toolName = xmlMatch[1];
    const body = xmlMatch[2];
    const params = {};
    const tagRegex = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(body)) !== null) {
      params[tagMatch[1]] = tagMatch[2].trim();
    }
    return { tool: toolName, params };
  }

  return null;
}

/* ==========================================================================
   9. Hybrid Intent Detection
   ========================================================================== */
export async function detectIntent(text, stateInstance = state) {
  if (!text) return 'default';
  const raw = typeof text === 'string' ? text : String(text);
  const lower = raw.toLowerCase().trim();

  // Conversational & Greetings
  if (/^(hi|hello|hey|greetings|good\s+(morning|afternoon|evening))\b/i.test(lower)) {
    return { tool: 'chat_greeting', params: { text: raw } };
  }
  if (/\b(who are you|what is your name|what's your name|introduce yourself|tell me about yourself)\b/i.test(lower)) {
    return { tool: 'chat_identity', params: {} };
  }
  if (/\b(what can you do|how can you help|help me|capabilities|what do you do)\b/i.test(lower)) {
    return { tool: 'chat_help', params: {} };
  }
  if (/^(thank you|thanks|appreciate it|great job)\b/i.test(lower)) {
    return { tool: 'chat_thanks', params: {} };
  }

  // Agent Delegation & Asking
  if (/\b(delegate to|ask)\s+([a-zA-Z0-9_-]+)/i.test(raw)) {
    const match = raw.match(/(?:delegate to|ask)\s+([a-zA-Z0-9_-]+)(?:\s+(?:about|to|for|with)?\s*(.*))?/i);
    if (match) {
      const targetName = match[1].toLowerCase();
      const queryText = (match[2] || '').trim();
      const targetAgent = stateInstance.config?.characters?.find(c =>
        c.name.toLowerCase() === targetName || c.id.toLowerCase() === targetName
      );
      if (targetAgent) {
        const isDelegate = /\bdelegate to\b/i.test(raw);
        return {
          tool: isDelegate ? 'delegate_to_agent' : 'ask_agent',
          params: {
            targetAgentId: targetAgent.id,
            message: queryText || raw
          }
        };
      }
    }
  }

  if (/\b(route to specialist|route to expert|route query)\b/i.test(raw)) {
    const cleanQuery = raw.replace(/route\s+(to\s+)?(specialist|expert)\s*/i, '').trim();
    return { tool: 'route_to_specialist', params: { query: cleanQuery || raw } };
  }

  if (/\b(list agents|available agents|who else is here|team members|agent team)\b/i.test(lower)) {
    return { tool: 'list_agents', params: {} };
  }

  // Web Search
  if (/\b(web search|search the web|search web|google online|search online|duckduckgo)\b/i.test(lower)) {
    const query = raw.replace(/\b(web search for|web search|search the web for|search the web|search web for|search web|search online for|search online)\b/gi, '').trim();
    return { tool: 'web_search', params: { query: query || raw } };
  }

  // Google Workspace
  if (/\b(google calendar|calendar events|upcoming appointments)\b/i.test(lower)) {
    return { tool: 'google_calendar_list', params: {} };
  }
  if (/\b(google drive|drive files|my drive)\b/i.test(lower)) {
    return { tool: 'google_drive_list', params: {} };
  }
  if (/\b(google sheets|read sheet|spreadsheet data)\b/i.test(lower)) {
    const sheetMatch = raw.match(/([a-zA-Z0-9_-]{20,})/);
    return {
      tool: 'google_sheets_read',
      params: { spreadsheetId: sheetMatch ? sheetMatch[1] : '' }
    };
  }

  // System & Config
  if (/\b(list tools|available tools|show tools|what tools)\b/i.test(lower)) {
    return { tool: 'list_tools', params: {} };
  }
  if (/\b(rollback config|revert config|undo config)\b/i.test(lower)) {
    return { tool: 'rollback_config', params: {} };
  }
  if (/\b(get config)\s+([a-zA-Z0-9_.]+)/i.test(raw)) {
    const match = raw.match(/get config\s+([a-zA-Z0-9_.]+)/i);
    return { tool: 'get_config', params: { path: match[1] } };
  }
  if (/\b(update config|set config)\s+([a-zA-Z0-9_.]+)\s+(.*)/i.test(raw)) {
    const match = raw.match(/(?:update|set) config\s+([a-zA-Z0-9_.]+)\s+(.*)/i);
    let val = match[2].trim();
    try { val = JSON.parse(val); } catch (e) {}
    return { tool: 'update_config', params: { path: match[1], value: val } };
  }
  if (/\b(change your name to|call you|your name is)\s+([a-zA-Z0-9_-]+)/i.test(raw)) {
    const match = raw.match(/(?:change your name to|call you|your name is)\s+([a-zA-Z0-9_-]+)/i);
    return { tool: 'change_character_name', params: { name: match[1] } };
  }

  // Core Tools
  if (/\b(spent|paid|expense|bought|income|earned|deposit|\$)\b/i.test(lower) && /\d+/.test(lower)) {
    return 'add_transaction';
  }
  if (/\b(analyze expenses|financial analysis|expense breakdown|spending analysis|analyze spending|budget analysis|spending chart)\b/i.test(lower)) {
    return 'analyze_expenses';
  }
  if (/\b(add todo|remind me to|task:|new task|need to)\b/i.test(lower)) {
    return 'add_todo';
  }
  if (/\b(list todos|show todos|my tasks|what are my todos|check tasks|pending tasks)\b/i.test(lower)) {
    return 'list_todos';
  }
  if (/\b(schedule|add event|calendar event|meeting at|appointment)\b/i.test(lower)) {
    return 'add_event';
  }
  if (/\b(check calendar|my schedule|agenda|upcoming events)\b/i.test(lower)) {
    return 'check_calendar';
  }
  if (/\b(create schema|new schema|table for)\b/i.test(lower)) {
    return 'create_schema';
  }
  if (/\b(search|find|lookup|query|recall)\b/i.test(lower)) {
    const cleanQuery = raw.replace(/^(search for|search|find|lookup|recall)\s+/i, '').trim();
    return { tool: 'search', params: { query: cleanQuery || raw } };
  }

  // Classifier fallback
  try {
    if (stateInstance.models && stateInstance.models['zero-shot-classification']) {
      const classifier = stateInstance.models['zero-shot-classification'];
      const tools = stateInstance.config.tools || [];
      const labels = tools.map(t => t.description);
      const res = await classifier(raw, { candidate_labels: labels });
      const idx = labels.indexOf(res.labels[0]);
      if (idx !== -1 && res.scores[0] > 0.4) {
        return tools[idx].name;
      }
    }
  } catch (e) {}

  return 'default';
}

/* ==========================================================================
   10. Tool Execution Engine
   ========================================================================== */
export async function executeTool(toolIdentifier, rawInput, stateInstance = state, registryInstance = toolRegistry) {
  let actualToolName = '';
  let params = {};
  let inputText = '';

  if (typeof toolIdentifier === 'object' && toolIdentifier !== null) {
    actualToolName = toolIdentifier.tool || '';
    params = { ...(toolIdentifier.params || {}) };
  } else if (typeof toolIdentifier === 'string') {
    actualToolName = toolIdentifier;
  }

  if (typeof rawInput === 'object' && rawInput !== null) {
    params = { ...params, ...rawInput };
    inputText = params.query || params.message || params.task || params.description || '';
  } else if (typeof rawInput === 'string') {
    inputText = rawInput;
  }

  const lower = inputText.toLowerCase();

  // Natural language extraction for core tools
  if (actualToolName === 'add_transaction') {
    if (params.amount === undefined) {
      const amtMatch = inputText.match(/(\d+(\.\d{1,2})?)/);
      if (!amtMatch) {
        return { text: "⚠️ Please specify an amount (e.g. 'Spent $16.50 on lunch at cafe')." };
      }
      params.amount = parseFloat(amtMatch[1]);
    }
    if (!params.type) {
      params.type = /\b(income|earned|salary|deposit|received)\b/i.test(inputText) ? 'income' : 'expense';
    }
    if (!params.description) {
      params.description = inputText
        .replace(/(\$|\bspent\b|\bpaid\b|\bfor\b|\bon\b|\bearned\b|\breceived\b)/gi, '')
        .replace(String(params.amount), '')
        .trim() || 'Transaction';
    }
    if (!params.category) {
      let matchedCategory = 'general';
      for (const [catName, kws] of Object.entries(stateInstance.config.categories || {})) {
        if (kws.some(k => lower.includes(k))) {
          matchedCategory = catName;
          break;
        }
      }
      params.category = matchedCategory;
    }
  } else if (actualToolName === 'add_todo') {
    if (!params.task) {
      params.task = inputText.replace(/\b(add todo|remind me to|task:|new task|need to)\b/gi, '').trim();
    }
    if (!params.priority) {
      params.priority = /\b(urgent|critical)\b/i.test(inputText) ? 'high' :
                        /\b(low|minor)\b/i.test(inputText) ? 'low' : 'normal';
    }
  } else if (actualToolName === 'add_event') {
    if (!params.summary) {
      params.summary = inputText.replace(/\b(schedule|add event|calendar event|meeting with|appointment)\b/gi, '').trim() || 'Scheduled Event';
    }
    if (!params.description) params.description = inputText;
  } else if (actualToolName === 'create_schema') {
    if (!params.name) {
      const match = inputText.match(/create schema\s+([a-zA-Z0-9_-]+)/i);
      if (match) params.name = match[1];
    }
  } else if (actualToolName === 'search' || actualToolName === 'rag_query') {
    actualToolName = 'search';
    if (!params.query) {
      params.query = inputText.replace(/^(search for|search|find|lookup|recall)\s+/i, '').trim();
    }
  } else if (actualToolName === 'change_character_name') {
    if (!params.name) {
      const match = inputText.match(/(?:to|call you|your name is)\s+([a-zA-Z0-9_-]+)/i);
      if (match) params.name = match[1];
    }
  } else if (actualToolName === 'delegate_to_agent' || actualToolName === 'ask_agent') {
    if (!params.message && params.query) {
      params.message = params.query;
    }
  }

  const reg = registryInstance || toolRegistry;
  if (reg.hasTool(actualToolName)) {
    try {
      const result = await reg.execute(actualToolName, params);
      return result;
    } catch (err) {
      return { text: `⚠️ Error executing tool **${actualToolName}**: ${err.message}` };
    }
  }

  // Conversational response handlers
  if (actualToolName === 'chat_greeting') {
    const char = getActiveCharacter(stateInstance);
    if (isBrowser) setCharacterEmotion('happy');
    return {
      text: `Hello! I'm **${char.name}**, your ${char.persona.toLowerCase()}. How can I help you today? You can ask me to log expenses, manage tasks, check your calendar, search records, or consult with other specialists.`
    };
  }
  if (actualToolName === 'chat_identity') {
    const char = getActiveCharacter(stateInstance);
    if (isBrowser) setCharacterEmotion('happy');
    const specs = (char.specialization || []).map(s => `\`${s}\``).join(', ');
    return {
      text: `I am **${char.name}**! ${char.persona}\n\nMy primary specializations include: ${specs || 'general assistance'}. I can operate tools on-device and coordinate with other specialists when needed.`
    };
  }
  if (actualToolName === 'chat_help') {
    const char = getActiveCharacter(stateInstance);
    if (isBrowser) setCharacterEmotion('neutral');
    return {
      text: `Here are some things I can do for you right now:\n\n` +
        `- 💰 **Financial Tracking**: Say *"Spent $16.50 on lunch"* or *"Analyze expenses"*\n` +
        `- 📋 **Task Management**: Say *"Add todo: review report"* or *"List todos"*\n` +
        `- 📅 **Calendar**: Say *"Schedule meeting tomorrow at 3pm"* or *"Check calendar"*\n` +
        `- 🔍 **Semantic Search**: Say *"Search marketing projects"*\n` +
        `- 👥 **Multi-Agent**: Say *"Ask Marcus about budget"* or *"List agents"*\n` +
        `- 🛠️ **Tools**: Say *"List tools"* to inspect all registered tools.`
    };
  }
  if (actualToolName === 'chat_thanks') {
    const char = getActiveCharacter(stateInstance);
    if (isBrowser) setCharacterEmotion('happy');
    return {
      text: `You're very welcome! Let me know if you need anything else.`
    };
  }

  // Fallback to text generator model
  if (isBrowser) setCharacterEmotion('thinking');
  try {
    const char = getActiveCharacter(stateInstance);
    const generator = await getModel('text2text-generation', stateInstance.config?.modelSettings?.generator, stateInstance);
    if (generator) {
      const historyTurns = (stateInstance.chatHistory || [])
        .filter(m => m.content && !m.content.includes('Active Tools') && !m.content.includes('Spreadsheet Data') && !m.content.includes('Permission:'))
        .slice(-3)
        .map(m => {
          const role = m.role === 'user' ? 'User' : 'Assistant';
          const cleanText = m.content.replace(/[`*#]/g, '').slice(0, 80).trim();
          return `${role}: ${cleanText}`;
        })
        .join('\n');

      const cleanPrompt = `${char.systemPrompt}\n${historyTurns ? historyTurns + '\n' : ''}User: ${inputText.slice(0, 150)}\nAssistant:`;
      const out = await generator(cleanPrompt, {
        max_new_tokens: 80,
        repetition_penalty: 1.25,
        no_repeat_ngram_size: 3
      });
      if (isBrowser) setCharacterEmotion('neutral');
      const genText = (out[0]?.generated_text || '').trim();
      return { text: genText || "I am ready to help." };
    }
  } catch (e) {
    console.warn('Text generator fallback failed:', e);
  }

  if (isBrowser) setCharacterEmotion('neutral');
  return {
    text: `I understood your request, but the requested tool **"${actualToolName}"** is not active. Type "List tools" to see available tools.`
  };
}

/* ==========================================================================
   11. Embeddings & Pipeline Manager
   ========================================================================== */
export async function computeEmbedding(schemaName, data, stateInstance = state) {
  try {
    const biz = getActiveBusiness(stateInstance);
    const schema = biz.schemas?.[schemaName];
    if (!schema) return null;
    const fields = schema.vectorize || Object.keys(schema.fields || {});
    const text = fields.map(f => data[f]).filter(Boolean).join(' ');
    if (!text) return null;

    const embedder = await getModel('feature-extraction', stateInstance.config.modelSettings.embedder, stateInstance);
    if (!embedder) return null;
    const out = await embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  } catch (e) {
    return null;
  }
}

export const modelStatus = {};

export function updateModelStatus(key, status, label) {
  modelStatus[key] = { status, label };
  if (!isBrowser) return;
  const panel = document.getElementById('modelStatusPanel');
  if (!panel) return;
  panel.innerHTML = Object.entries(modelStatus).map(([k, m]) => {
    const icon = m.status === 'ready' ? '<i class="bi bi-check-circle-fill text-success"></i>' :
                 m.status === 'loading' ? '<span class="spinner-border spinner-border-sm text-primary"></span>' :
                 m.status === 'error' ? '<i class="bi bi-exclamation-triangle text-danger"></i>' :
                 '<i class="bi bi-circle text-body-secondary"></i>';
    return `<div class="d-flex align-items-center gap-2 small"><span>${icon}</span><span class="text-truncate">${m.label}</span></div>`;
  }).join('');
}

export async function getModel(task, modelName, stateInstance = state) {
  if (!modelName) return null;
  const key = `${task}:${modelName}`;
  if (stateInstance.models && stateInstance.models[key]) {
    return stateInstance.models[key];
  }

  const tf = await getTransformers();
  if (!tf || !tf.pipeline) return null;

  const shortName = modelName.split('/').pop();
  updateModelStatus(key, 'loading', `Loading ${shortName}...`);

  try {
    const selectedDtype = stateInstance.config?.modelSettings?.dtype || 'q8';
    const model = await tf.pipeline(task, modelName, {
      dtype: selectedDtype,
      progress_callback: (progress) => {
        if (progress.status === 'progress') {
          updateModelStatus(key, 'loading', `Loading ${shortName}: ${Math.round(progress.progress * 100)}%`);
        }
      }
    });
    updateModelStatus(key, 'ready', shortName);
    stateInstance.models[key] = model;
    // Also cache under plain task name for classifiers
    if (task === 'zero-shot-classification') {
      stateInstance.models['zero-shot-classification'] = model;
    }
    return model;
  } catch (e) {
    console.error(`Failed to load model ${modelName}:`, e);
    updateModelStatus(key, 'error', shortName);

    // If the model is unauthorized (401) or not found, remove it from availableModels to prevent future attempts
    if (e.message.includes('401') || e.message.includes('Unauthorized') || e.message.includes('not found')) {
      const available = stateInstance.config.modelSettings.availableModels || [];
      const idx = available.findIndex(m => m.id === modelName);
      if (idx !== -1) {
        available.splice(idx, 1);
        stateInstance.config.modelSettings.availableModels = available;
        await db.setKV('app_config', stateInstance.config);
        if (isBrowser) {
          showToast(`Model "${modelName}" is unavailable and has been removed.`);
        }
      }
      // Also clear the currently selected model if it matches
      if (stateInstance.config.modelSettings.generator === modelName) {
        stateInstance.config.modelSettings.generator = available.find(m => m.type === 'generator')?.id || '';
      } else if (stateInstance.config.modelSettings.embedder === modelName) {
        stateInstance.config.modelSettings.embedder = available.find(m => m.type === 'embedder')?.id || '';
      } else if (stateInstance.config.modelSettings.classifier === modelName) {
        stateInstance.config.modelSettings.classifier = available.find(m => m.type === 'classifier')?.id || '';
      }
      await db.setKV('app_config', stateInstance.config);
      if (isBrowser) {
        populateModelSelects(); // Refresh dropdowns
        renderConfigEditor();
      }
    }
    return null;
  }
}

/* ==========================================================================
   12. Core Tool Registrations
   ========================================================================== */
export function registerAllCoreTools(registry, dbInstance, stateInstance, agentCommInstance, googleAPIInstance) {
  registry.register({
    name: 'add_transaction',
    description: 'Record an income or expense transaction',
    schema: {
      parameters: {
        amount: { type: 'number', required: true },
        type: { type: 'string', enum: ['expense', 'income'], required: false },
        category: { type: 'string', required: false },
        description: { type: 'string', required: false },
        date: { type: 'string', required: false }
      }
    },
    permissionLevel: registry.permissionLevels.USER_DATA,
    icon: 'bi-cash-coin',
    execute: async (params) => {
      const biz = getActiveBusiness(stateInstance);
      if (isBrowser) setCharacterEmotion('money');
      const rec = {
        type: params.type || 'expense',
        amount: Number(params.amount),
        category: params.category || 'general',
        description: params.description || 'Transaction',
        date: params.date || new Date().toISOString().slice(0, 10)
      };
      const emb = await computeEmbedding('transactions', rec, stateInstance);
      await dbInstance.addRecord(biz.id, 'transactions', rec, emb);
      if (isBrowser) renderExplorerTable();
      return {
        text: `Recorded **${rec.type}** of **$${rec.amount.toFixed(2)}** in *[${rec.category}]* for "${rec.description}".`
      };
    }
  });

  registry.register({
    name: 'analyze_expenses',
    description: 'Generate charts and analyze spending by category',
    schema: { parameters: {} },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-pie-chart',
    execute: async () => {
      const biz = getActiveBusiness(stateInstance);
      if (isBrowser) setCharacterEmotion('money');
      const records = await dbInstance.getRecords(biz.id, 'transactions');
      if (!records.length) {
        return { text: `No transactions recorded yet in workspace "${biz.name}".` };
      }

      let totalExp = 0, totalInc = 0;
      const catTotals = {};
      records.forEach(r => {
        const amt = Number(r.data.amount) || 0;
        if (r.data.type === 'expense') {
          totalExp += amt;
          const c = r.data.category || 'general';
          catTotals[c] = (catTotals[c] || 0) + amt;
        } else {
          totalInc += amt;
        }
      });

      const chartId = 'ch_' + Date.now();
      return {
        text: `### 📊 Financial Breakdown (${biz.name})\n- **Total Income:** $${totalInc.toFixed(2)}\n- **Total Expenses:** $${totalExp.toFixed(2)}\n- **Net Cashflow:** $${(totalInc - totalExp).toFixed(2)}`,
        chart: {
          id: chartId,
          type: 'doughnut',
          labels: Object.keys(catTotals),
          data: Object.values(catTotals)
        }
      };
    }
  });

  registry.register({
    name: 'add_todo',
    description: 'Add a task to the todo list',
    schema: {
      parameters: {
        task: { type: 'string', required: true },
        priority: { type: 'string', enum: ['high', 'normal', 'low'], required: false },
        due_date: { type: 'string', required: false }
      }
    },
    permissionLevel: registry.permissionLevels.USER_DATA,
    icon: 'bi-check2-square',
    execute: async (params) => {
      const biz = getActiveBusiness(stateInstance);
      if (isBrowser) setCharacterEmotion('task');
      const rec = {
        task: params.task,
        status: 'pending',
        priority: params.priority || 'normal',
        due_date: params.due_date || new Date().toISOString().slice(0, 10)
      };
      const emb = await computeEmbedding('todos', rec, stateInstance);
      await dbInstance.addRecord(biz.id, 'todos', rec, emb);
      if (isBrowser) renderExplorerTable();
      return { text: `Added to-do: **"${rec.task}"** [Priority: *${rec.priority}*].` };
    }
  });

  registry.register({
    name: 'list_todos',
    description: 'List current pending or completed todos',
    schema: { parameters: {} },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-list-task',
    execute: async () => {
      const biz = getActiveBusiness(stateInstance);
      if (isBrowser) setCharacterEmotion('task');
      const todos = await dbInstance.getRecords(biz.id, 'todos');
      if (!todos.length) return { text: "No todos found in this workspace." };
      const list = todos.map(t => `- [${t.data.status === 'done' ? 'x' : ' '}] **${t.data.task}** *(${t.data.priority || 'normal'})*`).join('\n');
      return { text: `### 📋 Active Tasks (${biz.name}):\n${list}` };
    }
  });

  registry.register({
    name: 'add_event',
    description: 'Schedule a calendar event or meeting',
    schema: {
      parameters: {
        summary: { type: 'string', required: true },
        start: { type: 'string', required: false },
        end: { type: 'string', required: false },
        description: { type: 'string', required: false }
      }
    },
    permissionLevel: registry.permissionLevels.USER_DATA,
    icon: 'bi-calendar-plus',
    execute: async (params) => {
      const biz = getActiveBusiness(stateInstance);
      if (isBrowser) setCharacterEmotion('event');
      const rec = {
        summary: params.summary,
        start: params.start || new Date().toISOString().slice(0, 10),
        end: params.end || new Date().toISOString().slice(0, 10),
        description: params.description || ''
      };
      const emb = await computeEmbedding('calendar_events', rec, stateInstance);
      await dbInstance.addRecord(biz.id, 'calendar_events', rec, emb);
      if (isBrowser) renderExplorerTable();
      return { text: `Calendar event scheduled: **"${rec.summary}"**.` };
    }
  });

  registry.register({
    name: 'check_calendar',
    description: 'Check upcoming appointments and schedule',
    schema: { parameters: {} },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-calendar-week',
    execute: async () => {
      const biz = getActiveBusiness(stateInstance);
      if (isBrowser) setCharacterEmotion('event');
      const events = await dbInstance.getRecords(biz.id, 'calendar_events');
      if (!events.length) return { text: "Your workspace schedule is clear." };
      return {
        text: `### 📅 Upcoming Schedule:\n` + events.map(e => `- **${e.data.summary}** (${e.data.start})`).join('\n')
      };
    }
  });

  registry.register({
    name: 'create_schema',
    description: 'Dynamically create a new data schema with typed fields',
    schema: {
      parameters: {
        name: { type: 'string', required: true },
        fields: { type: 'object', required: false },
        vectorize: { type: 'array', required: false }
      }
    },
    permissionLevel: registry.permissionLevels.CONFIG,
    icon: 'bi-diagram-3',
    execute: async (params) => {
      const biz = getActiveBusiness(stateInstance);
      const name = params.name.toLowerCase().trim();
      const schemaDef = {
        fields: params.fields || { title: "string", description: "string", status: "string" },
        vectorize: params.vectorize || ["title", "description"]
      };
      await configAPI.addSchema(biz.id, name, schemaDef);
      if (isBrowser) {
        renderExplorerSchemas();
        renderConfigEditor();
      }
      return { text: `Created dynamic schema **"${name}"** in workspace "${biz.name}".` };
    }
  });

  registry.register({
    name: 'search',
    description: 'Instant semantic search across all indexed data records',
    schema: {
      parameters: { query: { type: 'string', required: true } }
    },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-search',
    execute: async (params) => {
      const biz = getActiveBusiness(stateInstance);
      if (isBrowser) setCharacterEmotion('search');
      const query = params.query;
      const records = await dbInstance.getRecords(biz.id);
      if (!records.length) return { text: "No records found in this workspace." };

      let queryVec = null;
      try {
        const embedder = await getModel('feature-extraction', stateInstance.config.modelSettings.embedder, stateInstance);
        if (embedder) {
          const queryOut = await embedder(query, { pooling: 'mean', normalize: true });
          queryVec = Array.from(queryOut.data);
        }
      } catch (e) {}

      const scored = [];
      for (const rec of records) {
        if (queryVec && rec.embedding) {
          const sim = cosineSimilarity(queryVec, rec.embedding);
          if (sim > 0.15) scored.push({ rec, score: sim });
        } else {
          const matchCount = Object.values(rec.data || {}).filter(val =>
            String(val).toLowerCase().includes(query.toLowerCase())
          ).length;
          if (matchCount > 0) scored.push({ rec, score: matchCount * 0.2 });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, 5);
      if (!top.length) return { text: `No semantic matches found for "${query}".` };

      const items = top.map(m =>
        `- **[${m.rec.schemaName}]** ${JSON.stringify(m.rec.data)} *(Match: ${Math.round(Math.min(m.score, 1) * 100)}%)*`
      ).join('\n');
      return { text: `### 🔍 Semantic Matches:\n${items}` };
    }
  });

  registry.register({
    name: 'update_config',
    description: 'Update a configuration value by path (AI-accessible)',
    schema: {
      parameters: {
        path: { type: 'string', required: true },
        value: { required: true }
      }
    },
    permissionLevel: registry.permissionLevels.CONFIG,
    icon: 'bi-gear',
    execute: async (params) => {
      await configAPI.updateConfig(params.path, params.value);
      if (isBrowser) {
        updateHeaderUI();
        renderConfigEditor();
        populateModelSelects();
      }
      return { text: `Configuration updated at **${params.path}**.` };
    }
  });

  registry.register({
    name: 'get_config',
    description: 'Get a configuration value by path (AI-accessible)',
    schema: {
      parameters: { path: { type: 'string', required: true } }
    },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-info-circle',
    execute: async (params) => {
      const val = await configAPI.getConfig(params.path);
      return { text: `Config at \`${params.path}\`: \`${JSON.stringify(val)}\`` };
    }
  });

  registry.register({
    name: 'add_character',
    description: 'Add a new character/persona to the system (AI-accessible)',
    schema: {
      parameters: { character: { type: 'object', required: true } }
    },
    permissionLevel: registry.permissionLevels.CONFIG,
    icon: 'bi-person-plus',
    execute: async (params) => {
      const res = await configAPI.addCharacter(params.character);
      if (isBrowser) renderCharacters();
      return { text: `Character **"${res.character}"** added successfully.` };
    }
  });

  registry.register({
    name: 'add_business',
    description: 'Add a new business/workspace to the system (AI-accessible)',
    schema: {
      parameters: { business: { type: 'object', required: true } }
    },
    permissionLevel: registry.permissionLevels.CONFIG,
    icon: 'bi-building-add',
    execute: async (params) => {
      const res = await configAPI.addBusiness(params.business);
      if (isBrowser) renderBusinesses();
      return { text: `Workspace **"${res.business}"** added successfully.` };
    }
  });

  registry.register({
    name: 'create_tool',
    description: 'Create and register a new tool dynamically (AI-accessible)',
    schema: {
      parameters: { toolDefinition: { type: 'object', required: true } }
    },
    permissionLevel: registry.permissionLevels.SYSTEM,
    icon: 'bi-tools',
    execute: async (params) => {
      const res = await registry.registerToolFromAI(params.toolDefinition, dbInstance);
      if (isBrowser) renderTools();
      return { text: `Dynamic tool **"${res.tool}"** created and registered.` };
    }
  });

  registry.register({
    name: 'rollback_config',
    description: 'Rollback configuration to a previous state (AI-accessible)',
    schema: {
      parameters: { timestamp: { type: 'number', required: false } }
    },
    permissionLevel: registry.permissionLevels.CONFIG,
    icon: 'bi-arrow-counterclockwise',
    execute: async (params) => {
      let ts = params.timestamp;
      if (!ts) {
        const history = await configAPI.getHistory(2);
        if (history.length > 0) ts = history[0].id; // use id instead of timestamp
        else return { text: "No configuration snapshots available for rollback." };
      }
      const res = await configAPI.rollback(ts);
      if (isBrowser) {
        renderConfigEditor();
        updateHeaderUI();
        populateModelSelects();
      }
      return { text: `Configuration rolled back to state from ${res.rolledBackTo}.` };
    }
  });

  registry.register({
    name: 'list_tools',
    description: 'List all available tools with their schemas (AI-accessible)',
    schema: { parameters: {} },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-list-check',
    execute: async () => {
      const tools = registry.getAllTools();
      const list = tools.map(t => `- **${t.name}**: ${t.description} *(Permission: ${t.permissionLevel})*`).join('\n');
      return { text: `### 🛠️ Active Tools (${tools.length}):\n${list}` };
    }
  });

  registry.register({
    name: 'execute_chain',
    description: 'Execute a chain of tools in sequence (AI-accessible)',
    schema: {
      parameters: { chain: { type: 'object', required: true } }
    },
    permissionLevel: registry.permissionLevels.USER_DATA,
    icon: 'bi-link',
    execute: async (params) => {
      const chainExec = new ToolChain(registry);
      const res = await chainExec.execute(params.chain);
      const summary = res.results.map(r => `- Step ${r.stepIndex + 1} (${r.tool}): ${r.success ? '✓' : '✗ ' + r.error}`).join('\n');
      return { text: `### 🔗 Chain Execution Result:\n${summary}` };
    }
  });

  registry.register({
    name: 'delegate_to_agent',
    description: 'Delegate a task to another specialized agent (AI-accessible)',
    schema: {
      parameters: {
        targetAgentId: { type: 'string', required: true },
        message: { type: 'string', required: true },
        context: { type: 'object', required: false }
      }
    },
    permissionLevel: registry.permissionLevels.USER_DATA,
    icon: 'bi-person-workspace',
    execute: async (params) => {
      const current = getActiveCharacter(stateInstance);
      const target = stateInstance.config.characters.find(c => c.id === params.targetAgentId);
      if (!target) return { text: `Agent "${params.targetAgentId}" not found.` };

      const delegation = await agentCommInstance.delegateToAgent(current.id, params.targetAgentId, params.message, params.context);
      if (delegation.status === 'completed') {
        return {
          text: `Delegated to **${target.name}**:\n\n${agentCommInstance.formatAgentResponse(target.name, delegation.result.text)}`
        };
      }
      return { text: `Delegation to ${target.name} failed: ${delegation.error}` };
    }
  });

  registry.register({
    name: 'ask_agent',
    description: 'Ask a specific agent a question for collaboration (AI-accessible)',
    schema: {
      parameters: {
        targetAgentId: { type: 'string', required: true },
        message: { type: 'string', required: true }
      }
    },
    permissionLevel: registry.permissionLevels.USER_DATA,
    icon: 'bi-chat-quote',
    execute: async (params) => {
      const current = getActiveCharacter(stateInstance);
      const answer = await agentCommInstance.askAgent(current.id, params.targetAgentId, params.message);
      return {
        text: `**${current.name}**: I consulted with **${answer.agentName}**.\n\n**${answer.agentName}**: ${answer.text}`
      };
    }
  });

  registry.register({
    name: 'list_agents',
    description: 'List all available agents and their specializations (AI-accessible)',
    schema: { parameters: {} },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-people',
    execute: async () => {
      const chars = stateInstance.config.characters || [];
      const list = chars.map(c => {
        const caps = agentCommInstance.getAgentCapabilities(c).join(', ');
        return `- **${c.name}** (${c.persona}): Specializes in *${caps}*`;
      }).join('\n');
      return { text: `### 👥 Available Workspace Agents:\n${list}` };
    }
  });

  registry.register({
    name: 'route_to_specialist',
    description: 'Automatically route query to the best specialist agent (AI-accessible)',
    schema: {
      parameters: { query: { type: 'string', required: true } }
    },
    permissionLevel: registry.permissionLevels.USER_DATA,
    icon: 'bi-signpost-split',
    execute: async (params) => {
      const current = getActiveCharacter(stateInstance);
      const specialist = agentCommInstance.getBestAgentForQuery(params.query);
      if (!specialist || specialist.id === current.id) {
        const detected = await detectIntent(params.query, stateInstance);
        const res = await executeTool(detected, params.query, stateInstance);
        return res;
      }
      const delegation = await agentCommInstance.delegateToAgent(current.id, specialist.id, params.query);
      if (delegation.status === 'completed') {
        return {
          text: `Routed to specialist **${specialist.name}**:\n\n${agentCommInstance.formatAgentResponse(specialist.name, delegation.result.text)}`
        };
      }
      return { text: `Specialist routing to ${specialist.name} failed: ${delegation.error}` };
    }
  });

  registry.register({
    name: 'web_search',
    description: 'Search the internet for information (AI-accessible)',
    schema: {
      parameters: { query: { type: 'string', required: true } }
    },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-globe',
    execute: async (params) => {
      const q = params.query;
      try {
        const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=0`);
        const data = await res.json();
        const results = [];
        if (data.Abstract) results.push(`**Abstract:** ${data.Abstract}`);
        if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
          const topics = data.RelatedTopics.slice(0, 4)
            .filter(t => t.Text && t.FirstURL)
            .map(t => `- [${t.Text}](${t.FirstURL})`);
          if (topics.length) results.push(`**Related:**\n${topics.join('\n')}`);
        }
        if (results.length === 0) {
          return {
            text: `### 🔍 Web Search for "${q}":\nNo instant abstract found. [Search directly on DuckDuckGo](https://duckduckgo.com/?q=${encodeURIComponent(q)}).`
          };
        }
        return { text: `### 🔍 Web Results for "${q}":\n\n${results.join('\n\n')}` };
      } catch (err) {
        return {
          text: `Web search: [Open "${q}" on DuckDuckGo](https://duckduckgo.com/?q=${encodeURIComponent(q)})`
        };
      }
    }
  });

  registry.register({
    name: 'google_calendar_list',
    description: 'List Google Calendar events (AI-accessible)',
    schema: { parameters: {} },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-calendar-event',
    execute: async () => {
      try {
        return await googleAPIInstance.listCalendarEvents();
      } catch (err) {
        return { text: `⚠️ ${err.message}` };
      }
    }
  });

  registry.register({
    name: 'google_drive_list',
    description: 'List Google Drive files (AI-accessible)',
    schema: { parameters: {} },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-google',
    execute: async () => {
      try {
        return await googleAPIInstance.listDriveFiles();
      } catch (err) {
        return { text: `⚠️ ${err.message}` };
      }
    }
  });

  registry.register({
    name: 'google_sheets_read',
    description: 'Read Google Sheets data (AI-accessible)',
    schema: {
      parameters: {
        spreadsheetId: { type: 'string', required: true },
        range: { type: 'string', required: false }
      }
    },
    permissionLevel: registry.permissionLevels.READ_ONLY,
    icon: 'bi-table',
    execute: async (params) => {
      try {
        return await googleAPIInstance.readSheet(params.spreadsheetId, params.range);
      } catch (err) {
        return { text: `⚠️ ${err.message}` };
      }
    }
  });

  registry.register({
    name: 'change_character_name',
    description: "Change the current character's name (AI-accessible)",
    schema: {
      parameters: { name: { type: 'string', required: true } }
    },
    permissionLevel: registry.permissionLevels.CONFIG,
    icon: 'bi-person-badge',
    execute: async (params) => {
      const current = getActiveCharacter(stateInstance);
      const newName = params.name.trim();
      if (!newName) return { text: "Please provide a valid character name." };
      await configAPI.updateCharacter(current.id, { name: newName });
      if (isBrowser) {
        updateHeaderUI();
        renderCharacters();
      }
      return { text: `My name has been changed to **${newName}**.` };
    }
  });
}

/* ==========================================================================
   13. Global State & Initialization
   ========================================================================== */
export const db = new WorkspaceDB();
export const toolRegistry = new ToolRegistry();
export const state = {
  config: null,
  activeCharacterId: null,
  activeBusinessId: null,
  models: {},
  chatHistory: [],
  speechRecognition: null,
  isListening: false
};
export const configAPI = new ConfigAPI(db, state);
export const agentComm = new AgentCommunication(state, db);
export const googleAPI = new GoogleAPI(state, db);
export const toolChain = new ToolChain(toolRegistry);

export function getActiveCharacter(stateInstance = state) {
  if (!stateInstance.config || !stateInstance.config.characters || stateInstance.config.characters.length === 0) {
    return {
      id: stateInstance.config?.app?.defaultCharacter || 'agent',
      name: stateInstance.config?.app?.name || 'Agent',
      persona: stateInstance.config?.app?.subtitle || 'Assistant',
      color: stateInstance.config?.app?.theme?.primary || '#4f46e5'
    };
  }
  return stateInstance.config.characters.find(c => c.id === stateInstance.activeCharacterId) ||
         stateInstance.config.characters[0];
}

export function getActiveBusiness(stateInstance = state) {
  if (!stateInstance.config || !stateInstance.config.businesses || stateInstance.config.businesses.length === 0) {
    return {
      id: stateInstance.config?.app?.defaultBusiness || 'workspace',
      name: 'Default Workspace',
      schemas: {}
    };
  }
  return stateInstance.config.businesses.find(b => b.id === stateInstance.activeBusinessId) ||
         stateInstance.config.businesses[0];
}

export async function loadConfiguration(stateInstance = state, dbInstance = db) {
  let diskConfig = null;

  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    try {
      const fs = await import('fs');
      diskConfig = JSON.parse(fs.readFileSync('config.json', 'utf8'));
    } catch (e) {}
  } else if (typeof fetch !== 'undefined') {
    try {
      const res = await fetch('config.json');
      if (res.ok) {
        diskConfig = await res.json();
      }
    } catch (e) {
      try {
        const res = await fetch('./config.json');
        if (res.ok) {
          diskConfig = await res.json();
        }
      } catch (e2) {}
    }
  }

  const saved = await dbInstance.getKV('app_config');
  if (saved) {
    try {
      validateConfig(saved);
      // Saved config is valid
      if (!diskConfig || !diskConfig.app?.version || saved.app?.version === diskConfig.app?.version) {
        stateInstance.config = saved;
        return stateInstance.config;
      }
      // If disk config is newer, we'll use it below
    } catch (e) {
      console.warn('Saved config failed validation, discarding:', e);
      // Do NOT fall back to saved; continue to try disk config
    }
  }

  if (diskConfig) {
    validateConfig(diskConfig);
    stateInstance.config = diskConfig;
    await dbInstance.setKV('app_config', stateInstance.config);
    return stateInstance.config;
  }

  // If we still have a saved config that was valid, we would have returned already;
  // so if we reach here, there's no valid config.
  throw new Error('Could not load a valid configuration (config.json).');
}

/* ==========================================================================
   14. UI Controllers & DOM Rendering
   ========================================================================== */
export function setCharacterEmotion(emotionName = 'neutral') {
  if (!isBrowser) return;
  const char = getActiveCharacter();
  const avatarEl = document.getElementById('current-avatar');
  const wrapEl = document.getElementById('current-avatar-wrap');
  if (!avatarEl || !wrapEl) return;

  const emoji = char.emotions?.[emotionName] || char.emotions?.neutral || '🤖';
  avatarEl.textContent = emoji;
  wrapEl.style.backgroundColor = char.color || 'var(--app-primary)';
}

export function applyTheme(mode) {
  if (!isBrowser) return;
  document.documentElement.setAttribute('data-bs-theme', mode);
  const icon = document.getElementById('themeIcon');
  const label = document.getElementById('themeLabel');
  if (icon && label) {
    icon.className = mode === 'dark' ? 'bi bi-sun-fill' : 'bi bi-moon-stars';
    label.textContent = mode === 'dark' ? 'Light' : 'Dark';
  }
  if (state.config?.app) {
    if (!state.config.app.theme) state.config.app.theme = { mode };
    else state.config.app.theme.mode = mode;
  }
}

export function updateHeaderUI() {
  if (!isBrowser || !state.config) return;
  const char = getActiveCharacter();
  const biz = getActiveBusiness();

  const nameEl = document.getElementById('current-name');
  const personaEl = document.getElementById('current-persona');
  const bizLabelEl = document.getElementById('activeBizLabel');
  const bizBadgeEl = document.getElementById('activeBizBadge');
  const brandEl = document.getElementById('appBrandName');
  const mobileBrandEl = document.getElementById('mobileBrandName');
  const subEl = document.getElementById('appBrandSubtitle');

  if (nameEl) nameEl.textContent = char.name;
  if (personaEl) personaEl.textContent = char.persona;
  if (bizLabelEl) bizLabelEl.textContent = biz.name;
  if (bizBadgeEl) bizBadgeEl.textContent = biz.name;
  if (brandEl) brandEl.textContent = state.config.app.name;
  if (mobileBrandEl) mobileBrandEl.textContent = state.config.app.name;
  if (subEl) subEl.textContent = state.config.app.subtitle;

  setCharacterEmotion('neutral');

  const charMenu = document.getElementById('charSwitchMenu');
  if (charMenu && state.config.characters) {
    charMenu.innerHTML = state.config.characters.map(c => `
      <li><button class="dropdown-item ${c.id === state.activeCharacterId ? 'active' : ''}" data-sw-char="${c.id}">
        ${c.emotions?.neutral || '🤖'} ${c.name}
      </button></li>
    `).join('');
    charMenu.querySelectorAll('[data-sw-char]').forEach(b => {
      b.onclick = () => {
        state.activeCharacterId = b.dataset.swChar;
        updateHeaderUI();
        renderCharacters();
        showToast(`Switched active agent to ${getActiveCharacter().name}`);
      };
    });
  }

  const bizMenu = document.getElementById('bizSwitchMenu');
  if (bizMenu && state.config.businesses) {
    bizMenu.innerHTML = state.config.businesses.map(b => `
      <li><button class="dropdown-item ${b.id === state.activeBusinessId ? 'active' : ''}" data-sw-biz="${b.id}">
        <i class="bi bi-building"></i> ${b.name}
      </button></li>
    `).join('');
    bizMenu.querySelectorAll('[data-sw-biz]').forEach(b => {
      b.onclick = () => {
        state.activeBusinessId = b.dataset.swBiz;
        updateHeaderUI();
        renderBusinesses();
        renderExplorerSchemas();
        showToast(`Switched workspace to ${getActiveBusiness().name}`);
      };
    });
  }
}

export function renderQuickPrompts() {
  if (!isBrowser || !state.config) return;
  const container = document.getElementById('quickPromptsContainer');
  if (!container) return;
  container.innerHTML = (state.config.quickPrompts || []).map(q => `
    <button class="btn btn-sm btn-outline-secondary rounded-pill text-nowrap d-flex align-items-center gap-1" data-query="${escapeHtml(q.query)}" data-emo="${q.emotion || 'neutral'}">
      <span>${escapeHtml(q.label)}</span>
    </button>
  `).join('');

  container.querySelectorAll('[data-query]').forEach(btn => {
    btn.onclick = () => {
      const input = document.getElementById('chatInput');
      if (input) {
        input.value = btn.dataset.query;
        setCharacterEmotion(btn.dataset.emo);
        const sendBtn = document.getElementById('sendBtn');
        if (sendBtn) sendBtn.click();
      }
    };
  });
}

export function renderCharacters() {
  if (!isBrowser || !state.config) return;
  const list = document.getElementById('characterList');
  if (!list) return;
  list.innerHTML = (state.config.characters || []).map(c => `
    <div class="list-group-item d-flex align-items-center gap-3 py-3">
      <span class="rounded-circle text-white d-inline-flex align-items-center justify-content-center flex-shrink-0 list-avatar" style="background-color: ${c.color || 'var(--app-primary)'}">
        ${c.emotions?.neutral || '🤖'}
      </span>
      <div class="flex-grow-1 min-w-0">
        <div class="fw-bold">${escapeHtml(c.name)} ${c.id === state.activeCharacterId ? '<span class="badge text-bg-primary ms-1">Active</span>' : ''}</div>
        <small class="text-body-secondary text-truncate d-block">${escapeHtml(c.persona)}</small>
        ${c.specialization ? `<small class="text-primary">${c.specialization.map(s => `#${s}`).join(' ')}</small>` : ''}
      </div>
      <button class="btn btn-sm btn-outline-secondary" data-sel-char="${c.id}"><i class="bi bi-check2"></i> Select</button>
    </div>
  `).join('');

  list.querySelectorAll('[data-sel-char]').forEach(b => {
    b.onclick = () => {
      state.activeCharacterId = b.dataset.selChar;
      updateHeaderUI();
      renderCharacters();
      showToast(`Active agent: ${getActiveCharacter().name}`);
    };
  });
}

export function renderBusinesses() {
  if (!isBrowser || !state.config) return;
  const list = document.getElementById('businessList');
  if (!list) return;
  list.innerHTML = (state.config.businesses || []).map(b => `
    <div class="list-group-item d-flex align-items-center gap-3 py-3">
      <span class="rounded-circle bg-secondary text-white d-inline-flex align-items-center justify-content-center flex-shrink-0 list-avatar">
        <i class="bi bi-building"></i>
      </span>
      <div class="flex-grow-1 min-w-0">
        <div class="fw-bold">${escapeHtml(b.name)} ${b.id === state.activeBusinessId ? '<span class="badge text-bg-primary ms-1">Active</span>' : ''}</div>
        <small class="text-body-secondary">${Object.keys(b.schemas || {}).length} Schemas Configured</small>
      </div>
      <button class="btn btn-sm btn-outline-secondary" data-sel-biz="${b.id}"><i class="bi bi-check2"></i> Select</button>
    </div>
  `).join('');

  list.querySelectorAll('[data-sel-biz]').forEach(b => {
    b.onclick = () => {
      state.activeBusinessId = b.dataset.selBiz;
      updateHeaderUI();
      renderBusinesses();
      renderExplorerSchemas();
      showToast(`Active workspace: ${getActiveBusiness().name}`);
    };
  });
}

export function renderTools() {
  if (!isBrowser || !state.config) return;
  const list = document.getElementById('toolsList');
  if (!list) return;
  const tools = toolRegistry.getAllTools();
  list.innerHTML = tools.map(t => `
    <div class="list-group-item d-flex align-items-center gap-3 py-3">
      <span class="rounded-circle bg-body-secondary text-primary d-inline-flex align-items-center justify-content-center flex-shrink-0 tool-icon">
        <i class="bi ${t.icon || 'bi-tools'}"></i>
      </span>
      <div class="flex-grow-1 min-w-0">
        <div class="d-flex align-items-center gap-2">
          <strong class="font-monospace">${escapeHtml(t.name)}</strong>
          <span class="badge bg-secondary-subtle text-secondary-emphasis">${t.permissionLevel}</span>
        </div>
        <small class="text-body-secondary d-block">${escapeHtml(t.description)}</small>
      </div>
    </div>
  `).join('');
}

export function renderExplorerSchemas() {
  if (!isBrowser || !state.config) return;
  const sel = document.getElementById('explorerSchemaSelect');
  if (!sel) return;
  const biz = getActiveBusiness();
  const schemas = Object.keys(biz.schemas || {});
  sel.innerHTML = schemas.map(s => `<option value="${s}">${s}</option>`).join('');
  renderExplorerTable();
}

export async function renderExplorerTable(filterText = '') {
  if (!isBrowser || !state.config) return;
  const sel = document.getElementById('explorerSchemaSelect');
  const schemaName = sel ? sel.value : null;
  const thead = document.getElementById('explorerTableHead');
  const tbody = document.getElementById('explorerTableBody');
  const countBadge = document.getElementById('tableRecordCount');
  if (!thead || !tbody) return;

  const biz = getActiveBusiness();
  const schema = biz.schemas?.[schemaName];
  if (!schema || !schema.fields || typeof schema.fields !== 'object') {
    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td class="text-body-secondary p-3">Selected schema is invalid or missing fields definition.</td></tr>';
    if (countBadge) countBadge.textContent = '0 records';
    return;
  }

  const fields = Object.keys(schema.fields || {});
  thead.innerHTML = `
    <th>ID</th>
    ${fields.map(f => `<th class="text-capitalize">${escapeHtml(f)}</th>`).join('')}
    <th>Index</th>
    <th class="text-end">Actions</th>
  `;

  const allRecords = await db.getRecords(biz.id, schemaName);
  const records = filterText ? filterRecords(allRecords, filterText) : allRecords;

  if (countBadge) {
    countBadge.textContent = filterText
      ? `${records.length} of ${allRecords.length} records`
      : `${records.length} records`;
  }

  if (!records.length) {
    tbody.innerHTML = `<tr><td colspan="${fields.length + 3}" class="text-center py-4 text-body-secondary">No records match criteria in "${schemaName}".</td></tr>`;
    return;
  }

  tbody.innerHTML = records.map(r => `
    <tr>
      <td class="font-monospace small text-body-secondary">${r.id.slice(-6)}</td>
      ${fields.map(f => `<td>${escapeHtml(String(r.data[f] ?? ''))}</td>`).join('')}
      <td>${r.embedding ? '<span class="badge text-bg-success">Vectorized</span>' : '<span class="badge text-bg-secondary">Unindexed</span>'}</td>
      <td class="text-end">
        <button class="btn btn-sm btn-outline-danger py-0 px-2" data-del="${r.id}"><i class="bi bi-trash"></i></button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => {
      await db.deleteRecord(b.dataset.del);
      renderExplorerTable(document.getElementById('tableFilterInput')?.value || '');
      showToast('Record deleted');
    };
  });
}

export function renderConfigEditor() {
  if (!isBrowser || !state.config) return;
  const editor = document.getElementById('configEditor');
  if (editor) editor.value = JSON.stringify(state.config, null, 2);
  renderConfigHistory();
  populateModelSelects(); // Update model dropdowns when config changes
}

export async function renderConfigHistory() {
  if (!isBrowser) return;
  const container = document.getElementById('configHistoryList');
  if (!container) return;
  const history = await configAPI.getHistory(20);
  if (!history.length) {
    container.innerHTML = '<small class="text-body-secondary">No configuration changes recorded yet.</small>';
    return;
  }

  container.innerHTML = history.map(h => `
    <div class="card border-0 bg-body-tertiary p-2">
      <div class="d-flex align-items-center justify-content-between">
        <div>
          <small class="fw-semibold text-capitalize">${escapeHtml(h.action)}</small>
          <small class="text-body-secondary d-block font-monospace">${escapeHtml(h.target)}</small>
        </div>
        <div class="d-flex align-items-center gap-2">
          <small class="text-body-secondary">${new Date(h.timestamp).toLocaleTimeString()}</small>
          <button class="btn btn-sm btn-outline-secondary py-0 px-2" data-rollback="${h.id}" title="Rollback to this point">
            <i class="bi bi-arrow-counterclockwise"></i>
          </button>
        </div>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-rollback]').forEach(btn => {
    btn.onclick = async () => {
      try {
        await configAPI.rollback(btn.dataset.rollback);
        renderConfigEditor();
        updateHeaderUI();
        renderQuickPrompts();
        renderCharacters();
        renderBusinesses();
        renderExplorerSchemas();
        showToast('Configuration restored successfully');
      } catch (e) {
        showToast(`Rollback failed: ${e.message}`);
      }
    };
  });
}

export function appendChatMessage(role, content, meta = null, saveToDb = true) {
  if (!isBrowser) return;
  const container = document.getElementById('chatMessages');
  if (!container) return;
  const char = getActiveCharacter();

  const row = document.createElement('div');
  row.className = `d-flex align-items-end gap-2 mb-3 ${role === 'user' ? 'flex-row-reverse' : ''}`;

  const avatar = document.createElement('span');
  avatar.className = `rounded-circle text-white d-inline-flex align-items-center justify-content-center flex-shrink-0 chat-avatar ${role === 'user' ? 'bg-primary' : ''}`;
  if (role === 'user') {
    avatar.innerHTML = '<i class="bi bi-person-fill"></i>';
  } else {
    avatar.style.backgroundColor = char.color || 'var(--app-primary)';
    avatar.textContent = char.emotions?.neutral || '🤖';
  }

  const bubble = document.createElement('div');
  bubble.className = role === 'user'
    ? 'card bg-primary text-white border-0 shadow-sm p-3 rounded-4 chat-bubble'
    : 'card bg-body-tertiary border shadow-sm p-3 rounded-4 chat-bubble';

  if (typeof marked !== 'undefined') {
    bubble.innerHTML = marked.parse(content || '');
  } else {
    bubble.textContent = content || '';
  }

  if (meta?.chart && typeof Chart !== 'undefined') {
    const canvasBox = document.createElement('div');
    canvasBox.className = 'bg-body p-2 rounded border mt-2';
    canvasBox.innerHTML = `<canvas id="${meta.chart.id}"></canvas>`;
    bubble.appendChild(canvasBox);
    setTimeout(() => {
      const ctx = document.getElementById(meta.chart.id);
      if (ctx) {
        new Chart(ctx, {
          type: meta.chart.type,
          data: {
            labels: meta.chart.labels,
            datasets: [{
              data: meta.chart.data,
              backgroundColor: state.config?.app?.ui?.chartColors || ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6']
            }]
          },
          options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
        });
      }
    }, 100);
  }

  row.appendChild(avatar);
  row.appendChild(bubble);
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;

  const msgObj = {
    id: 'm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    businessId: state.activeBusinessId,
    role,
    content,
    meta,
    timestamp: Date.now()
  };
  state.chatHistory.push(msgObj);
  if (saveToDb) {
    db.addChatMessage(msgObj);
  }

  if (role === 'ai' && state.config?.app?.voice?.autoSpeak) {
    speakSpeech(content);
  }
}

export function showTypingIndicator() {
  if (!isBrowser) return;
  const container = document.getElementById('chatMessages');
  if (!container || document.getElementById('typingBubble')) return;

  const char = getActiveCharacter();
  const thinkingEmoji = char?.emotions?.thinking || '🤔';
  const charColor = char?.color || 'var(--app-primary)';

  const row = document.createElement('div');
  row.className = 'd-flex align-items-center gap-2 mb-3';
  row.id = 'typingBubble';
  row.innerHTML = `
    <span class="rounded-circle text-white d-inline-flex align-items-center justify-content-center flex-shrink-0 typing-avatar" style="background-color: ${escapeHtml(charColor)};">${thinkingEmoji}</span>
    <div class="card bg-body-tertiary border p-2 rounded-4">
      <div class="spinner-grow spinner-grow-sm text-primary" role="status"></div>
    </div>
  `;
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

export function hideTypingIndicator() {
  if (!isBrowser) return;
  document.getElementById('typingBubble')?.remove();
}

export function speakSpeech(text) {
  if (!isBrowser || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const clean = text.replace(/[*#_`]/g, '');
  const char = getActiveCharacter();
  const utter = new SpeechSynthesisUtterance(clean);
  utter.pitch = char.voicePitch || 1.0;
  utter.rate = char.voiceRate || 1.0;
  utter.lang = state.config?.app?.voice?.lang || 'en-US';
  window.speechSynthesis.speak(utter);
}

export function showToast(text) {
  if (!isBrowser) return;
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast show align-items-center text-bg-dark border-0 mb-2';
  el.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${escapeHtml(text)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>
  `;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function initSidebarResize() {
  if (!isBrowser) return;
  const sidebar = document.getElementById('sidebar');
  const resizeHandle = document.getElementById('resizeHandle');
  if (!sidebar || !resizeHandle) return;

  let saved = null;
  try {
    saved = localStorage.getItem('sidebarWidth');
  } catch (e) {}
  if (saved) sidebar.style.width = saved + 'px';

  let isResizing = false;
  let startX = 0;
  let startW = 0;

  const minW = state.config?.app?.ui?.sidebar?.minWidth || 200;
  const maxW = state.config?.app?.ui?.sidebar?.maxWidth || 500;

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    resizeHandle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newWidth = Math.max(minW, Math.min(maxW, startW + (e.clientX - startX)));
    sidebar.style.width = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      resizeHandle.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem('sidebarWidth', sidebar.offsetWidth);
      } catch (e) {}
    }
  });
}

export function initTabNavigation() {
  if (!isBrowser) return;
  const tabButtons = document.querySelectorAll('#workspaceTabs button[data-bs-toggle="pill"]');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const targetPaneId = btn.getAttribute('data-bs-target');
      document.querySelectorAll('.tab-content .tab-pane').forEach(p => p.classList.remove('show', 'active'));
      const targetPane = document.querySelector(targetPaneId);
      if (targetPane) targetPane.classList.add('show', 'active');
    });
  });
}

/* ==========================================================================
   15. Model Selection UI Helpers
   ========================================================================== */
export function populateModelSelects() {
  if (!isBrowser || !state.config) return;

  const embedderSelect = document.getElementById('embedderModelSelect');
  const classifierSelect = document.getElementById('classifierModelSelect');
  const generatorSelect = document.getElementById('generatorModelSelect');
  const dtypeSelect = document.getElementById('dtypeSelect');

  if (!embedderSelect || !classifierSelect || !generatorSelect) return;

  const availableModels = state.config.modelSettings?.availableModels || [];
  const currentEmbedder = state.config.modelSettings?.embedder;
  const currentClassifier = state.config.modelSettings?.classifier;
  const currentGenerator = state.config.modelSettings?.generator;

  // Helper to ensure current model is in list even if missing
  function ensureCurrentModel(list, currentId, type) {
    if (currentId && !list.some(m => m.id === currentId)) {
      list.push({ id: currentId, name: currentId.split('/').pop(), type });
    }
    return list;
  }

  let embedders = availableModels.filter(m => m.type === 'embedder');
  let classifiers = availableModels.filter(m => m.type === 'classifier');
  let generators = availableModels.filter(m => m.type === 'generator');

  embedders = ensureCurrentModel(embedders, currentEmbedder, 'embedder');
  classifiers = ensureCurrentModel(classifiers, currentClassifier, 'classifier');
  generators = ensureCurrentModel(generators, currentGenerator, 'generator');

  embedderSelect.innerHTML = embedders.map(m =>
    `<option value="${m.id}" ${m.id === currentEmbedder ? 'selected' : ''}>${m.name || m.id}</option>`
  ).join('') || '<option value="">No embedder models</option>';

  classifierSelect.innerHTML = classifiers.map(m =>
    `<option value="${m.id}" ${m.id === currentClassifier ? 'selected' : ''}>${m.name || m.id}</option>`
  ).join('') || '<option value="">No classifier models</option>';

  generatorSelect.innerHTML = generators.map(m =>
    `<option value="${m.id}" ${m.id === currentGenerator ? 'selected' : ''}>${m.name || m.id}</option>`
  ).join('') || '<option value="">No generator models</option>';

  if (dtypeSelect) {
    const currentDtype = state.config.modelSettings?.dtype || 'q8';
    dtypeSelect.value = currentDtype;
  }

  // Add event listeners if not already added
  if (!embedderSelect.dataset.listener) {
    embedderSelect.addEventListener('change', async (e) => {
      state.config.modelSettings.embedder = e.target.value;
      await db.setKV('app_config', state.config);
      showToast(`Embedder model changed to ${e.target.value}`);
      renderConfigEditor(); // update config textarea
    });
    embedderSelect.dataset.listener = '1';
  }
  if (!classifierSelect.dataset.listener) {
    classifierSelect.addEventListener('change', async (e) => {
      state.config.modelSettings.classifier = e.target.value;
      await db.setKV('app_config', state.config);
      showToast(`Classifier model changed to ${e.target.value}`);
      renderConfigEditor();
    });
    classifierSelect.dataset.listener = '1';
  }
  if (!generatorSelect.dataset.listener) {
    generatorSelect.addEventListener('change', async (e) => {
      state.config.modelSettings.generator = e.target.value;
      await db.setKV('app_config', state.config);
      showToast(`Generator model changed to ${e.target.value}`);
      renderConfigEditor();
    });
    generatorSelect.dataset.listener = '1';
  }
  if (dtypeSelect && !dtypeSelect.dataset.listener) {
    dtypeSelect.addEventListener('change', async (e) => {
      state.config.modelSettings.dtype = e.target.value;
      await db.setKV('app_config', state.config);
      showToast(`Data type changed to ${e.target.value}`);
      renderConfigEditor();
    });
    dtypeSelect.dataset.listener = '1';
  }

  // Add "Add Model" button if not already present
  if (!document.getElementById('addModelBtn')) {
    const modelsPane = document.getElementById('pane-models');
    if (modelsPane) {
      const addBtn = document.createElement('button');
      addBtn.id = 'addModelBtn';
      addBtn.className = 'btn btn-outline-primary btn-sm mt-3';
      addBtn.innerHTML = '<i class="bi bi-plus-circle"></i> Add Custom Model';
      addBtn.addEventListener('click', addCustomModel);
      modelsPane.appendChild(addBtn);
    }
  }
}

// Function to add a custom model via prompt
export async function addCustomModel() {
  if (!isBrowser || !state.config) return;

  const modelId = window.prompt('Enter the Hugging Face model ID (e.g., Xenova/LaMini-Flan-T5-77M):');
  if (!modelId || !modelId.trim()) return;

  const modelType = window.prompt('Enter model type (embedder, classifier, generator):');
  if (!modelType || !['embedder', 'classifier', 'generator'].includes(modelType.trim().toLowerCase())) {
    showToast('Invalid model type. Must be embedder, classifier, or generator.');
    return;
  }

  const type = modelType.trim().toLowerCase();
  const name = modelId.split('/').pop();

  // Add to availableModels if not already present
  const available = state.config.modelSettings.availableModels || [];
  if (!available.some(m => m.id === modelId)) {
    available.push({ id: modelId, name, type });
    state.config.modelSettings.availableModels = available;
  }

  // Set as current model for its type
  if (type === 'embedder') state.config.modelSettings.embedder = modelId;
  else if (type === 'classifier') state.config.modelSettings.classifier = modelId;
  else if (type === 'generator') state.config.modelSettings.generator = modelId;

  await db.setKV('app_config', state.config);
  populateModelSelects();
  renderConfigEditor();
  showToast(`Model "${modelId}" added as ${type}.`);
}

/* ==========================================================================
   16. Main Initialization Lifecycle
   ========================================================================== */
export async function init() {
  if (!isBrowser) return;

  await db.init();
  await loadConfiguration();

  state.activeCharacterId = state.config.app.defaultCharacter || state.config.characters[0].id;
  state.activeBusinessId = state.config.app.defaultBusiness || state.config.businesses[0].id;

  applyTheme(state.config.app.theme?.mode || 'light');
  initTabNavigation();
  initSidebarResize();

  registerAllCoreTools(toolRegistry, db, state, agentComm, googleAPI);

  const customTools = await db.getKV('custom_tools');
  if (Array.isArray(customTools)) {
    for (const def of customTools) {
      try {
        await toolRegistry.registerToolFromAI(def, db);
      } catch (e) {
        console.warn('Failed to load custom tool:', e);
      }
    }
  }

  updateHeaderUI();
  renderQuickPrompts();
  renderCharacters();
  renderBusinesses();
  renderTools();
  renderExplorerSchemas();
  renderConfigEditor();
  populateModelSelects(); // Populate model dropdowns and add button

  googleAPI.init();

  const history = await db.getChat(state.activeBusinessId);
  const cleanHistory = history.filter(m => !(m.content && m.content.includes('Analyze spending by category') && m.content.includes('Analyze expenses by category')));
  if (cleanHistory.length !== history.length) {
    await db.clearChat(state.activeBusinessId);
    for (const m of cleanHistory) {
      await db.addChatMessage(m);
    }
  }

  if (cleanHistory.length) {
    cleanHistory.forEach(m => appendChatMessage(m.role, m.content, m.meta, false));
  } else {
    appendChatMessage('ai', `Welcome! I am **${getActiveCharacter().name}**. I'm ready to manage your workspace, analyze expenses, track tasks, and query on-device vector stores.`, null, true);
  }

  const tableFilter = document.getElementById('tableFilterInput');
  if (tableFilter) {
    tableFilter.addEventListener('input', (e) => {
      renderExplorerTable(e.target.value);
    });
  }

  const sendAction = async () => {
    const input = document.getElementById('chatInput');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    appendChatMessage('user', q);
    showTypingIndicator();

    try {
      const intent = await detectIntent(q, state);
      const res = await executeTool(intent, q, state);

      const toolCall = parseToolCall(res.text);
      if (toolCall) {
        const chainRes = await executeTool(toolCall.tool, toolCall.params, state);
        hideTypingIndicator();
        appendChatMessage('ai', chainRes.text, chainRes.chart ? { chart: chainRes.chart } : null);
      } else {
        hideTypingIndicator();
        appendChatMessage('ai', res.text, res.chart ? { chart: res.chart } : null);
      }
    } catch (err) {
      hideTypingIndicator();
      setCharacterEmotion('error');
      appendChatMessage('ai', `I encountered an issue executing your request: ${err.message}`);
    }
  };

  const sendBtn = document.getElementById('sendBtn');
  if (sendBtn) sendBtn.onclick = sendAction;

  const chatInput = document.getElementById('chatInput');
  if (chatInput) {
    chatInput.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAction();
      }
    };
  }

  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.onclick = async () => {
      const curr = document.documentElement.getAttribute('data-bs-theme');
      const next = curr === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      await configAPI.updateConfig('app.theme.mode', next);
    };
  }

  const voiceToggle = document.getElementById('voiceAutoToggle');
  if (voiceToggle) {
    voiceToggle.onclick = async (e) => {
      if (!state.config.app.voice) state.config.app.voice = { autoSpeak: false, lang: 'en-US' };
      state.config.app.voice.autoSpeak = !state.config.app.voice.autoSpeak;
      e.currentTarget.classList.toggle('btn-primary', state.config.app.voice.autoSpeak);
      await db.setKV('app_config', state.config);
      showToast(`Auto-voice feedback ${state.config.app.voice.autoSpeak ? 'enabled' : 'disabled'}`);
    };
  }

  const clearBtn = document.getElementById('clearChatBtn');
  if (clearBtn) {
    clearBtn.onclick = async () => {
      await db.clearChat(state.activeBusinessId);
      const container = document.getElementById('chatMessages');
      if (container) container.innerHTML = '';
      state.chatHistory = [];
      showToast('Chat history cleared');
    };
  }

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = document.getElementById('micBtn');
  if (SpeechRec && micBtn) {
    state.speechRecognition = new SpeechRec();
    state.speechRecognition.continuous = false;
    state.speechRecognition.lang = state.config?.app?.voice?.lang || 'en-US';
    state.speechRecognition.onresult = (e) => {
      if (chatInput) chatInput.value = e.results[0][0].transcript;
      micBtn.classList.remove('btn-danger');
      state.isListening = false;
    };
    state.speechRecognition.onerror = () => {
      micBtn.classList.remove('btn-danger');
      state.isListening = false;
    };
    state.speechRecognition.onend = () => {
      micBtn.classList.remove('btn-danger');
      state.isListening = false;
    };
    micBtn.onclick = () => {
      if (!state.isListening) {
        state.speechRecognition.start();
        state.isListening = true;
        micBtn.classList.add('btn-danger');
      } else {
        state.speechRecognition.stop();
        state.isListening = false;
        micBtn.classList.remove('btn-danger');
      }
    };
  } else if (micBtn) {
    micBtn.disabled = true;
    micBtn.title = 'Speech Recognition not supported in this browser';
  }

  const explorerSel = document.getElementById('explorerSchemaSelect');
  if (explorerSel) {
    explorerSel.onchange = () => renderExplorerTable();
  }

  const addRecBtn = document.getElementById('addRecordBtn');
  if (addRecBtn) {
    addRecBtn.onclick = () => {
      const schemaName = document.getElementById('explorerSchemaSelect')?.value;
      const biz = getActiveBusiness();
      const schema = biz.schemas?.[schemaName];
      if (!schema || !schema.fields) return;

      const body = document.getElementById('recordModalBody');
      document.getElementById('recordModalTitle').textContent = `Add Record to "${schemaName}"`;
      body.innerHTML = Object.entries(schema.fields).map(([name, type]) => `
        <div>
          <label class="form-label text-capitalize">${escapeHtml(name)} <small class="text-body-secondary">(${type})</small></label>
          <input class="form-control" id="f_${name}" type="${type === 'number' ? 'number' : 'text'}" required />
        </div>
      `).join('');

      const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('recordModal'));
      modal.show();

      document.getElementById('saveRecordBtn').onclick = async () => {
        const data = {};
        for (const [name, type] of Object.entries(schema.fields)) {
          const el = document.getElementById(`f_${name}`);
          const val = el ? el.value : '';
          data[name] = type === 'number' ? Number(val) : val;
        }
        const emb = await computeEmbedding(schemaName, data, state);
        await db.addRecord(biz.id, schemaName, data, emb);
        modal.hide();
        renderExplorerTable();
        showToast('Record indexed and saved');
      };
    };
  }

  const newCharBtn = document.getElementById('newCharacterBtn');
  if (newCharBtn) {
    newCharBtn.onclick = () => {
      const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('characterModal'));
      modal.show();
    };
  }

  const saveCharBtn = document.getElementById('saveCharacterBtn');
  if (saveCharBtn) {
    saveCharBtn.onclick = async () => {
      const name = document.getElementById('charNameInput').value.trim();
      const id = (document.getElementById('charIdInput').value.trim() || name.toLowerCase().replace(/[^a-z0-9]/g, ''));
      const persona = document.getElementById('charPersonaInput').value.trim();
      const prompt = document.getElementById('charPromptInput').value.trim();
      const color = document.getElementById('charColorInput').value;
      const avatar = document.getElementById('charAvatarInput').value.trim() || '🤖';
      const spec = document.getElementById('charSpecInput').value.split(',').map(s => s.trim()).filter(Boolean);

      if (!name || !id) {
        showToast('Please provide character Name and ID.');
        return;
      }

      try {
        await configAPI.addCharacter({
          id,
          name,
          persona: persona || 'Workspace Assistant',
          systemPrompt: prompt || `You are ${name}.`,
          color,
          specialization: spec.length ? spec : ['general'],
          emotions: { neutral: avatar, thinking: '🤔', happy: '😊', error: '⚠️' }
        });
        bootstrap.Modal.getInstance(document.getElementById('characterModal')).hide();
        renderCharacters();
        updateHeaderUI();
        showToast(`Character "${name}" created!`);
      } catch (e) {
        showToast(`Error: ${e.message}`);
      }
    };
  }

  const newBizBtn = document.getElementById('newBusinessBtn');
  if (newBizBtn) {
    newBizBtn.onclick = () => {
      const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('businessModal'));
      modal.show();
    };
  }

  const saveBizBtn = document.getElementById('saveBusinessBtn');
  if (saveBizBtn) {
    saveBizBtn.onclick = async () => {
      const name = document.getElementById('bizNameInput').value.trim();
      const id = (document.getElementById('bizIdInput').value.trim() || name.toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (!name || !id) {
        showToast('Please provide workspace Name.');
        return;
      }

      try {
        await configAPI.addBusiness({ id, name });
        bootstrap.Modal.getInstance(document.getElementById('businessModal')).hide();
        renderBusinesses();
        updateHeaderUI();
        showToast(`Workspace "${name}" created!`);
      } catch (e) {
        showToast(`Error: ${e.message}`);
      }
    };
  }

  const newSchemaBtn = document.getElementById('newSchemaBtn');
  if (newSchemaBtn) {
    newSchemaBtn.onclick = () => {
      const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('schemaModal'));
      modal.show();
    };
  }

  const saveSchemaBtn = document.getElementById('saveSchemaBtn');
  if (saveSchemaBtn) {
    saveSchemaBtn.onclick = async () => {
      const name = document.getElementById('schemaNameInput').value.trim().toLowerCase();
      const fieldsStr = document.getElementById('schemaFieldsInput').value.trim();
      if (!name) {
        showToast('Please specify a schema name.');
        return;
      }

      let fields = { title: "string", description: "string" };
      if (fieldsStr) {
        try {
          fields = JSON.parse(fieldsStr);
        } catch (e) {
          fields = {};
          fieldsStr.split(',').forEach(pair => {
            const [k, v] = pair.split(':').map(s => s.trim());
            if (k) fields[k] = v || 'string';
          });
        }
      }

      const biz = getActiveBusiness();
      await configAPI.addSchema(biz.id, name, {
        fields,
        vectorize: Object.keys(fields).filter(k => fields[k] === 'string')
      });
      bootstrap.Modal.getInstance(document.getElementById('schemaModal')).hide();
      renderExplorerSchemas();
      renderConfigEditor();
      showToast(`Schema "${name}" created!`);
    };
  }

  const saveConfigBtn = document.getElementById('saveConfigBtn');
  if (saveConfigBtn) {
    saveConfigBtn.onclick = async () => {
      try {
        const text = document.getElementById('configEditor').value;
        const parsed = JSON.parse(text);
        validateConfig(parsed);
        state.config = parsed;
        await db.setKV('app_config', state.config);
        updateHeaderUI();
        renderQuickPrompts();
        renderCharacters();
        renderBusinesses();
        renderExplorerSchemas();
        populateModelSelects(); // Refresh model dropdowns after config edit
        showToast('Configuration updated and saved');
      } catch (e) {
        showToast(`Invalid configuration: ${e.message}`);
      }
    };
  }

  const exportBtn = document.getElementById('exportConfigBtn');
  if (exportBtn) {
    exportBtn.onclick = () => {
      const blob = new Blob([JSON.stringify(state.config, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'config.json';
      a.click();
    };
  }

  const importBtn = document.getElementById('importConfigBtn');
  const importInput = document.getElementById('importConfigInput');
  if (importBtn && importInput) {
    importBtn.onclick = () => importInput.click();
    importInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (file) {
        const text = await file.text();
        document.getElementById('configEditor').value = text;
        document.getElementById('saveConfigBtn').click();
      }
    };
  }

  const resetBtn = document.getElementById('resetConfigBtn');
  if (resetBtn) {
    resetBtn.onclick = async () => {
      await db.deleteKV('app_config');
      await loadConfiguration();
      renderConfigEditor();
      updateHeaderUI();
      renderQuickPrompts();
      renderCharacters();
      renderBusinesses();
      renderExplorerSchemas();
      populateModelSelects();
      showToast('Configuration reset to defaults');
    };
  }
}

if (isBrowser && !window.__DISABLE_AUTO_INIT__) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
}
```
