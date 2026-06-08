// YJS-WORKER-SPLIT phase 3 cutover -- selector between in-process
// and remote Y.Doc rooms.
//
// Selection precedence (first match wins):
//   1. FLOWTEX_YJS_WORKER=enabled / 1 / true  -> remote
//   2. FLOWTEX_YJS_WORKER=disabled / 0 / false -> in-process
//      (lets an operator explicitly opt out even in cluster mode)
//   3. Cluster mode AND REDIS_URL set -> remote (the phase 3
//      cutover default: if you're running multi-instance, you
//      want the worker tier)
//   4. Anything else -> in-process (single-VPS deploys, dev,
//      tests with no env)
//
// Pre-cutover, only rule (1) was true; in-process was the implicit
// default for every other case. The new default in (3) makes the
// worker tier opt-in by infrastructure shape rather than requiring
// the operator to set TWO env vars (instance mode AND yjs worker).
// Single-VPS deploys see no change because FLOWTEX_INSTANCE_MODE is
// unset (defaults to "single"); cluster deploys get the right
// thing automatically.
//
// Why an intermediary selector instead of editing every call site
// to flag-decide:
//   - The selector is the single source of truth for the routing
//     decision.
//   - Callers don't have to know which backend is live; the
//     interface is identical (acquireRoom / applyUpdate /
//     encodeStateAsUpdate / releaseRoom / peekRoom).
//   - Tests can swap the selector's internal active reference
//     without touching call-site mocks.

import * as inProcess from './yjsRoom.js';
import * as remote from './yjsRoomClient.js';

let active = null;

function classifyExplicitFlag(raw) {
  const v = (raw || '').toLowerCase();
  if (v === 'enabled' || v === '1' || v === 'true') return 'remote';
  if (v === 'disabled' || v === '0' || v === 'false') return 'in-process';
  return null;                                  // unset / unknown
}

/**
 * Pick the backend based on the precedence rules above. Idempotent
 * within the process lifetime -- subsequent calls return the
 * already-selected backend so the routing decision survives across
 * the request lifecycle.
 */
export function getYjsBackend() {
  if (active) return active;
  // 1 + 2: explicit operator decision wins.
  const explicit = classifyExplicitFlag(process.env.FLOWTEX_YJS_WORKER);
  if (explicit === 'remote') {
    active = { kind: 'remote', impl: remote };
    return active;
  }
  if (explicit === 'in-process') {
    active = { kind: 'in-process', impl: inProcess };
    return active;
  }
  // 3: cutover default for cluster deploys.
  const clusterMode = (process.env.FLOWTEX_INSTANCE_MODE || 'single').toLowerCase() === 'cluster';
  const hasRedis = !!process.env.REDIS_URL;
  if (clusterMode && hasRedis) {
    active = { kind: 'remote', impl: remote };
    return active;
  }
  // 4: in-process default for single-VPS / dev / tests.
  active = { kind: 'in-process', impl: inProcess };
  return active;
}

export function isWorkerSplitEnabled() {
  return getYjsBackend().kind === 'remote';
}

export function _resetForTests() {
  active = null;
}

// ── Convenience wrappers ───────────────────────────────────────────────
//
// Each wrapper checks the selector then dispatches. Most call sites
// will eventually be migrated to import these directly; for phase 1
// we leave existing direct imports of yjsRoom alone so the diff stays
// small. The wrappers exist so a future call site can opt in by
// import path.

export async function acquireRoom(projectId, fileId) {
  return getYjsBackend().impl.acquireRoom(projectId, fileId);
}

export async function applyUpdate(projectId, fileId, updateBytes) {
  const backend = getYjsBackend();
  if (backend.kind === 'in-process') {
    // The in-process applyUpdate is synchronous in the existing API;
    // promisify for interface symmetry with the remote variant.
    backend.impl.applyUpdate(projectId, fileId, updateBytes);
    return true;
  }
  return backend.impl.applyUpdate(projectId, fileId, updateBytes);
}

export async function encodeStateAsUpdate(projectId, fileId) {
  const backend = getYjsBackend();
  if (backend.kind === 'in-process') {
    return backend.impl.encodeStateAsUpdate(projectId, fileId);
  }
  return backend.impl.encodeStateAsUpdate(projectId, fileId);
}

export async function releaseRoom(projectId, fileId) {
  return getYjsBackend().impl.releaseRoom(projectId, fileId);
}

/**
 * Synchronous read-only probe. Returns the room object (with .ydoc)
 * when held locally; returns null on the remote backend because the
 * Y.Doc lives in another process. Anchor-resolution call sites use
 * the null return as a signal to fall back to legacy from_pos/to_pos
 * integer columns -- same path they already take when no room is
 * held in process.
 */
export function peekRoom(projectId, fileId) {
  return getYjsBackend().impl.peekRoom(projectId, fileId);
}
