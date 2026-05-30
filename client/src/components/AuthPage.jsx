import React, { useState, useEffect } from 'react';
import { post, get } from '../api.js';

/** Authentication page handling login, registration, email verification, password reset, and 2FA. */
export default function AuthPage({ onAuth }) {
  const urlParams = new URLSearchParams(window.location.search);
  const resetToken = urlParams.get('token');
  const verifyToken = urlParams.get('verify');
  const [mode, setMode] = useState(resetToken ? 'reset' : verifyToken ? 'verifying' : 'login');
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

  const handleSubmit = async (e) => {
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
      setError(err.message);
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

  const handleForgotPassword = async (e) => {
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
      setError(err.message);
    }
    setLoading(false);
  };

  const handleResetPassword = async (e) => {
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
      setError(err.message);
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

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">FlowTex</h1>

        {mode === 'verifying' ? (
          <p className="auth-subtitle">Verifying your email...</p>
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
                <strong>junk</strong>. If it&apos;s still missing after 5–10
                minutes, use <em>Resend verification email</em> below.
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
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="auth-input"
                autoFocus
              />
              <input
                type="password"
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
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
                onChange={(e) => setEmail(e.target.value)}
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
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required
                autoFocus
                className="auth-input auth-input-totp"
                inputMode="numeric"
                autoComplete="one-time-code"
              />
              <label className="auth-trust-label">
                <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} />
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
            <form onSubmit={handleSubmit} className="auth-form">
              {mode === 'register' && (
                <input
                  type="text"
                  placeholder="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="auth-input"
                />
              )}
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
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
                onChange={(e) => setPassword(e.target.value)}
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
          </>
        )}
      </div>
    </div>
  );
}
