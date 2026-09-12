/**
 * WorkspaceDB - Persistent Storage Layer
 * Singleton service for IndexedDB with memory fallback.
 *
 * Reads are served from in-memory mirrors (O(1), zero transaction latency).
 * Writes always mirror to memory first, then persist to IndexedDB for the next
 * session. After a page reload, hydrate() replays persisted data into memory.
 */

import { isBrowser } from './env.js';

class StoreFlat {
  constructor() {
    this.kv = new Map();
    this.records = new Map();
    this.chat = new Map();
  }
}

export class WorkspaceDB {
  constructor(name = 'AIWorkspacePro_DB', version = 2) {
    this.name = name;
    this.version = version;
    this.db = null;
    this.readyPromise = null;
    this.memoryStores = new StoreFlat();
  }

  init() {
    if (this.readyPromise) return this.readyPromise;
    if (!isBrowser || typeof indexedDB === 'undefined') {
      this.readyPromise = Promise.resolve();
      return this.readyPromise;
    }
    this.readyPromise = new Promise((resolve) => {
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
          this.hydrate().finally(resolve);
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
    return this.readyPromise;
  }

  /**
   * Replay persisted IndexedDB data into the in-memory mirrors. Safe to call
   * repeatedly (new session: memory starts empty; existing session: idempotent
   * because writes stay ahead of hydration).
   */
  async hydrate() {
    if (!this.db) return;
    await this._loadAll('kv', (v) => this.memoryStores.kv.set(v.key, v.value));
    await this._loadAll('records', (v) => this.memoryStores.records.set(v.id, v));
    await this._loadAll('chat', (v) => this.memoryStores.chat.set(v.id, v));
  }

  _loadAll(storeName, sink) {
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => {
          (req.result || []).forEach(sink);
          resolve();
        };
        req.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async getKV(key) {
    return this.memoryStores.kv.get(key) || null;
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
    return this.memoryStores.records.get(id) || null;
  }

  async getRecords(businessId, schemaName = null) {
    const all = Array.from(this.memoryStores.records.values());
    return all.filter(r => r.businessId === businessId && (!schemaName || r.schemaName === schemaName));
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

  async deleteRecordsByBusiness(businessId) {
    const all = Array.from(this.memoryStores.records.values());
    const ids = all.filter(r => r.businessId === businessId).map(r => r.id);
    for (const id of ids) {
      await this.deleteRecord(id);
    }
  }

  /**
   * Reset every store (memory mirrors + IndexedDB). Used by hermetic test
   * suites so repeated browser runs start from a clean state instead of
   * hydrating leftovers persisted across earlier runs.
   */
  async clearAll() {
    this.memoryStores.kv.clear();
    this.memoryStores.records.clear();
    this.memoryStores.chat.clear();
    if (!this.db) return Promise.resolve();
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction(['kv', 'records', 'chat'], 'readwrite');
        tx.objectStore('kv').clear();
        tx.objectStore('records').clear();
        tx.objectStore('chat').clear();
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
    const all = Array.from(this.memoryStores.chat.values());
    return all.filter(m => m.businessId === businessId).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Atomically replace a business's entire chat log (used by session
   * compaction). Mirrors to memory first, then rebuilds the IndexedDB store for
   * that business.
   */
  async replaceChat(businessId, messages) {
    const next = Array.isArray(messages) ? messages : [];
    for (const [id, m] of this.memoryStores.chat.entries()) {
      if (m.businessId === businessId) this.memoryStores.chat.delete(id);
    }
    for (const m of next) {
      const chatMsg = {
        id: m.id || 'm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        ...m,
        businessId: m.businessId || businessId,
        timestamp: m.timestamp || Date.now()
      };
      this.memoryStores.chat.set(chatMsg.id, chatMsg);
    }
    if (!this.db) return Promise.resolve();
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction('chat', 'readwrite');
        const store = tx.objectStore('chat');
        const idx = store.index('by_biz');
        const delReq = idx.openKeyCursor(IDBKeyRange.only(businessId));
        delReq.onsuccess = () => {
          const cursor = delReq.result;
          if (cursor) {
            store.delete(cursor.primaryKey);
            cursor.continue();
          } else {
            for (const m of next) {
              store.add({
                id: m.id,
                ...m,
                businessId: m.businessId || businessId,
                timestamp: m.timestamp || Date.now()
              });
            }
            resolve();
          }
        };
        delReq.onerror = () => resolve();
      } catch (e) {
        resolve();
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

// Cosine similarity utility - can be moved to utils/math.js for tree-shaking
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

// Export singleton instance
export const workspaceDB = new WorkspaceDB();

if (isBrowser) {
  workspaceDB.init();
}