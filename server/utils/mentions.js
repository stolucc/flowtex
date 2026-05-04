import { v4 as uuid } from 'uuid';
import db from '../db.js';

/**
 * Extract @mentions from comment/reply text and record them for batched email notification.
 * Mention format: @Name or @"Full Name" (matches project member names, case-insensitive).
 */
export async function recordMentions({ text, commentId, replyId, mentionerUserId, projectId }) {
  // Extract raw mention strings: @Word or @"Multiple Words"
  const mentionRe = /@"([^"]+)"|@(\S+)/g;
  const rawMentions = [];
  let m;
  while ((m = mentionRe.exec(text))) {
    rawMentions.push((m[1] || m[2]).toLowerCase());
  }
  if (rawMentions.length === 0) return [];

  // Fetch project members to resolve names → user IDs
  const members = await db.all(
    `SELECT u.id, LOWER(u.name) AS name_lower FROM project_members pm
     JOIN users u ON pm.user_id = u.id WHERE pm.project_id = $1`,
    [projectId],
  );

  // Cap snippet at 200 chars total (199 + ellipsis when truncated) so the
  // payload never exceeds the database column.
  const snippet = text.length > 200 ? text.slice(0, 199) + '…' : text;
  const recorded = [];

  for (const mention of rawMentions) {
    const member = members.find((m) => m.name_lower === mention);
    if (!member || member.id === mentionerUserId) continue; // skip self-mentions

    const id = uuid();
    await db.run(
      `INSERT INTO comment_mentions (id, comment_id, reply_id, mentioned_user_id, mentioner_user_id, project_id, snippet)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, commentId || null, replyId || null, member.id, mentionerUserId, projectId, snippet],
    );
    recorded.push(member.id);
  }

  return recorded;
}
