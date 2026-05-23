import db from '../db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export { UUID_RE };

// ── Membership cache (TTL 5s) ───────────────────────────────────────────
const membershipCache = new Map();
const MEMBERSHIP_TTL = 5000;

function membershipCacheKey(projectId, userId) {
  return `${projectId}:${userId}`;
}

/**
 * Invalidate cached membership entries for a project (and optionally a specific user).
 * @param {string} projectId
 * @param {string} [userId] - If omitted, invalidates all users for the project.
 */
export function invalidateMembership(projectId, userId) {
  if (userId) {
    membershipCache.delete(membershipCacheKey(projectId, userId));
  } else {
    // Invalidate all entries for this project
    for (const key of membershipCache.keys()) {
      if (key.startsWith(projectId + ':')) membershipCache.delete(key);
    }
  }
}

// Periodic cleanup of stale entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of membershipCache) {
    if (now - entry.ts > MEMBERSHIP_TTL) membershipCache.delete(key);
  }
}, 60000).unref();

/** Express middleware: reject the request if no session userId is set. */
export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

/** Express middleware: reject unless the session user has is_admin=true. */
export async function requireAdmin(req, res, next) {
  const user = await db.get('SELECT is_admin FROM users WHERE id = $1', [req.session.userId]);
  if (!user?.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Check project membership and send 403 if not a member.
 * @returns {Promise<{role: string}|null>} The membership row, or null if access was denied.
 */
export async function requireMember(projectId, userId, res) {
  const member = await isProjectMember(projectId, userId);
  if (!member) {
    res.status(403).json({ error: 'No access to this project' });
    return null;
  }
  return member;
}

/**
 * Check if a user is a member of a project (with 5s TTL cache).
 * @returns {Promise<{role: string}|null>}
 */
export async function isProjectMember(projectId, userId) {
  if (!UUID_RE.test(projectId)) return null;
  const cacheKey = membershipCacheKey(projectId, userId);
  const cached = membershipCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < MEMBERSHIP_TTL) {
    return cached.value;
  }
  const row = await db.get('SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [
    projectId,
    userId,
  ]);
  const value = row || null;
  membershipCache.set(cacheKey, { value, ts: Date.now() });
  return value;
}
