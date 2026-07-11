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
import { mapSupabaseSession } from '../services/auth/userAccountMapper';
import { fetchCurrentUserProfile } from '../services/auth/profileService';
import { mapProfileRowToUserAccount } from '../services/auth/profileMapper';
import { bootstrapWorkspaceCloudSyncIfNeeded } from '../services/workspace/workspaceCloudBootstrapService';
import { isSupabaseConfigured } from '../lib/supabase';

interface AuthContextValue {
  user: UserAccount | null;
  session: AuthSession | null;
  isAuthenticated: boolean;
  isAllowed: boolean;
  isAdmin: boolean;
  isAuthReady: boolean;
  profileError: boolean;
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

async function resolveAuthFromSession(session: Session | null): Promise<{
  session: AuthSession | null;
  user: UserAccount | null;
  profileError: boolean;
}> {
  if (!session) {
    return { session: null, user: null, profileError: false };
  }

  const profileResult = await fetchCurrentUserProfile(session.user.id);
  if (!profileResult.success) {
    return {
      session: mapSupabaseSession(session),
      user: null,
      profileError: true,
    };
  }

  return {
    session: mapSupabaseSession(session),
    user: mapProfileRowToUserAccount(profileResult.profile),
    profileError: false,
  };
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [user, setUser] = useState<UserAccount | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [profileError, setProfileError] = useState(false);

  const applyResolvedAuth = useCallback(
    (resolved: { session: AuthSession | null; user: UserAccount | null; profileError: boolean }) => {
      setSession(resolved.session);
      setUser(resolved.user);
      setProfileError(resolved.profileError);

      if (
        resolved.session &&
        resolved.user &&
        !resolved.profileError &&
        isSupabaseConfigured() &&
        isUserAllowedToUseApp(resolved.user)
      ) {
        void bootstrapWorkspaceCloudSyncIfNeeded();
      }
    },
    [],
  );

  const refreshAuth = useCallback(async () => {
    const payload = await fetchCurrentSession();
    if (!payload) {
      applyResolvedAuth({ session: null, user: null, profileError: false });
      return;
    }
    applyResolvedAuth({
      session: payload.session,
      user: payload.user,
      profileError: false,
    });
  }, [applyResolvedAuth]);

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
      if (payload) {
        applyResolvedAuth({
          session: payload.session,
          user: payload.user,
          profileError: false,
        });
      } else {
        const { data } = await client.auth.getSession();
        if (data.session) {
          const resolved = await resolveAuthFromSession(data.session);
          applyResolvedAuth(resolved);
        } else {
          applyResolvedAuth({ session: null, user: null, profileError: false });
        }
      }
      setIsAuthReady(true);
    })();

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, nextSession: Session | null) => {
      void (async () => {
        const resolved = await resolveAuthFromSession(nextSession);
        applyResolvedAuth(resolved);
      })();
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [applyResolvedAuth]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await signInWithPassword(email, password);
    if (result.success) {
      applyResolvedAuth({
        session: result.data.session,
        user: result.data.user,
        profileError: false,
      });
    }
    return result;
  }, [applyResolvedAuth]);

  const logout = useCallback(async () => {
    await signOutUser();
    applyResolvedAuth({ session: null, user: null, profileError: false });
  }, [applyResolvedAuth]);

  const register = useCallback(async (input: RegisterUserInput) => {
    const result = await signUpUser(input);
    if (result.success && result.outcome === 'session_created') {
      applyResolvedAuth({
        session: result.payload.session,
        user: result.payload.user,
        profileError: false,
      });
    }
    return result;
  }, [applyResolvedAuth]);

  const value = useMemo(
    () => ({
      user,
      session,
      isAuthenticated: Boolean(session && user && !profileError),
      isAllowed: isUserAllowedToUseApp(user ?? undefined),
      isAdmin: user?.role === 'admin',
      isAuthReady,
      profileError,
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
    [user, session, isAuthReady, profileError, login, logout, register, refreshAuth],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
