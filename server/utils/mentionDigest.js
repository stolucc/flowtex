import db from '../db.js';
import { sendMentionDigestEmail } from './email.js';
import logger from '../logger.js';

const DIGEST_INTERVAL = 5 * 60 * 1000; // 5 minutes

/**
 * Periodically send batched @mention notification emails.
 * Groups all pending (un-notified) mentions by recipient and sends one email per user.
 */
export function startMentionDigestJob() {
  async function flush() {
    try {
      // Fetch all pending mentions grouped by recipient. Skip chat-mention
      // rows (chat_message_id IS NOT NULL) — chat @-mentions are bell-only by
      // design; mark them notified so they don't accumulate in this queue.
      await db.run(
        `UPDATE comment_mentions SET notified_at = NOW()
         WHERE chat_message_id IS NOT NULL AND notified_at IS NULL`,
      );
      const pending = await db.all(`
        SELECT cm.id, cm.snippet, cm.mentioned_user_id, cm.mentioner_user_id, cm.project_id,
               u_to.email AS recipient_email, u_to.name AS recipient_name,
               u_from.name AS mentioner_name,
               p.name AS project_name
        FROM comment_mentions cm
        JOIN users u_to ON cm.mentioned_user_id = u_to.id
        JOIN users u_from ON cm.mentioner_user_id = u_from.id
        JOIN projects p ON cm.project_id = p.id
        WHERE cm.notified_at IS NULL AND cm.chat_message_id IS NULL
        ORDER BY cm.created_at
      `);

      if (pending.length === 0) return;

      // Group by recipient
      const byRecipient = {};
      for (const row of pending) {
        if (!byRecipient[row.mentioned_user_id]) {
          byRecipient[row.mentioned_user_id] = {
            email: row.recipient_email,
            name: row.recipient_name,
            mentions: [],
            ids: [],
          };
        }
        byRecipient[row.mentioned_user_id].mentions.push(row);
        byRecipient[row.mentioned_user_id].ids.push(row.id);
      }

      const baseUrl = process.env.APP_URL || 'http://localhost:3001';

      for (const [userId, data] of Object.entries(byRecipient)) {
        try {
          await sendMentionDigestEmail(data.email, {
            recipientName: data.name,
            mentions: data.mentions,
            baseUrl,
          });
          // Mark as notified
          const placeholders = data.ids.map((_, i) => `$${i + 1}`).join(',');
          await db.run(
            `UPDATE comment_mentions SET notified_at = NOW() WHERE id IN (${placeholders})`,
            data.ids,
          );
          logger.info({ userId, count: data.mentions.length }, 'Sent mention digest email');
        } catch (err) {
          logger.error({ err, userId }, 'Failed to send mention digest email');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Mention digest job error');
    }
  }

  // First flush after 1 minute, then every 5 minutes
  setTimeout(flush, 60000).unref();
  setInterval(flush, DIGEST_INTERVAL).unref();
}
