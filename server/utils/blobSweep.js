// Cron driver for the blob-storage background sweeps. Two independent
// intervals (mirrors softDeletePurge.js shape):
//
//   - Refcount-orphan sweep: every hour. Cheap query + a handful of
//     unlinks at most.
//   - Reconciliation walk: every 6 hours. Walks the projects directory
//     to catch the rollback-orphan case (writeBlob landed a blob on
//     disk but the surrounding DB transaction failed).
//
// Both kick once at startup so a server that has been down past the
// interval catches up without waiting. .unref() on the interval handles
// so we don't pin the event loop in tests or short-lived processes.

import logger from '../logger.js';
import { sweepOrphanRefcounts, reconcileOnDiskBlobs } from '../services/blobGc.js';

const ORPHAN_SWEEP_INTERVAL = 60 * 60 * 1000; // 1 hour
const RECONCILE_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

export function startBlobSweepJob() {
  async function orphanSweep() {
    try {
      const result = await sweepOrphanRefcounts();
      if (result.collected > 0) {
        logger.info(result, 'blobSweep: collected orphan blob refcounts');
      }
    } catch (err) {
      logger.error({ err }, 'blobSweep: orphan refcount sweep failed');
    }
  }

  async function reconcile() {
    try {
      const recon = await reconcileOnDiskBlobs();
      if (recon.orphaned > 0 || recon.walked > 0) {
        logger.info(recon, 'blobSweep: reconciliation walk complete');
      }
    } catch (err) {
      logger.error({ err }, 'blobSweep: reconciliation sweep failed');
    }
  }

  orphanSweep();
  reconcile();
  setInterval(orphanSweep, ORPHAN_SWEEP_INTERVAL).unref();
  setInterval(reconcile, RECONCILE_INTERVAL).unref();
}
