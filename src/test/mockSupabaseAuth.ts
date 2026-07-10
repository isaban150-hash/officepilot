import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import type { LicensePlan, LicenseStatus, UserRole, UserStatus } from '../types/auth';
import {
  buildActiveLicenseMetadata,
  buildSignUpMetadata,
  mapSupabaseSession,
  mapSupabaseUserToAccount,
  type OfficePilotUserMetadata,
} from '../services/auth/userAccountMapper';
import type { RegisterUserInput } from '../types/auth';
import { getLicenseFromUserAccount } from '../services/auth/licenseService';

interface MockAuthUser {
  password: string;
  user: User;
}

type AuthChangeCallback = (event: string, session: Session | null) => void;

const usersByEmail = new Map<string, MockAuthUser>();
const usersById = new Map<string, MockAuthUser>();
let currentSession: Session | null = null;
const listeners = new Set<AuthChangeCallback>();

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

function toUser(email: string, metadata: OfficePilotUserMetadata, id = createUserId()): User {
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

function upsertMockUser(email: string, password: string, metadata: OfficePilotUserMetadata, id?: string): User {
  const normalizedEmail = email.trim().toLowerCase();
  const user = toUser(normalizedEmail, metadata, id);
  const record = { password, user };
  usersByEmail.set(normalizedEmail, record);
  usersById.set(user.id, record);
  return user;
}

function updateUserMetadata(userId: string, patch: Partial<OfficePilotUserMetadata>): User | null {
  const record = usersById.get(userId);
  if (!record) return null;
  const metadata = { ...(record.user.user_metadata as OfficePilotUserMetadata), ...patch };
  const updatedUser = { ...record.user, user_metadata: metadata, updated_at: nowIso() };
  record.user = updatedUser;
  usersByEmail.set(updatedUser.email ?? '', record);
  usersById.set(userId, record);
  if (currentSession?.user.id === userId) {
    currentSession = createSession(updatedUser);
    notifyAuthChange('USER_UPDATED');
  }
  return updatedUser;
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
}

export function seedMockAdminUser(): User {
  const metadata: OfficePilotUserMetadata = {
    company_name: 'OfficePilot Admin',
    first_name: 'System',
    last_name: 'Administrator',
    status: 'active',
    role: 'admin',
    accepted_terms_version: '1.0-draft',
    accepted_privacy_version: '1.0-draft',
    accepted_license_version: '1.0-draft',
    legal_accepted_at: nowIso(),
    ...buildActiveLicenseMetadata(365),
  };
  return upsertMockUser(DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD, metadata, 'usr-admin');
}

export function mockRegisterUser(input: RegisterUserInput): User {
  if (usersByEmail.has(input.email.trim().toLowerCase())) {
    throw new Error('User already registered');
  }
  return upsertMockUser(input.email, input.password, buildSignUpMetadata(input));
}

export function mockApproveUser(userId: string): User | null {
  return updateUserMetadata(userId, buildActiveLicenseMetadata(90));
}

export function mockBlockUser(userId: string): User | null {
  return updateUserMetadata(userId, { status: 'blocked' });
}

export function mockExpireLicense(userId: string): User | null {
  return updateUserMetadata(userId, {
    license_status: 'expired' as LicenseStatus,
    license_expires_at: nowIso(),
  });
}

export function mockGrantBetaLicense(userId: string, daysValid = 90): User | null {
  return updateUserMetadata(userId, buildActiveLicenseMetadata(daysValid));
}

export function mockFindUserByEmail(email: string): User | undefined {
  return usersByEmail.get(email.trim().toLowerCase())?.user;
}

export function mockListUsersForAdmin(): Array<{
  user: ReturnType<typeof mapSupabaseUserToAccount>;
  license: ReturnType<typeof getLicenseFromUserAccount>;
}> {
  return Array.from(usersById.values()).map(({ user }) => {
    const account = mapSupabaseUserToAccount(user);
    return { user: account, license: getLicenseFromUserAccount(account) };
  });
}

function createMockAuth() {
  return {
    signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
      const record = usersByEmail.get(email.trim().toLowerCase());
      if (!record || record.password !== password) {
        return { data: { session: null, user: null }, error: { message: 'Invalid login credentials' } };
      }
      currentSession = createSession(record.user);
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
      options?: { data?: OfficePilotUserMetadata };
    }) => {
      const normalizedEmail = email.trim().toLowerCase();
      if (usersByEmail.has(normalizedEmail)) {
        return { data: { session: null, user: null }, error: { message: 'User already registered' } };
      }
      const user = upsertMockUser(normalizedEmail, password, options?.data ?? {});
      if (signUpMode === 'email_confirmation') {
        notifyAuthChange('SIGNED_UP');
        return { data: { session: null, user }, error: null };
      }
      currentSession = createSession(user);
      notifyAuthChange('SIGNED_UP');
      return { data: { session: currentSession, user }, error: null };
    },
    signOut: async () => {
      currentSession = null;
      notifyAuthChange('SIGNED_OUT');
      return { error: null };
    },
    getSession: async () => ({ data: { session: currentSession }, error: null }),
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
  } as unknown as SupabaseClient;
}

export function getMockCurrentSession(): Session | null {
  return currentSession;
}

export function getMockCurrentUserAccount() {
  if (!currentSession) return null;
  return mapSupabaseUserToAccount(currentSession.user);
}

export function getMockCurrentAuthSession() {
  if (!currentSession) return null;
  return mapSupabaseSession(currentSession);
}

export function mockUpdateUserRole(userId: string, role: UserRole): User | null {
  return updateUserMetadata(userId, { role });
}

export function mockUpdateUserStatus(userId: string, status: UserStatus): User | null {
  return updateUserMetadata(userId, { status });
}

export function mockUpdateLicensePlan(userId: string, plan: LicensePlan): User | null {
  return updateUserMetadata(userId, { license_plan: plan });
}
