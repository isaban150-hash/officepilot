import { getSupabaseClient } from '../../lib/supabase';
import type { ProfileRow } from '../../types/profile';
import { mapProfileRowToUserAccount, mapProfileToLicense } from './profileMapper';
import type { License, UserAccount } from '../../types/auth';

export type AdminActionResult =
  | { success: true; profile: ProfileRow; user: UserAccount; license?: License }
  | { success: false; error: string };

export type AdminListResult =
  | { success: true; rows: Array<{ user: UserAccount; license?: License }> }
  | { success: false; error: string };

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase ist nicht konfiguriert.');
  }
  return client;
}

function mapAdminResult(data: ProfileRow | null, error: { message: string } | null): AdminActionResult {
  if (error || !data) {
    return { success: false, error: error?.message ?? 'Aktion fehlgeschlagen.' };
  }
  const user = mapProfileRowToUserAccount(data);
  return { success: true, profile: data, user, license: mapProfileToLicense(data) };
}

export async function adminListProfiles(): Promise<AdminListResult> {
  const client = requireClient();
  const { data, error } = await client.rpc('admin_list_profiles');

  if (error) {
    return { success: false, error: error.message };
  }

  const rows = ((data ?? []) as ProfileRow[]).map((profile) => ({
    user: mapProfileRowToUserAccount(profile),
    license: mapProfileToLicense(profile),
  }));

  return { success: true, rows };
}

export async function adminApproveUser(userId: string): Promise<AdminActionResult> {
  const client = requireClient();
  const { data, error } = await client.rpc('admin_approve_user', { p_user_id: userId });
  return mapAdminResult(data as ProfileRow | null, error);
}

export async function adminBlockUser(userId: string): Promise<AdminActionResult> {
  const client = requireClient();
  const { data, error } = await client.rpc('admin_block_user', { p_user_id: userId });
  return mapAdminResult(data as ProfileRow | null, error);
}

export async function adminActivateLicense(
  userId: string,
  expiresAt?: string | null,
): Promise<AdminActionResult> {
  const client = requireClient();
  const { data, error } = await client.rpc('admin_activate_license', {
    p_user_id: userId,
    p_expires_at: expiresAt ?? null,
  });
  return mapAdminResult(data as ProfileRow | null, error);
}

export async function adminDeactivateLicense(userId: string): Promise<AdminActionResult> {
  const client = requireClient();
  const { data, error } = await client.rpc('admin_deactivate_license', { p_user_id: userId });
  return mapAdminResult(data as ProfileRow | null, error);
}

export async function adminSetLicenseExpiry(userId: string, expiresAt: string): Promise<AdminActionResult> {
  const client = requireClient();
  const { data, error } = await client.rpc('admin_set_license_expiry', {
    p_user_id: userId,
    p_expires_at: expiresAt,
  });
  return mapAdminResult(data as ProfileRow | null, error);
}

export async function adminClearLicenseExpiry(userId: string): Promise<AdminActionResult> {
  const client = requireClient();
  const { data, error } = await client.rpc('admin_clear_license_expiry', { p_user_id: userId });
  return mapAdminResult(data as ProfileRow | null, error);
}

export async function adminExpireLicense(userId: string): Promise<AdminActionResult> {
  const client = requireClient();
  const { data, error } = await client.rpc('admin_expire_license', { p_user_id: userId });
  return mapAdminResult(data as ProfileRow | null, error);
}

export async function adminExtendLicense(userId: string, days: number): Promise<AdminActionResult> {
  const list = await adminListProfiles();
  if (!list.success) {
    return { success: false, error: list.error };
  }
  const current = list.rows.find((row) => row.user.id === userId);
  if (!current) {
    return { success: false, error: 'Benutzer nicht gefunden.' };
  }

  const base =
    current.user.licenseExpiresAt && new Date(current.user.licenseExpiresAt) > new Date()
      ? new Date(current.user.licenseExpiresAt)
      : new Date();
  base.setDate(base.getDate() + days);

  const activate = await adminActivateLicense(userId, base.toISOString());
  if (!activate.success) return activate;
  return adminSetLicenseExpiry(userId, base.toISOString());
}

export async function listUsersForAdmin(): Promise<Array<{ user: UserAccount; license?: License }>> {
  const result = await adminListProfiles();
  if (!result.success) return [];
  return result.rows;
}

export async function approveUser(userId: string): Promise<UserAccount | null> {
  const result = await adminApproveUser(userId);
  return result.success ? result.user : null;
}

export async function blockUser(userId: string): Promise<UserAccount | null> {
  const result = await adminBlockUser(userId);
  return result.success ? result.user : null;
}

export async function grantBetaLicense(userId: string, daysValid = 90): Promise<UserAccount | null> {
  const expires = new Date();
  expires.setDate(expires.getDate() + daysValid);
  const result = await adminActivateLicense(userId, expires.toISOString());
  return result.success ? result.user : null;
}

export async function extendLicense(userId: string, days: number): Promise<UserAccount | null> {
  const result = await adminExtendLicense(userId, days);
  return result.success ? result.user : null;
}

export async function expireLicense(userId: string): Promise<UserAccount | null> {
  const result = await adminExpireLicense(userId);
  return result.success ? result.user : null;
}
