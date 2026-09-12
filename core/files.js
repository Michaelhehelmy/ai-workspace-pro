/** files.js — "Give the assistant a folder": write real Word/Excel files.
 *
 * The app is a static browser app with no server-side filesystem, so "a
 * folder" is implemented with the browser's File System Access API: the user
 * grants read-write access to one directory once (Chromium picker), and the
 * handle is persisted in IndexedDB so it survives reloads.
 *
 * Files are real .docx / .xlsx produced by buildDocx / buildXlsx (OOXML is a
 * ZIP of XML; see core/zip.js). When no folder is available — Firefox,
 * Safari, phones, tablets, or a revoked permission — saveFile falls back to a
 * regular browser download: identical bytes, identical content. */

import { isBrowser } from './env.js';
import { workspaceDB as db } from './db.js';
import { zipBytes } from './zip.js';

const FOLDER_HANDLE_KEY = 'folder_handle';

let folderHandle = null; // FileSystemDirectoryHandle | null

export { crc32, zipBytes, inspectZip } from './zip.js';

// ── OOXML builders: Word (.docx) and Excel (.xlsx) ─────────────────────────

function escXml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

// paragraphs: array of strings or { text, bold?, heading? }
export async function buildDocx({ title, paragraphs }) {
  const lines = (paragraphs && paragraphs.length ? paragraphs : [{ text: title || 'Document', heading: true }]);
  const body = lines.map(line => {
    const t = typeof line === 'string' ? { text: line } : (line || {});
    const props = t.heading ? '<w:b/><w:sz w:val="32"/><w:szCs w:val="32"/>' : (t.bold ? '<w:b/>' : '');
    const text = escXml(t.text ?? '');
    return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;

  return zipBytes([
    { name: '[Content_Types].xml', data: DOCX_CONTENT_TYPES },
    { name: '_rels/.rels', data: DOCX_RELS },
    { name: 'word/document.xml', data: xml }
  ]);
}

function colName(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function cellXml(r, c, cell) {
  const ref = colName(c) + (r + 1);
  if (cell === null || cell === undefined) return '';
  let value = cell;
  let style = '';
  if (typeof cell === 'object') {
    value = cell.value;
    if (cell.bold) style = ' s="1"';
  }
  if (value === undefined) return `<c r="${ref}"${style}/>`;
  if (typeof value === 'boolean') {
    return `<c r="${ref}" t="b"${style}><v>${value ? 1 : 0}</v></c>`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `<c r="${ref}"${style}/>`;
    return `<c r="${ref}"${style}><v>${value}</v></c>`;
  }
  if (typeof value !== 'string') value = String(value);
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escXml(value)}</t></is></c>`;
}

function sheetXml(rows) {
  const body = (rows || []).map((row, r) => {
    if (!Array.isArray(row) || !row.length) return '';
    const cells = row.map((cell, c) => cellXml(r, c, cell)).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

const XLSX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function workbookXml(sheets) {
  const list = sheets.map((s, i) => `<sheet name="${escXml(s.name || `Sheet${i + 1}`)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${list}</sheets></workbook>`;
}

function workbookRels(sheetCount) {
  let rels = '';
  for (let i = 0; i < sheetCount; i++) {
    rels += `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`;
  }
  rels += `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function xlsxContentTypes(sheetCount) {
  let overrides = '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
  for (let i = 0; i < sheetCount; i++) {
    overrides += `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  }
  overrides += '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`;
}

// sheets: [{ name?, rows: array of rows; each cell is string|number|boolean
//          or { value, bold? } }]
export async function buildXlsx({ sheets }) {
  const list = (sheets && sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }]);
  const parts = [
    { name: '[Content_Types].xml', data: xlsxContentTypes(list.length) },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: workbookXml(list) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels(list.length) },
    { name: 'xl/styles.xml', data: XLSX_STYLES }
  ];
  list.forEach((sheet, i) => {
    parts.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet.rows || []) });
  });
  return zipBytes(parts);
}

export function defaultDocxFilename(title) {
  const slug = String(title || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return `${slug || 'document'}.docx`;
}

// ── Folder access + save/download ───────────────────────────────────────────

export function hasFolderHandle() {
  return !!folderHandle;
}

export function getFolderName() {
  return (folderHandle && folderHandle.name) || null;
}

export function setFolderHandle(handle) {
  folderHandle = handle || null;
}

export function clearFolderHandle() {
  folderHandle = null;
}

// Rehydrate a previously-granted folder handle from IndexedDB.
export async function restoreFolder() {
  if (!isBrowser) { folderHandle = null; return false; }
  try {
    const stored = await db.getKV(FOLDER_HANDLE_KEY);
    if (stored && typeof stored.getFileHandle === 'function') {
      folderHandle = stored;
      return true;
    }
  } catch (_) { /* fall through */ }
  folderHandle = null;
  return false;
}

// Prompt the user to pick a writable folder (Chromium only). Returns the
// folder name on success, null when cancelled or unsupported.
export async function requestFolder() {
  if (!isBrowser || typeof window.showDirectoryPicker !== 'function') return null;
  try {
    folderHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    try { await db.setKV(FOLDER_HANDLE_KEY, folderHandle); } catch (_) { /* best-effort */ }
    return folderHandle.name;
  } catch (_) {
    return null;
  }
}

async function writeToFolder(name, data) {
  const handle = await folderHandle.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
  return { folder: folderHandle.name, filename: name, bytes: data.length };
}

function downloadFile(name, data, mimeType) {
  const blob = new Blob([data], { type: mimeType || 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return { download: name, bytes: data.length };
}

// Preferred target: the user's chosen folder. Falls back to a browser
// download when no folder / the permission was revoked. Outside a browser
// (tests) returns metadata only.
export async function saveFile(name, data, mimeType) {
  if (folderHandle) {
    try {
      return await writeToFolder(name, data);
    } catch (_) { /* revoked or unwritable → fall through to download */ }
  }
  if (isBrowser) return downloadFile(name, data, mimeType);
  return { filename: name, bytes: data.length };
}