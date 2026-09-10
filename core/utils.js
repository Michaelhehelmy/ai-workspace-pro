/**
 * core/utils.js - Shared String & Filtering Utilities
 */

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

export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}