import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthSession, UserAccount } from '../types/auth';
import {
  approveUser,
  blockUser,
  ensureDefaultAdminUser,
  extendLicense,
  expireLicense,
  getCurrentUser,
  grantBetaLicense,
  hydrateAuthFromStorage,
  isUserAllowedToUseApp,
  login as loginUser,
  logout as logoutUser,
  registerUser,
  type AuthResult,
} from '../services/auth/authService';
import type { RegisterUserInput } from '../types/auth';

interface AuthContextValue {
  user: UserAccount | null;
  session: AuthSession | null;
  isAuthenticated: boolean;
  isAllowed: boolean;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<AuthResult<AuthSession>>;
  logout: () => void;
  register: (input: RegisterUserInput) => Promise<AuthResult<UserAccount>>;
  refreshAuth: () => void;
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

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState(() => hydrateAuthFromStorage());
  const [user, setUser] = useState<UserAccount | null>(() => getCurrentUser());

  const refreshAuth = useCallback(() => {
    const nextSession = hydrateAuthFromStorage();
    setSession(nextSession);
    setUser(getCurrentUser());
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await loginUser(email, password);
    if (result.success) {
      setSession(result.data);
      setUser(getCurrentUser());
    }
    return result;
  }, []);

  const logout = useCallback(() => {
    logoutUser();
    setSession(null);
    setUser(null);
  }, []);

  const register = useCallback(async (input: RegisterUserInput) => {
    const result = await registerUser(input);
    return result;
  }, []);

  const value = useMemo(
    () => ({
      user,
      session,
      isAuthenticated: Boolean(user && session),
      isAllowed: isUserAllowedToUseApp(user ?? undefined),
      isAdmin: user?.role === 'admin',
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
    [user, session, login, logout, register, refreshAuth],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export async function bootstrapAuthOnStartup(): Promise<void> {
  hydrateAuthFromStorage();
  await ensureDefaultAdminUser();
}
