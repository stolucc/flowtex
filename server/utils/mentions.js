import { v4 as uuid } from 'uuid';
import db from '../db.js';

/**
 * Extract @mentions from comment/reply text and record them for batched email notification.
 * Mention format: @Name or @"Full Name" (matches project member names, case-insensitive).
 *
 * If `assignedToUserId` is set, the assignee is ALWAYS recorded as a
 * notification target — even when they are also the mentioner. Self-mentions
 * from free text are still skipped (you typed your own name in passing); a
 * deliberate "assign this task to me" is treated as an explicit subscription.
 * The recorded list is deduplicated by user id so an assignee who is also
 * @-mentioned only gets one notification + one email.
 */
export async function recordMentions({ text, commentId, replyId, mentionerUserId, projectId, assignedToUserId }) {
  // Extract raw mention strings: @Word or @"Multiple Words".
  // The leading lookbehind requires the @ to start the string or follow
  // whitespace / a small set of punctuation — so emails (alice@example.com),
  // citations, and other @-containing tokens are not treated as mentions.
  // Quoted mentions reject embedded newlines so a `@"...\n..."` can't span
  // an entire paragraph and balloon the candidate list.
  const mentionRe = /(?:^|(?<=[\s([{<,;:!?]))@(?:"([^"\n\r]+)"|(\S+))/g;
  const rawMentions = new Set();
  let m;
  while ((m = mentionRe.exec(text))) {
    rawMentions.add((m[1] || m[2]).toLowerCase());
  }
  // Early bail only when neither path has work to do — an assignment alone
  // (no @-mention in the body) must still record.
  if (rawMentions.size === 0 && !assignedToUserId) return [];

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
  const seenUserIds = new Set();

  // Path 1: @-mentions from the body — skip self.
  for (const mention of rawMentions) {
    const member = members.find((m) => m.name_lower === mention);
    if (!member || member.id === mentionerUserId) continue;
    if (seenUserIds.has(member.id)) continue;
    seenUserIds.add(member.id);
    recorded.push(await insertMentionRow({
      mentionedUserId: member.id, mentionerUserId, commentId, replyId, projectId, snippet,
    }));
  }

  // Path 2: explicit assignment — always record, even when the assignee IS
  // the mentioner. The assignee_picker in the UI is only populated from
  // @-mentioned names, so this path mostly fires alongside path 1; the
  // dedupe above keeps it to one row per user.
  if (assignedToUserId && !seenUserIds.has(assignedToUserId)) {
    // Confirm the assignee is actually a project member (defence against
    // tampered request bodies and stale client state).
    const assignee = members.find((m) => m.id === assignedToUserId);
    if (assignee) {
      seenUserIds.add(assignedToUserId);
      recorded.push(await insertMentionRow({
        mentionedUserId: assignedToUserId, mentionerUserId, commentId, replyId, projectId, snippet,
      }));
    }
  }

  return recorded;
}

async function insertMentionRow({ mentionedUserId, mentionerUserId, commentId, replyId, projectId, snippet }) {
  const id = uuid();
  await db.run(
    `INSERT INTO comment_mentions (id, comment_id, reply_id, mentioned_user_id, mentioner_user_id, project_id, snippet)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, commentId || null, replyId || null, mentionedUserId, mentionerUserId, projectId, snippet],
  );
  return {
    id,
    mentionedUserId,
    commentId: commentId || null,
    replyId: replyId || null,
    projectId,
    snippet,
  };
}
