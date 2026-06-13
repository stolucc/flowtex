// @ts-check
import React, { useEffect, useState } from 'react';
import { post, get } from '../api.js';

/**
 * Unlock prompt for an encrypted, locked project. Accepts either the
 * passphrase or the recovery code (the server tries both). On success
 * calls onUnlocked so the app can re-fetch project data.
 *
 * @param {object} props
 * @param {string} props.projectId
 * @param {() => void} props.onUnlocked
 * @param {() => void} [props.onCancel]  e.g. go back to dashboard
 */
export default function ProjectUnlockModal({ projectId, onUnlocked, onCancel }) {
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');

  useEffect(() => {
    let cancelled = false;
    get(`/api/projects/${projectId}/encryption`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setHint(d?.passphraseHint || ''); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  const submit = async (/** @type {React.FormEvent} */ e) => {
    e.preventDefault();
    if (!secret) return;
    setBusy(true);
    setError('');
    try {
      const res = await post(`/api/projects/${projectId}/unlock`, { secret });
      const data = await res.json();
      if (res.status === 429) { setError(data.error || 'Too many attempts. Wait a few minutes.'); return; }
      if (!res.ok || !data.ok) { setError('Incorrect passphrase or recovery code.'); return; }
      onUnlocked();
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-card unlock-modal" onClick={(/** @type {any} */ e) => e.stopPropagation()}>
        <form onSubmit={submit}>
          <h2>Unlock project</h2>
          <p className="unlock-modal-blurb">
            This project is encrypted. Enter its passphrase (or recovery code) to
            decrypt and open it.
          </p>
          {hint && <div className="unlock-hint">Hint: {hint}</div>}
          <label>
            Passphrase or recovery code
            <input
              type="password"
              autoFocus
              value={secret}
              onChange={(/** @type {any} */ e) => setSecret(e.target.value)}
            />
          </label>
          {error && <div className="encrypt-modal-error">{error}</div>}
          <div className="modal-actions">
            {onCancel && (
              <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
                Back
              </button>
            )}
            <button type="submit" className="btn-primary" disabled={busy || !secret}>
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
