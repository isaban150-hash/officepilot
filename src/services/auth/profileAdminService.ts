import { getSupabaseClient } from '../../lib/supabase';
import type { ProfileRow } from '../../types/profile';
import { mapProfileRowToUserAccount, mapProfileToLicense } from './profileMapper';
import type { License, UserAccount } from '../../types/auth';
import { generateUuid } from '../sync/syncMetaService';
import { unknownFailure, type ShownFailure, type TranslationKey } from '../../i18n';

/*
 * EINRICHTUNG-01 (AP4; EIN-08, EIN-20, EIN-21; Vertrag 1.9, P-01 bis P-09) — Plattform-Verwaltung im Client.
 *
 * Jede Aktion trägt eine Anfrage-ID (Wiederholung ohne zweite Wirkung, P-06.2, P-07.2). Fehler kommen zusätzlich als
 * übersetzbarer Schlüssel (`errorKey`); die Oberfläche zeigt nie den Servertext (P-08.1). `error` bleibt für
 * bestehende Aufrufer und Protokolle ohne Geheimnisse erhalten. EINRICHTUNG-01 (AP9; 1.30, Q-01.2) — eine unbekannte
 * Meldung trägt zusätzlich die Kurzreferenz (`ref`); angezeigt wird dann der allgemeine Text mit Referenz.
 */
export type AdminActionResult =
  | { success: true; profile: ProfileRow; user: UserAccount; license?: License }
  | { success: false; error: string; errorKey: TranslationKey; ref?: string };

export type AdminListResult =
  | { success: true; rows: Array<{ user: UserAccount; license?: License }> }
  | { success: false; error: string; errorKey: TranslationKey; ref?: string };

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase ist nicht konfiguriert.');
  }
  return client;
}

/** P-08.1 — der Servertext wird nie angezeigt; bekannte Codes haben eigene Texte. */
export function adminErrorKey(message: string | undefined | null): TranslationKey {
  const text = message ?? '';
  if (/Keine Admin-Berechtigung/.test(text)) return 'platform.error.forbidden';
  if (/admin_self_action/.test(text)) return 'platform.error.self';
  if (/admin_last_admin/.test(text)) return 'platform.error.lastAdmin';
  if (/admin_expiry_in_past/.test(text)) return 'platform.error.expiryInPast';
  if (/admin_license_conflict/.test(text)) return 'platform.error.conflict';
  if (/admin_license_unlimited/.test(text)) return 'platform.error.unlimited';
  if (/admin_target_blocked/.test(text)) return 'platform.error.targetBlocked';
  if (/repair_not_applicable/.test(text)) return 'platform.error.repairNotApplicable';
  if (/team_target_invalid/.test(text)) return 'platform.error.repairTarget';
  if (/session_not_active/.test(text)) return 'team.error.session';
  if (/Failed to fetch|NetworkError/i.test(text)) return 'team.error.network';
  if (/Benutzer nicht gefunden/.test(text)) return 'platform.error.notFound';
  return 'platform.error.unknown';
}

/** Bekannte Meldung → eigener Text; unbekannte → allgemeiner Text mit Kurzreferenz (nie der Servertext). */
export function adminFailure(message: string | undefined | null): ShownFailure {
  const errorKey = adminErrorKey(message);
  return errorKey === 'platform.error.unknown' ? unknownFailure(errorKey, message ?? 'unknown') : { errorKey };
}

function fail(message: string | undefined | null): { success: false; error: string; errorKey: TranslationKey; ref?: string } {
  return { success: false, error: message ?? 'Aktion fehlgeschlagen.', ...adminFailure(message) };
}

function mapAdminResult(data: ProfileRow | null, error: { message: string } | null): AdminActionResult {
  if (error || !data) {
    return fail(error?.message);
  }
  const user = mapProfileRowToUserAccount(data);
  return { success: true, profile: data, user, license: mapProfileToLicense(data) };
}

async function adminRpc(name: string, args: Record<string, unknown>): Promise<AdminActionResult> {
  try {
    const client = requireClient();
    const { data, error } = await client.rpc(name, args);
    return mapAdminResult(data as ProfileRow | null, error);
  } catch (thrown) {
    return fail(thrown instanceof Error ? thrown.message : null);
  }
}

export async function adminListProfiles(): Promise<AdminListResult> {
  try {
    const client = requireClient();
    const { data, error } = await client.rpc('admin_list_profiles');
    if (error) {
      return fail(error.message);
    }
    const rows = ((data ?? []) as ProfileRow[]).map((profile) => ({
      user: mapProfileRowToUserAccount(profile),
      license: mapProfileToLicense(profile),
    }));
    return { success: true, rows };
  } catch (thrown) {
    return fail(thrown instanceof Error ? thrown.message : null);
  }
}

export async function adminApproveUser(userId: string, requestId = generateUuid()): Promise<AdminActionResult> {
  return adminRpc('admin_approve_user', { p_user_id: userId, p_request_id: requestId });
}

export async function adminBlockUser(userId: string, requestId = generateUuid()): Promise<AdminActionResult> {
  return adminRpc('admin_block_user', { p_user_id: userId, p_request_id: requestId });
}

export async function adminActivateLicense(
  userId: string,
  expiresAt?: string | null,
  requestId = generateUuid(),
): Promise<AdminActionResult> {
  return adminRpc('admin_activate_license', { p_user_id: userId, p_expires_at: expiresAt ?? null, p_request_id: requestId });
}

export async function adminDeactivateLicense(userId: string, requestId = generateUuid()): Promise<AdminActionResult> {
  return adminRpc('admin_deactivate_license', { p_user_id: userId, p_request_id: requestId });
}

export async function adminSetLicenseExpiry(userId: string, expiresAt: string, requestId = generateUuid()): Promise<AdminActionResult> {
  return adminRpc('admin_set_license_expiry', { p_user_id: userId, p_expires_at: expiresAt, p_request_id: requestId });
}

export async function adminClearLicenseExpiry(userId: string, requestId = generateUuid()): Promise<AdminActionResult> {
  return adminRpc('admin_clear_license_expiry', { p_user_id: userId, p_request_id: requestId });
}

export async function adminExpireLicense(userId: string, requestId = generateUuid()): Promise<AdminActionResult> {
  return adminRpc('admin_expire_license', { p_user_id: userId, p_request_id: requestId });
}

/** P-05 — freischalten mit Lizenz bis zu einem Datum in der Zukunft, in einer Transaktion. */
export async function adminApproveWithLicense(userId: string, expiresAt: string, requestId = generateUuid()): Promise<AdminActionResult> {
  return adminRpc('admin_approve_with_license', { p_user_id: userId, p_expires_at: expiresAt, p_request_id: requestId });
}

/**
 * P-06 — verlängern mit dem gesehenen Ablauf: Der Server rechnet `max(jetzt, gesehener Ablauf) + 30 Tage` und meldet
 * einen Konflikt, wenn sich der Ablauf inzwischen geändert hat. Bisher las der Client die Liste, rechnete selbst und
 * schrieb zweimal — zwei Admins gleichzeitig addierten doppelt.
 */
export async function adminExtendLicense(userId: string, seenExpiresAt: string | null, requestId = generateUuid()): Promise<AdminActionResult> {
  return adminRpc('admin_extend_license', { p_user_id: userId, p_seen_expires_at: seenExpiresAt, p_request_id: requestId });
}

export interface PlatformEvent {
  id: string;
  action: string;
  actorName: string | null;
  targetName: string | null;
  createdAt: string;
}

export async function adminListEvents(limit = 200): Promise<{ ok: true; events: PlatformEvent[] } | { ok: false; errorKey: TranslationKey; ref?: string }> {
  try {
    const client = requireClient();
    const { data, error } = await client.rpc('admin_list_events', { p_limit: limit });
    if (error) return { ok: false, ...adminFailure(error.message) };
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    return {
      ok: true,
      events: rows.map((row) => ({
        id: String(row.id ?? ''),
        action: String(row.action ?? ''),
        actorName: typeof row.actor_name === 'string' ? row.actor_name : null,
        targetName: typeof row.target_name === 'string' ? row.target_name : null,
        createdAt: String(row.created_at ?? ''),
      })),
    };
  } catch (thrown) {
    return { ok: false, ...adminFailure(thrown instanceof Error ? thrown.message : null) };
  }
}

export interface OwnershipRepairCase {
  workspaceId: string;
  workspaceName: string;
  ownerName: string | null;
  ownerState: 'blocked' | 'pending' | 'profile_missing' | string;
  candidates: Array<{ userId: string; name: string | null; email: string | null; role: 'admin' | 'member' }>;
  openTransfer: { transferId: string; toUserId: string; expiresAt: string } | null;
}

/** 1.6a (E15) — Betriebe ohne handlungsfähigen Inhaber mit den zulässigen Zielen. */
export async function adminListOwnershipRepairCases(): Promise<{ ok: true; cases: OwnershipRepairCase[] } | { ok: false; errorKey: TranslationKey; ref?: string }> {
  try {
    const client = requireClient();
    const { data, error } = await client.rpc('admin_list_ownership_repair_cases');
    if (error) return { ok: false, ...adminFailure(error.message) };
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    return {
      ok: true,
      cases: rows.map((row) => {
        const open = row.open_transfer as Record<string, unknown> | null;
        return {
          workspaceId: String(row.workspace_id ?? ''),
          workspaceName: String(row.workspace_name ?? ''),
          ownerName: typeof row.owner_name === 'string' ? row.owner_name : null,
          ownerState: String(row.owner_state ?? ''),
          candidates: (Array.isArray(row.candidates) ? (row.candidates as Array<Record<string, unknown>>) : []).map((c) => ({
            userId: String(c.user_id ?? ''),
            name: typeof c.name === 'string' ? c.name : null,
            email: typeof c.email === 'string' ? c.email : null,
            role: c.role === 'admin' ? 'admin' : 'member',
          })),
          openTransfer:
            open && typeof open.transfer_id === 'string'
              ? { transferId: open.transfer_id, toUserId: String(open.to_user_id ?? ''), expiresAt: String(open.expires_at ?? '') }
              : null,
        };
      }),
    };
  } catch (thrown) {
    return { ok: false, ...adminFailure(thrown instanceof Error ? thrown.message : null) };
  }
}

export async function adminRequestOwnershipRepair(
  workspaceId: string,
  targetUserId: string,
  requestId = generateUuid(),
): Promise<{ ok: true } | { ok: false; errorKey: TranslationKey; ref?: string }> {
  try {
    const client = requireClient();
    const { error } = await client.rpc('platform_request_ownership_repair', {
      p_workspace_id: workspaceId,
      p_target_user_id: targetUserId,
      p_request_id: requestId,
    });
    return error ? { ok: false, ...adminFailure(error.message) } : { ok: true };
  } catch (thrown) {
    return { ok: false, ...adminFailure(thrown instanceof Error ? thrown.message : null) };
  }
}

export async function adminRevokeOwnershipRepair(transferId: string, requestId = generateUuid()): Promise<{ ok: true } | { ok: false; errorKey: TranslationKey; ref?: string }> {
  try {
    const client = requireClient();
    const { error } = await client.rpc('platform_revoke_ownership_repair', { p_transfer_id: transferId, p_request_id: requestId });
    return error ? { ok: false, ...adminFailure(error.message) } : { ok: true };
  } catch (thrown) {
    return { ok: false, ...adminFailure(thrown instanceof Error ? thrown.message : null) };
  }
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

/** Bestehende Schnittstelle (Kontext): verlängert um 30 Tage mit dem zuletzt gesehenen Ablauf. */
export async function extendLicense(userId: string, _days = 30): Promise<UserAccount | null> {
  const list = await adminListProfiles();
  if (!list.success) return null;
  const current = list.rows.find((row) => row.user.id === userId);
  if (!current) return null;
  const result = await adminExtendLicense(userId, current.user.licenseExpiresAt ?? null);
  return result.success ? result.user : null;
}

export async function expireLicense(userId: string): Promise<UserAccount | null> {
  const result = await adminExpireLicense(userId);
  return result.success ? result.user : null;
}
