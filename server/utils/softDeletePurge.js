// @ts-check
import { purgeExpiredSoftDeletes, SOFT_DELETE_WINDOW_DAYS } from '../services/authService.js';
import logger from '../logger.js';

// Run once an hour; the cron only acts on rows whose deleted_at is older
// than SOFT_DELETE_WINDOW_DAYS, so the cadence is just "how soon after
// the window closes should the purge actually fire."
const SWEEP_INTERVAL = 60 * 60 * 1000;

/** Start the daily recovery-bin sweep: every SWEEP_INTERVAL, hard-delete
 *  any soft-deleted user whose window has elapsed. Safe to call once at
 *  process start; uses .unref() so it doesn't keep the event loop alive. */
export function startSoftDeletePurgeJob() {
  async function sweep() {
    try {
      const purged = await purgeExpiredSoftDeletes();
      if (purged.length > 0) {
        logger.info(
          { count: purged.length, ids: purged, windowDays: SOFT_DELETE_WINDOW_DAYS },
          'Purged expired soft-deleted users',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Soft-delete purge sweep failed');
    }
  }
  // Run once at startup so a server that was down past the window doesn't
  // wait a full hour before catching up.
  sweep();
  setInterval(sweep, SWEEP_INTERVAL).unref();
}
