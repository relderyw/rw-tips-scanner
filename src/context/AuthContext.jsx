import { createContext, useContext, useEffect, useState } from 'react';
import * as auth from '../services/authService.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  useEffect(() => auth.onAuthChange((nextUser) => {
    setUser(nextUser);
    setAuthReady(true);
  }), []);
  useEffect(() => {
    if (!user) return undefined;
    const timer = setInterval(() => {
      if (!user.isAdmin && user.expiresAt && Date.now() >= user.expiresAt) {
        auth.logout().catch((error) => console.error('[auth] failed to end expired session:', error));
        return;
      }
      auth.refreshSessionClaims().catch((error) => {
        if (error?.message) {
          console.warn('[auth] sessão atualizada ou encerrada:', error.message);
        }
      });
    }, 15000);
    return () => clearInterval(timer);
  }, [user]);
  const login = async (...args) => {
    const signedInUser = await auth.login(...args);
    setUser(signedInUser);
    setAuthReady(true);
    return signedInUser;
  };
  return <AuthContext.Provider value={{ user, authReady, login, logout: auth.logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
