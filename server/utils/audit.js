// @ts-check
import db from '../db.js';
import logger from '../logger.js';

/**
 * Write an entry to the audit log table.
 * @param {string|null} userId
 * @param {string} action - e.g. 'login', 'password_reset', 'project_delete'.
 * @param {{
 *   targetType?: string | null,
 *   targetId?: string | null,
 *   detail?: object | string | null,
 *   ip?: string | null,
 * }} [opts]
 */
export async function auditLog(userId, action, { targetType, targetId, detail, ip } = {}) {
  try {
    await db.run(
      'INSERT INTO audit_log (user_id, action, target_type, target_id, detail, ip) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId || null, action, targetType || null, targetId || null, detail || null, ip || null],
    );
  } catch (err) {
    logger.error({ err }, 'Audit log error');
  }
}
