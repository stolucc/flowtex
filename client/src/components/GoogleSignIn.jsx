// @ts-check
import React, { useState, useEffect } from 'react';
import { post, get } from '../api.js';

// Google sign-in UI: the "Continue with Google" button, the two
// interstitials the server redirects to after Google (link an existing
// account / enter the FlowTex 2FA code), and the Settings section.
// Server side: server/routes/googleAuth.js.

/** User-facing text for the ?google_error=<code> the server redirects with.
 *  @param {string | null} code */
export function googleErrorMessage(code) {
  switch (code) {
    case null:
    case '':
      return '';
    case 'cancelled':
      return 'Google sign-in was cancelled.';
    case 'expired':
      return 'That Google sign-in took too long or was already used. Please try again.';
    case 'unverified_email':
      return 'Your Google account email is not verified, so it cannot be used to sign in.';
    case 'deleted':
      return 'This account has been deleted. Contact an administrator to restore it.';
    case 'sso_required':
      return 'This account signs in through your organisation. Use your organisation’s sign-in button instead.';
    case 'other_google_linked':
      return 'A different Google account is linked to this FlowTex account. Sign in with that one, or with your password.';
    case 'already_linked':
      return 'That Google account is already linked to another FlowTex account.';
    case 'session_changed':
      return 'You were signed out while linking. Sign in and try again.';
    case 'unavailable':
      return 'Google sign-in is temporarily unavailable.';
    default:
      return 'Google sign-in failed. Please try again.';
  }
}

/** Is Google sign-in configured on this server? null while loading. */
export function useGoogleAvailable() {
  const [available, setAvailable] = useState(/** @type {boolean | null} */ (null));
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await get('/api/auth/google/available');
        const data = res.ok ? await res.json() : { available: false };
        if (!cancelled) setAvailable(!!data.available);
      } catch {
        if (!cancelled) setAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** Where to come back to after Google: the deep link the visitor hit,
 *  unless they are already on a /login page. */
function currentReturnTo() {
  const { pathname, search } = window.location;
  if (pathname.startsWith('/login') || pathname.startsWith('/api/')) return '/';
  // Strip one-shot params the auth page itself consumes.
  const params = new URLSearchParams(search);
  params.delete('google_error');
  const qs = params.toString();
  return pathname + (qs ? `?${qs}` : '');
}

/** @param {{ label?: string }} props */
export function GoogleSignInButton({ label = 'Continue with Google' }) {
  const href = `/api/auth/google/login?returnTo=${encodeURIComponent(currentReturnTo())}`;
  return (
    <a href={href} className="auth-button auth-google-button">
      <GoogleLogo />
      <span>{label}</span>
    </a>
  );
}

const secondaryButtonStyle = {
  marginTop: 8,
  background: 'transparent',
  color: 'var(--text-secondary)',
  border: '1px solid var(--border)',
};

async function cancelAndGoToLogin() {
  try {
    await post('/api/auth/google/cancel', {});
  } catch {
    // Leaving the page is right regardless.
  }
  window.location.assign('/login');
}

/** Shown at /login/link-google: a FlowTex account already uses the
 *  Google email. Ask for its password (+2FA) before linking. */
export function GoogleLinkInterstitial() {
  const [pending, setPending] = useState(/** @type {any} */ (null));
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [trustDevice, setTrustDevice] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await get('/api/auth/google/pending');
        const data = res.ok ? await res.json() : null;
        setPending(data && data.kind === 'link' ? data : 'expired');
      } catch {
        setPending('expired');
      }
    })();
  }, []);

  const submit = async (/** @type {any} */ e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const body = { password, ...(needTotp ? { totpCode, trustDevice } : {}) };
      const res = await post('/api/auth/google/confirm-link', body);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.mfaRequired) {
        setNeedTotp(true);
      } else if (res.ok && data.ok) {
        window.location.assign(data.redirect || '/');
        return;
      } else {
        setError(data.error || 'Account link failed.');
      }
    } catch {
      setError('Account link failed. Please try again.');
    }
    setBusy(false);
  };

  if (pending === null) {
    return <p className="auth-subtitle">Loading…</p>;
  }
  if (pending === 'expired') {
    return (
      <>
        <p className="auth-subtitle">Link your Google account</p>
        <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
          This request expired or was already used.
        </p>
        <button className="auth-button" onClick={() => window.location.assign('/login')} style={{ marginTop: 16 }}>
          Back to sign-in
        </button>
      </>
    );
  }
  return (
    <>
      <p className="auth-subtitle">Link your Google account</p>
      <div className="auth-google-note">
        <p style={{ margin: 0 }}>
          A FlowTex account already uses <strong>{pending.email}</strong>
          {pending.existingName ? <> (<strong>{String(pending.existingName).slice(0, 80)}</strong>)</> : null}.
        </p>
        <p style={{ margin: '8px 0 0', color: 'var(--text-secondary)' }}>
          Enter its FlowTex password to link Google to it. After that you can sign in with either.
        </p>
      </div>
      <form onSubmit={submit} className="auth-form">
        {!needTotp ? (
          <input
            type="password"
            placeholder="FlowTex password"
            aria-label="FlowTex password"
            value={password}
            onChange={(/** @type {any} */ e) => setPassword(e.target.value)}
            required
            autoFocus
            autoComplete="current-password"
            className="auth-input"
          />
        ) : (
          <>
            <input
              type="text"
              placeholder="000000"
              aria-label="2FA code"
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
          </>
        )}
        {error && <div className="auth-error">{error}</div>}
        <button
          type="submit"
          className="auth-button"
          disabled={busy || (!needTotp ? !password : totpCode.length !== 6)}
        >
          {busy ? '...' : needTotp ? 'Verify and link' : 'Link and sign in'}
        </button>
        <button type="button" className="auth-button" onClick={cancelAndGoToLogin} disabled={busy} style={secondaryButtonStyle}>
          Cancel
        </button>
      </form>
    </>
  );
}

/** Shown at /login/google-mfa: Google sign-in done, FlowTex 2FA next. */
export function GoogleMfaInterstitial() {
  const [totpCode, setTotpCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (/** @type {any} */ e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await post('/api/auth/google/mfa', { totpCode, trustDevice });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        window.location.assign(data.redirect || '/');
        return;
      }
      setError(data.error || 'Verification failed.');
    } catch {
      setError('Verification failed. Please try again.');
    }
    setBusy(false);
  };

  return (
    <>
      <p className="auth-subtitle">Enter the 6-digit code from your authenticator app</p>
      <form onSubmit={submit} className="auth-form">
        <input
          type="text"
          placeholder="000000"
          aria-label="2FA code"
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
        <button type="submit" className="auth-button" disabled={busy || totpCode.length !== 6}>
          {busy ? '...' : 'Verify'}
        </button>
        <button type="button" className="auth-button" onClick={cancelAndGoToLogin} disabled={busy} style={secondaryButtonStyle}>
          Cancel
        </button>
      </form>
    </>
  );
}

/** Settings → Google tab.
 *  @param {{ user: any, onUpdate: (u: any) => void }} props */
export function GoogleAccountSection({ user, onUpdate }) {
  const available = useGoogleAvailable();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  // Result of a link round-trip through Google (?google=linked or
  // ?google_error=<code>). Read once, then strip from the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ok = params.get('google') === 'linked';
    const err = params.get('google_error');
    if (!ok && !err) return;
    if (ok) {
      setSuccess('Google account linked. You can now sign in with Google.');
      onUpdate({ ...user, googleLinked: true });
    } else {
      setError(googleErrorMessage(err));
    }
    params.delete('google');
    params.delete('google_error');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const link = async (/** @type {any} */ e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const res = await post('/api/auth/google/link-start', { password });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        window.location.assign(data.url);
        return;
      }
      setError(data.error || 'Could not start Google linking.');
    } catch {
      setError('Could not start Google linking.');
    }
    setBusy(false);
  };

  const unlink = async (/** @type {any} */ e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const res = await post('/api/auth/google/unlink', { password });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSuccess('Google account unlinked.');
        setPassword('');
        onUpdate({ ...user, googleLinked: false });
      } else {
        setError(data.error || 'Unlink failed.');
      }
    } catch {
      setError('Unlink failed.');
    }
    setBusy(false);
  };

  if (available === null) return <p className="mfa-description">Loading…</p>;
  if (!available && !user.googleLinked) {
    return <p className="mfa-description">Google sign-in is not enabled on this server.</p>;
  }

  return (
    <>
      {error && <div className="auth-error">{error}</div>}
      {success && <div className="mfa-success">{success}</div>}
      {user.googleLinked ? (
        <>
          <p className="mfa-description">
            A Google account is linked. You can sign in with Google or with your password.
          </p>
          {user.hasPassword ? (
            <form onSubmit={unlink} className="auth-form">
              <input
                type="password"
                placeholder="Current password"
                aria-label="Current password"
                value={password}
                onChange={(/** @type {any} */ e) => setPassword(e.target.value)}
                required
                className="auth-input"
                autoComplete="current-password"
              />
              <button type="submit" className="auth-button" disabled={busy || !password}>
                {busy ? '...' : 'Unlink Google'}
              </button>
            </form>
          ) : (
            <p className="mfa-description">
              Your account has no password yet, so Google is your only way to sign in. To unlink
              Google, first set a password with <em>Forgot password?</em> on the sign-in page.
            </p>
          )}
        </>
      ) : user.hasPassword ? (
        <>
          <p className="mfa-description">
            Link a Google account to sign in with Google as well as your password. Confirm your
            password, then choose the Google account.
          </p>
          <form onSubmit={link} className="auth-form">
            <input
              type="password"
              placeholder="Current password"
              aria-label="Current password"
              value={password}
              onChange={(/** @type {any} */ e) => setPassword(e.target.value)}
              required
              className="auth-input"
              autoComplete="current-password"
            />
            <button type="submit" className="auth-button" disabled={busy || !password}>
              {busy ? '...' : 'Link Google account'}
            </button>
          </form>
        </>
      ) : (
        <p className="mfa-description">This account cannot link a Google account.</p>
      )}
    </>
  );
}
