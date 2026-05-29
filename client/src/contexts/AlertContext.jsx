import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/** Themed replacement for window.alert / window.confirm.
 *
 *  Provider renders at most one dialog at a time. The hook returns
 *  promise-based primitives so callers (components AND hooks) get the
 *  same imperative shape they're used to:
 *
 *    const { alert, confirm } = useAlert();
 *    await alert('Could not save');
 *    if (await confirm('Delete this file?', { tone: 'danger' })) {
 *      ...
 *    }
 *
 *  Both stack — calling alert/confirm while a dialog is open queues the
 *  new request behind the current one, so a save-failure mid-dialog
 *  can't silently disappear. Escape and overlay-click resolve cancel
 *  (alert: void, confirm: false) and look identical to clicking the
 *  default action button so muscle memory carries over from native.
 */

const AlertContext = createContext(null);

const DEFAULT_LABELS = { ok: 'OK', confirm: 'Confirm', cancel: 'Cancel' };

export function AlertProvider({ children }) {
  // Queue of pending dialogs. Render the head; pop on resolve.
  const [queue, setQueue] = useState([]);
  const idRef = useRef(0);

  const pushDialog = useCallback((spec) => {
    return new Promise((resolve) => {
      const id = ++idRef.current;
      setQueue((q) => [...q, { ...spec, id, resolve }]);
    });
  }, []);

  const alert = useCallback((message, opts = {}) => {
    return pushDialog({
      kind: 'alert',
      title: opts.title || 'Notice',
      message,
      okLabel: opts.okLabel || DEFAULT_LABELS.ok,
    });
  }, [pushDialog]);

  const confirm = useCallback((message, opts = {}) => {
    return pushDialog({
      kind: 'confirm',
      title: opts.title || 'Confirm',
      message,
      confirmLabel: opts.confirmLabel || DEFAULT_LABELS.confirm,
      cancelLabel: opts.cancelLabel || DEFAULT_LABELS.cancel,
      tone: opts.tone || 'default',
    });
  }, [pushDialog]);

  const resolveCurrent = useCallback((value) => {
    setQueue((q) => {
      if (!q.length) return q;
      q[0].resolve(value);
      return q.slice(1);
    });
  }, []);

  const current = queue[0];
  const value = { alert, confirm };

  return (
    <AlertContext.Provider value={value}>
      {children}
      {current && <DialogShell spec={current} onResolve={resolveCurrent} />}
    </AlertContext.Provider>
  );
}

export function useAlert() {
  const ctx = useContext(AlertContext);
  if (!ctx) {
    // Failing loudly here beats silent no-ops — callers MUST be inside
    // an AlertProvider for security/UX guarantees (no swallowed errors,
    // no missing confirmations).
    throw new Error('useAlert called outside AlertProvider');
  }
  return ctx;
}

function DialogShell({ spec, onResolve }) {
  const primaryRef = useRef(null);

  useEffect(() => {
    primaryRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        // Alert: dismissing equals acknowledgement.
        // Confirm: dismissing equals cancel.
        onResolve(spec.kind === 'alert' ? undefined : false);
      } else if (e.key === 'Enter') {
        onResolve(spec.kind === 'alert' ? undefined : true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // spec.id rotates on each new dialog so the listener re-binds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.id]);

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      onResolve(spec.kind === 'alert' ? undefined : false);
    }
  };

  return (
    <div className="modal-overlay confirm-dialog-overlay" onClick={handleOverlayClick}>
      <div className="modal-card confirm-dialog" role="dialog" aria-modal="true">
        <p className="confirm-dialog-message">{spec.message}</p>
        <div className="confirm-dialog-actions">
          {spec.kind === 'confirm' && (
            <button
              type="button"
              className="confirm-dialog-cancel"
              onClick={() => onResolve(false)}
            >
              {spec.cancelLabel}
            </button>
          )}
          <button
            type="button"
            ref={primaryRef}
            className={spec.kind === 'confirm' && spec.tone === 'danger'
              ? 'confirm-dialog-delete'
              : 'confirm-dialog-cancel'}
            onClick={() => onResolve(spec.kind === 'alert' ? undefined : true)}
          >
            {spec.kind === 'alert' ? spec.okLabel : spec.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
