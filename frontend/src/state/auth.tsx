/**
 * Auth context: a single master password buys a long-lived JWT (ARCHITECTURE §5).
 * The token lives in localStorage (see api/client); this just exposes login/logout
 * and reacts to server-side 401s by dropping back to the login screen.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, getToken, isGatewayFronted, onUnauthorized, setToken } from '../api/client';
import { connectSocket, disconnectSocket } from '../api/socket';
import { hasOfflineAccess, isOnline, useOnlineStatus } from './connectivity';

interface AuthContextValue {
  authed: boolean;
  /** False until the initial auth-config probe resolves (avoids a login-screen flash). */
  ready: boolean;
  login: (password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const online = useOnlineStatus();
  // Open straight onto the cached mail whenever this device has been signed in before
  // and nothing on it can be verified first: offline, or behind the SSO gateway (where
  // the probe below is the only check and the gateway re-authenticates on its own if the
  // session lapsed). Waiting on the probe instead held a phone on a skeleton for the
  // full probe timeout whenever the server was down — the case offline mail exists for.
  const [authed, setAuthed] = useState<boolean>(
    () => Boolean(getToken()) || (hasOfflineAccess() && (!isOnline() || isGatewayFronted())),
  );
  const [ready, setReady] = useState<boolean>(
    () => Boolean(getToken()) || !isOnline() || (hasOfflineAccess() && isGatewayFronted()),
  );

  // Ask the backend whether in-app login is required. When it's disabled
  // (external SSO fronts the site), treat the session as authed with no token —
  // the backend ignores the missing JWT on every route and the socket handshake.
  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      if (!isOnline()) {
        setAuthed(Boolean(getToken()) || hasOfflineAccess());
        setReady(true);
        return;
      }
      void api.authConfig().then(({ authRequired }) => {
        if (cancelled) return;
        setAuthed(authRequired ? Boolean(getToken()) : true);
        setReady(true);
      });
    };
    probe();
    // An app launched offline skips the probe entirely. Verify the real server
    // session as soon as connectivity returns without requiring a reload.
    window.addEventListener('online', probe);
    return () => {
      cancelled = true;
      window.removeEventListener('online', probe);
    };
  }, []);

  useEffect(() => {
    if (authed && online) connectSocket();
    else disconnectSocket();
  }, [authed, online]);

  useEffect(() => onUnauthorized(() => setAuthed(false)), []);

  const login = useCallback(async (password: string) => {
    await api.login(password);
    setAuthed(true);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    disconnectSocket();
    setAuthed(false);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ authed, ready, login, logout }),
    [authed, ready, login, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
