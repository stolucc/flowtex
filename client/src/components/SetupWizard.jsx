import React, { useState } from 'react';
import { post } from '../api.js';

export default function SetupWizard({ onComplete }) {
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [appUrl, setAppUrl] = useState(window.location.origin);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (step === 1) {
      if (!email || !name || !password) return setError('All fields are required');
      if (password.length < 8) return setError('Password must be at least 8 characters');
      if (!/[A-Z]/.test(password)) return setError('Password must contain an uppercase letter');
      if (!/[a-z]/.test(password)) return setError('Password must contain a lowercase letter');
      if (!/[0-9]/.test(password)) return setError('Password must contain a digit');
      if (password !== confirmPassword) return setError('Passwords do not match');
      setStep(2);
      return;
    }

    // Step 2: submit everything
    setLoading(true);
    try {
      const res = await post('/api/setup/init', {
        email, name, password, appUrl,
        smtpHost: smtpHost || undefined,
        smtpPort: smtpPort ? Number(smtpPort) : undefined,
        smtpUser: smtpUser || undefined,
        smtpPass: smtpPass || undefined,
        smtpFrom: smtpFrom || undefined,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Setup failed');
        setLoading(false);
        return;
      }
      onComplete(data);
    } catch {
      setError('Connection failed');
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 480 }}>
        <h2 style={{ marginBottom: 4 }}>FlowTex Setup</h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 20, fontSize: 14 }}>
          {step === 1 ? 'Create your admin account' : 'Configure your instance (optional)'}
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <div style={{
            flex: 1, height: 3, borderRadius: 2,
            background: 'var(--accent)',
          }} />
          <div style={{
            flex: 1, height: 3, borderRadius: 2,
            background: step >= 2 ? 'var(--accent)' : 'var(--border)',
          }} />
        </div>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          {step === 1 && (
            <>
              <label>
                Name
                <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus />
              </label>
              <label>
                Email
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} />
              </label>
              <label>
                Password
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} />
              </label>
              <label>
                Confirm password
                <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
              </label>
              <button type="submit">Continue</button>
            </>
          )}

          {step === 2 && (
            <>
              <label>
                App URL
                <input type="url" value={appUrl} onChange={e => setAppUrl(e.target.value)}
                  placeholder="https://flowtex.example.com" />
              </label>

              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 14 }}>
                  SMTP settings (for email verification, password resets)
                </summary>
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <label>
                    SMTP host
                    <input type="text" value={smtpHost} onChange={e => setSmtpHost(e.target.value)}
                      placeholder="smtp.gmail.com" />
                  </label>
                  <label>
                    SMTP port
                    <input type="number" value={smtpPort} onChange={e => setSmtpPort(e.target.value)}
                      placeholder="587" />
                  </label>
                  <label>
                    SMTP user
                    <input type="text" value={smtpUser} onChange={e => setSmtpUser(e.target.value)}
                      placeholder="user@gmail.com" />
                  </label>
                  <label>
                    SMTP password
                    <input type="password" value={smtpPass} onChange={e => setSmtpPass(e.target.value)} />
                  </label>
                  <label>
                    From address
                    <input type="email" value={smtpFrom} onChange={e => setSmtpFrom(e.target.value)}
                      placeholder="noreply@example.com" />
                  </label>
                </div>
              </details>

              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button type="button" onClick={() => setStep(1)}
                  style={{ flex: 1, background: 'var(--bg-secondary)' }}>
                  Back
                </button>
                <button type="submit" disabled={loading} style={{ flex: 2 }}>
                  {loading ? 'Setting up...' : 'Complete setup'}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
