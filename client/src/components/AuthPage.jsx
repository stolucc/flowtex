// @ts-check
import React, { useState, useEffect } from 'react';
import { post, get } from '../api.js';

/**
 * Authentication page handling login, registration, email verification, password reset, and 2FA.
 * @param {any} props
 */
export default function AuthPage({ onAuth }) {
  const urlParams = new URLSearchParams(window.location.search);
  const resetToken = urlParams.get('token');
  const verifyToken = urlParams.get('verify');
  // Two invitation flows can land here unauthenticated:
  //   ?invite=<uuid>           → unregistered invitee clicked the
  //                              "Create account & accept" CTA. Look
  //                              up the invitation, prefill the
  //                              register form, show a banner.
  //   ?invite-decline=<token>  → unregistered invitee clicked the
  //                              "Decline" link. POST the token,
  //                              show confirmation, no account
  //                              creation needed.
  const inviteId = urlParams.get('invite');
  const declineToken = urlParams.get('invite-decline');
  // The server-side ACS redirects an existing password user to
  // /login/confirm-saml-link after they've authenticated at the IdP.
  // We detect that path here and render the interstitial.
  const isSamlConfirmPath = typeof window !== 'undefined'
    && window.location.pathname === '/login/confirm-saml-link';
  const initialMode = resetToken
    ? 'reset'
    : verifyToken
      ? 'verifying'
      : declineToken
        ? 'invite-decline'
        : isSamlConfirmPath
          ? 'saml-confirm-link'
          : inviteId
            ? 'register'
            : 'login';
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [trustDevice, setTrustDevice] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [unverifiedEmail, setUnverifiedEmail] = useState('');
  const [resending, setResending] = useState(false);
  // Context for the unregistered-invitee flow (loaded async on mount
  // when ?invite=<id> is present). null = not loaded yet; an object
  // with { projectName, inviterName, hasAccount } once fetched.
  const [inviteInfo, setInviteInfo] = useState(/** @type {any} */ (null));
  // Outcome of POSTing ?invite-decline=<token>: null = in-flight,
  // 'ok' = declined successfully, an error string on failure.
  const [declineResult, setDeclineResult] = useState(/** @type {any} */ (null));
  // SAML: list of enabled IdPs for the "Continue with <IdP>" buttons.
  // Empty array when no IdPs configured (no SSO section is rendered).
  // Loaded once on mount; the login page is a cold-render scenario,
  // there's no need to react to subsequent config changes.
  const [samlIdPs, setSamlIdPs] = useState(/** @type {any[]} */ ([]));
  // SAML confirm-link state. When the URL is /login/confirm-saml-link,
  // we fetch /api/auth/saml/pending-link and stash the result here.
  // null = not loaded yet; an object once fetched; 'expired' on 404.
  const [samlPendingLink, setSamlPendingLink] = useState(/** @type {any} */ (null));
  // Set to true while POSTing to /confirm-link or /cancel-link so the
  // buttons disable and don't double-submit.
  const [samlConfirmBusy, setSamlConfirmBusy] = useState(false);

  // Handle email verification token from URL
  useEffect(() => {
    if (!verifyToken) return;
    (async () => {
      try {
        const res = await get(`/api/auth/verify-email?token=${verifyToken}`);
        const data = await res.json();
        if (res.ok) {
          setSuccess('Email verified successfully! You can now sign in.');
          setMode('login');
        } else {
          setError(data.error || 'Verification failed');
          setMode('login');
        }
      } catch {
        setError('Verification failed. Please try again.');
        setMode('login');
      }
      window.history.replaceState({}, '', '/');
    })();
  }, [verifyToken]);

  // Load the public invitation context when ?invite=<id> is on the URL.
  // Prefills the email and lets the register banner show "<Inviter>
  // invited you to <Project>".
  useEffect(() => {
    if (!inviteId) return;
    (async () => {
      try {
        const res = await get(`/api/invitations/public/${encodeURIComponent(inviteId)}`);
        if (!res.ok) {
          setInviteInfo({ error: 'This invitation link is no longer valid.' });
          return;
        }
        const info = await res.json();
        setInviteInfo(info);
        // Prefill the email field so the recipient registers under
        // the address the invitation was sent to. They CAN edit it
        // (they might prefer a different address), but then the
        // invitation won't auto-attach to their new account.
        if (info.email && !email) setEmail(info.email);
        // If they ALREADY have an account, the right next step is
        // login, not register — flip the mode.
        if (info.hasAccount) setMode('login');
      } catch {
        setInviteInfo({ error: 'Failed to load invitation details.' });
      }
    })();
    // Intentionally not cleaning up the URL — we want the inviter
    // context to survive a tab refresh during the register flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteId]);

  // Handle the one-shot decline link from the unregistered-invitee
  // email (?invite-decline=<token>). POST the token, show outcome.
  useEffect(() => {
    if (!declineToken) return;
    (async () => {
      try {
        const res = await post('/api/invitations/by-token/decline', { token: declineToken });
        if (res.ok) setDeclineResult('ok');
        else {
          const data = await res.json().catch(() => ({}));
          setDeclineResult(data.error || 'Failed to decline the invitation.');
        }
      } catch {
        setDeclineResult('Failed to decline the invitation.');
      }
      // Strip the token from the URL so a refresh or share doesn't
      // resurface it. The server marked the token null on success
      // anyway, but defence in depth.
      window.history.replaceState({}, '', '/');
    })();
  }, [declineToken]);

  // SAML: fetch the public IdP list so the login page can render
  // "Continue with <IdP>" buttons (Pattern B). Skipped on the
  // saml-confirm-link path (we never want to show login options on
  // the confirmation interstitial).
  useEffect(() => {
    if (mode === 'saml-confirm-link') return;
    (async () => {
      try {
        const res = await get('/api/auth/saml/list-public');
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data.idps)) setSamlIdPs(data.idps);
      } catch {
        // No IdPs configured / endpoint absent / network failure -> no
        // SSO section. Don't surface this to the user; SSO not being
        // available is the normal case for a fresh install.
      }
    })();
  }, []);

  // SAML: on the confirm-link interstitial, fetch the pending link
  // state. 404 -> expired (or never existed). Anything else means
  // the user has something to confirm.
  useEffect(() => {
    if (mode !== 'saml-confirm-link') return;
    (async () => {
      try {
        const res = await get('/api/auth/saml/pending-link');
        if (res.status === 404) {
          setSamlPendingLink('expired');
          return;
        }
        if (!res.ok) {
          setSamlPendingLink('expired');
          return;
        }
        const data = await res.json();
        setSamlPendingLink(data);
      } catch {
        setSamlPendingLink('expired');
      }
    })();
  }, [mode]);

  const handleSamlConfirm = async () => {
    if (samlConfirmBusy) return;
    setSamlConfirmBusy(true);
    setError('');
    try {
      const res = await post('/api/auth/saml/confirm-link', {});
      const data = await res.json();
      if (res.ok && data.ok) {
        // The server already established the session via the cookie.
        // A full reload lets App.jsx pick up the session and bypass
        // AuthPage entirely. Using the server-supplied redirect (the
        // RelayState the SAML flow round-tripped) preserves
        // "deep-link returns you to the page you wanted."
        window.location.assign(data.redirect || '/');
        return;
      }
      setError(data.error || 'Account link failed.');
    } catch {
      setError('Account link failed. Please try again.');
    } finally {
      setSamlConfirmBusy(false);
    }
  };

  const handleSamlCancel = async () => {
    if (samlConfirmBusy) return;
    setSamlConfirmBusy(true);
    try {
      await post('/api/auth/saml/cancel-link', {});
    } catch {
      // Even on error, leaving the page is the right UX.
    }
    // Take them back to /login. The page already wipes the pending
    // state server-side; a clean reload presents the normal form.
    window.location.assign('/login');
  };

  const handleSubmit = async (/** @type {any} */ e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setUnverifiedEmail('');
    setLoading(true);
    try {
      if (mode === 'register') {
        const res = await post('/api/auth/register', { email, name, password });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Something went wrong');
        } else if (data.needsVerification) {
          setMode('check-email');
          setUnverifiedEmail(data.email);
        } else {
          onAuth(data);
        }
      } else {
        // Login
        const body = { email, password, ...(mfaRequired ? { totpCode, trustDevice } : {}) };
        const res = await post('/api/auth/login', body);
        const data = await res.json();
        if (!res.ok) {
          if (data.unverified) {
            setUnverifiedEmail(email);
          }
          setError(data.error || 'Something went wrong');
        } else if (data.mfaRequired) {
          setMfaRequired(true);
        } else {
          onAuth(data);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  };

  const handleResendVerification = async () => {
    if (!unverifiedEmail || resending) return;
    setResending(true);
    setError('');
    setSuccess('');
    try {
      await post('/api/auth/resend-verification', { email: unverifiedEmail });
      setSuccess('Verification email sent! Please check your inbox.');
    } catch {
      setError('Failed to resend verification email.');
    }
    setResending(false);
  };

  const handleForgotPassword = async (/** @type {any} */ e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      const res = await post('/api/auth/forgot-password', { email });
      if (res.ok) {
        setSuccess('If an account with that email exists, a password reset link has been sent.');
      } else {
        const data = await res.json();
        setError(data.error || 'Something went wrong');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  };

  const handleResetPassword = async (/** @type {any} */ e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      const res = await post('/api/auth/reset-password', { token: resetToken, password });
      const data = await res.json();
      if (res.ok) {
        setSuccess('Password reset successfully. You can now sign in.');
        // Clean up URL
        window.history.replaceState({}, '', '/');
        setTimeout(() => {
          setMode('login');
          setSuccess('');
          setPassword('');
          setConfirmPassword('');
        }, 2000);
      } else {
        setError(data.error || 'Something went wrong');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  };

  const handleBack = () => {
    setMfaRequired(false);
    setTotpCode('');
    setError('');
    setSuccess('');
  };

  const goToLogin = () => {
    setMode('login');
    setError('');
    setSuccess('');
    setPassword('');
    setConfirmPassword('');
    setUnverifiedEmail('');
    window.history.replaceState({}, '', '/');
  };

  // Marketing pane is only shown alongside the main login/register form —
  // not during transient flows (verify, reset, MFA prompt, invite-decline)
  // where the user is already mid-task and a sidebar would be a distraction.
  const showMarketing = (mode === 'login' || mode === 'register') && !mfaRequired;

  return (
    <div className={`auth-page${showMarketing ? ' has-marketing' : ''}`}>
      {showMarketing && <AuthMarketingPane />}
      <div className="auth-card">
        <h1 className="auth-title">FlowTex</h1>

        {mode === 'invite-decline' ? (
          <>
            <p className="auth-subtitle">Invitation declined</p>
            <div style={{ textAlign: 'center', padding: '8px 0 16px', fontSize: 14, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
              {declineResult === null && <p>Processing…</p>}
              {declineResult === 'ok' && (
                <>
                  <p style={{ marginBottom: 8 }}>
                    Thanks &mdash; the inviter has been notified that you declined.
                  </p>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    No account has been created. You can close this tab.
                  </p>
                </>
              )}
              {declineResult && declineResult !== 'ok' && (
                <p className="auth-error">{declineResult}</p>
              )}
            </div>
          </>
        ) : mode === 'verifying' ? (
          <p className="auth-subtitle">Verifying your email...</p>
        ) : mode === 'saml-confirm-link' ? (
          <>
            <p className="auth-subtitle">Link your account?</p>
            {samlPendingLink === null && (
              <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                Loading…
              </p>
            )}
            {samlPendingLink === 'expired' && (
              <>
                <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                  This confirmation link has expired or was already used.
                </p>
                <button
                  className="auth-button"
                  onClick={() => window.location.assign('/login')}
                  style={{ marginTop: 16 }}
                >
                  Back to sign-in
                </button>
              </>
            )}
            {samlPendingLink && typeof samlPendingLink === 'object' && (
              <>
                <div style={{
                  padding: '12px 14px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  margin: '8px 0 16px',
                  fontSize: 14,
                  lineHeight: 1.5,
                }}>
                  <p style={{ margin: 0 }}>
                    You signed in to{' '}
                    <strong>{samlPendingLink.idpDisplayName}</strong>{' '}
                    with the email <strong>{samlPendingLink.email}</strong>.
                  </p>
                  <p style={{ margin: '8px 0 0' }}>
                    An existing FlowTex account uses that email
                    {samlPendingLink.existingName ? (
                      <> (<strong>{samlPendingLink.existingName}</strong>)</>
                    ) : null}.
                  </p>
                  <p style={{ margin: '12px 0 0', color: 'var(--text-secondary)' }}>
                    If you link these accounts, your future sign-ins will go
                    through {samlPendingLink.idpDisplayName} only — your
                    FlowTex password will be removed.
                  </p>
                </div>
                {error && (
                  <p style={{
                    color: 'var(--err)',
                    fontSize: 13,
                    margin: '0 0 12px',
                    textAlign: 'center',
                  }}>{error}</p>
                )}
                <button
                  type="button"
                  className="auth-button"
                  onClick={handleSamlConfirm}
                  disabled={samlConfirmBusy}
                >
                  {samlConfirmBusy ? '...' : `Yes, link with ${samlPendingLink.idpDisplayName}`}
                </button>
                <button
                  type="button"
                  className="auth-button"
                  onClick={handleSamlCancel}
                  disabled={samlConfirmBusy}
                  style={{
                    marginTop: 8,
                    background: 'transparent',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  Cancel
                </button>
              </>
            )}
          </>
        ) : mode === 'check-email' ? (
          <>
            <p className="auth-subtitle">Check your email</p>
            <div
              style={{
                textAlign: 'center',
                padding: '8px 0 16px',
                fontSize: 14,
                lineHeight: 1.6,
                color: 'var(--text-secondary)',
              }}
            >
              <p>We&apos;ve sent a verification link to</p>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{unverifiedEmail}</p>
              <p style={{ marginTop: 12 }}>Click the link in the email to activate your account.</p>
              <p style={{ marginTop: 12, fontSize: 13, color: 'var(--text-muted)' }}>
                The message can take a few minutes to arrive — depending on your
                mail provider it might also land in <strong>spam</strong> or{' '}
                <strong>junk</strong>. The link is valid for{' '}
                <strong>1 hour</strong>; if you need a fresh one, use{' '}
                <em>Resend verification email</em> below.
              </p>
            </div>
            {success && <div className="auth-success">{success}</div>}
            {error && <div className="auth-error">{error}</div>}
            <button
              className="auth-button"
              style={{ background: 'var(--bg-hover)', marginBottom: 8 }}
              onClick={handleResendVerification}
              disabled={resending}
            >
              {resending ? '...' : 'Resend verification email'}
            </button>
            <p className="auth-switch">
              <button onClick={goToLogin}>Back to sign in</button>
            </p>
          </>
        ) : mode === 'reset' ? (
          <>
            <p className="auth-subtitle">Set a new password</p>
            <form onSubmit={handleResetPassword} className="auth-form">
              <input
                type="password"
                placeholder="New password"
                value={password}
                onChange={(/** @type {any} */ e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="auth-input"
                autoFocus
              />
              <input
                type="password"
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(/** @type {any} */ e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                className="auth-input"
              />
              {error && <div className="auth-error">{error}</div>}
              {success && <div className="auth-success">{success}</div>}
              <button type="submit" className="auth-button" disabled={loading}>
                {loading ? '...' : 'Reset Password'}
              </button>
            </form>
            <p className="auth-switch">
              <button onClick={goToLogin}>Back to sign in</button>
            </p>
          </>
        ) : mode === 'forgot' ? (
          <>
            <p className="auth-subtitle">Enter your email to receive a reset link</p>
            <form onSubmit={handleForgotPassword} className="auth-form">
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(/** @type {any} */ e) => setEmail(e.target.value)}
                required
                className="auth-input"
                autoFocus
              />
              {error && <div className="auth-error">{error}</div>}
              {success && <div className="auth-success">{success}</div>}
              <button type="submit" className="auth-button" disabled={loading}>
                {loading ? '...' : 'Send Reset Link'}
              </button>
            </form>
            <p className="auth-switch">
              <button onClick={goToLogin}>Back to sign in</button>
            </p>
          </>
        ) : mfaRequired ? (
          <>
            <p className="auth-subtitle">Enter the 6-digit code from your authenticator app</p>
            <form onSubmit={handleSubmit} className="auth-form">
              <input
                type="text"
                placeholder="000000"
                value={totpCode}
                onChange={(/** @type {any} */ e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required
                autoFocus
                className="auth-input auth-input-totp"
                inputMode="numeric"
                autoComplete="one-time-code"
              />
              <label className="auth-trust-label">
                <input type="checkbox" checked={trustDevice} onChange={(/** @type {any} */ e) => setTrustDevice(e.target.checked)} />
                Trust this device for 30 days
              </label>
              {error && <div className="auth-error">{error}</div>}
              <button type="submit" className="auth-button" disabled={loading || totpCode.length !== 6}>
                {loading ? '...' : 'Verify'}
              </button>
            </form>
            <p className="auth-switch">
              <button onClick={handleBack}>Back to login</button>
            </p>
          </>
        ) : (
          <>
            <p className="auth-subtitle">{mode === 'login' ? 'Sign in to your account' : 'Create a new account'}</p>
            {mode === 'register' && inviteInfo && !inviteInfo.error && (
              <div className="auth-invite-banner">
                {/* Cap attacker-controllable display strings (L2 from the audit) —
                    inviterName + projectName are both owner-chosen and rendered
                    inline next to the words "invited you to". Keeping the
                    visible portion short means a malicious project name can't
                    fully bury the "...on FlowTex" framing. Server applies the
                    same cap in the email subject; this is the in-app mirror. */}
                <strong>{String(inviteInfo.inviterName || '').slice(0, 60)}</strong> invited you to collaborate on
                {' '}<strong>{String(inviteInfo.projectName || '').slice(0, 80)}</strong>.
                {' '}Register with this email to accept &mdash; the invitation will
                appear on your dashboard right after you verify your email.
              </div>
            )}
            {mode === 'register' && inviteInfo?.error && (
              <div className="auth-error" style={{ marginBottom: 12 }}>{inviteInfo.error}</div>
            )}
            <form onSubmit={handleSubmit} className="auth-form">
              {mode === 'register' && (
                <input
                  type="text"
                  placeholder="Name"
                  value={name}
                  onChange={(/** @type {any} */ e) => setName(e.target.value)}
                  required
                  className="auth-input"
                />
              )}
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(/** @type {any} */ e) => setEmail(e.target.value)}
                required
                className="auth-input"
              />
              {mode === 'register' && (
                <p className="auth-tip">
                  <strong>Tip:</strong> most mail providers ignore everything after a{' '}
                  <code>+</code> in the local-part of an address, so you can append
                  {' '}<code>+flowtex</code> to make a unique alias that still lands
                  in your inbox — e.g. <code>k.stol+flowtex@ucc.ie</code>. Handy for
                  filtering, and if a data breach later leaks FlowTex addresses
                  you&apos;ll know exactly where it came from.
                </p>
              )}
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(/** @type {any} */ e) => setPassword(e.target.value)}
                required
                minLength={6}
                className="auth-input"
              />
              {error && <div className="auth-error">{error}</div>}
              {success && <div className="auth-success">{success}</div>}
              {unverifiedEmail && (
                <button
                  type="button"
                  className="auth-resend-btn"
                  onClick={handleResendVerification}
                  disabled={resending}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent)',
                    cursor: 'pointer',
                    fontSize: 13,
                    marginBottom: 8,
                    textDecoration: 'underline',
                  }}
                >
                  {resending ? 'Sending...' : 'Resend verification email'}
                </button>
              )}
              <button type="submit" className="auth-button" disabled={loading}>
                {loading ? '...' : mode === 'login' ? 'Sign In' : 'Register'}
              </button>
            </form>
            {/* Pattern B: when SSO is configured, show the IdP buttons
                below the password form so users can pick. Hidden when
                no IdPs are configured (no operator has set up SAML)
                and during the register / mfa flows where they're not
                meaningful. */}
            {mode === 'login' && !mfaRequired && samlIdPs.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  margin: '8px 0 12px',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                }}>
                  <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                  or
                  <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                </div>
                {samlIdPs.map((/** @type {any} */ idp) => (
                  <a
                    key={idp.id}
                    href={idp.loginUrl}
                    className="auth-button"
                    style={{
                      display: 'block',
                      textAlign: 'center',
                      textDecoration: 'none',
                      marginBottom: 8,
                      background: 'transparent',
                      color: 'var(--text)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    Continue with {idp.displayName}
                  </a>
                ))}
              </div>
            )}
            {mode === 'login' && (
              <p className="auth-switch">
                <button
                  onClick={() => {
                    setMode('forgot');
                    setError('');
                    setSuccess('');
                  }}
                >
                  Forgot password?
                </button>
              </p>
            )}
            <p className="auth-switch">
              {mode === 'login' ? (
                <>
                  Don&apos;t have an account?{' '}
                  <button
                    onClick={() => {
                      setMode('register');
                      setError('');
                      setUnverifiedEmail('');
                    }}
                  >
                    Register
                  </button>
                </>
              ) : (
                <>
                  Already have an account? <button onClick={goToLogin}>Sign In</button>
                </>
              )}
            </p>
            {/* User guide link: new users land on /login or /register
                with no in-app navigation yet, so this is the only place
                they can discover the manual before signing in. Opens
                in a new tab so the auth form keeps the user's input. */}
            <p className="auth-switch auth-guide-link">
              New to FlowTex?{' '}
              <a href="/docs/user-guide.html" target="_blank" rel="noopener">
                Read the user guide
              </a>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** Marketing pane shown next to the login/register form on the landing page.
 *  The hero image is served from /marketing/editor-screenshot.png; if the
 *  file isn't present the <img> hides itself via onError so the page still
 *  renders cleanly (the feature list carries the page on its own). */
function AuthMarketingPane() {
  return (
    <aside className="auth-marketing" aria-label="About FlowTex">
      <h2 className="auth-marketing-headline">Write LaTeX with the people you write with.</h2>
      <p className="auth-marketing-lede">
        A collaborative LaTeX editor with a live PDF preview, real-time
        editing, inline comments, and a writing history that&rsquo;s actually
        useful.
      </p>
      <figure className="auth-marketing-hero">
        <img
          src="/marketing/editor-screenshot.png"
          alt="FlowTex editor with source on the left and PDF preview on the right"
          loading="lazy"
          onError={(e) => {
            // No screenshot deployed yet — hide the figure entirely so the
            // feature list flows up. Avoids the broken-image icon.
            const fig = e.currentTarget.closest('figure');
            if (fig) fig.style.display = 'none';
          }}
        />
      </figure>
      <ul className="auth-marketing-features">
        <li>
          <strong>Edit together in real time</strong>
          <span>Live cursors, shared changes, no merge headaches.</span>
        </li>
        <li>
          <strong>Inline comments and project chat</strong>
          <span>Discuss specific lines, @-mention collaborators, get email digests.</span>
        </li>
        <li>
          <strong>Live PDF preview with SyncTeX</strong>
          <span>Recompile on save; click the PDF to jump straight to the source.</span>
        </li>
        <li>
          <strong>Track changes and version history</strong>
          <span>Word-style review, every save snapshotted, restore any earlier version.</span>
        </li>
      </ul>
    </aside>
  );
}
