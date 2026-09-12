/**
 * core/compaction.js - Session compaction
 *
 * Bounds the chat context by collapsing older messages into a single summary
 * message. Message ordering / role / agentName are preserved for the retained
 * tail so the UI renders normally. Summarisation is injectable: when a real
 * summariser (e.g. generateResponse via the dialog backend) is supplied it is
 * used; otherwise a deterministic, zero-network digest is produced so the
 * mechanism works in fully hermetic/offline conditions.
 */

/**
 * Deterministic, model-free digest of a set of chat messages. Counts turns and
 * extracts the most frequent content keywords — honest context, no fabrication.
 */
export function buildDigestSummary(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  if (!msgs.length) return 'No prior activity.';
  const turns = msgs.length;
  const userTurns = msgs.filter(m => m.role === 'user').length;
  const assistantTurns = msgs.filter(m => m.role === 'assistant').length;
  const otherTurns = turns - userTurns - assistantTurns;

  const wordFreq = new Map();
  for (const m of msgs) {
    const words = String(m.content || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s$]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !/[0-9]/.test(w[0]) && !['that','this','with','from','your','have','will','what','the'].includes(w));
    for (const w of words) wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
  }
  const top = Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);
  const topics = top.length ? ` Topics: ${top.join(', ')}.` : '';

  const roles = [];
  if (userTurns) roles.push(`${userTurns} user turn(s)`);
  if (assistantTurns) roles.push(`${assistantTurns} assistant turn(s)`);
  if (otherTurns) roles.push(`${otherTurns} other entry/entries`);
  return `Earlier conversation: ${roles.join(', ')}.${topics}`;
}

/**
 * Collapse the older chat messages for a business into one summary message.
 *
 *   opts.keepRecent  — newest N messages left untouched (default 10)
 *   opts.summarizer  — async (messages) => string used when provided
 *                      (e.g. generateResponse via the dialog backend)
 *
 * Returns null when there is nothing to compact (fewer messages than the
 * threshold), otherwise:
 *   { compacted: true, originalCount, keptCount, summary, chat }
 */
export async function compactChat(db, businessId, opts = {}) {
  const keepRecent = Number.isFinite(opts.keepRecent) ? opts.keepRecent : 10;
  const msgs = await db.getChat(businessId);
  const originalCount = msgs.length;
  if (originalCount <= keepRecent) return null;

  const older = msgs.slice(0, -keepRecent);
  const recent = msgs.slice(-keepRecent);

  let summary;
  if (typeof opts.summarizer === 'function') {
    try {
      summary = String(await opts.summarizer(older) || '').trim();
    } catch (_) {
      summary = buildDigestSummary(older);
    }
    if (!summary) summary = buildDigestSummary(older);
  } else {
    summary = buildDigestSummary(older);
  }

  const synthetic = {
    id: 'msg_summary_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    businessId,
    role: 'system',
    agentName: 'system',
    content: `Session summary:\n${summary}`,
    summary: true,
    timestamp: older[0].timestamp
  };

  const chat = [synthetic, ...recent];
  await db.replaceChat(businessId, chat);
  return { compacted: true, originalCount, keptCount: recent.length, summary, chat };
}