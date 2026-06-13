// @ts-check
// In-memory cache of unlocked project DEKs (Phase 2).
//
// When a user unlocks an encrypted project (Phase 3 routes), the
// derived DEK is held here so subsequent reads/writes in the same
// server process don't re-derive (Argon2id is ~250-500 ms). The cache
// is process-local and volatile by design:
//   - A server restart drops every DEK -> encrypted-project routes
//     return 423 (locked) and the client re-prompts for the passphrase.
//   - DEKs are NEVER persisted. Losing them on restart is the point.
//
// Refcounting: multiple sessions/tabs can unlock the same project. We
// keep one DEK + a reference count; the buffer is zeroed and dropped
// only when the last holder locks. This avoids one tab's "lock"
// wiping a key another tab is still using.

import { buffersEqual } from '../utils/projectCrypto.js';

/**
 * @typedef {{ dek: Buffer, refs: number }} Entry
 * @type {Map<string, Entry>}
 */
const cache = new Map();

/**
 * Record an unlocked DEK for a project (or bump its refcount if the
 * project is already unlocked). Idempotent per logical holder: callers
 * pair one unlock with one lock.
 *
 * If the project is already cached under a DIFFERENT DEK (shouldn't
 * happen — same project has one DEK — but guard anyway), the new key
 * is rejected and the existing refcount is left untouched; callers
 * treat a false return as "use the already-cached key".
 *
 * @param {string} projectId
 * @param {Buffer} dek 32-byte data key
 * @returns {boolean} true if stored/bumped under this dek
 */
export function unlockProject(projectId, dek) {
  if (!projectId || !Buffer.isBuffer(dek) || dek.length !== 32) return false;
  const existing = cache.get(projectId);
  if (existing) {
    if (!buffersEqual(existing.dek, dek)) return false;
    existing.refs += 1;
    return true;
  }
  // Copy so the caller's buffer lifetime doesn't affect the cache.
  cache.set(projectId, { dek: Buffer.from(dek), refs: 1 });
  return true;
}

/**
 * Release one reference. When the last reference drops, the DEK buffer
 * is zeroed and removed.
 *
 * @param {string} projectId
 * @returns {boolean} true if the project is now fully locked (no refs)
 */
export function lockProject(projectId) {
  const entry = cache.get(projectId);
  if (!entry) return true;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    entry.dek.fill(0); // zero key material before drop
    cache.delete(projectId);
    return true;
  }
  return false;
}

/**
 * Force-drop a project's DEK regardless of refcount (e.g. passphrase
 * rotation invalidates the cached key). Zeroes the buffer.
 *
 * @param {string} projectId
 */
export function forceLockProject(projectId) {
  const entry = cache.get(projectId);
  if (!entry) return;
  entry.dek.fill(0);
  cache.delete(projectId);
}

/**
 * Get the cached DEK for a project, or null if locked. The returned
 * buffer is the live cache buffer — callers must NOT mutate it.
 *
 * @param {string} projectId
 * @returns {Buffer | null}
 */
export function getProjectDEK(projectId) {
  return cache.get(projectId)?.dek ?? null;
}

/**
 * @param {string} projectId
 * @returns {boolean}
 */
export function isProjectUnlocked(projectId) {
  return cache.has(projectId);
}

/**
 * Current refcount for a project (0 if locked). Exposed for tests +
 * diagnostics.
 * @param {string} projectId
 */
export function refCount(projectId) {
  return cache.get(projectId)?.refs ?? 0;
}

/**
 * Drop ALL cached DEKs (zeroing each). For tests and graceful
 * shutdown.
 */
export function clearAllProjectKeys() {
  for (const entry of cache.values()) entry.dek.fill(0);
  cache.clear();
}
