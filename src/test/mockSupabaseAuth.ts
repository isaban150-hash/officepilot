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
  mockProfileSelectOwn,
  mockRpc,
  mockUpdateProfileRole,
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
  resetMockProfileStore();
}

export function getMockLastResetPasswordCall(): { email: string; redirectTo: string } | null {
  return lastResetPasswordCall;
}

export function getMockUpdateUserCallCount(): number {
  return updateUserCallCount;
}

/** Establish a recovery session and emit PASSWORD_RECOVERY (test helper). */
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

export function mockApproveUser(userId: string, daysValid = 90) {
  return mockApproveProfile(userId, daysValid);
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

function createMockFrom() {
  return {
    select: () => ({
      eq: (_column: string, value: string) => ({
        maybeSingle: async () => {
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
      const record = usersByEmail.get(email.trim().toLowerCase());
      if (!record || record.password !== password) {
        return { data: { session: null, user: null }, error: { message: 'Invalid login credentials' } };
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
      if (usersByEmail.has(normalizedEmail)) {
        return { data: { session: null, user: null }, error: { message: 'User already registered' } };
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
    signOut: async () => {
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
    resetPasswordForEmail: async (email: string, options?: { redirectTo?: string }) => {
      lastResetPasswordCall = {
        email: email.trim().toLowerCase(),
        redirectTo: options?.redirectTo ?? '',
      };
      return { data: {}, error: null };
    },
    updateUser: async (attributes: { password?: string }) => {
      if (!currentSession) {
        return { data: { user: null }, error: { message: 'Auth session missing' } };
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
