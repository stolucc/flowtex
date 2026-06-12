// @ts-check
import { Router } from 'express';
import { lookupCommandPackage, resetIndexCache } from '../services/commandPackageIndex.js';
import logger from '../logger.js';

const router = Router();

// Bound the rate of cmd-package lookups per user. The index is built
// in-memory on the first call and then cheap to query; but a misbehaving
// client (or a fuzzer) could still drive load up if it spams unique
// commands and forces upstream LLM fallbacks. 120/min is comfortably
// above the realistic burst rate (an error panel with 20 unique
// undefined commands -> 20 lookups, batched).
const RATE_BUCKET = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;

/** @param {string} userId */
function checkRate(userId) {
  const now = Date.now();
  const bucket = RATE_BUCKET.get(userId) || [];
  // Drop stamps outside the window
  const fresh = bucket.filter((/** @type {number} */ t) => now - t < RATE_WINDOW_MS);
  if (fresh.length >= RATE_MAX) {
    RATE_BUCKET.set(userId, fresh);
    return false;
  }
  fresh.push(now);
  RATE_BUCKET.set(userId, fresh);
  return true;
}

/** Validate the `cmd` query param: ASCII letters + digits, 1-64 chars,
 *  no backslash (the client strips it before sending). */
/** @param {unknown} cmd */
function validateCmd(cmd) {
  if (typeof cmd !== 'string') return null;
  if (cmd.length < 1 || cmd.length > 64) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9@:]*$/.test(cmd)) return null;
  return cmd;
}

/**
 * GET /api/latex/command-package?cmd=cref
 *
 * Returns { package: string|null, source: 'index' }.
 *
 * The index is built lazily on first call from the local TeX Live
 * installation. Subsequent calls are O(1) until the 24h refresh
 * deadline.
 */
router.get('/command-package', async (req, res) => {
  const cmd = validateCmd(req.query.cmd);
  if (!cmd) {
    return res.status(400).json({ error: 'Bad cmd' });
  }
  const userId = req.session?.userId || 'anon';
  if (!checkRate(userId)) {
    return res.status(429).json({ error: 'Too many lookups; slow down.' });
  }
  try {
    const pkg = await lookupCommandPackage(cmd);
    res.json({ package: pkg, source: pkg ? 'index' : 'unknown' });
  } catch (err) {
    logger.warn({ err, cmd }, 'command-package lookup failed');
    res.status(500).json({ error: 'Lookup failed', package: null });
  }
});

/**
 * POST /api/latex/command-package/reindex
 *
 * Admin-only: clear the cache so the next /command-package lookup
 * rebuilds against the current installation. Useful right after
 * installing a new TL package via tlmgr.
 */
router.post('/command-package/reindex', async (req, res) => {
  // Require the requester to be authenticated as admin -- only admins
  // can edit shared installation state.
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
  const dbRow = req.app?.locals?.dbCheckAdmin
    ? await req.app.locals.dbCheckAdmin(req.session.userId)
    : null;
  if (!dbRow?.is_admin) return res.status(403).json({ error: 'Admin only' });
  resetIndexCache();
  res.json({ ok: true });
});

export default router;
