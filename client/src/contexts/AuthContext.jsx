import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { get, post } from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    get('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        setUser(u);
        setAuthChecked(true);
      })
      .catch(() => setAuthChecked(true));

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

  return <AuthContext.Provider value={{ user, setUser, authChecked, handleLogout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
