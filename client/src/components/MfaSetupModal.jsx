import React, { useState, useEffect } from 'react';
import { get, post, put, patch, del } from '../api.js';

/** Account settings modal with tabs for 2FA, email, password, GitHub connection, and account deletion. */
export default function MfaSetupModal({ user, onClose, onUpdate, onAccountDeleted, initialTab }) {
  const [tab, setTab] = useState(initialTab || 'mfa');

  // ── MFA state ──────────────────────────────────────────────────────
  const [step, setStep] = useState(user.totpEnabled ? 'disable' : 'start');
  const [qrCode, setQrCode] = useState(null);
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [mfaPassword, setMfaPassword] = useState('');
  const [mfaError, setMfaError] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);

  // ── Profile (display name) state ───────────────────────────────────
  const [profileName, setProfileName] = useState(user.name || '');
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);

  // ── Change email state ─────────────────────────────────────────────
  const [emailNewVal, setEmailNewVal] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [emailSuccess, setEmailSuccess] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);

  // ── Change password state ──────────────────────────────────────────
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');
  const [pwLoading, setPwLoading] = useState(false);

  // ── Delete account state ───────────────────────────────────────────
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);

  // ── MFA handlers ───────────────────────────────────────────────────
  /** Request a new TOTP secret and QR code from the server. */
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

  /** Verify the user's TOTP code and enable 2FA. */
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

  /** Disable 2FA after password confirmation. */
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

  // ── GitHub connection state ───────────────────────────────────────
  const [ghHasToken, setGhHasToken] = useState(false);
  const [ghUsername, setGhUsername] = useState(null);
  const [ghOauthAvailable, setGhOauthAvailable] = useState(false);
  const [ghTokenInput, setGhTokenInput] = useState('');
  const [ghShowTokenInput, setGhShowTokenInput] = useState(false);
  const [ghConnecting, setGhConnecting] = useState(false);
  const [ghError, setGhError] = useState('');
  const [ghSuccess, setGhSuccess] = useState('');
  const [ghLoading, setGhLoading] = useState(true);

  useEffect(() => {
    if (tab === 'github') {
      setGhLoading(true);
      Promise.all([
        get('/api/github/token')
          .then((r) => r.json())
          .catch(() => ({ hasToken: false })),
        get('/api/github/oauth/available')
          .then((r) => r.json())
          .catch(() => ({ available: false })),
      ]).then(([tokenData, oauthData]) => {
        setGhHasToken(tokenData.hasToken);
        setGhUsername(tokenData.username || null);
        setGhOauthAvailable(oauthData.available);
        setGhLoading(false);
      });
    }
  }, [tab]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('github') === 'connected') {
      setTab('github');
      setGhHasToken(true);
      setGhSuccess('GitHub account connected successfully');
      window.history.replaceState({}, '', window.location.pathname);
      setTimeout(() => setGhSuccess(''), 3000);
    }
  }, []);

  /** Redirect to the GitHub OAuth authorization flow. */
  const ghConnectOAuth = () => {
    setGhConnecting(true);
    const returnTo = window.location.pathname;
    window.location.href = `/api/github/oauth/authorize?returnTo=${encodeURIComponent(returnTo)}`;
  };

  /** Save a manually entered GitHub personal access token. */
  const ghSaveToken = async () => {
    if (!ghTokenInput.trim()) return;
    setGhError('');
    const res = await put('/api/github/token', { token: ghTokenInput.trim() });
    if (res.ok) {
      setGhHasToken(true);
      setGhShowTokenInput(false);
      setGhTokenInput('');
      setGhSuccess('Token saved');
      setTimeout(() => setGhSuccess(''), 2000);
    } else {
      const d = await res.json();
      setGhError(d.error);
    }
  };

  /** Revoke the stored GitHub token and disconnect the account. */
  const ghDisconnect = async () => {
    await del('/api/github/token');
    setGhHasToken(false);
    setGhShowTokenInput(false);
    setGhSuccess('GitHub disconnected');
    setTimeout(() => setGhSuccess(''), 2000);
  };

  // ── Profile (display name) handler ─────────────────────────────────
  const handleSaveProfile = async (e) => {
    e.preventDefault();
    setProfileError('');
    setProfileSuccess('');
    const trimmed = profileName.trim();
    if (!trimmed) { setProfileError('Name is required'); return; }
    if (trimmed === user.name) { setProfileSuccess('No changes to save'); return; }
    setProfileLoading(true);
    try {
      const res = await patch('/api/auth/me', { name: trimmed });
      const data = await res.json();
      if (!res.ok) {
        setProfileError(data.error || 'Failed to update profile');
      } else {
        setProfileSuccess('Name updated');
        onUpdate?.(data);
      }
    } catch {
      setProfileError('Failed to update profile');
    } finally {
      setProfileLoading(false);
    }
  };

  // ── Change email handler ───────────────────────────────────────────
  /** Submit a request to change the user's email address. */
  const handleChangeEmail = async (e) => {
    e.preventDefault();
    setEmailError('');
    setEmailSuccess('');
    setEmailLoading(true);
    try {
      const res = await post('/api/auth/change-email', { password: emailPassword, newEmail: emailNewVal });
      const data = await res.json();
      if (!res.ok) {
        setEmailError(data.error);
      } else {
        setEmailSuccess('Email changed successfully');
        onUpdate({ ...user, email: data.email });
        setEmailNewVal('');
        setEmailPassword('');
      }
    } catch (err) {
      setEmailError(err.message);
    }
    setEmailLoading(false);
  };

  // ── Change password handler ────────────────────────────────────────
  /** Submit a request to change the user's password. */
  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPwError('');
    setPwSuccess('');
    if (newPw !== confirmPw) {
      setPwError('New passwords do not match');
      return;
    }
    setPwLoading(true);
    try {
      const res = await post('/api/auth/change-password', { currentPassword: currentPw, newPassword: newPw });
      const data = await res.json();
      if (!res.ok) {
        setPwError(data.error);
      } else {
        setPwSuccess('Password changed successfully');
        setCurrentPw('');
        setNewPw('');
        setConfirmPw('');
      }
    } catch (err) {
      setPwError(err.message);
    }
    setPwLoading(false);
  };

  // ── Delete account handler ─────────────────────────────────────────
  /** Permanently delete the user's account after password and confirmation check. */
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
        <p className="settings-user-info">
          {user.name} &mdash; {user.email}
        </p>

        <div className="settings-tabs">
          <button className={`settings-tab ${tab === 'profile' ? 'active' : ''}`} onClick={() => setTab('profile')}>
            Profile
          </button>
          <button className={`settings-tab ${tab === 'mfa' ? 'active' : ''}`} onClick={() => setTab('mfa')}>
            2FA
          </button>
          <button className={`settings-tab ${tab === 'email' ? 'active' : ''}`} onClick={() => setTab('email')}>
            Email
          </button>
          <button className={`settings-tab ${tab === 'password' ? 'active' : ''}`} onClick={() => setTab('password')}>
            Password
          </button>
          <button className={`settings-tab ${tab === 'github' ? 'active' : ''}`} onClick={() => setTab('github')}>
            GitHub
          </button>
          <button className={`settings-tab ${tab === 'delete' ? 'active' : ''}`} onClick={() => setTab('delete')}>
            Delete Account
          </button>
        </div>

        {tab === 'profile' && (
          <div className="settings-section">
            <p className="mfa-description">
              The name collaborators see on your cursor, comments, and tracked changes.
            </p>
            <form onSubmit={handleSaveProfile} className="auth-form">
              <input
                type="text"
                placeholder="Display name"
                value={profileName}
                onChange={(e) => { setProfileName(e.target.value); setProfileError(''); setProfileSuccess(''); }}
                maxLength={200}
                autoComplete="name"
                required
                className="auth-input"
              />
              {profileError && <div className="auth-error">{profileError}</div>}
              {profileSuccess && <div className="mfa-success">{profileSuccess}</div>}
              <button
                type="submit"
                className="auth-button"
                disabled={profileLoading || !profileName.trim() || profileName.trim() === user.name}
              >
                {profileLoading ? 'Saving...' : 'Save'}
              </button>
            </form>
          </div>
        )}

        {tab === 'mfa' && (
          <div className="settings-section">
            {step === 'start' && (
              <>
                <p className="mfa-description">
                  Add an extra layer of security to your account by requiring a verification code from an authenticator
                  app when you sign in.
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
                  <summary>Can&apos;t scan? Enter this key manually</summary>
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
                <button className="auth-button" onClick={onClose}>
                  Done
                </button>
              </>
            )}

            {step === 'disable' && (
              <>
                <p className="mfa-description">
                  Two-factor authentication is currently <strong>enabled</strong>. Enter your password to disable it.
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

        {tab === 'email' && (
          <div className="settings-section">
            <p className="mfa-description">
              Current email: <strong>{user.email}</strong>
            </p>
            <form onSubmit={handleChangeEmail} className="auth-form">
              <input
                type="email"
                placeholder="New email address"
                value={emailNewVal}
                onChange={(e) => setEmailNewVal(e.target.value)}
                required
                className="auth-input"
                autoComplete="email"
              />
              <input
                type="password"
                placeholder="Your password"
                value={emailPassword}
                onChange={(e) => setEmailPassword(e.target.value)}
                required
                className="auth-input"
                autoComplete="current-password"
              />
              {emailError && <div className="auth-error">{emailError}</div>}
              {emailSuccess && <div className="mfa-success">{emailSuccess}</div>}
              <button type="submit" className="auth-button" disabled={emailLoading || !emailNewVal || !emailPassword}>
                {emailLoading ? 'Changing...' : 'Change Email'}
              </button>
            </form>
          </div>
        )}

        {tab === 'password' && (
          <div className="settings-section">
            <p className="mfa-description">Change your account password.</p>
            <form onSubmit={handleChangePassword} className="auth-form">
              <input
                type="password"
                placeholder="Current password"
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
                required
                className="auth-input"
                autoComplete="current-password"
              />
              <input
                type="password"
                placeholder="New password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                required
                className="auth-input"
                autoComplete="new-password"
              />
              <input
                type="password"
                placeholder="Confirm new password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                required
                className="auth-input"
                autoComplete="new-password"
              />
              {pwError && <div className="auth-error">{pwError}</div>}
              {pwSuccess && <div className="mfa-success">{pwSuccess}</div>}
              <button type="submit" className="auth-button" disabled={pwLoading || !currentPw || !newPw || !confirmPw}>
                {pwLoading ? 'Changing...' : 'Change Password'}
              </button>
            </form>
          </div>
        )}

        {tab === 'github' && (
          <div className="settings-section">
            {ghError && <div className="auth-error">{ghError}</div>}
            {ghSuccess && <div className="mfa-success">{ghSuccess}</div>}
            {ghLoading ? (
              <p className="mfa-description">Loading...</p>
            ) : ghHasToken ? (
              <>
                <p className="mfa-description">
                  Your GitHub account is <strong>connected</strong>
                  {ghUsername && (
                    <>
                      {' '}
                      as <strong>{ghUsername}</strong>
                    </>
                  )}
                  . You can link individual projects to GitHub repositories from within each project.
                </p>
                <button className="auth-button mfa-disable-btn" onClick={ghDisconnect}>
                  Disconnect GitHub
                </button>
              </>
            ) : (
              <>
                <p className="mfa-description">
                  Connect your GitHub account to push and pull projects to/from GitHub repositories.
                </p>
                {ghOauthAvailable ? (
                  <>
                    <button className="auth-button" onClick={ghConnectOAuth} disabled={ghConnecting}>
                      {ghConnecting ? 'Connecting...' : 'Connect to GitHub'}
                    </button>
                    <p className="mfa-description" style={{ marginTop: 12, fontSize: 12 }}>
                      Or{' '}
                      <button
                        className="github-sync-link-btn"
                        onClick={() => setGhShowTokenInput(true)}
                        style={{ fontSize: 12 }}
                      >
                        use a Personal Access Token
                      </button>{' '}
                      instead.
                    </p>
                  </>
                ) : (
                  <p className="mfa-description">
                    Create a token at GitHub &rarr; Settings &rarr; Developer settings &rarr; Personal access tokens
                    (needs <code>repo</code> scope).
                  </p>
                )}
                {(ghShowTokenInput || !ghOauthAvailable) && (
                  // Wrapping the password input in its own form with
                  // autoComplete="off" scopes the browser's autofill scan
                  // to this form only. Without it, the browser scans the
                  // whole page for a matching "username" field — and the
                  // closest unattributed <input type="text"> is the
                  // dashboard's project-search bar, into which the user's
                  // saved github.com username then gets autofilled. The
                  // <input name="username" hidden> is a decoy: it absorbs
                  // the autofill so it cannot escape this form.
                  <form
                    autoComplete="off"
                    onSubmit={(e) => { e.preventDefault(); ghSaveToken(); }}
                    style={{ display: 'flex', gap: 8, marginTop: 8 }}
                  >
                    <input type="text" autoComplete="username" name="username" hidden readOnly value="" />
                    <input
                      type="password"
                      className="auth-input"
                      placeholder="ghp_..."
                      autoComplete="new-password"
                      name="github-pat"
                      value={ghTokenInput}
                      onChange={(e) => setGhTokenInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') ghSaveToken();
                      }}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="submit"
                      className="auth-button"
                      disabled={!ghTokenInput.trim()}
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      Save
                    </button>
                  </form>
                )}
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
              <label className="settings-label">
                Type <strong>DELETE</strong> to confirm:
              </label>
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

        <button className="modal-close-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
