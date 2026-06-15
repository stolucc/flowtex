// @ts-check
import { useEffect, useMemo, useState } from 'react';
import { createYjsBinding, isYjsSyncEnabled } from '../utils/yjsBinding.js';

/**
 * Phase 1.5 of the YJS-MIGRATION.
 *
 * Glue between the per-file Y.js binding and the existing WebSocket
 * dispatcher. The hook is intentionally a no-op when the feature flag
 * is off — it returns { enabled: false, extension: null } and creates
 * no Y.Doc, so the legacy `changes` flow is untouched on default
 * builds.
 *
 * When the flag is on:
 *   - A fresh Y.Doc is created the first time `file` becomes truthy
 *     and torn down when `file.id` changes (or on unmount).
 *   - `ws:yjs-update` window events are routed to the binding's
 *     `applyRemoteUpdate`. The dispatcher in useWebSocket.js has
 *     already filtered self-echoes by originId, but the binding
 *     re-checks for safety.
 *   - The CodeMirror extension is returned for Editor.jsx to splice
 *     into its extensions array.
 *
 * @param {any} file       active file ({ id, content }) or null
 * @param {(msg: object) => void} sendWs  WS send function from App.jsx
 * @param {string} originId        per-tab origin tag (shared with the
 *                                 `changes` flow so a single tab can
 *                                 still filter all its own echoes)
 * @param {boolean} [encrypted]    when true, force Y.js OFF (encrypted
 *                                 projects use the legacy relay)
 */
export default function useYjsSync(file, sendWs, originId, encrypted = false) {
  const enabled = useMemo(() => isYjsSyncEnabled({ encrypted }), [encrypted]);
  // Holding the binding in state (not a ref) so the consumer
  // re-renders once the extension is available — Editor.jsx needs
  // to know to re-init CodeMirror with the new extension.
  const [binding, setBinding] = useState(/** @type {any} */ (null));
  // Flips true once the binding's initial content is resolved (canonical
  // state applied, a peer update arrived, or the offline-fallback window
  // elapsed). Editor.jsx waits for this before creating the CodeMirror
  // view so the view is built WITH the full document — CodeMirror measures
  // line heights at creation; a doc inserted async into an
  // already-laid-out empty editor leaves the height map stuck at 1 line
  // (the file is in the DOM but the viewport renders blank). Resets to
  // false per file so each file re-waits for its own content.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!enabled) { setBinding(null); setHydrated(false); return undefined; }
    if (!file || !file.id) { setBinding(null); setHydrated(false); return undefined; }

    setHydrated(false);
    const b = createYjsBinding({
      fileId: file.id,
      initialText: typeof file.content === 'string' ? file.content : '',
      sendWs,
      originId,
      // sync defaults to phase2 inside createYjsBinding -- be
      // explicit here so a future rename is obvious.
      sync: 'phase2',
    });
    setBinding(b);

    let hydrateDone = false;
    const markHydrated = () => { if (!hydrateDone) { hydrateDone = true; setHydrated(true); } };
    // Already seeded (phase-1 path / pre-populated) — ready immediately.
    if (b.ytext.length > 0) markHydrated();
    // Safety net: an empty file never gets a non-empty state and an
    // offline client gets no server reply at all. Mount anyway once the
    // fallback-seed window has comfortably passed so the editor never
    // hangs unmounted.
    const hydrateTimer = setTimeout(markHydrated, 1800);

    const onWsYjsUpdate = (/** @type {any} */ e) => {
      const msg = e?.detail;
      if (!msg || msg.fileId !== file.id) return;
      b.applyRemoteUpdate(msg.update, msg.originId);
      if (b.ytext.length > 0) markHydrated();
    };
    const onWsYjsState = (/** @type {any} */ e) => {
      const msg = e?.detail;
      if (!msg || msg.fileId !== file.id) return;
      b.applyRemoteState(msg.state);
      // Server resolved this file's state — mount even if it's empty.
      markHydrated();
    };
    window.addEventListener('ws:yjs-update', onWsYjsUpdate);
    window.addEventListener('ws:yjs-state', onWsYjsState);

    return () => {
      window.removeEventListener('ws:yjs-update', onWsYjsUpdate);
      window.removeEventListener('ws:yjs-state', onWsYjsState);
      clearTimeout(hydrateTimer);
      setBinding(null);
      setHydrated(false);
      b.destroy();
    };
    // file.content is deliberately NOT in the dep list — re-creating
    // the binding on every keystroke would wipe the Y.Doc state. The
    // initial content is only used as a seed; further edits flow
    // through the binding itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, file?.id, sendWs, originId]);

  return {
    enabled,
    extension: binding?.extension ?? null,
    // Exposed so Editor.jsx's TC marks input filter can ignore
    // transactions dispatched by y-codemirror's syncPlugin during
    // a remote-state apply (which would otherwise mark the entire
    // initial document as user-inserted tracked changes).
    isApplyingRemote: binding?.isApplyingRemote ?? null,
    // Current canonical Y.Text as a string. Editor.jsx uses this to seed
    // the editor doc in the SAME transaction that splices in the yCollab
    // extension, so when the Y.Text is already populated (large docs whose
    // yjs-state applied before the splice) the view matches it. y-codemirror
    // only observes FUTURE Y.Text changes — it does not backfill an
    // already-full Y.Text into an empty view, which left big files blank.
    getText: binding ? () => binding.ytext.toString() : null,
    // See the [hydrated] state above. Editor.jsx gates view creation on
    // this so the CodeMirror view is built with the full document.
    hydrated,
  };
}
