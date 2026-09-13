/**
 * core/extensions.js - Extension system (Pi-style modular bundles)
 *
 * An extension is a named, versioned bundle of tools plus an optional
 * permission POLICY. Extensions keep the agent modular: every tool belongs to
 * exactly one extension, permission asking happens at extension scope, and an
 * extension can be switched off — its tools refuse to execute without being
 * unregistered (so nothing else in the system breaks).
 *
 * Built-in tools are grouped into named extensions via BUILTIN_EXTENSIONS and
 * wired up by `applyBuiltinExtensions`. Tools created at runtime by `create_tool`
 * are claimed by the 'custom' (Dynamic Tools) extension automatically.
 */

import { PERMISSION_LEVELS } from './tools.js';

const PERMISSION_META = {
  [PERMISSION_LEVELS.READ_ONLY]: { label: 'Read only', badge: 'text-bg-info' },
  [PERMISSION_LEVELS.USER_DATA]: { label: 'User data', badge: 'text-bg-success' },
  [PERMISSION_LEVELS.CONFIG]: { label: 'Config change', badge: 'text-bg-warning' },
  [PERMISSION_LEVELS.SYSTEM]: { label: 'System', badge: 'text-bg-danger' }
};

export function permissionMeta(level) {
  return PERMISSION_META[level] || { label: String(level || 'unknown'), badge: 'text-bg-secondary' };
}

export class Extension {
  constructor(spec) {
    if (!spec || !spec.id || !spec.name) {
      throw new Error('Extension requires an id and a name');
    }
    this.id = spec.id;
    this.name = spec.name;
    this.version = spec.version || '1.0.0';
    this.description = spec.description || '';
    this.icon = spec.icon || 'bi-box';
    this.enabled = spec.enabled !== false;
    this._tools = new Set();
    // Optional async gate: (toolName, params, context) =>
    //   false | 'level' | { allowed: false, reason } | { level } | undefined
    this.policy = typeof spec.policy === 'function' ? spec.policy : null;
    // Sync nominal permission overrides per tool (used when formatting/asking).
    this.permissionOverrides = spec.permissionOverrides || {};
  }

  addTool(name) {
    if (name) this._tools.add(String(name));
    return this;
  }

  hasTool(name) {
    return this._tools.has(String(name));
  }

  tools() {
    return Array.from(this._tools);
  }

  nominalLevel(toolName, fallback) {
    return this.permissionOverrides[toolName] || fallback || PERMISSION_LEVELS.USER_DATA;
  }
}

export class ExtensionRegistry {
  constructor() {
    this._extensions = new Map();
    this._toolToExt = new Map();
    this._registry = null;
  }

  attach(toolRegistry) {
    if (toolRegistry && typeof toolRegistry.getTool === 'function') {
      toolRegistry._extensionRegistry = this;
      this._registry = toolRegistry;
    }
    return this;
  }

  defineExtension(spec) {
    if (this._extensions.has(spec.id)) return this._extensions.get(spec.id);
    const ext = new Extension(spec);
    this._extensions.set(ext.id, ext);
    return ext;
  }

  assign(extId, toolNames) {
    const ext = this._extensions.get(extId);
    if (!ext) throw new Error(`Unknown extension "${extId}"`);
    for (const name of (Array.isArray(toolNames) ? toolNames : [toolNames])) {
      if (!name) continue;
      ext.addTool(name);
      this._toolToExt.set(String(name), ext.id);
    }
    return this;
  }

  /**
   * Claim any registered-but-unassigned tool under the given extension id
   * (used for runtime-created dynamic tools).
   */
  claimDanglingTool(toolName, fallbackExtId = 'custom') {
    const name = String(toolName || '');
    if (!name || this._toolToExt.has(name)) return this;
    const ext = this._extensions.get(fallbackExtId)
      || this.defineExtension({ id: fallbackExtId, name: 'Dynamic Tools', icon: 'bi-braces', description: 'Tools created at runtime.' });
    ext.addTool(name);
    this._toolToExt.set(name, ext.id);
    return this;
  }

  getExtension(extId) {
    return this._extensions.get(extId) || null;
  }

  getExtensionFor(toolName) {
    const extId = this._toolToExt.get(String(toolName));
    return extId ? this.getExtension(extId) : null;
  }

  setEnabled(extId, enabled) {
    const ext = this._extensions.get(extId);
    if (!ext) return false;
    ext.enabled = enabled === true;
    return true;
  }

  isEnabled(extId) {
    const ext = this._extensions.get(extId);
    return ext ? ext.enabled : null;
  }

  listExtensions() {
    return Array.from(this._extensions.values()).map(ext => ({
      id: ext.id,
      name: ext.name,
      version: ext.version,
      description: ext.description,
      icon: ext.icon,
      enabled: ext.enabled,
      tools: ext.tools()
    }));
  }

  /**
   * The gate ToolRegistry.execute consults: everything the executor needs to
   * enforce extension scope (enable state, platform, nominal permission).
   */
  gateFor(toolName) {
    const ext = this.getExtensionFor(toolName);
    if (!ext) return null;
    const fallback = this._registry && this._registry.getTool(toolName)
      ? this._registry.getTool(toolName).permissionLevel
      : PERMISSION_LEVELS.USER_DATA;
    return {
      id: ext.id,
      name: ext.name,
      icon: ext.icon,
      enabled: ext.enabled,
      policy: ext.policy,
      permissionLevels: PERMISSION_LEVELS,
      nominalLevel: ext.nominalLevel(toolName, fallback)
    };
  }

  /**
   * Persistence: rematerialize enable state from a stored list of disabled ids.
   */
  restoreState(disabledIds = []) {
    for (const id of disabledIds) this.setEnabled(id, false);
    return this;
  }

  saveState() {
    return {
      disabled: this.listExtensions().filter(e => !e.enabled).map(e => e.id)
    };
  }
}

export const extensionRegistry = new ExtensionRegistry();

/**
 * The built-in tool groupings. Order here is the order shown in the Tools tab.
 * `permissionOverrides` set the nominal (asked) permission for tools whose
 * registered level differs from what the extension wants to present.
 */
export const BUILTIN_EXTENSIONS = [
  {
    id: 'finance',
    name: 'Finance',
    version: '1.0.0',
    description: 'Record transactions and analyze spending across workspaces.',
    icon: 'bi-cash-coin',
    tools: ['add_transaction', 'analyze_expenses']
  },
  {
    id: 'tasks',
    name: 'Tasks',
    version: '1.0.0',
    description: 'Create and review to-dos.',
    icon: 'bi-check2-square',
    tools: ['add_todo', 'list_todos']
  },
  {
    id: 'calendar',
    name: 'Calendar',
    version: '1.0.0',
    description: 'Schedule events and consult the upcoming agenda.',
    icon: 'bi-calendar-week',
    tools: ['add_event', 'check_calendar']
  },
  {
    id: 'data',
    name: 'Data & Search',
    version: '1.0.0',
    description: 'Create schemas and run semantic search across records.',
    icon: 'bi-diagram-3',
    tools: ['create_schema', 'search']
  },
  {
    id: 'config',
    name: 'Configuration',
    version: '1.0.0',
    description: 'Read and change workspace configuration, characters, and behaviors.',
    icon: 'bi-gear',
    tools: [
      'update_config', 'get_config', 'add_character', 'add_business',
      'rollback_config', 'change_character_name'
    ],
    permissionOverrides: {
      update_config: PERMISSION_LEVELS.CONFIG,
      get_config: PERMISSION_LEVELS.READ_ONLY,
      add_character: PERMISSION_LEVELS.CONFIG,
      add_business: PERMISSION_LEVELS.CONFIG,
      rollback_config: PERMISSION_LEVELS.CONFIG,
      change_character_name: PERMISSION_LEVELS.CONFIG
    }
  },
  {
    id: 'system',
    name: 'System',
    version: '1.0.0',
    description: 'Dangerous tools that build tools, run chains, or introspect the registry.',
    icon: 'bi-tools',
    tools: ['create_tool', 'list_tools', 'execute_chain'],
    permissionOverrides: {
      create_tool: PERMISSION_LEVELS.SYSTEM,
      list_tools: PERMISSION_LEVELS.READ_ONLY,
      execute_chain: PERMISSION_LEVELS.SYSTEM
    },
    policy: async (toolName) => {
      if (toolName === 'execute_chain') return PERMISSION_LEVELS.SYSTEM;
      return undefined;
    }
  },
  {
    id: 'agents',
    name: 'Agents & Team',
    version: '1.0.0',
    description: 'Delegate work and consult the character roster.',
    icon: 'bi-people',
    tools: ['delegate_to_agent', 'ask_agent', 'list_agents', 'route_to_specialist']
  },
  {
    id: 'web',
    name: 'Web',
    version: '1.0.0',
    description: 'Search the open internet through the web_search tool.',
    icon: 'bi-globe',
    tools: ['web_search']
  },
  {
    id: 'google',
    name: 'Google Workspace',
    version: '1.0.0',
    description: 'Read Google Calendar, Drive, and Sheets (OAuth-backed).',
    icon: 'bi-google',
    tools: ['google_calendar_list', 'google_drive_list', 'google_sheets_read']
  },
  {
    id: 'documents',
    name: 'Documents',
    version: '1.0.0',
    description: 'Create Word and Excel files in a folder you choose (or as downloads).',
    icon: 'bi-folder2-open',
    tools: ['create_document', 'create_spreadsheet']
  },
  {
    id: 'workspace',
    name: 'Workspace',
    version: '1.0.0',
    description: 'The in-app coding agent: list, read, write, edit, and delete files in the folder you grant.',
    icon: 'bi-code-square',
    tools: [
      'list_workspace', 'read_workspace_file', 'write_workspace_file',
      'edit_workspace_file', 'append_workspace_file', 'delete_workspace_file'
    ],
    permissionOverrides: {
      list_workspace: PERMISSION_LEVELS.READ_ONLY,
      read_workspace_file: PERMISSION_LEVELS.READ_ONLY,
      write_workspace_file: PERMISSION_LEVELS.CONFIG,
      edit_workspace_file: PERMISSION_LEVELS.CONFIG,
      append_workspace_file: PERMISSION_LEVELS.CONFIG,
      delete_workspace_file: PERMISSION_LEVELS.CONFIG
    }
  },
  {
    id: 'custom',
    name: 'Dynamic Tools',
    version: '1.0.0',
    description: 'Tools the AI created at runtime via create_tool.',
    icon: 'bi-braces',
    tools: []
  }
];

/**
 * Register the built-in extensions into a registry and wire it to the tool
 * registry. Every tool name in the manifest must exist, otherwise the mismatch
 * is silently skipped (so partial tool sets in tests don't throw).
 */
export function applyBuiltinExtensions(registry = extensionRegistry, toolRegistry = null) {
  for (const spec of BUILTIN_EXTENSIONS) {
    registry.defineExtension(spec);
    registry.assign(spec.id, spec.tools);
  }
  if (toolRegistry) registry.attach(toolRegistry);
  return registry;
}

export default extensionRegistry;