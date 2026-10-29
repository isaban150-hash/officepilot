import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import type { RegisterUserInput } from '../types/auth';
import { mapProfileRowToUserAccount, mapProfileToLicense, buildRegistrationMetadata } from '../services/auth/profileMapper';
import { mapSupabaseSession } from '../services/auth/userAccountMapper';
import {
  createMockProfileFromRegistration,
  getAllMockProfiles,
  mockApproveProfile,
  mockBlockProfile,
  mockExpireProfileLicense,
  mockExtendProfileLicense,
  mockGrantBetaProfileLicense,
  mockGrantProfileLicense,
  mockProfileSelectOwn,
  mockRpc,
  mockUpdateProfileRole,
  mockUpdateProfileEmail,
  mockUpdateProfileStatus,
  resetMockProfileStore,
  seedMockAdminProfile,
  setMockProfileCurrentUser,
} from './mockProfileStore';

interface MockAuthUser {
  password: string;
  user: User;
}

type AuthChangeCallback = (event: string, session: Session | null) => void;

const usersByEmail = new Map<string, MockAuthUser>();
const usersById = new Map<string, MockAuthUser>();
let currentSession: Session | null = null;
const listeners = new Set<AuthChangeCallback>();
let lastResetPasswordCall: { email: string; redirectTo: string } | null = null;
let updateUserCallCount = 0;
let mockRecoveryActive = false;

function nowIso(): string {
  return new Date().toISOString();
}

function createUserId(): string {
  return `usr-${crypto.randomUUID()}`;
}

function createSession(user: User): Session {
  return {
    access_token: `mock-access-${user.id}`,
    refresh_token: `mock-refresh-${user.id}`,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user,
  };
}

function notifyAuthChange(event: string): void {
  for (const listener of listeners) {
    listener(event, currentSession);
  }
}

function toUser(email: string, metadata: Record<string, string>, id = createUserId()): User {
  const createdAt = nowIso();
  return {
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email,
    email_confirmed_at: createdAt,
    phone: '',
    confirmed_at: createdAt,
    last_sign_in_at: createdAt,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: metadata,
    identities: [
      {
        id: `${id}-identity`,
        identity_id: id,
        user_id: id,
        identity_data: { email, sub: id },
        provider: 'email',
        created_at: createdAt,
        updated_at: createdAt,
        last_sign_in_at: createdAt,
      },
    ],
    created_at: createdAt,
    updated_at: createdAt,
    is_anonymous: false,
  };
}

function upsertMockUser(
  email: string,
  password: string,
  metadata: Record<string, string>,
  id?: string,
): User {
  const normalizedEmail = email.trim().toLowerCase();
  const user = toUser(normalizedEmail, metadata, id);
  const record = { password, user };
  usersByEmail.set(normalizedEmail, record);
  usersById.set(user.id, record);
  createMockProfileFromRegistration(user.id, normalizedEmail, metadata);
  return user;
}

export const DEFAULT_ADMIN_EMAIL = 'admin@officepilot.local';
export const DEFAULT_ADMIN_PASSWORD = 'OfficePilot-Admin-2026';

let signUpMode: 'with_session' | 'email_confirmation' = 'with_session';

export function setMockSignUpMode(mode: 'with_session' | 'email_confirmation'): void {
  signUpMode = mode;
}

export function resetMockSupabaseAuth(): void {
  usersByEmail.clear();
  usersById.clear();
  currentSession = null;
  listeners.clear();
  signUpMode = 'with_session';
  lastResetPasswordCall = null;
  updateUserCallCount = 0;
  mockRecoveryActive = false;
  getUserFailure = null;
  getUserCallCount = 0;
  profileFetchMode = null;
  profileFetchCount = 0;
  releaseHeld = [];
  signInFailure = null;
  resendCalls = [];
  lastSignUpOptions = null;
  lastSignOutScope = null;
  pendingEmailChange = null;
  isolatedSignInCount = 0;
  isolatedSignOutCount = 0;
  resetMockProfileStore();
}

/**
 * EINRICHTUNG-01 (AP1, E8) — `auth.getUser` fragt in Produktion den Server. Im Test lässt sich die Antwort steuern:
 * `network` (vorübergehend unbekannt), `invalid` (Server bestätigt die Sitzung nicht, etwa widerrufen).
 */
let getUserFailure: null | 'network' | 'invalid' = null;
let getUserCallCount = 0;

export function setMockGetUserFailure(mode: null | 'network' | 'invalid'): void {
  getUserFailure = mode;
}

/**
 * EINRICHTUNG-01 (AP2, A-07) — Anmeldefehler des Auth-Servers nachstellen (Code, Status, Fehlerart wie supabase-js).
 */
type MockAuthError = { name?: string; code?: string; status?: number; message: string };
let signInFailure: MockAuthError | 'throw' | null = null;
let resendCalls: Array<{ type: string; email: string; emailRedirectTo?: string }> = [];
let lastSignUpOptions: Record<string, unknown> | null = null;
let lastSignOutScope: string | null = null;

export function setMockSignInFailure(failure: MockAuthError | 'throw' | null): void {
  signInFailure = failure;
}

export function getMockResendCalls(): Array<{ type: string; email: string; emailRedirectTo?: string }> {
  return resendCalls;
}

export function getMockLastSignUpOptions(): Record<string, unknown> | null {
  return lastSignUpOptions;
}

export function getMockLastSignOutScope(): string | null {
  return lastSignOutScope;
}

/** EINRICHTUNG-01 (AP3, K-02) — angeforderter, noch nicht bestätigter E-Mail-Wechsel. */
let pendingEmailChange: { userId: string; email: string; redirect?: string } | null = null;

export function getMockPendingEmailChange(): { userId: string; email: string; redirect?: string } | null {
  return pendingEmailChange;
}

/** Beide Bestätigungslinks benutzt: Die neue Adresse gilt (wie der Server-Trigger profiles.email nachzieht). */
export function confirmMockEmailChange(): void {
  if (!pendingEmailChange) return;
  const record = usersById.get(pendingEmailChange.userId);
  if (!record) return;
  usersByEmail.delete(record.user.email ?? '');
  record.user = { ...record.user, email: pendingEmailChange.email };
  usersByEmail.set(pendingEmailChange.email, record);
  mockUpdateProfileEmail(pendingEmailChange.userId, pendingEmailChange.email);
  if (currentSession?.user.id === pendingEmailChange.userId) currentSession = { ...currentSession, user: record.user };
  pendingEmailChange = null;
}

/** Wie oft `auth.getUser` (die Bestätigung beim Server) aufgerufen wurde — über alle Client-Instanzen. */
export function getMockGetUserCallCount(): number {
  return getUserCallCount;
}

export function getMockLastResetPasswordCall(): { email: string; redirectTo: string } | null {
  return lastResetPasswordCall;
}

export function getMockUpdateUserCallCount(): number {
  return updateUserCallCount;
}

/** Establish a recovery session and emit PASSWORD_RECOVERY (test helper). */
/** EINRICHTUNG-01 (AP2, N-A1.6) — ein Auth-Ereignis mit der aktuellen Sitzung auslösen (etwa TOKEN_REFRESHED). */
export function emitMockAuthEvent(event: string): void {
  notifyAuthChange(event);
}

export function startMockPasswordRecovery(email: string): Session {
  const record = usersByEmail.get(email.trim().toLowerCase());
  if (!record) {
    throw new Error(`Mock user not found for recovery: ${email}`);
  }
  currentSession = createSession(record.user);
  setMockProfileCurrentUser(record.user.id);
  mockRecoveryActive = true;
  notifyAuthChange('PASSWORD_RECOVERY');
  return currentSession;
}

export function seedMockAdminUser(): User {
  const metadata = buildRegistrationMetadata({
    companyName: 'OfficePilot Admin',
    firstName: 'System',
    lastName: 'Administrator',
    acceptedTermsVersion: '1.0-draft',
    acceptedPrivacyVersion: '1.0-draft',
    acceptedLicenseVersion: '1.0-draft',
  });
  const user = toUser(DEFAULT_ADMIN_EMAIL, metadata, 'usr-admin');
  usersByEmail.set(DEFAULT_ADMIN_EMAIL, { password: DEFAULT_ADMIN_PASSWORD, user });
  usersById.set(user.id, { password: DEFAULT_ADMIN_PASSWORD, user });
  seedMockAdminProfile(user.id, DEFAULT_ADMIN_EMAIL, metadata);
  return user;
}

export function mockRegisterUser(input: RegisterUserInput): User {
  if (usersByEmail.has(input.email.trim().toLowerCase())) {
    throw new Error('User already registered');
  }
  return upsertMockUser(input.email, input.password, buildRegistrationMetadata(input));
}

export function mockFindUserByEmail(email: string): User | undefined {
  return usersByEmail.get(email.trim().toLowerCase())?.user;
}

export function mockManipulateUserMetadata(userId: string, patch: Record<string, string>): void {
  const record = usersById.get(userId);
  if (!record) return;
  record.user = {
    ...record.user,
    user_metadata: {
      ...(record.user.user_metadata as Record<string, string>),
      ...patch,
    },
  };
  usersByEmail.set(record.user.email ?? '', record);
  usersById.set(userId, record);
}

export function mockApproveUser(userId: string) {
  return mockApproveProfile(userId);
}

/** EINRICHTUNG-01 (EIN-20) — Lizenz getrennt von der Freischaltung, wie in Produktion. */
export function mockGrantLicense(userId: string, daysValid = 90) {
  return mockGrantProfileLicense(userId, daysValid);
}

export function mockBlockUser(userId: string) {
  return mockBlockProfile(userId);
}

export function mockExpireLicense(userId: string) {
  return mockExpireProfileLicense(userId);
}

export function mockGrantBetaLicense(userId: string, daysValid = 90) {
  return mockGrantBetaProfileLicense(userId, daysValid);
}

export function mockExtendLicense(userId: string, days: number) {
  return mockExtendProfileLicense(userId, days);
}

export function mockUpdateUserRole(userId: string, role: 'user' | 'admin') {
  return mockUpdateProfileRole(userId, role);
}

export function mockUpdateUserStatus(userId: string, status: 'pending' | 'approved' | 'blocked') {
  return mockUpdateProfileStatus(userId, status);
}

export function mockListUsersForAdmin() {
  return getAllMockProfiles().map((profile) => ({
    user: mapProfileRowToUserAccount(profile),
    license: mapProfileToLicense(profile),
  }));
}

export { getMockProfile, setMockProfileCurrentUser } from './mockProfileStore';

/**
 * EINRICHTUNG-01 (AP2, A-01, A-10) — Profilabruf nachstellen: Netzfehler (wirft), Zeitüberschreitung (hängt bis zur
 * Freigabe), abgewiesene Sitzung (401), bestätigt fehlendes Profil. Zählt die Abrufe.
 */
type MockProfileFetchMode = null | 'network' | 'unauthorized' | 'missing' | 'hold';
let profileFetchMode: MockProfileFetchMode = null;
let profileFetchCount = 0;
let releaseHeld: Array<() => void> = [];

export function setMockProfileFetchMode(mode: MockProfileFetchMode): void {
  profileFetchMode = mode;
}

export function getMockProfileFetchCount(): number {
  return profileFetchCount;
}

/** EINRICHTUNG-01 (Eigenprüfung, B-2) — gibt nur den ältesten gehaltenen Abruf frei (Antwortreihenfolge nachstellen). */
export function releaseOldestMockProfileFetch(): void {
  releaseHeld.shift()?.();
}

/** Gibt gehaltene Abrufe frei (Modus `hold`); sie liefern danach den aktuellen Stand. */
export function releaseMockProfileFetches(): void {
  const offen = releaseHeld;
  releaseHeld = [];
  for (const freigeben of offen) freigeben();
}

function createMockFrom() {
  return {
    select: () => ({
      eq: (_column: string, value: string) => ({
        maybeSingle: async () => {
          profileFetchCount += 1;
          if (profileFetchMode === 'hold') await new Promise<void>((resolve) => releaseHeld.push(resolve));
          if (profileFetchMode === 'network') throw new TypeError('Failed to fetch');
          if (profileFetchMode === 'unauthorized') return { data: null, error: { message: 'JWT expired', code: 'PGRST301', status: 401 } };
          if (profileFetchMode === 'missing') return { data: null, error: null };
          const profile = mockProfileSelectOwn(value);
          if (!profile) {
            return { data: null, error: null };
          }
          return { data: profile, error: null };
        },
      }),
    }),
  };
}

function createMockAuth() {
  return {
    signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
      if (signInFailure === 'throw') throw new TypeError('Failed to fetch');
      if (signInFailure) return { data: { session: null, user: null }, error: signInFailure };
      const record = usersByEmail.get(email.trim().toLowerCase());
      if (!record || record.password !== password) {
        return {
          data: { session: null, user: null },
          error: { name: 'AuthApiError', code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' },
        };
      }
      currentSession = createSession(record.user);
      setMockProfileCurrentUser(record.user.id);
      notifyAuthChange('SIGNED_IN');
      return { data: { session: currentSession, user: record.user }, error: null };
    },
    signUp: async ({
      email,
      password,
      options,
    }: {
      email: string;
      password: string;
      options?: { data?: Record<string, string> };
    }) => {
      const normalizedEmail = email.trim().toLowerCase();
      lastSignUpOptions = (options as Record<string, unknown> | undefined) ?? null;
      if (usersByEmail.has(normalizedEmail)) {
        return {
          data: { session: null, user: null },
          error: { name: 'AuthApiError', code: 'user_already_exists', status: 422, message: 'User already registered' },
        };
      }
      const metadata = options?.data ?? {};
      const user = upsertMockUser(normalizedEmail, password, metadata);
      if (signUpMode === 'email_confirmation') {
        notifyAuthChange('SIGNED_UP');
        return { data: { session: null, user }, error: null };
      }
      currentSession = createSession(user);
      setMockProfileCurrentUser(user.id);
      notifyAuthChange('SIGNED_UP');
      return { data: { session: currentSession, user }, error: null };
    },
    signOut: async (options?: { scope?: string }) => {
      lastSignOutScope = options?.scope ?? 'global';
      // EINRICHTUNG-01 (AP3, K-03.4) — „others“ beendet nur die anderen Sitzungen; diese bleibt.
      if (options?.scope === 'others') return { error: null };
      currentSession = null;
      setMockProfileCurrentUser(null);
      mockRecoveryActive = false;
      notifyAuthChange('SIGNED_OUT');
      return { error: null };
    },
    getSession: async () => {
      if (currentSession) {
        setMockProfileCurrentUser(currentSession.user.id);
      } else {
        setMockProfileCurrentUser(null);
      }
      return { data: { session: currentSession }, error: null };
    },
    getUser: async () => {
      getUserCallCount += 1;
      if (getUserFailure === 'network') {
        return { data: { user: null }, error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } };
      }
      if (getUserFailure === 'invalid' || !currentSession) {
        return { data: { user: null }, error: { name: 'AuthSessionMissingError', message: 'Auth session missing!', status: 401 } };
      }
      return { data: { user: currentSession.user }, error: null };
    },
    resend: async (input: { type: string; email: string; options?: { emailRedirectTo?: string } }) => {
      resendCalls.push({ type: input.type, email: input.email, emailRedirectTo: input.options?.emailRedirectTo });
      return { data: {}, error: null };
    },
    resetPasswordForEmail: async (email: string, options?: { redirectTo?: string }) => {
      lastResetPasswordCall = {
        email: email.trim().toLowerCase(),
        redirectTo: options?.redirectTo ?? '',
      };
      return { data: {}, error: null };
    },
    updateUser: async (attributes: { password?: string; email?: string }, options?: { emailRedirectTo?: string }) => {
      if (!currentSession) {
        return { data: { user: null }, error: { message: 'Auth session missing' } };
      }
      // EINRICHTUNG-01 (AP3, K-02) — E-Mail-Wechsel: erst nach beiden Bestätigungen wirksam.
      if (typeof attributes.email === 'string') {
        pendingEmailChange = { userId: currentSession.user.id, email: attributes.email, redirect: options?.emailRedirectTo };
        return { data: { user: currentSession.user }, error: null };
      }
      // EINRICHTUNG-01 (AP3, K-03) — regulärer Passwortwechsel einer angemeldeten Sitzung (ohne Wiederherstellung).
      if (!mockRecoveryActive && typeof attributes.password === 'string') {
        const record = usersById.get(currentSession.user.id);
        if (!record) return { data: { user: null }, error: { message: 'User not found' } };
        if (attributes.password.length < 8) return { data: { user: null }, error: { name: 'AuthApiError', code: 'weak_password', status: 422, message: 'weak' } };
        if (attributes.password === record.password) {
          return { data: { user: null }, error: { name: 'AuthApiError', code: 'same_password', status: 422, message: 'same' } };
        }
        record.password = attributes.password;
        // Beide Indizes zeigen auf dasselbe Konto (das Admin-Konto wird mit zwei Einträgen angelegt).
        usersByEmail.set(record.user.email ?? '', record);
        usersById.set(record.user.id, record);
        return { data: { user: record.user }, error: null };
      }
      if (!mockRecoveryActive) {
        return { data: { user: null }, error: { message: 'Not in recovery' } };
      }
      const password = attributes.password;
      if (typeof password !== 'string' || password.length === 0) {
        return { data: { user: null }, error: { message: 'Password required' } };
      }
      updateUserCallCount += 1;
      const record = usersById.get(currentSession.user.id);
      if (!record) {
        return { data: { user: null }, error: { message: 'User not found' } };
      }
      record.password = password;
      usersByEmail.set(record.user.email ?? '', record);
      usersById.set(record.user.id, record);
      return { data: { user: record.user }, error: null };
    },
    onAuthStateChange: (callback: AuthChangeCallback) => {
      listeners.add(callback);
      return {
        data: {
          subscription: {
            unsubscribe: () => listeners.delete(callback),
          },
        },
      };
    },
  };
}

/**
 * EINRICHTUNG-01 (AP3, K-03.3) — wie `createIsolatedAuthClient`: prüft Zugangsdaten gegen dieselben Konten, ohne die
 * Sitzung dieses Geräts zu ändern und ohne Ereignis an die App. Zählt Prüfungen und beendete Prüfsitzungen.
 */
let isolatedSignInCount = 0;
let isolatedSignOutCount = 0;

export function getMockIsolatedAuthCounts(): { signIn: number; signOut: number } {
  return { signIn: isolatedSignInCount, signOut: isolatedSignOutCount };
}

export function createMockIsolatedAuthClient(): SupabaseClient {
  return {
    auth: {
      signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
        isolatedSignInCount += 1;
        if (signInFailure === 'throw') throw new TypeError('Failed to fetch');
        if (signInFailure) return { data: { session: null, user: null }, error: signInFailure };
        const record = usersByEmail.get(email.trim().toLowerCase());
        if (!record || record.password !== password) {
          return {
            data: { session: null, user: null },
            error: { name: 'AuthApiError', code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' },
          };
        }
        return { data: { session: createSession(record.user), user: record.user }, error: null };
      },
      signOut: async () => {
        isolatedSignOutCount += 1;
        return { error: null };
      },
    },
  } as unknown as SupabaseClient;
}

export function createMockSupabaseClient(): SupabaseClient {
  return {
    auth: createMockAuth(),
    from: () => createMockFrom(),
    rpc: async (name: string, args?: Record<string, unknown>) => {
      try {
        const data = mockRpc(name, args ?? {});
        return { data, error: null };
      } catch (error) {
        return {
          data: null,
          error: { message: error instanceof Error ? error.message : 'RPC fehlgeschlagen' },
        };
      }
    },
  } as unknown as SupabaseClient;
}

export function getMockCurrentSession(): Session | null {
  return currentSession;
}

export function getMockCurrentAuthSession() {
  if (!currentSession) return null;
  return mapSupabaseSession(currentSession);
}
