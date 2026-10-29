import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  clearPasswordRecoveryPending,
  expireLicense,
  extendLicense,
  fetchCurrentSession,
  grantBetaLicense,
  hasPasswordRecoverySession,
  isUserAllowedToUseApp,
  markPasswordRecoveryPending,
  PASSWORD_RECOVERY_SHARED_KEY,
  readPasswordRecoveryPendingFlag,
  requestPasswordReset,
  signInWithPassword,
  signOutUser,
  signUpUser,
  updatePasswordDuringRecovery,
  type AuthPayload,
  type AuthResult,
  type PasswordUpdateError,
  type RegisterResult,
} from '../services/auth/supabaseAuthService';
import { mapSupabaseSession } from '../services/auth/userAccountMapper';
import { fetchCurrentUserProfile } from '../services/auth/profileService';
import { mapProfileRowToUserAccount } from '../services/auth/profileMapper';
import {
  clearCachedProfile,
  readCachedProfile,
  readLastConfirmedAccount,
  writeCachedProfile,
} from '../services/auth/profileCacheService';
import {
  clearCloudRightsState,
  markCloudRightsConfirmed,
  markCloudRightsUnconfirmed,
} from '../services/auth/cloudRightsState';
import { subscribeSessionInvalid } from '../services/auth/sessionInvalidationService';
import { adoptProfileUiLanguage } from '../services/auth/personalUiLanguage';
import { isolateBusinessStateOnLogout } from '../services/storage/storageBootstrapService';
import { resetCompanySession } from '../services/brain/companySessionService';
import {
  forgetRememberedWorkspaceBinding,
  prepareWorkspaceCloudBootstrapRetry,
} from '../services/workspace/workspaceCloudBootstrapService';

/**
 * EINRICHTUNG-01 (AP2) — warum die App zuletzt abgemeldet hat, für einen einmaligen Hinweis auf der Anmeldeseite.
 * `profile_missing`: Der Server bestätigt, dass zu dieser Anmeldung kein Profil gehört (A-10.1).
 * `session_invalid`: Der Server hat die Sitzung abgewiesen, etwa nach „Auf allen Geräten abmelden“ (A-01.3).
 * `account_deleted`: EINRICHTUNG-01 (AP7; 1.25) — das Konto wurde gelöscht bzw. die Löschung wird abgeschlossen; die
 *   Daten dieses Kontos wurden von diesem Gerät entfernt.
 * `device_data_removed`: EINRICHTUNG-01 (AP8; 1.29) — die Daten dieses Kontos wurden von diesem Gerät entfernt; die
 *   Serverdaten bleiben unverändert.
 */
export type AuthLogoutReason = 'profile_missing' | 'session_invalid' | 'account_deleted' | 'device_data_removed';

const LOGOUT_REASON_KEY = 'officetakt.auth.logoutReason';

function rememberLogoutReason(reason: AuthLogoutReason): void {
  try {
    sessionStorage.setItem(LOGOUT_REASON_KEY, reason);
  } catch {
    // ohne Speicher entfällt nur der Hinweis
  }
}

function readLogoutReason(): AuthLogoutReason | null {
  try {
    const value = sessionStorage.getItem(LOGOUT_REASON_KEY);
    return value === 'profile_missing' || value === 'session_invalid' || value === 'account_deleted' || value === 'device_data_removed'
      ? value
      : null;
  } catch {
    return null;
  }
}

function forgetLogoutReason(): void {
  try {
    sessionStorage.removeItem(LOGOUT_REASON_KEY);
  } catch {
    // nichts zu tun
  }
}

/** EINRICHTUNG-01 (AP2, A-01.1) — automatische Wiederholung eines gescheiterten Profilabrufs. */
const PROFILE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

interface AuthContextValue {
  user: UserAccount | null;
  session: AuthSession | null;
  isAuthenticated: boolean;
  isAllowed: boolean;
  isAdmin: boolean;
  isAuthReady: boolean;
  profileError: boolean;
  /**
   * EINRICHTUNG-01 (AP2, A-01) — false, solange das Profil nur aus dem Zwischenspeicher stammt: Der Abruf ist
   * gescheitert (Netz, Zeitüberschreitung, 5xx) und wird wiederholt. Rechte daraus gelten nicht für cloudbestätigte
   * Aktionen.
   */
  profileConfirmed: boolean;
  /** EINRICHTUNG-01 (AP2) — die Verbindung zum Server ist gestört; die Anmeldung bleibt bestehen. */
  connectionIssue: boolean;
  /** EINRICHTUNG-01 (AP2) — einmaliger Hinweis nach einer vom Server veranlassten Abmeldung. */
  logoutReason: AuthLogoutReason | null;
  clearLogoutReason: () => void;
  /** EINRICHTUNG-01 (AP2) — den Profilabruf sofort erneut versuchen. */
  retryProfile: () => Promise<void>;
  /** True while a password-recovery session must stay on /reset-password. */
  passwordRecoveryPending: boolean;
  login: (email: string, password: string) => Promise<AuthResult<AuthPayload>>;
  /** EINRICHTUNG-01 (AP2, Vertrag 1.8) — nur dieses Gerät (`scope: 'local'`). */
  logout: () => Promise<void>;
  /** EINRICHTUNG-01 (AP7; 1.25) — lokale Abmeldung nach einer Kontolöschung, mit einmaligem Hinweis auf der Anmeldeseite. */
  logoutAfterAccountDeletion: () => Promise<void>;
  /** EINRICHTUNG-01 (AP8; 1.29) — lokale Abmeldung vor dem Entfernen der Gerätedaten, mit einmaligem Hinweis. */
  logoutAfterDeviceDataRemoval: () => Promise<void>;
  /** EINRICHTUNG-01 (AP2, Vertrag 1.8) — alle Refresh-Sitzungen des Kontos widerrufen (`scope: 'global'`). */
  logoutEverywhere: () => Promise<void>;
  register: (input: RegisterUserInput) => Promise<RegisterResult>;
  refreshAuth: () => Promise<void>;
  requestPasswordReset: (email: string, redirectTo: string) => ReturnType<typeof requestPasswordReset>;
  refreshPasswordRecoveryState: () => Promise<boolean>;
  updatePasswordDuringRecovery: (
    password: string,
  ) => Promise<{ success: true } | { success: false; error: PasswordUpdateError }>;
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

/**
 * EINRICHTUNG-01 (AP2, EIN-09; B3) — was eine Sitzung über das Profil ergibt.
 * - `confirmed`: Server-Profil geladen.
 * - `cached`: Abruf vorübergehend gescheitert, letztes bestätigtes Profil desselben Kontos (unbestätigt).
 * - `unavailable`: Abruf vorübergehend gescheitert, kein Zwischenstand — weder Abmeldung noch App.
 * - `profile_missing` / `session_invalid`: vom Server bestätigt — Abmeldung dieses Geräts.
 */
type ResolvedAuth =
  | { kind: 'signed_out' }
  | { kind: 'confirmed'; session: AuthSession; user: UserAccount }
  | { kind: 'cached'; session: AuthSession; user: UserAccount }
  | { kind: 'unavailable'; session: AuthSession }
  | { kind: 'profile_missing' }
  | { kind: 'session_invalid' };

async function resolveAuthFromSession(session: Session | null): Promise<ResolvedAuth> {
  if (!session) return { kind: 'signed_out' };
  const mapped = mapSupabaseSession(session);
  const profileResult = await fetchCurrentUserProfile(session.user.id);
  if (profileResult.success) {
    writeCachedProfile(profileResult.profile);
    return { kind: 'confirmed', session: mapped, user: mapProfileRowToUserAccount(profileResult.profile) };
  }
  if (profileResult.error === 'not_found') return { kind: 'profile_missing' };
  if (profileResult.error === 'session_invalid') return { kind: 'session_invalid' };
  const cached = readCachedProfile(session.user.id);
  return cached
    ? { kind: 'cached', session: mapped, user: mapProfileRowToUserAccount(cached) }
    : { kind: 'unavailable', session: mapped };
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [user, setUser] = useState<UserAccount | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [profileError, setProfileError] = useState(false);
  const [profileConfirmed, setProfileConfirmed] = useState(true);
  const [connectionIssue, setConnectionIssue] = useState(false);
  const [logoutReason, setLogoutReason] = useState<AuthLogoutReason | null>(() => readLogoutReason());
  const [passwordRecoveryPending, setPasswordRecoveryPending] = useState(() =>
    readPasswordRecoveryPendingFlag(),
  );

  /**
   * EINRICHTUNG-01 (AP2, EIN-09; A-03, N-A1) — Generationszähler. Jede Anmeldung, Abmeldung und jedes Auth-Ereignis
   * erhöht ihn; ein Profilabruf wirkt nur, wenn er noch zur aktuellen Generation gehört. So setzt ein vor dem Abmelden
   * gestarteter Abruf den Nutzer nicht wieder, und Antworten von Konto A wirken nie bei Konto B.
   */
  const generationRef = useRef(0);
  const userIdRef = useRef<string | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryIndexRef = useRef(0);
  const lastSessionRef = useRef<Session | null>(null);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const applySignedOut = useCallback(() => {
    clearRetry();
    retryIndexRef.current = 0;
    lastSessionRef.current = null;
    if (userIdRef.current) clearCloudRightsState(userIdRef.current);
    userIdRef.current = null;
    setSession(null);
    setUser(null);
    setProfileError(false);
    setProfileConfirmed(true);
    setConnectionIssue(false);
  }, [clearRetry]);

  const applyConfirmed = useCallback(
    (nextSession: AuthSession, nextUser: UserAccount) => {
      clearRetry();
      retryIndexRef.current = 0;
      if (userIdRef.current && userIdRef.current !== nextUser.id) clearCloudRightsState(userIdRef.current);
      userIdRef.current = nextUser.id;
      markCloudRightsConfirmed(nextUser.id, 'profile_unconfirmed');
      // EINRICHTUNG-01 (AP3, K-04.3) — die am Profil gespeicherte Sprache gilt auch auf diesem Gerät.
      if (nextUser.uiLanguage) adoptProfileUiLanguage(nextUser.id, nextUser.uiLanguage);
      setSession(nextSession);
      setUser(nextUser);
      setProfileError(false);
      setProfileConfirmed(true);
      setConnectionIssue(false);
    },
    [clearRetry],
  );

  /** Lokale Abmeldung nach einer Bestätigung des Servers (Profil fehlt, Sitzung abgewiesen). */
  const signOutConfirmedByServer = useCallback(
    async (reason: AuthLogoutReason) => {
      generationRef.current += 1;
      const previous = userIdRef.current;
      rememberLogoutReason(reason);
      setLogoutReason(reason);
      try {
        await signOutUser('local');
      } catch {
        // Die lokale Sitzung wird unten ohnehin verworfen.
      }
      clearPasswordRecoveryPending();
      setPasswordRecoveryPending(false);
      isolateBusinessStateOnLogout();
      resetCompanySession();
      prepareWorkspaceCloudBootstrapRetry();
      clearCachedProfile(previous);
      forgetRememberedWorkspaceBinding(previous);
      applySignedOut();
      // EINRICHTUNG-01 (Eigenprüfung, B-2) — ein endgültiger Stand: „bereit“ auch dann, wenn dies im Startwettlauf geschieht.
      setIsAuthReady(true);
    },
    [applySignedOut],
  );

  const scheduleRetryRef = useRef<() => void>(() => undefined);

  /**
   * Eine Sitzung auflösen und das Ergebnis anwenden — nur, wenn die Generation noch stimmt.
   */
  const resolveAndApply = useCallback(
    async (nextSession: Session | null, generation: number) => {
      lastSessionRef.current = nextSession;
      const resolved = await resolveAuthFromSession(nextSession);
      if (generation !== generationRef.current) return;
      switch (resolved.kind) {
        case 'signed_out':
          applySignedOut();
          return;
        case 'confirmed':
          applyConfirmed(resolved.session, resolved.user);
          return;
        case 'cached':
          // A-01.1 — keine Abmeldung: Profil und Sitzung bleiben, Hinweis und automatische Wiederholung.
          if (userIdRef.current && userIdRef.current !== resolved.user.id) clearCloudRightsState(userIdRef.current);
          userIdRef.current = resolved.user.id;
          markCloudRightsUnconfirmed(resolved.user.id, 'profile_unconfirmed');
          setSession(resolved.session);
          setUser(resolved.user);
          setProfileError(false);
          setProfileConfirmed(false);
          setConnectionIssue(true);
          scheduleRetryRef.current();
          return;
        case 'unavailable':
          if (userIdRef.current && userIdRef.current !== resolved.session.userId) clearCloudRightsState(userIdRef.current);
          userIdRef.current = resolved.session.userId;
          setSession(resolved.session);
          setUser(null);
          setProfileError(false);
          setProfileConfirmed(false);
          setConnectionIssue(true);
          scheduleRetryRef.current();
          return;
        case 'profile_missing':
          await signOutConfirmedByServer('profile_missing');
          return;
        case 'session_invalid':
          await signOutConfirmedByServer('session_invalid');
          return;
      }
    },
    [applyConfirmed, applySignedOut, signOutConfirmedByServer],
  );

  const retryProfile = useCallback(async () => {
    clearRetry();
    const client = getSupabaseClient();
    if (!client) return;
    const generation = ++generationRef.current;
    let current: Session | null = lastSessionRef.current;
    try {
      const { data } = await client.auth.getSession();
      current = data.session ?? null;
    } catch {
      // Sitzung gerade nicht lesbar: mit der zuletzt bekannten weiter versuchen.
    }
    if (generation !== generationRef.current) return;
    await resolveAndApply(current, generation);
  }, [clearRetry, resolveAndApply]);

  scheduleRetryRef.current = () => {
    if (retryTimerRef.current !== null) return;
    const delay = PROFILE_RETRY_DELAYS_MS[Math.min(retryIndexRef.current, PROFILE_RETRY_DELAYS_MS.length - 1)]!;
    retryIndexRef.current += 1;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      void retryProfile();
    }, delay);
  };

  const refreshPasswordRecoveryState = useCallback(async () => {
    const active = await hasPasswordRecoverySession();
    setPasswordRecoveryPending(active);
    return active;
  }, []);

  const refreshAuth = useCallback(async () => {
    const generation = ++generationRef.current;
    const payload = await fetchCurrentSession();
    if (generation !== generationRef.current) return;
    if (!payload) {
      // Kein bestätigtes Profil: über den vollständigen Weg auflösen (Netzfehler melden nicht ab).
      const client = getSupabaseClient();
      if (!client) {
        applySignedOut();
        return;
      }
      let current: Session | null = null;
      try {
        current = (await client.auth.getSession()).data.session ?? null;
      } catch {
        current = lastSessionRef.current;
      }
      if (generation !== generationRef.current) return;
      await resolveAndApply(current, generation);
      return;
    }
    writeCachedProfile(payload.profile);
    lastSessionRef.current = payload.supabaseSession;
    applyConfirmed(payload.session, payload.user);
  }, [applyConfirmed, applySignedOut, resolveAndApply]);

  useEffect(() => {
    const client = getSupabaseClient();
    if (!client) {
      setIsAuthReady(true);
      return;
    }

    let active = true;
    const generation = ++generationRef.current;

    void (async () => {
      let initial: Session | null = null;
      let readable = true;
      try {
        const { data, error } = await client.auth.getSession();
        if (error) readable = false;
        initial = data?.session ?? null;
      } catch {
        readable = false;
      }
      if (!active) return;
      if (!readable && !initial) {
        /*
         * B3 „vorübergehend unbekannt“ (N-A1.5b): keine automatische Abmeldung. Nur der kontogebundene Offline-Pfad
         * des zuletzt bestätigten Kontos — unbestätigt, ohne Schreibanfrage (der Sync-Lauf hält ohne lesbare Sitzung
         * an, DOKUMENTE-01 R1). Ohne bestätigtes Konto erscheint die Anmeldeseite; gespeicherte Daten bleiben.
         */
        const last = readLastConfirmedAccount();
        const cached = readCachedProfile(last);
        if (generation === generationRef.current) {
          if (last && cached) {
            const offlineUser = mapProfileRowToUserAccount(cached);
            userIdRef.current = offlineUser.id;
            markCloudRightsUnconfirmed(offlineUser.id, 'profile_unconfirmed');
            setSession({ userId: offlineUser.id, accessToken: '', createdAt: offlineUser.createdAt });
            setUser(offlineUser);
            setProfileError(false);
            setProfileConfirmed(false);
            setConnectionIssue(true);
            scheduleRetryRef.current();
          } else {
            applySignedOut();
          }
        }
      } else {
        await resolveAndApply(initial, generation);
      }
      if (!active) return;
      /*
       * EINRICHTUNG-01 (Eigenprüfung, B-2; A-01, A-12) — hat ein Auth-Ereignis den Startlauf überholt (neuere Generation),
       * gilt dessen Ergebnis: Der neuere Lauf setzt „bereit“, sobald er angewendet ist. Sonst wäre die App kurz „bereit,
       * aber abgemeldet“ und leitete eine angemeldete Person über die Anmeldeseite um.
       */
      if (generation !== generationRef.current) return;
      if (initial && readPasswordRecoveryPendingFlag()) setPasswordRecoveryPending(true);
      if (!initial && !readPasswordRecoveryPendingFlag()) setPasswordRecoveryPending(false);
      setIsAuthReady(true);
    })();

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, nextSession: Session | null) => {
      void (async () => {
        if (event === 'PASSWORD_RECOVERY') {
          markPasswordRecoveryPending();
          setPasswordRecoveryPending(true);
        }
        if (event === 'SIGNED_OUT') {
          clearPasswordRecoveryPending();
          setPasswordRecoveryPending(false);
        }
        // Das Startereignis wertet der Startlauf oben aus.
        if (event === 'INITIAL_SESSION') return;
        // N-A1.6 — ein erneuertes Token desselben Kontos ist kein Kontowechsel: nichts neu laden.
        if (
          event === 'TOKEN_REFRESHED' &&
          nextSession &&
          nextSession.user.id === userIdRef.current
        ) {
          lastSessionRef.current = nextSession;
          setSession(mapSupabaseSession(nextSession));
          return;
        }
        const generationNow = ++generationRef.current;
        if (event === 'SIGNED_OUT' || !nextSession) {
          const previous = userIdRef.current;
          if (previous) {
            clearCachedProfile(previous);
            forgetRememberedWorkspaceBinding(previous);
          }
          applySignedOut();
          // EINRICHTUNG-01 (Eigenprüfung, B-2) — der Lauf, dessen Ergebnis gilt, setzt „bereit“ (auch im Startwettlauf).
          setIsAuthReady(true);
          return;
        }
        await resolveAndApply(nextSession, generationNow);
        if (readPasswordRecoveryPendingFlag()) {
          setPasswordRecoveryPending(true);
        }
        if (generationNow === generationRef.current) setIsAuthReady(true);
      })();
    });

    // EINRICHTUNG-01 (AP2, B3) — der Server hat die Sitzung abgewiesen: nur dieses Gerät abmelden.
    const unsubscribeInvalid = subscribeSessionInvalid(() => {
      if (!userIdRef.current) return;
      void signOutConfirmedByServer('session_invalid');
    });

    // EINRICHTUNG-01 (AP2, A-11.1) — beginnt oder endet in einem anderen Tab eine Wiederherstellung, folgt dieser Tab.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== PASSWORD_RECOVERY_SHARED_KEY) return;
      setPasswordRecoveryPending(readPasswordRecoveryPendingFlag());
    };
    window.addEventListener('storage', onStorage);

    // Netz zurück: einen offenen Profilabruf sofort wiederholen.
    const onOnline = () => {
      if (retryTimerRef.current !== null) void retryProfile();
    };
    window.addEventListener('online', onOnline);

    return () => {
      active = false;
      generationRef.current += 1;
      subscription.unsubscribe();
      unsubscribeInvalid();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('storage', onStorage);
      clearRetry();
    };
  }, [applySignedOut, clearRetry, resolveAndApply, retryProfile, signOutConfirmedByServer]);

  const login = useCallback(
    async (email: string, password: string) => {
      const generation = ++generationRef.current;
      const result = await signInWithPassword(email, password);
      if (result.success && generation === generationRef.current) {
        clearPasswordRecoveryPending();
        setPasswordRecoveryPending(false);
        forgetLogoutReason();
        setLogoutReason(null);
        writeCachedProfile(result.data.profile);
        lastSessionRef.current = result.data.supabaseSession;
        applyConfirmed(result.data.session, result.data.user);
      }
      return result;
    },
    [applyConfirmed],
  );

  const endSession = useCallback(
    async (scope: 'local' | 'global') => {
      // A-03.1 — ein laufender Profilabruf wirkt danach nicht mehr.
      generationRef.current += 1;
      const previous = userIdRef.current;
      await signOutUser(scope);
      clearPasswordRecoveryPending();
      setPasswordRecoveryPending(false);
      isolateBusinessStateOnLogout();
      resetCompanySession();
      prepareWorkspaceCloudBootstrapRetry();
      clearCachedProfile(previous);
      forgetRememberedWorkspaceBinding(previous);
      applySignedOut();
    },
    [applySignedOut],
  );

  const logout = useCallback(() => endSession('local'), [endSession]);
  const logoutAfterAccountDeletion = useCallback(async () => {
    await endSession('local');
    rememberLogoutReason('account_deleted');
    setLogoutReason('account_deleted');
  }, [endSession]);
  const logoutAfterDeviceDataRemoval = useCallback(async () => {
    await endSession('local');
    rememberLogoutReason('device_data_removed');
    setLogoutReason('device_data_removed');
  }, [endSession]);
  const logoutEverywhere = useCallback(() => endSession('global'), [endSession]);

  const register = useCallback(async (input: RegisterUserInput) => {
    const generation = ++generationRef.current;
    const result = await signUpUser(input);
    if (result.success && result.outcome === 'session_created' && generation === generationRef.current) {
      writeCachedProfile(result.payload.profile);
      lastSessionRef.current = result.payload.supabaseSession;
      applyConfirmed(result.payload.session, result.payload.user);
    }
    return result;
  }, [applyConfirmed]);

  const requestPasswordResetFn = useCallback(
    (email: string, redirectTo: string) => requestPasswordReset(email, redirectTo),
    [],
  );

  const updatePasswordDuringRecoveryFn = useCallback(
    async (password: string) => {
      const result = await updatePasswordDuringRecovery(password);
      return result;
    },
    [],
  );

  const clearLogoutReason = useCallback(() => {
    forgetLogoutReason();
    setLogoutReason(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      session,
      isAuthenticated: Boolean(session && user && !profileError),
      isAllowed: isUserAllowedToUseApp(user ?? undefined),
      isAdmin: user?.role === 'admin',
      isAuthReady,
      profileError,
      profileConfirmed,
      connectionIssue,
      logoutReason,
      clearLogoutReason,
      retryProfile,
      passwordRecoveryPending,
      login,
      logout,
      logoutAfterAccountDeletion,
      logoutAfterDeviceDataRemoval,
      logoutEverywhere,
      register,
      refreshAuth,
      requestPasswordReset: requestPasswordResetFn,
      refreshPasswordRecoveryState,
      updatePasswordDuringRecovery: updatePasswordDuringRecoveryFn,
      approveUser,
      blockUser,
      extendLicense,
      expireLicense,
      grantBetaLicense,
    }),
    [
      user,
      session,
      isAuthReady,
      profileError,
      profileConfirmed,
      connectionIssue,
      logoutReason,
      clearLogoutReason,
      retryProfile,
      passwordRecoveryPending,
      login,
      logout,
      logoutAfterAccountDeletion,
      logoutAfterDeviceDataRemoval,
      logoutEverywhere,
      register,
      refreshAuth,
      requestPasswordResetFn,
      refreshPasswordRecoveryState,
      updatePasswordDuringRecoveryFn,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * EMAIL-01B3 — für Bausteine, die auch ohne Auth-Kontext gerendert werden
 * (bestehende Detailseiten-Tests mounten ohne AuthProvider). Ohne Provider
 * gibt es keinen Nutzer — und damit kein Schreibrecht.
 */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext);
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
