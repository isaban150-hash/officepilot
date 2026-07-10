import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import type { AuthSession, UserAccount } from '../types/auth';
import type { RegisterUserInput } from '../types/auth';
import { getSupabaseClient } from '../lib/supabase';
import {
  approveUser,
  blockUser,
  expireLicense,
  extendLicense,
  fetchCurrentSession,
  grantBetaLicense,
  isUserAllowedToUseApp,
  signInWithPassword,
  signOutUser,
  signUpUser,
  type AuthPayload,
  type AuthResult,
  type RegisterResult,
} from '../services/auth/supabaseAuthService';
import { mapSupabaseSession, mapSupabaseUserToAccount } from '../services/auth/userAccountMapper';

interface AuthContextValue {
  user: UserAccount | null;
  session: AuthSession | null;
  isAuthenticated: boolean;
  isAllowed: boolean;
  isAdmin: boolean;
  isAuthReady: boolean;
  login: (email: string, password: string) => Promise<AuthResult<AuthPayload>>;
  logout: () => Promise<void>;
  register: (input: RegisterUserInput) => Promise<RegisterResult>;
  refreshAuth: () => Promise<void>;
  approveUser: typeof approveUser;
  blockUser: typeof blockUser;
  extendLicense: typeof extendLicense;
  expireLicense: typeof expireLicense;
  grantBetaLicense: typeof grantBetaLicense;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

function applyAuthPayload(
  payload: AuthPayload | null,
  setSession: (session: AuthSession | null) => void,
  setUser: (user: UserAccount | null) => void,
): void {
  if (!payload) {
    setSession(null);
    setUser(null);
    return;
  }
  setSession(payload.session);
  setUser(payload.user);
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [user, setUser] = useState<UserAccount | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  const refreshAuth = useCallback(async () => {
    const payload = await fetchCurrentSession();
    applyAuthPayload(payload, setSession, setUser);
  }, []);

  useEffect(() => {
    const client = getSupabaseClient();
    if (!client) {
      setIsAuthReady(true);
      return;
    }

    let active = true;

    void (async () => {
      const payload = await fetchCurrentSession();
      if (!active) return;
      applyAuthPayload(payload, setSession, setUser);
      setIsAuthReady(true);
    })();

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, nextSession: Session | null) => {
      if (!nextSession) {
        applyAuthPayload(null, setSession, setUser);
        return;
      }
      applyAuthPayload(
        {
          session: mapSupabaseSession(nextSession),
          user: mapSupabaseUserToAccount(nextSession.user),
          supabaseSession: nextSession,
        },
        setSession,
        setUser,
      );
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await signInWithPassword(email, password);
    if (result.success) {
      applyAuthPayload(result.data, setSession, setUser);
    }
    return result;
  }, []);

  const logout = useCallback(async () => {
    await signOutUser();
    applyAuthPayload(null, setSession, setUser);
  }, []);

  const register = useCallback(async (input: RegisterUserInput) => {
    const result = await signUpUser(input);
    if (result.success && result.outcome === 'session_created') {
      applyAuthPayload(result.payload, setSession, setUser);
    }
    return result;
  }, []);

  const value = useMemo(
    () => ({
      user,
      session,
      isAuthenticated: Boolean(user && session),
      isAllowed: isUserAllowedToUseApp(user ?? undefined),
      isAdmin: user?.role === 'admin',
      isAuthReady,
      login,
      logout,
      register,
      refreshAuth,
      approveUser,
      blockUser,
      extendLicense,
      expireLicense,
      grantBetaLicense,
    }),
    [user, session, isAuthReady, login, logout, register, refreshAuth],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
