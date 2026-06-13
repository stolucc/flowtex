// @ts-check
import React, { useState } from 'react';
import { post } from '../api.js';

/**
 * Two-step modal to turn on per-project encryption:
 *   1. passphrase entry (+ optional hint) → POST /encrypt
 *   2. recovery-code reveal — user MUST confirm they saved it before
 *      the modal can close (the code is shown exactly once).
 *
 * @param {object} props
 * @param {string} props.projectId
 * @param {() => void} props.onClose
 * @param {() => void} [props.onEnabled]  called after the user confirms
 */
export default function EnableEncryptionModal({ projectId, onClose, onEnabled }) {
  const [step, setStep] = useState(/** @type {'entry' | 'reveal'} */ ('entry'));
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [savedAck, setSavedAck] = useState(false);
  const [copied, setCopied] = useState(false);

  const submit = async (/** @type {React.FormEvent} */ e) => {
    e.preventDefault();
    setError('');
    if (passphrase.length < 8) { setError('Passphrase must be at least 8 characters.'); return; }
    if (passphrase !== confirm) { setError('Passphrases do not match.'); return; }
    setBusy(true);
    try {
      const res = await post(`/api/projects/${projectId}/encrypt`, {
        passphrase,
        passphraseHint: hint.trim() || null,
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Could not enable encryption.'); setBusy(false); return; }
      setRecoveryCode(data.recoveryCode);
      setStep('reveal');
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const copyCode = () => {
    try {
      navigator.clipboard?.writeText(recoveryCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const finish = () => {
    if (!savedAck) return;
    onEnabled?.();
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={step === 'entry' ? onClose : undefined}>
      <div className="modal-card encrypt-modal" onClick={(/** @type {any} */ e) => e.stopPropagation()}>
        {step === 'entry' && (
          <form onSubmit={submit}>
            <h2>Enable encryption</h2>
            <p className="encrypt-modal-blurb">
              Encrypts this project&apos;s file contents at rest. Protects against
              database leaks and backup theft. It does <strong>not</strong> protect
              against a compromised server — files are briefly in cleartext on disk
              during compile. If you lose both the passphrase and the recovery
              code, the data is <strong>unrecoverable</strong>.
            </p>
            <label>
              Passphrase
              <input
                type="password"
                autoFocus
                value={passphrase}
                onChange={(/** @type {any} */ e) => setPassphrase(e.target.value)}
                placeholder="at least 12 characters recommended"
              />
            </label>
            <label>
              Confirm passphrase
              <input
                type="password"
                value={confirm}
                onChange={(/** @type {any} */ e) => setConfirm(e.target.value)}
              />
            </label>
            <label>
              Hint (optional, stored in plaintext)
              <input
                type="text"
                value={hint}
                onChange={(/** @type {any} */ e) => setHint(e.target.value)}
                placeholder="shown on the unlock screen"
              />
            </label>
            {error && <div className="encrypt-modal-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? 'Encrypting…' : 'Enable encryption'}
              </button>
            </div>
          </form>
        )}

        {step === 'reveal' && (
          <div>
            <h2>Save your recovery code</h2>
            <p className="encrypt-modal-blurb">
              This is the <strong>only</strong> time this code is shown. Store it in a
              password manager. It unlocks the project if you forget the passphrase.
            </p>
            <div className="encrypt-recovery-code">
              <code>{recoveryCode}</code>
              <button type="button" className="btn-secondary" onClick={copyCode}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <label className="encrypt-ack">
              <input
                type="checkbox"
                checked={savedAck}
                onChange={(/** @type {any} */ e) => setSavedAck(e.target.checked)}
              />
              I have saved this recovery code somewhere safe.
            </label>
            <div className="modal-actions">
              <button type="button" className="btn-primary" onClick={finish} disabled={!savedAck}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
