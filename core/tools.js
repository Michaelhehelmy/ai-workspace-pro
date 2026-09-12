/**
 * ToolRegistry - Tool Management Layer
 * Singleton for tool registration, validation, and execution
 */

import { isBrowser } from './env.js';

export const PERMISSION_LEVELS = {
  READ_ONLY: 'read_only',
  USER_DATA: 'user_data',
  CONFIG: 'config',
  SYSTEM: 'system'
};

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

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.permissionLevels = PERMISSION_LEVELS;
  }

  register(tool) {
    if (!tool || !tool.name || typeof tool.execute !== 'function') {
      throw new Error('Invalid tool definition: missing name or execute function');
    }
    this.tools.set(tool.name, {
      name: tool.name,
      type: tool.type || 'internal',
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
    return Array.from(this.tools.values()).map(t => {
      const gate = this._extensionRegistry ? this._extensionRegistry.gateFor(t.name) : null;
      return {
        name: t.name,
        type: t.type,
        description: t.description,
        schema: t.schema,
        permissionLevel: t.permissionLevel,
        icon: t.icon,
        ...(gate ? {
          extension: gate.name,
          extensionId: gate.id,
          extensionIcon: gate.icon,
          extensionEnabled: gate.enabled
        } : {})
      };
    });
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

      if (typeof bootstrap === 'undefined') {
        console.warn('Bootstrap not loaded; auto-approving permission for', toolName);
        return resolve(true);
      }

      const toolEl = document.getElementById('permToolName');
      const levelEl = document.getElementById('permLevelName');
      if (toolEl) toolEl.textContent = toolName;
      if (levelEl) levelEl.textContent = level;

      const gate = this._extensionRegistry ? this._extensionRegistry.gateFor(toolName) : null;
      const extEl = document.getElementById('permExtName');
      if (extEl) extEl.textContent = gate ? `${gate.name} (${gate.id})` : '—';

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

    // Extension-scoped gate: disabled extensions refuse to run, and the
    // extension's policy may override the effective permission level.
    const gate = this._extensionRegistry ? this._extensionRegistry.gateFor(toolName) : null;
    if (gate && !gate.enabled) {
      throw new Error(`Tool "${toolName}" is disabled because the "${gate.name}" extension is turned off`);
    }

    let effectiveLevel = permissionLevel || (gate ? gate.nominalLevel : tool.permissionLevel);

    if (gate && gate.policy) {
      const decision = await gate.policy(toolName, params, context);
      if (decision === false) {
        throw new Error(`Extension "${gate.name}" denied execution of ${toolName}`);
      } else if (typeof decision === 'string') {
        effectiveLevel = decision;
      } else if (decision && typeof decision === 'object') {
        if (decision.allowed === false) {
          throw new Error((decision.reason && `Extension "${gate.name}" denied ${toolName}: ${decision.reason}`) || `Extension "${gate.name}" denied execution of ${toolName}`);
        }
        if (decision.level) effectiveLevel = decision.level;
      }
    }

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
    if (this.getTool(toolDefinition.name)) {
      throw new Error(`Tool "${toolDefinition.name}" already exists in registry`);
    }
    const sandboxedFn = createSandboxedTool(toolDefinition.code, db);
    const safeTool = {
      name: toolDefinition.name,
      type: 'dynamic',
      description: toolDefinition.description || 'Custom dynamic tool',
      execute: sandboxedFn,
      schema: toolDefinition.schema || { parameters: {} },
      permissionLevel: toolDefinition.permissionLevel || this.permissionLevels.USER_DATA,
      icon: toolDefinition.icon || 'bi-gear'
    };
    this.register(safeTool);
    if (this._extensionRegistry) {
      this._extensionRegistry.claimDanglingTool(safeTool.name, 'custom');
    }

    if (db) {
      const existing = (await db.getKV('custom_tools')) || [];
      if (!existing.some(t => t && t.name === toolDefinition.name)) {
        existing.push(toolDefinition);
      }
      await db.setKV('custom_tools', existing);
    }
    return { success: true, tool: safeTool.name };
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
        const softError = !!(res && res.error);
        results.push({
          stepIndex: i,
          tool: step.tool,
          success: !softError,
          result: res,
          ...(softError ? { error: typeof res.error === 'string' ? res.error : 'Step returned an error' } : {})
        });

        if (step.outputKey) {
          context[step.outputKey] = res;
        }

        if (softError && step.stopOnError !== false) {
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

// Export singleton instance
export const toolRegistry = new ToolRegistry();

export default toolRegistry;