import React, { useState } from 'react';
import { post } from '../api.js';

export default function MfaSetupModal({ user, onClose, onUpdate, onAccountDeleted }) {
  const [tab, setTab] = useState('mfa');

  // ── MFA state ──────────────────────────────────────────────────────
  const [step, setStep] = useState(user.totpEnabled ? 'disable' : 'start');
  const [qrCode, setQrCode] = useState(null);
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [mfaPassword, setMfaPassword] = useState('');
  const [mfaError, setMfaError] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);

  // ── Delete account state ───────────────────────────────────────────
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);

  // ── MFA handlers ───────────────────────────────────────────────────
  const handleSetup = async () => {
    setMfaError('');
    setMfaLoading(true);
    try {
      const res = await post('/api/auth/totp/setup');
      const data = await res.json();
      if (!res.ok) {
        setMfaError(data.error);
      } else {
        setQrCode(data.qrCode);
        setSecret(data.secret);
        setStep('scan');
      }
    } catch (err) {
      setMfaError(err.message);
    }
    setMfaLoading(false);
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    setMfaError('');
    setMfaLoading(true);
    try {
      const res = await post('/api/auth/totp/verify', { code });
      const data = await res.json();
      if (!res.ok) {
        setMfaError(data.error);
      } else {
        setStep('done');
        onUpdate({ ...user, totpEnabled: true });
      }
    } catch (err) {
      setMfaError(err.message);
    }
    setMfaLoading(false);
  };

  const handleDisable = async (e) => {
    e.preventDefault();
    setMfaError('');
    setMfaLoading(true);
    try {
      const res = await post('/api/auth/totp/disable', { password: mfaPassword });
      const data = await res.json();
      if (!res.ok) {
        setMfaError(data.error);
      } else {
        onUpdate({ ...user, totpEnabled: false });
        onClose();
      }
    } catch (err) {
      setMfaError(err.message);
    }
    setMfaLoading(false);
  };

  // ── Delete account handler ─────────────────────────────────────────
  const handleDeleteAccount = async (e) => {
    e.preventDefault();
    setDeleteError('');
    if (deleteConfirm !== 'DELETE') {
      setDeleteError('Please type DELETE to confirm');
      return;
    }
    setDeleteLoading(true);
    try {
      const res = await post('/api/auth/delete-account', { password: deletePassword });
      const data = await res.json();
      if (!res.ok) {
        setDeleteError(data.error);
      } else {
        onAccountDeleted();
      }
    } catch (err) {
      setDeleteError(err.message);
    }
    setDeleteLoading(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Account Settings</h2>
        <p className="settings-user-info">{user.name} &mdash; {user.email}</p>

        <div className="settings-tabs">
          <button
            className={`settings-tab ${tab === 'mfa' ? 'active' : ''}`}
            onClick={() => setTab('mfa')}
          >
            Two-Factor Auth
          </button>
          <button
            className={`settings-tab ${tab === 'delete' ? 'active' : ''}`}
            onClick={() => setTab('delete')}
          >
            Delete Account
          </button>
        </div>

        {tab === 'mfa' && (
          <div className="settings-section">
            {step === 'start' && (
              <>
                <p className="mfa-description">
                  Add an extra layer of security to your account by requiring a verification code from an authenticator app when you sign in.
                </p>
                {mfaError && <div className="auth-error">{mfaError}</div>}
                <button className="auth-button" onClick={handleSetup} disabled={mfaLoading}>
                  {mfaLoading ? 'Setting up...' : 'Set Up 2FA'}
                </button>
              </>
            )}

            {step === 'scan' && (
              <>
                <p className="mfa-description">
                  Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.):
                </p>
                {qrCode && <img src={qrCode} alt="QR Code" className="mfa-qr" />}
                <details className="mfa-secret-details">
                  <summary>Can't scan? Enter this key manually</summary>
                  <code className="mfa-secret-code">{secret}</code>
                </details>
                <form onSubmit={handleVerify} className="auth-form">
                  <p className="mfa-description">Enter the 6-digit code from your app to verify:</p>
                  <input
                    type="text"
                    placeholder="000000"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    required
                    autoFocus
                    className="auth-input auth-input-totp"
                    inputMode="numeric"
                  />
                  {mfaError && <div className="auth-error">{mfaError}</div>}
                  <button type="submit" className="auth-button" disabled={mfaLoading || code.length !== 6}>
                    {mfaLoading ? 'Verifying...' : 'Verify & Enable'}
                  </button>
                </form>
              </>
            )}

            {step === 'done' && (
              <>
                <p className="mfa-success">Two-factor authentication is now enabled.</p>
                <button className="auth-button" onClick={onClose}>Done</button>
              </>
            )}

            {step === 'disable' && (
              <>
                <p className="mfa-description">
                  Two-factor authentication is currently <strong>enabled</strong>.
                  Enter your password to disable it.
                </p>
                <form onSubmit={handleDisable} className="auth-form">
                  <input
                    type="password"
                    placeholder="Your password"
                    value={mfaPassword}
                    onChange={(e) => setMfaPassword(e.target.value)}
                    required
                    className="auth-input"
                  />
                  {mfaError && <div className="auth-error">{mfaError}</div>}
                  <button type="submit" className="auth-button mfa-disable-btn" disabled={mfaLoading}>
                    {mfaLoading ? 'Disabling...' : 'Disable 2FA'}
                  </button>
                </form>
              </>
            )}
          </div>
        )}

        {tab === 'delete' && (
          <div className="settings-section">
            <div className="delete-account-warning">
              <strong>This action is permanent and cannot be undone.</strong>
              <p>Deleting your account will:</p>
              <ul>
                <li>Remove all projects you own that have no other members</li>
                <li>Remove you from all shared projects</li>
                <li>Delete your tags, GitHub links, and session data</li>
                <li>Anonymise your comments and file history</li>
              </ul>
            </div>
            <form onSubmit={handleDeleteAccount} className="auth-form">
              <label className="settings-label">Enter your password:</label>
              <input
                type="password"
                placeholder="Your password"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                required
                className="auth-input"
              />
              <label className="settings-label">Type <strong>DELETE</strong> to confirm:</label>
              <input
                type="text"
                placeholder="DELETE"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                required
                className="auth-input"
              />
              {deleteError && <div className="auth-error">{deleteError}</div>}
              <button
                type="submit"
                className="auth-button delete-account-btn"
                disabled={deleteLoading || deleteConfirm !== 'DELETE' || !deletePassword}
              >
                {deleteLoading ? 'Deleting account...' : 'Permanently Delete My Account'}
              </button>
            </form>
          </div>
        )}

        <button className="modal-close-btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
