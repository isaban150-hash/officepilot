import { describe, expect, it } from 'vitest';
import {
  approveUser,
  login,
  loginAsDefaultAdmin,
  registerAndApproveUser,
  registerPendingTestUser,
  seedDefaultAdminUser,
} from './test/authFixtures';
import {
  adminApproveUser,
  adminBlockUser,
  adminListProfiles,
  adminActivateLicense,
  adminDeactivateLicense,
  adminSetLicenseExpiry,
  adminClearLicenseExpiry,
  adminExpireLicense,
} from './services/auth/profileAdminService';
import { fetchCurrentUserProfile } from './services/auth/profileService';
import { getLicenseBlockReason, isUserAllowedToUseApp } from './services/auth/licenseService';
import {
  getMockProfile,
  mockManipulateUserMetadata,
  setMockProfileCurrentUser,
} from './test/mockSupabaseAuth';
import { mapProfileRowToUserAccount } from './services/auth/profileMapper';
import { signInWithPassword } from './services/auth/authService';

describe('SUPABASE-AUTH-03 profiles', () => {
  it('neues Profil erhält pending/user/inactive', async () => {
    const user = await registerPendingTestUser('new-profile@example.com');
    const profile = getMockProfile(user.id);
    expect(profile?.status).toBe('pending');
    expect(profile?.role).toBe('user');
    expect(profile?.license_status).toBe('inactive');
  });

  it('manipuliertes user_metadata gewährt keinen Adminzugriff', async () => {
    const user = await registerAndApproveUser('metadata-hack@example.com');
    await login('metadata-hack@example.com', 'TestPasswort1');
    mockManipulateUserMetadata(user.id, { role: 'admin' });
    const profile = getMockProfile(user.id);
    expect(profile?.role).toBe('user');
    expect(mapProfileRowToUserAccount(profile!).role).toBe('user');
  });

  it('manipuliertes user_metadata gewährt keinen freigeschalteten Zugriff', async () => {
    const user = await registerPendingTestUser('metadata-status@example.com');
    await login('metadata-status@example.com', 'TestPasswort1');
    mockManipulateUserMetadata(user.id, { status: 'approved' });
    const profile = getMockProfile(user.id);
    expect(profile?.status).toBe('pending');
    expect(getLicenseBlockReason(mapProfileRowToUserAccount(profile!))).toBe('pending');
  });

  it('fehlendes Profil führt nicht zu Zugriff', async () => {
    await seedDefaultAdminUser();
    const result = await signInWithPassword('admin@officepilot.local', 'OfficePilot-Admin-2026');
    expect(result.success).toBe(true);
    setMockProfileCurrentUser('missing-profile-id');
    const loaded = await fetchCurrentUserProfile('missing-profile-id');
    expect(loaded.success).toBe(false);
  });

  it('pending führt zu Waiting Approval', async () => {
    const user = await registerPendingTestUser('pending-guard@example.com');
    expect(getLicenseBlockReason(user)).toBe('pending');
  });

  it('blocked führt zur Blocked-Seite', async () => {
    const user = await registerAndApproveUser('blocked-guard@example.com');
    await loginAsDefaultAdmin();
    await adminBlockUser(user.id);
    const profile = getMockProfile(user.id);
    expect(getLicenseBlockReason(mapProfileRowToUserAccount(profile!))).toBe('blocked');
  });

  it('inactive/expired führt zur Lizenzseite', async () => {
    const user = await registerAndApproveUser('license-guard@example.com');
    await loginAsDefaultAdmin();
    await adminDeactivateLicense(user.id);
    let profile = getMockProfile(user.id)!;
    expect(getLicenseBlockReason(mapProfileRowToUserAccount(profile))).toBe('no_license');

    await adminExpireLicense(user.id);
    profile = getMockProfile(user.id)!;
    expect(getLicenseBlockReason(mapProfileRowToUserAccount(profile))).toBe('license_expired');
  });

  it('Nicht-Admin kann keine Admin-RPC aufrufen', async () => {
    const user = await registerAndApproveUser('non-admin-rpc@example.com');
    await login('non-admin-rpc@example.com', 'TestPasswort1');
    const list = await adminListProfiles();
    expect(list.success).toBe(false);
    expect(list.error).toContain('Admin');
  });

  it('Admin kann Benutzer verwalten', async () => {
    await loginAsDefaultAdmin();
    const pending = await registerPendingTestUser('admin-rpc@example.com');
    await loginAsDefaultAdmin();

    const list = await adminListProfiles();
    expect(list.success).toBe(true);
    expect(list.rows.some((row) => row.user.id === pending.id)).toBe(true);

    expect((await adminApproveUser(pending.id)).success).toBe(true);
    expect((await adminBlockUser(pending.id)).success).toBe(true);
    expect((await adminActivateLicense(pending.id, new Date().toISOString())).success).toBe(true);
    expect((await adminDeactivateLicense(pending.id)).success).toBe(true);

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 7);
    expect((await adminSetLicenseExpiry(pending.id, expiry.toISOString())).success).toBe(true);
    expect((await adminClearLicenseExpiry(pending.id)).success).toBe(true);
    expect((await adminExpireLicense(pending.id)).success).toBe(true);
  });

  it('Freischaltung über Fixture aktiviert approved + Lizenz', async () => {
    const user = await registerPendingTestUser('fixture-approve@example.com');
    const approved = await approveUser(user.id);
    expect(approved?.status).toBe('approved');
    expect(isUserAllowedToUseApp(approved!)).toBe(true);
  });
});
