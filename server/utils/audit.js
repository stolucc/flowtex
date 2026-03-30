import db from '../db.js';
import logger from '../logger.js';

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
