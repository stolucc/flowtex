// @ts-check
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { get, post } from '../api.js';

/**
 * @typedef {{
 *   user: any,
 *   setUser: (u: any) => void,
 *   authChecked: boolean,
 *   handleLogout: () => Promise<void>,
 *   needsSetup: boolean,
 *   setNeedsSetup: (n: boolean) => void,
 * }} AuthContextValue
 */

/** @type {React.Context<AuthContextValue | null>} */
const AuthContext = createContext(/** @type {AuthContextValue | null} */ (null));

/** Provides authentication state (user, logout, setup status) to the component tree.
 *  @param {{ children: React.ReactNode }} props
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    Promise.all([
      get('/api/auth/me')
        .then((r) => (r.ok ? r.json() : null))
        .catch((e) => { console.warn('Auth check failed:', e); return null; }),
      get('/api/setup/status')
        .then((r) => (r.ok ? r.json() : null))
        .catch((e) => { console.warn('Setup status check failed:', e); return null; }),
    ]).then(([u, setup]) => {
      setUser(u);
      if (setup?.needsSetup) setNeedsSetup(true);
      setAuthChecked(true);
    });

    const onExpired = () => {
      setUser(null);
      setAuthChecked(true);
    };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  const handleLogout = useCallback(async () => {
    await post('/api/auth/logout');
    setUser(null);
    window.history.replaceState(null, '', '/');
  }, []);

  return (
    <AuthContext.Provider value={{ user, setUser, authChecked, handleLogout, needsSetup, setNeedsSetup }}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Consumes the AuthContext; must be used within an AuthProvider.
 * @returns {AuthContextValue}
 */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
