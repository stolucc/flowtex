// Cron driver for the phase-B blob-storage background work. Two
// independent intervals (mirrors softDeletePurge.js shape):
//
//   - Refcount-orphan sweep: every hour. Cheap query + a handful of
//     unlinks at most.
//   - Reconciliation + migrator: every 6 hours. Walks the projects
//     directory and ticks the legacy-base64 migrator a few batches
//     forward.
//
// Both kick once at startup so a server that has been down past the
// interval catches up without waiting. .unref() on the interval handles
// so we don't pin the event loop in tests or short-lived processes.

import logger from '../logger.js';
import { sweepOrphanRefcounts, reconcileOnDiskBlobs } from '../services/blobGc.js';
import { migrateLegacyBlobBatch, countLegacyBlobRows } from '../services/blobMigrator.js';

const ORPHAN_SWEEP_INTERVAL = 60 * 60 * 1000; // 1 hour
const RECONCILE_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const MIGRATOR_BATCHES_PER_TICK = 4; // 4 × 25 = up to 100 rows / tick

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

  async function reconcileAndMigrate() {
    try {
      const recon = await reconcileOnDiskBlobs();
      if (recon.orphaned > 0 || recon.walked > 0) {
        logger.info(recon, 'blobSweep: reconciliation walk complete');
      }
    } catch (err) {
      logger.error({ err }, 'blobSweep: reconciliation sweep failed');
    }

    try {
      const remaining = await countLegacyBlobRows();
      if (remaining === 0) return;
      let totalMigrated = 0;
      for (let i = 0; i < MIGRATOR_BATCHES_PER_TICK; i++) {
        const batch = await migrateLegacyBlobBatch();
        totalMigrated += batch.migrated;
        if (batch.examined === 0) break;
      }
      if (totalMigrated > 0) {
        logger.info(
          { migrated: totalMigrated, remainingBeforeTick: remaining },
          'blobSweep: migrated legacy base64 rows to blob store',
        );
      }
    } catch (err) {
      logger.error({ err }, 'blobSweep: legacy-row migrator failed');
    }
  }

  orphanSweep();
  reconcileAndMigrate();
  setInterval(orphanSweep, ORPHAN_SWEEP_INTERVAL).unref();
  setInterval(reconcileAndMigrate, RECONCILE_INTERVAL).unref();
}
