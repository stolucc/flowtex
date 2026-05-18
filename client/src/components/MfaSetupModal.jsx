import React, { useState, useEffect } from 'react';
import { get, post, put, patch, del } from '../api.js';
import {
  pingHealth,
  fetchHelperVersion,
  pairWithHelper,
  getHelperToken,
  clearHelperToken,
} from '../utils/helperBridge.js';

/** Boxed command snippet with a copy-to-clipboard button. Used in the
 *  "Helper not detected" walkthrough so users can run the install
 *  commands without manually retyping. */
function CommandBlock({ label, command, copyKey, copiedCommand, onCopy }) {
  const isCopied = copiedCommand === copyKey;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
        <pre style={{
          flex: 1,
          margin: 0,
          padding: '6px 10px',
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          fontSize: 12,
          fontFamily: 'monospace',
          color: 'var(--text-primary)',
          whiteSpace: 'pre-wrap',
          overflowX: 'auto',
        }}>{command}</pre>
        <button
          type="button"
          onClick={() => onCopy(command, copyKey)}
          style={{
            padding: '6px 10px',
            fontSize: 11,
            background: isCopied ? '#16a34a' : 'var(--bg-surface)',
            color: isCopied ? '#fff' : 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {isCopied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

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

  // ── Compile-location state (Phase 3, hidden unless server flag on) ──
  const [compileLocation, setCompileLocation] = useState(user.compileLocation || 'server');
  const [compileLocError, setCompileLocError] = useState('');
  const [compileLocSuccess, setCompileLocSuccess] = useState('');
  const [compileLocLoading, setCompileLocLoading] = useState(false);
  const localCompileFeatureOn = !!user.serverFeatures?.localCompile;

  // ── Helper pairing state ───────────────────────────────────────────
  // The helper status object reflects what useHelperStatus would compute,
  // but here we probe directly when the Compile tab is opened so the user
  // sees the latest state without leaving and coming back. Three top-level
  // shapes:
  //  - { available:false, error:'unreachable' }  → not installed / not running
  //  - { available:false, error:'unpaired' }     → helper is up, no token / wrong token
  //  - { available:true,  year:'2025', ... }     → fully paired and healthy
  const [helperStatus, setHelperStatus] = useState({ available: false, loading: false });
  const [pairCode, setPairCode] = useState('');
  const [pairError, setPairError] = useState('');
  const [pairLoading, setPairLoading] = useState(false);
  const [showPairInput, setShowPairInput] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(null);

  // Two probe entry points so the polling ticker doesnt flash
  // "Detecting…" over an already-green status. The user-initiated
  // version (button click, tab open) shows the loading state because
  // there was no prior info; the silent version just settles the new
  // status without UI churn.
  const probeHelperSilent = async () => {
    const alive = await pingHealth();
    if (!alive) {
      setHelperStatus({ available: false, loading: false, error: 'unreachable' });
      return;
    }
    const v = await fetchHelperVersion();
    if (!v) {
      setHelperStatus({ available: false, loading: false, error: 'unpaired' });
      return;
    }
    setHelperStatus({ available: true, loading: false, year: v.year, enginesAvailable: v.enginesAvailable, biber: v.biber });
  };
  const probeHelper = async () => {
    setHelperStatus((s) => ({ ...s, loading: true }));
    await probeHelperSilent();
  };

  // Probe on tab open AND keep polling while the tab is visible.
  // Adaptive cadence:
  //   - 3 s when not green: user is mid-install / mid-pair, fast feedback
  //     loop matters (start the helper in a terminal and the badge flips
  //     within a few seconds).
  //   - 60 s when green: helpers state is stable, just a periodic
  //     liveness check so a crashed/killed helper eventually shows up.
  // Re-runs whenever availability flips because the dep is read at
  // hook setup time.
  useEffect(() => {
    if (tab !== 'compile' || !localCompileFeatureOn) return undefined;
    probeHelper();
    const interval = helperStatus.available ? 60_000 : 3_000;
    const id = setInterval(probeHelperSilent, interval);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, localCompileFeatureOn, helperStatus.available]);

  const copyToClipboard = (text, key) => {
    try {
      navigator.clipboard.writeText(text);
      setCopiedCommand(key);
      setTimeout(() => setCopiedCommand((c) => (c === key ? null : c)), 1500);
    } catch {
      // No clipboard permission — fall back silently. The text is
      // already in the visible block so the user can select-and-copy.
    }
  };

  const handlePairSubmit = async (e) => {
    e.preventDefault();
    setPairError('');
    if (!/^\d{6}$/.test(pairCode)) {
      setPairError('Pairing code must be 6 digits');
      return;
    }
    setPairLoading(true);
    try {
      const result = await pairWithHelper(pairCode);
      if (!result.ok) {
        setPairError(result.error || 'Pairing failed');
      } else {
        setShowPairInput(false);
        setPairCode('');
        await probeHelper();
      }
    } catch (err) {
      setPairError(err?.message || 'Pairing failed');
    } finally {
      setPairLoading(false);
    }
  };

  const handleUnpair = () => {
    clearHelperToken();
    probeHelper();
  };

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

  // ── Compile location handler ───────────────────────────────────────
  const handleSaveCompileLocation = async (e) => {
    e.preventDefault();
    setCompileLocError('');
    setCompileLocSuccess('');
    if (compileLocation === (user.compileLocation || 'server')) {
      setCompileLocSuccess('No changes to save');
      return;
    }
    setCompileLocLoading(true);
    try {
      const res = await patch('/api/auth/me', { compile_location: compileLocation });
      const data = await res.json();
      if (!res.ok) {
        setCompileLocError(data.error || 'Failed to update compile location');
      } else {
        setCompileLocSuccess('Compile location updated');
        onUpdate?.(data);
      }
    } catch {
      setCompileLocError('Failed to update compile location');
    } finally {
      setCompileLocLoading(false);
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
          {localCompileFeatureOn && (
            <button className={`settings-tab ${tab === 'compile' ? 'active' : ''}`} onClick={() => setTab('compile')}>
              Compile
            </button>
          )}
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

        {tab === 'compile' && localCompileFeatureOn && (
          <div className="settings-section">
            {/* ── Helper status + pairing ─────────────────────────── */}
            <div style={{ padding: '10px 14px', marginBottom: 16, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>flowtex-helper status</div>
              {helperStatus.loading && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Detecting…</div>}
              {!helperStatus.loading && helperStatus.available && (
                <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                  <span style={{ color: '#16a34a' }}>●</span>{' '}
                  Paired. TeX Live {helperStatus.year || '?'}
                  {helperStatus.enginesAvailable?.length > 0 && (
                    <span style={{ color: 'var(--text-muted)' }}> ({helperStatus.enginesAvailable.join(', ')})</span>
                  )}
                  <button
                    type="button"
                    onClick={handleUnpair}
                    style={{ marginLeft: 12, padding: '2px 10px', fontSize: 12, background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}
                  >
                    Unpair
                  </button>
                </div>
              )}
              {!helperStatus.loading && !helperStatus.available && helperStatus.error === 'unpaired' && (
                <div style={{ fontSize: 13 }}>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ color: '#f59e0b' }}>●</span>{' '}
                    Helper is running but not paired with this browser.
                  </div>
                  {!showPairInput && (
                    <>
                      <CommandBlock
                        label="In a second terminal, generate a pairing code:"
                        command="./flowtex-helper pair"
                        copyKey="pair"
                        copiedCommand={copiedCommand}
                        onCopy={copyToClipboard}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPairInput(true)}
                        style={{ marginTop: 4, padding: '6px 14px', fontSize: 13, background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                      >
                        Got a code — pair now
                      </button>
                    </>
                  )}
                </div>
              )}
              {!helperStatus.loading && !helperStatus.available && helperStatus.error === 'unreachable' && (
                <div style={{ fontSize: 13 }}>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ color: '#ef4444' }}>●</span>{' '}
                    Helper not detected. Open a terminal and run these commands once:
                  </div>
                  <CommandBlock
                    label="1. Build the helper (one-time, requires Go)"
                    command={'brew install go\ncd /Users/alan/flowtex/helper\nmake build'}
                    copyKey="build"
                    copiedCommand={copiedCommand}
                    onCopy={copyToClipboard}
                  />
                  <CommandBlock
                    label="2. Run it (leave this terminal open)"
                    command="./flowtex-helper"
                    copyKey="run"
                    copiedCommand={copiedCommand}
                    onCopy={copyToClipboard}
                  />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                    This panel polls every 3 seconds. As soon as the helper is running, the status flips to yellow and a "Pair helper" button appears — no need to click Retry.
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      onClick={() => setShowDiagnostics((s) => !s)}
                      style={{ padding: '2px 8px', fontSize: 11, background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--text-muted)' }}
                    >
                      {showDiagnostics ? 'Hide' : 'Show'} diagnostics
                    </button>
                  </div>
                  {showDiagnostics && (
                    <div style={{ marginTop: 6, padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>
{`Probing: http://localhost:9876/health and https://localhost:9876/health
Bearer token in localStorage: ${localStorage.getItem('flowtex.helper.token') ? 'yes' : 'no'}
Cached scheme: ${localStorage.getItem('flowtex.helper.scheme') || '(none — http tried first)'}
Result: unreachable

Common causes:
- helper binary is not running (run ./flowtex-helper)
- terminal is blocked by firewall (loopback only, should not happen)
- another process owns port 9876 (lsof -iTCP:9876)
- still on the old TLS-only helper binary (rebuild with make build)`}
                    </div>
                  )}
                </div>
              )}
              {showPairInput && (
                <form onSubmit={handlePairSubmit} style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoFocus
                    placeholder="6-digit code"
                    value={pairCode}
                    onChange={(e) => { setPairCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setPairError(''); }}
                    maxLength={6}
                    style={{ padding: '4px 8px', fontSize: 13, width: 110, fontFamily: 'monospace', letterSpacing: 2, border: '1px solid var(--border)', borderRadius: 4 }}
                  />
                  <button
                    type="submit"
                    disabled={pairLoading || pairCode.length !== 6}
                    style={{ padding: '4px 12px', fontSize: 13, background: 'var(--accent)', color: 'var(--bg-primary)', border: 'none', borderRadius: 4, cursor: pairCode.length === 6 ? 'pointer' : 'not-allowed', opacity: pairCode.length === 6 ? 1 : 0.6 }}
                  >
                    {pairLoading ? 'Pairing…' : 'Pair'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowPairInput(false); setPairCode(''); setPairError(''); }}
                    style={{ padding: '4px 12px', fontSize: 13, background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </form>
              )}
              {pairError && <div className="auth-error" style={{ marginTop: 6 }}>{pairError}</div>}
            </div>

            <p className="mfa-description">
              Default compile location for projects you open. Each project can override this in its own settings.
            </p>
            <form onSubmit={handleSaveCompileLocation} className="auth-form">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="radio"
                  name="userCompileLocation"
                  checked={compileLocation === 'server'}
                  onChange={() => {
                    setCompileLocation('server');
                    setCompileLocError('');
                    setCompileLocSuccess('');
                  }}
                />
                <span>FlowTex server (default — works for everyone)</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 6 }}>
                <input
                  type="radio"
                  name="userCompileLocation"
                  checked={compileLocation === 'local'}
                  onChange={() => {
                    setCompileLocation('local');
                    setCompileLocError('');
                    setCompileLocSuccess('');
                  }}
                />
                <span>My local TeX Live (requires the flowtex-helper binary)</span>
              </label>
              <p className="settings-hint" style={{ marginTop: 6 }}>
                When &quot;Local&quot; is selected but the helper is missing or its TeX Live year does not match the project, compile silently falls back to the server.
              </p>
              {compileLocError && <div className="auth-error">{compileLocError}</div>}
              {compileLocSuccess && <div className="mfa-success">{compileLocSuccess}</div>}
              <button
                type="submit"
                className="auth-button"
                disabled={compileLocLoading || compileLocation === (user.compileLocation || 'server')}
              >
                {compileLocLoading ? 'Saving...' : 'Save'}
              </button>
            </form>
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
