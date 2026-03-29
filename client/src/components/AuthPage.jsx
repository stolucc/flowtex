import React, { useState } from 'react';
import { post } from '../api.js';

export default function AuthPage({ onAuth }) {
  const [mode, setMode] = useState('login'); // login | register | forgot | reset
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

  // Check for reset token in URL
  const urlParams = new URLSearchParams(window.location.search);
  const resetToken = urlParams.get('token');
  if (resetToken && mode !== 'reset') {
    setMode('reset');
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = mode === 'login'
        ? { email, password, ...(mfaRequired ? { totpCode, trustDevice } : {}) }
        : { email, name, password };
      const res = await post(endpoint, body);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong');
      } else if (data.mfaRequired) {
        setMfaRequired(true);
      } else {
        onAuth(data);
      }
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
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
    window.history.replaceState({}, '', '/');
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">FlowTex</h1>

        {mode === 'reset' ? (
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
                <input
                  type="checkbox"
                  checked={trustDevice}
                  onChange={(e) => setTrustDevice(e.target.checked)}
                />
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
            <p className="auth-subtitle">
              {mode === 'login' ? 'Sign in to your account' : 'Create a new account'}
            </p>
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
              <button type="submit" className="auth-button" disabled={loading}>
                {loading ? '...' : mode === 'login' ? 'Sign In' : 'Register'}
              </button>
            </form>
            {mode === 'login' && (
              <p className="auth-switch">
                <button onClick={() => { setMode('forgot'); setError(''); setSuccess(''); }}>
                  Forgot password?
                </button>
              </p>
            )}
            <p className="auth-switch">
              {mode === 'login' ? (
                <>
                  Don't have an account?{' '}
                  <button onClick={() => { setMode('register'); setError(''); }}>Register</button>
                </>
              ) : (
                <>
                  Already have an account?{' '}
                  <button onClick={goToLogin}>Sign In</button>
                </>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
