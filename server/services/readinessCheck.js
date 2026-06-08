// SAAS-FOUNDATIONS item 6 -- readiness check for the stateless web
// tier. Returns a `{ ready, reason?, redisStatus? }` shape so the
// /api/ready route is a thin wrapper around this pure function.
//
// Three failure modes:
//   1. Draining (SIGTERM started; flipping this BEFORE any other
//      shutdown work is what makes rolling deploys safe -- the LB
//      sees the next probe fail and stops sending new traffic).
//   2. DB unreachable.
//   3. Cluster mode + Redis unreachable.

const READY_STATUSES = new Set(['ready', 'connect']);

/**
 * @param {object} args
 * @param {boolean} args.draining     - true when SIGTERM handler is running
 * @param {() => Promise<unknown>} args.probeDb - throws if DB is unreachable
 * @param {string} args.instanceMode  - process.env.FLOWTEX_INSTANCE_MODE shape
 * @param {object|null} args.redisClient - ioredis-shaped client, or null
 * @returns {Promise<{ ready: boolean, status: string, error?: string, redisStatus?: string }>}
 */
export async function evaluateReadiness({ draining, probeDb, instanceMode, redisClient }) {
  if (draining) {
    return { ready: false, status: 'draining' };
  }
  try {
    await probeDb();
  } catch {
    return { ready: false, status: 'not ready', error: 'database unreachable' };
  }
  const clusterMode = (instanceMode || 'single').toLowerCase() === 'cluster';
  if (clusterMode) {
    const redisStatus = redisClient?.status;
    if (!redisClient || !READY_STATUSES.has(redisStatus)) {
      return {
        ready: false,
        status: 'not ready',
        error: 'redis unreachable',
        redisStatus: redisStatus || 'absent',
      };
    }
  }
  return { ready: true, status: 'ready' };
}
