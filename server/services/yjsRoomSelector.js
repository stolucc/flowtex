// YJS-WORKER-SPLIT phase 1 -- selector between in-process and
// remote Y.Doc rooms.
//
// FLOWTEX_YJS_WORKER=enabled routes every yjsRoom call through the
// Redis-backed client (services/yjsRoomClient.js) and the dedicated
// worker (server/yjsWorker.js). Any other value (including unset)
// keeps the in-process behaviour shipped in YJS-MIGRATION phases
// 2-6.
//
// Why an intermediary selector instead of editing every call site
// to import-flag-decide:
//   - The selector is the single source of truth for the routing
//     decision -- a future phase 3 cutover flips one boolean here.
//   - Callers don't have to know which backend is live; the
//     interface is identical (acquireRoom / applyUpdate /
//     encodeStateAsUpdate / releaseRoom).
//   - Tests can swap the selector's internal active reference
//     without touching call-site mocks.

import * as inProcess from './yjsRoom.js';
import * as remote from './yjsRoomClient.js';

let active = null;

/**
 * Pick the backend based on FLOWTEX_YJS_WORKER. Idempotent --
 * subsequent calls return the already-selected backend so the
 * routing decision survives across the request lifecycle.
 */
export function getYjsBackend() {
  if (active) return active;
  const mode = (process.env.FLOWTEX_YJS_WORKER || '').toLowerCase();
  active = mode === 'enabled' || mode === '1' || mode === 'true'
    ? { kind: 'remote', impl: remote }
    : { kind: 'in-process', impl: inProcess };
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
