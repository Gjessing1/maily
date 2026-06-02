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
import { api, getToken, onUnauthorized, setToken } from '../api/client';
import { connectSocket, disconnectSocket } from '../api/socket';

interface AuthContextValue {
  authed: boolean;
  login: (password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(getToken()));

  useEffect(() => {
    if (authed) connectSocket();
    else disconnectSocket();
  }, [authed]);

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
    () => ({ authed, login, logout }),
    [authed, login, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
