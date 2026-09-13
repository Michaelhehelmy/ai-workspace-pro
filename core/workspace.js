/**
 * core/workspace.js — file workspace for the in-app coding agent.
 *
 * The browser has no server-side filesystem, so a "workspace" reuses the same
 * File System Access folder handle as core/files.js: the user grants one
 * read-write directory and the coding agent lists / reads / writes / edits /
 * deletes files inside it. Every write is real bytes — no canned or fabricated
 * file content.
 *
 * The adapter indirection keeps this module hermetic: in the browser we wrap
 * the FileSystemDirectoryHandle (`createFsAdapter`); in Node (tests) we inject
 * an in-memory tree (`createMemAdapter`). The ops above never touch the DOM.
 *
 * Adapter interface:
 *   list(dir)      → Promise<[{ name, kind: 'file'|'dir', size? }]>
 *   readFile(path) → Promise<string>
 *   writeFile(path, content) → Promise<void>
 *   remove(path)   → Promise<void>
 */

export const WORKSPACE_MAX_FILE_BYTES = 1024 * 1024;
export const WORKSPACE_MAX_TREE_ENTRIES = 5000;

export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

// ── Adapter (bound by the browser bootstrap or tests) ───────────────────────

let workspaceAdapter = null;

export function setWorkspaceAdapter(adapter) {
  workspaceAdapter = adapter || null;
}

export function getWorkspaceAdapter() {
  return workspaceAdapter;
}

export function requireAdapter() {
  if (!workspaceAdapter) {
    throw new WorkspaceError(
      'E_NO_FOLDER',
      'No workspace folder is connected yet. Use the "Open folder" button in the Coder tab, or ask the agent to pick a folder first.'
    );
  }
  return workspaceAdapter;
}

// ── Path safety ─────────────────────────────────────────────────────────────
// Reject anything that could escape the granted directory (absolute paths,
// Windows drive letters, `..`, NUL). Paths are always relative to the root.

export function assertSafeRelPath(input) {
  const raw = String(input == null ? '' : input).replace(/\\/g, '/');
  if (!raw) throw new WorkspaceError('E_BAD_PATH', 'A file path is required.');
  if (raw.includes('\0')) throw new WorkspaceError('E_BAD_PATH', 'Paths may not contain NUL bytes.');
  if (raw.startsWith('/')) throw new WorkspaceError('E_BAD_PATH', 'Paths must be relative — no leading "/".');
  if (/^[a-zA-Z]:/.test(raw)) throw new WorkspaceError('E_BAD_PATH', 'Paths must be relative — no drive letters.');
  const parts = raw.split('/');
  if (parts.some(seg => seg === '..')) throw new WorkspaceError('E_BAD_PATH', 'Paths may not contain "..".');
  const clean = parts.filter(Boolean).join('/');
  if (!clean) throw new WorkspaceError('E_BAD_PATH', `"${input}" is not a usable path.`);
  return clean;
}

export function normalizeRelPath(p) {
  return String(p == null ? '.' : p).replace(/\\/g, '/').split('/').filter(s => s && s !== '.').join('/') || '.';
}

// ── Ops (shared by tools, the coding agent, and the UI) ─────────────────────

export async function listWorkspace(dir = '.') {
  const adapter = requireAdapter();
  const rel = normalizeRelPath(dir);
  const entries = await adapter.list(rel);
  if (entries.length > WORKSPACE_MAX_TREE_ENTRIES) {
    throw new WorkspaceError('E_TOO_MANY', `Too many entries (${entries.length}) — narrow the directory.`);
  }
  const sorted = [...entries].sort((a, b) =>
    a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : (a.name || '').localeCompare(b.name || ''));
  return { dir: rel, entries: sorted, adapter: adapterLabel(adapter) };
}

export async function readWorkspaceFile(inputPath) {
  const adapter = requireAdapter();
  const rel = assertSafeRelPath(inputPath);
  const content = await adapter.readFile(rel);
  if (content == null) throw new WorkspaceError('E_NOENT', `"${rel}" was not found in the workspace.`);
  return { path: rel, content: String(content), bytes: countBytes(content), lines: String(content).split('\n').length };
}

export async function writeWorkspaceFile(inputPath, content) {
  const adapter = requireAdapter();
  const rel = assertSafeRelPath(inputPath);
  if (typeof content !== 'string') throw new WorkspaceError('E_BAD_ARGS', 'File content must be text.');
  const bytes = countBytes(content);
  if (bytes > WORKSPACE_MAX_FILE_BYTES) {
    throw new WorkspaceError('E_TOO_BIG', `File would be ${bytes} bytes — over the ${WORKSPACE_MAX_FILE_BYTES} byte limit.`);
  }
  await adapter.writeFile(rel, content);
  return { path: rel, bytes, created: true };
}

export async function editWorkspaceFile(inputPath, oldText, newText) {
  const adapter = requireAdapter();
  const rel = assertSafeRelPath(inputPath);
  if (typeof oldText !== 'string' || oldText.length === 0) {
    throw new WorkspaceError('E_BAD_ARGS', 'An exact substring to replace is required.');
  }
  if (typeof newText !== 'string') throw new WorkspaceError('E_BAD_ARGS', 'Replacement text must be a string.');
  const before = await adapter.readFile(rel);
  if (before == null) throw new WorkspaceError('E_NOENT', `"${rel}" was not found in the workspace.`);
  if (!before.includes(oldText)) {
    throw new WorkspaceError('E_NO_MATCH', `The text ${quote(oldText)} wasn't found in ${rel}.`);
  }
  const after = before.split(oldText).join(newText);
  await adapter.writeFile(rel, after);
  return { path: rel, bytes: countBytes(after), patch: makePatch(before, after) };
}

export async function appendWorkspaceFile(inputPath, content) {
  const adapter = requireAdapter();
  const rel = assertSafeRelPath(inputPath);
  if (typeof content !== 'string' || !content) {
    throw new WorkspaceError('E_BAD_ARGS', 'Text to append is required.');
  }
  let before = '';
  try {
    const existing = await adapter.readFile(rel);
    if (existing != null) before = String(existing);
  } catch (_) { /* new file */ }
  const separator = before.endsWith('\n') || !before ? '' : '\n';
  const after = before + separator + content + '\n';
  await adapter.writeFile(rel, after);
  return { path: rel, bytes: countBytes(after), patch: makePatch(before, after) };
}

export async function deleteWorkspaceFile(inputPath) {
  const adapter = requireAdapter();
  const rel = assertSafeRelPath(inputPath);
  await adapter.remove(rel);
  return { path: rel, deleted: true };
}

// ── Diff --------------------------------------------------------------
// A human-readable line diff: trims common head/tail and reports the changed
// region (capped) with a JSON "action" the UI can summarize.

export function makePatch(before, after) {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) { aEnd--; bEnd--; }

  const removed = a.slice(start, aEnd);
  const added = b.slice(start, bEnd);
  const cap = 40;
  const removedCount = removed.length;
  const addedCount = added.length;

  const trimmed = (removed.length > cap || added.length > cap);
  return {
    start,
    removedCount,
    addedCount,
    unchanged: removedCount + addedCount === 0,
    contextBefore: a.slice(Math.max(0, start - 2), start),
    removed: removed.slice(0, cap),
    added: added.slice(0, cap),
    trimmed
  };
}

export function renderPatch(patch, maxLines = 24) {
  if (!patch) return '';
  if (patch.unchanged) return '(no change)';
  const lines = [];
  const sign = n => (n === 'remove' ? '-' : '+');
  const take = [];
  if (patch.contextBefore.length) take.push({ kind: 'ctx', lines: patch.contextBefore });
  for (const l of patch.removed) take.push({ kind: 'remove', lines: [l] });
  for (const l of patch.added) take.push({ kind: 'add', lines: [l] });
  let count = 0;
  for (const { kind, lines: chunks } of take) {
    for (const line of chunks) {
      if (count >= maxLines) { lines.push('  …'); count = Infinity; break; }
      lines.push(`${kind === 'ctx' ? ' ' : sign(kind)} ${line}`);
      count++;
    }
    if (count === Infinity) break;
  }
  return lines.join('\n');
}

// ── Browser adapter (File System Access API) ────────────────────────────────
// Available on Chromium. Falls back honestly: if the navigator API is missing,
// createFsAdapter returns null so the UI can prompt the user instead.

export async function createFsAdapter(dirHandle) {
  if (!dirHandle || typeof dirHandle.entries !== 'function') return null;

  async function findHandle(dir, name) {
    for await (const [n, h] of dir.entries()) {
      if (n === name) return h;
    }
    return null;
  }

  // Walk the directory chain to the parent of `rel`, returning the parent
  // handle and the final segment name.
  async function resolve(rel) {
    const parts = (rel === '.' || !rel) ? [] : rel.split('/');
    let dir = dirHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      const h = await findHandle(dir, parts[i]);
      if (!h || h.kind !== 'directory') {
        throw new WorkspaceError('E_NOENT', `Directory "${parts.slice(0, i + 1).join('/')}" not found.`);
      }
      dir = h;
    }
    return { dir, name: parts[parts.length - 1] || '' };
  }

  return {
    label: String(dirHandle.name || 'workspace'),
    async list(dir) {
      const { dir: d, name } = await resolve(dir);
      const handle = name ? await findHandle(d, name) : d;
      if (!handle || handle.kind !== 'directory') {
        throw new WorkspaceError('E_NOENT', `"${dir}" is not a directory.`);
      }
      const entries = [];
      let total = 0;
      for await (const [n, h] of handle.entries()) {
        total++;
        if (total > WORKSPACE_MAX_TREE_ENTRIES) break;
        entries.push({
          name: n,
          kind: h.kind === 'directory' ? 'dir' : 'file',
          size: h.kind === 'file' ? (await estimateSize(h)) : undefined
        });
      }
      return entries;
    },
    async readFile(rel) {
      const { dir, name } = await resolve(rel);
      if (!name) throw new WorkspaceError('E_NOENT', `"${rel}" is a directory, not a file.`);
      const h = await findHandle(dir, name);
      if (!h || h.kind !== 'file') throw new WorkspaceError('E_NOENT', `"${rel}" was not found in the workspace.`);
      const file = await h.getFile();
      if (file.size > WORKSPACE_MAX_FILE_BYTES) {
        throw new WorkspaceError('E_TOO_BIG', `"${rel}" is ${file.size} bytes — over the ${WORKSPACE_MAX_FILE_BYTES} byte read limit.`);
      }
      return await file.text();
    },
    async writeFile(rel, content) {
      const { dir, name } = await resolve(rel);
      const h = await dir.getFileHandle(name, { create: true });
      const writable = await h.createWritable();
      await writable.write(content);
      await writable.close();
    },
    async remove(rel) {
      const { dir, name } = await resolve(rel);
      if (!name) throw new WorkspaceError('E_BAD_PATH', 'Cannot delete the workspace root.');
      await dir.removeEntry(name, { recursive: true });
    }
  };
}

async function estimateSize(fileHandle) {
  try {
    const file = await fileHandle.getFile();
    return file.size;
  } catch (_) {
    return undefined;
  }
}

// ── In-memory adapter (Node + hermetic tests) ───────────────────────────────

export function createMemAdapter(initial = {}) {
  const files = new Map();
  for (const [k, v] of Object.entries(initial || {})) {
    files.set(assertSafeRelPath(k), String(v));
  }

  function under(prefix, path) {
    return prefix ? path.startsWith(prefix + '/') && path.length > prefix.length + 1 : !path.includes('/');
  }

  return {
    label: 'mem',
    async list(dir) {
      const prefix = (dir === '.' || !dir) ? '' : String(dir).replace(/\/+$/, '');
      if (prefix && !Array.from(files.keys()).some(p => p === prefix || p.startsWith(prefix + '/'))) {
        throw new WorkspaceError('E_NOENT', `Directory "${dir}" not found.`);
      }
      const out = new Map();
      for (const [path] of files) {
        if (prefix && !(path === prefix || path.startsWith(prefix + '/'))) continue;
        const rel = prefix ? path.slice(prefix.length + 1) : path;
        if (!rel || rel === prefix) continue;
        const seg = rel.split('/')[0];
        if (rel.includes('/')) {
          if (!out.has(seg)) out.set(seg, { name: seg, kind: 'dir' });
        } else {
          out.set(seg, { name: seg, kind: 'file', size: (files.get(path) || '').length });
        }
      }
      return Array.from(out.values());
    },
    async readFile(path) {
      const v = files.get(path);
      if (v === undefined) throw new WorkspaceError('E_NOENT', `"${path}" was not found in the workspace.`);
      return v;
    },
    async writeFile(path, content) {
      files.set(path, String(content));
    },
    async remove(path) {
      if (files.has(path)) {
        files.delete(path);
        return;
      }
      const children = Array.from(files.keys()).filter(p => p.startsWith(path + '/'));
      if (children.length) {
        for (const c of children) files.delete(c);
        return;
      }
      throw new WorkspaceError('E_NOENT', `"${path}" was not found in the workspace.`);
    }
  };
}

// ── Small helpers ───────────────────────────────────────────────────────────

function adapterLabel(adapter) {
  return (adapter && adapter.label) || 'workspace';
}

function countBytes(content) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(content)).length;
  return String(content).length;
}

function quote(s) {
  const t = String(s);
  return t.length > 48 ? `"${t.slice(0, 48)}…"` : `"${t}"`;
}