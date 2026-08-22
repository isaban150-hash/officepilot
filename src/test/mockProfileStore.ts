import type { ProfileRow } from '../types/profile';
import { buildRegistrationMetadata, createPendingProfileFromRegistration } from '../services/auth/profileMapper';

const profilesById = new Map<string, ProfileRow>();
let currentUserId: string | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function cloneProfile(profile: ProfileRow): ProfileRow {
  return { ...profile };
}

function requireAdmin(): ProfileRow {
  if (!currentUserId) {
    throw new Error('Nicht angemeldet');
  }
  const caller = profilesById.get(currentUserId);
  if (!caller || caller.role !== 'admin') {
    throw new Error('Keine Admin-Berechtigung');
  }
  return caller;
}

function updateProfile(userId: string, patch: Partial<ProfileRow>): ProfileRow {
  const existing = profilesById.get(userId);
  if (!existing) {
    throw new Error('Benutzer nicht gefunden');
  }
  const updated: ProfileRow = {
    ...existing,
    ...patch,
    updated_at: nowIso(),
  };
  profilesById.set(userId, updated);
  return cloneProfile(updated);
}

export function resetMockProfileStore(): void {
  profilesById.clear();
  currentUserId = null;
}

export function setMockProfileCurrentUser(userId: string | null): void {
  currentUserId = userId;
}

export function getMockProfile(userId: string): ProfileRow | undefined {
  const profile = profilesById.get(userId);
  return profile ? cloneProfile(profile) : undefined;
}

export function getAllMockProfiles(): ProfileRow[] {
  return Array.from(profilesById.values()).map(cloneProfile);
}

export function createMockProfileFromRegistration(
  userId: string,
  email: string,
  metadata: ReturnType<typeof buildRegistrationMetadata>,
): ProfileRow {
  const profile = createPendingProfileFromRegistration(userId, email, metadata);
  profilesById.set(userId, profile);
  return cloneProfile(profile);
}

export function seedMockAdminProfile(
  userId: string,
  email: string,
  metadata: ReturnType<typeof buildRegistrationMetadata>,
): ProfileRow {
  const expires = new Date();
  expires.setDate(expires.getDate() + 365);
  const profile: ProfileRow = {
    ...createPendingProfileFromRegistration(userId, email, metadata),
    status: 'approved',
    role: 'admin',
    license_status: 'active',
    license_expires_at: expires.toISOString(),
  };
  profilesById.set(userId, profile);
  return cloneProfile(profile);
}

export function mockProfileSelectOwn(userId: string): ProfileRow | null {
  if (currentUserId !== userId) {
    return null;
  }
  const profile = profilesById.get(userId);
  return profile ? cloneProfile(profile) : null;
}

/**
 * Zusätzliche RPC-Antworten für Tests, die nicht das Profil betreffen
 * (z. B. Workspace-Provisionierung). Kein Netzwerk, nur lokale Stubs.
 */
const extraRpcHandlers = new Map<string, (args: Record<string, unknown>) => unknown>();

export function registerMockRpcHandler(
  name: string,
  handler: (args: Record<string, unknown>) => unknown,
): void {
  extraRpcHandlers.set(name, handler);
}

export function clearMockRpcHandlers(): void {
  extraRpcHandlers.clear();
}

export function mockRpc(name: string, args: Record<string, unknown>): unknown {
  const extra = extraRpcHandlers.get(name);
  if (extra) return extra(args);

  switch (name) {
    case 'update_own_profile': {
      if (!currentUserId) throw new Error('Nicht angemeldet');
      return updateProfile(currentUserId, {
        company_name: String(args.p_company_name ?? ''),
        first_name: String(args.p_first_name ?? ''),
        last_name: String(args.p_last_name ?? ''),
        phone: (args.p_phone as string | null) ?? null,
        industry: (args.p_industry as string | null) ?? null,
      });
    }
    case 'admin_list_profiles': {
      requireAdmin();
      return getAllMockProfiles().sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    }
    case 'admin_approve_user':
      requireAdmin();
      return updateProfile(String(args.p_user_id), { status: 'approved' });
    case 'admin_block_user':
      requireAdmin();
      return updateProfile(String(args.p_user_id), { status: 'blocked' });
    case 'admin_activate_license': {
      requireAdmin();
      return updateProfile(String(args.p_user_id), {
        license_status: 'active',
        license_expires_at: (args.p_expires_at as string | null) ?? null,
      });
    }
    case 'admin_deactivate_license':
      requireAdmin();
      return updateProfile(String(args.p_user_id), { license_status: 'inactive' });
    case 'admin_set_license_expiry':
      requireAdmin();
      return updateProfile(String(args.p_user_id), {
        license_expires_at: args.p_expires_at as string,
      });
    case 'admin_clear_license_expiry':
      requireAdmin();
      return updateProfile(String(args.p_user_id), { license_expires_at: null });
    case 'admin_expire_license':
      requireAdmin();
      return updateProfile(String(args.p_user_id), {
        license_status: 'expired',
        license_expires_at: nowIso(),
      });
    default:
      throw new Error(`Unbekannte RPC-Funktion: ${name}`);
  }
}

export function mockApproveProfile(userId: string, daysValid = 90): ProfileRow | null {
  if (!profilesById.has(userId)) return null;
  const expires = new Date();
  expires.setDate(expires.getDate() + daysValid);
  return updateProfile(userId, {
    status: 'approved',
    license_status: 'active',
    license_expires_at: expires.toISOString(),
  });
}

export function mockBlockProfile(userId: string): ProfileRow | null {
  if (!profilesById.has(userId)) return null;
  return updateProfile(userId, { status: 'blocked' });
}

export function mockExpireProfileLicense(userId: string): ProfileRow | null {
  if (!profilesById.has(userId)) return null;
  return updateProfile(userId, {
    license_status: 'expired',
    license_expires_at: nowIso(),
  });
}

export function mockGrantBetaProfileLicense(userId: string, daysValid = 90): ProfileRow | null {
  if (!profilesById.has(userId)) return null;
  const expires = new Date();
  expires.setDate(expires.getDate() + daysValid);
  return updateProfile(userId, {
    license_status: 'active',
    license_expires_at: expires.toISOString(),
  });
}

export function mockExtendProfileLicense(userId: string, days: number): ProfileRow | null {
  if (!profilesById.has(userId)) return null;
  const existing = profilesById.get(userId)!;
  const base =
    existing.license_expires_at && new Date(existing.license_expires_at) > new Date()
      ? new Date(existing.license_expires_at)
      : new Date();
  base.setDate(base.getDate() + days);
  return updateProfile(userId, {
    license_status: 'active',
    license_expires_at: base.toISOString(),
  });
}

export function mockUpdateProfileRole(userId: string, role: ProfileRow['role']): ProfileRow | null {
  if (!profilesById.has(userId)) return null;
  return updateProfile(userId, { role });
}

export function mockUpdateProfileStatus(userId: string, status: ProfileRow['status']): ProfileRow | null {
  if (!profilesById.has(userId)) return null;
  return updateProfile(userId, { status });
}
