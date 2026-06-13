// @ts-check
// Y.js binding utility (phase 1 of the YJS-MIGRATION).
//
// Wires Y.Doc / Y.Text to a CodeMirror 6 editor via y-codemirror.next's
// `yCollab` extension, and pipes Y.js update bytes over the existing
// FlowTex WebSocket as `yjs-update` messages.
//
// Scope of phase 1:
//   - Behind a localStorage feature flag `flowtex-yjs-sync` (or the
//     `?yjs=1` URL query) so it can be enabled per-developer without
//     breaking the existing broadcast-relay sync flow.
//   - One Y.Doc per (project, file). The doc's lifetime is tied to
//     whoever opens it; the server is a relay only — no persistence.
//   - Initial content seeded from the file's plain-text `content`
//     field when the doc has not yet been populated by a peer's
//     update.
//   - Sends Y.js updates with a per-tab originId so an echoed update
//     can be filtered the same way the legacy `changes` frames are.
//
// Out of scope (deferred to later migration phases):
//   - Server-side Y.Doc persistence (PG `files.content_yjs`).
//   - Comments / tracked changes re-anchored on Y.RelativePosition.
//   - Migration of existing projects on first open.
//   - Garbage collection / compaction of Y.Doc history.
//   - Removal of the legacy `changes` WebSocket path.

import * as Y from 'yjs';
import { yCollab } from 'y-codemirror.next';

const FLAG_STORAGE_KEY = 'flowtex-yjs-sync';
const FLAG_URL_PARAM = 'yjs';

/**
 * Returns true iff Y.js sync is enabled in this browser.
 *
 * Phase 6 of YJS-MIGRATION flipped this default to TRUE -- new
 * sessions now use CRDT sync end-to-end. The flag may still be
 * explicitly disabled by:
 *   - `?yjs=0` in the page URL (per-tab opt-out, e.g. to debug the
 *     legacy `changes` relay path that remains in the codebase as a
 *     hot-pluggable fallback)
 *   - `localStorage.setItem('flowtex-yjs-sync', '0')` (persistent
 *     opt-out, e.g. while we observe production behaviour over the
 *     first few days after cutover)
 *
 * Recognised values:
 *   '0' / 'false' -> disabled
 *   anything else (incl. unset, '1', 'true') -> enabled
 */
/** @param {{ encrypted?: boolean }} [opts] */
export function isYjsSyncEnabled(opts = {}) {
  // Encrypted projects use the legacy `changes` relay, not Y.js: the
  // Y.Doc CRDT state (content_yjs) is a plaintext copy of the document
  // and would defeat at-rest encryption, and seeding a Y.Doc from the
  // now-ciphertext files.content would corrupt the editor. Hard off.
  if (opts && opts.encrypted) return false;
  try {
    if (typeof window !== 'undefined' && window.location?.search) {
      const params = new URLSearchParams(window.location.search);
      const val = params.get(FLAG_URL_PARAM);
      if (val === '0' || val === 'false') return false;
      if (val === '1' || val === 'true') return true;
    }
  } catch { /* malformed URL — fall through to storage */ }
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = window.localStorage.getItem(FLAG_STORAGE_KEY);
      if (stored === '0' || stored === 'false') return false;
    }
  } catch { /* private mode — treat as enabled (the new default) */ }
  return true;
}

/**
 * Build the Y.js sync surface for a single file. Returns a handle the
 * editor can use to mount the CodeMirror extension and to forward
 * incoming WebSocket payloads to the Y.Doc.
 *
 * @param {object} args
 * @param {string} args.fileId       File id this Y.Doc represents.
 * @param {string} args.initialText  Plain-text content used to seed
 *                                   the Y.Text iff it is still empty
 *                                   after construction (peer updates
 *                                   may arrive first; in that case
 *                                   the seed is skipped to avoid
 *                                   duplicating content).
 * @param {(payload: object) => void} args.sendWs  Sends a JSON message
 *                                   over the active WebSocket. The
 *                                   binding will call this with a
 *                                   `{ type: 'yjs-update', fileId,
 *                                   update, originId }` payload.
 * @param {string} args.originId     Per-tab identifier for self-echo
 *                                   filtering on reconnect.
 * @param {string} [args.sync]       Sync mode: 'phase1' (local seed) or 'phase2' (server seed).
 *
 * @returns {{
 *   ydoc: Y.Doc,
 *   ytext: Y.Text,
 *   extension: import('@codemirror/state').Extension,
 *   applyRemoteUpdate: (updateB64: string, fromOriginId?: string) => void,
 *   applyRemoteState: (stateB64: string) => void,
 *   isApplyingRemote: () => boolean,
 *   destroy: () => void,
 *   LOCAL_ORIGIN: symbol,
 * }}
 */
export function createYjsBinding({ fileId, initialText, sendWs, originId, sync = 'phase2' }) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('content');

  // Phase-1 behaviour: each binding seeds its own Y.Doc from the
  // file's plain text. Phase-2 behaviour: the server seeds (once) on
  // first acquireRoom and serves the canonical state via yjs-state,
  // so multiple clients converge instead of producing N separate
  // copies of the seed under their own client-ids. The `sync` arg
  // selects between the two; tests that don't exercise the server
  // round-trip stay on phase-1 seeding.
  const SEED_ORIGIN = Symbol('flowtex.yjs.seed');
  const wantsLocalSeed =
    sync === 'phase1' &&
    typeof initialText === 'string' &&
    initialText.length > 0;
  if (wantsLocalSeed) {
    ydoc.transact(() => {
      if (ytext.length === 0) {
        ytext.insert(0, initialText);
      }
    }, SEED_ORIGIN);
  }

  // Tag local edits with a per-binding origin object so we can tell
  // local-origin updates apart from updates we apply from the wire
  // (which use a different origin -- the decoded payload's source).
  const LOCAL_ORIGIN = Symbol('flowtex.yjs.local');
  // Tag remote-applied updates so the updateV2 listener can skip
  // rebroadcasting them (otherwise every remote update would loop
  // straight back out to the network).
  const REMOTE_ORIGIN = Symbol('flowtex.yjs.remote');

  const updateHandler = (/** @type {Uint8Array} */ update, /** @type {unknown} */ origin) => {
    if (origin === SEED_ORIGIN) return;
    if (origin === REMOTE_ORIGIN) return;
    // Encode update bytes as base64 for safe JSON transport. The
    // current WS layer already accepts arbitrary base64 payloads
    // (binary file uploads), so the wire shape is consistent.
    const b64 = bytesToBase64(update);
    sendWs?.({
      type: 'yjs-update',
      fileId,
      update: b64,
      ...(originId ? { originId } : {}),
    });
  };
  ydoc.on('updateV2', updateHandler);

  // Re-entrancy counter set during Y.applyUpdateV2 of remote updates.
  // y-codemirror's syncPlugin observes the Y.Doc change and dispatches
  // an immediate (synchronous) CodeMirror transaction to insert the
  // delta. That transaction must NOT be marked as a tracked-changes
  // insert -- it's not a user edit, it's the editor catching up to
  // the canonical CRDT state. The TC marks filter checks
  // isApplyingRemote() via its shouldSkip predicate (wired in
  // Editor.jsx).
  let isApplyingRemoteCount = 0;
  const isApplyingRemote = () => isApplyingRemoteCount > 0;

  const applyRemoteUpdate = (/** @type {string} */ updateB64, /** @type {string} */ fromOriginId = '') => {
    if (typeof updateB64 !== 'string') return;
    if (fromOriginId && fromOriginId === originId) return; // self-echo
    let bytes;
    try { bytes = base64ToBytes(updateB64); } catch { return; }
    isApplyingRemoteCount += 1;
    try {
      Y.applyUpdateV2(ydoc, bytes, REMOTE_ORIGIN);
    } finally {
      isApplyingRemoteCount -= 1;
    }
  };

  // Apply the server's encodeStateAsUpdateV2 payload sent in reply to
  // yjs-request-state. Same mechanism as applyRemoteUpdate (Y.js
  // states ARE updates) but conceptually the "bring me up to date"
  // hook rather than the per-keystroke one.
  const applyRemoteState = (/** @type {string} */ stateB64) => applyRemoteUpdate(stateB64, '');

  // yCollab wires the Y.Text to a CodeMirror EditorView. Awareness is
  // optional (cursors of other users); phase 1 leaves it null because
  // FlowTex already has its own cursor-broadcast path.
  const extension = yCollab(ytext, /* awareness */ null);

  // Phase 2: ask the server for the canonical state immediately.
  // The server replies with `yjs-state` which the hook routes to
  // applyRemoteState. Until that response arrives the Y.Doc is empty
  // and the editor briefly shows no content -- the round-trip is
  // typically tens of ms over loopback / local LAN.
  if (sync === 'phase2') {
    sendWs?.({ type: 'yjs-request-state', fileId });
  }

  const destroy = () => {
    ydoc.off('updateV2', updateHandler);
    ydoc.destroy();
  };

  return {
    ydoc, ytext, extension,
    applyRemoteUpdate, applyRemoteState,
    isApplyingRemote,
    destroy,
    LOCAL_ORIGIN,
  };
}

// ── Base64 helpers ─────────────────────────────────────────────────────────
//
// Y.js updates are raw Uint8Array. JSON.stringify can't represent
// Uint8Array directly, so we round-trip via base64. atob/btoa only
// handle Latin-1 strings; we feed them per-byte to keep the binary
// content exact.

// Browser-only conversion helpers. atob/btoa only handle Latin-1
// strings, so we feed them byte-at-a-time to keep the binary payload
// exact. Node/vitest tests run with btoa/atob polyfilled (Node 16+).
/** @param {Uint8Array} bytes */
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** @param {string} b64 */
function base64ToBytes(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

export const __testing = { bytesToBase64, base64ToBytes };
