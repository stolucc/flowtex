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
 * @param {object|null} file       active file ({ id, content }) or null
 * @param {(msg: object) => void} sendWs  WS send function from App.jsx
 * @param {string} originId        per-tab origin tag (shared with the
 *                                 `changes` flow so a single tab can
 *                                 still filter all its own echoes)
 */
export default function useYjsSync(file, sendWs, originId) {
  const enabled = useMemo(() => isYjsSyncEnabled(), []);
  // Holding the binding in state (not a ref) so the consumer
  // re-renders once the extension is available — Editor.jsx needs
  // to know to re-init CodeMirror with the new extension.
  const [binding, setBinding] = useState(null);

  useEffect(() => {
    if (!enabled) { setBinding(null); return undefined; }
    if (!file || !file.id) { setBinding(null); return undefined; }

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

    const onWsYjsUpdate = (e) => {
      const msg = e?.detail;
      if (!msg || msg.fileId !== file.id) return;
      b.applyRemoteUpdate(msg.update, msg.originId);
    };
    const onWsYjsState = (e) => {
      const msg = e?.detail;
      if (!msg || msg.fileId !== file.id) return;
      b.applyRemoteState(msg.state);
    };
    window.addEventListener('ws:yjs-update', onWsYjsUpdate);
    window.addEventListener('ws:yjs-state', onWsYjsState);

    return () => {
      window.removeEventListener('ws:yjs-update', onWsYjsUpdate);
      window.removeEventListener('ws:yjs-state', onWsYjsState);
      setBinding(null);
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
  };
}
