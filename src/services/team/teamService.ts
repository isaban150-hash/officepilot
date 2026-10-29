/**
 * EINRICHTUNG-01 (AP4; Verträge 1.4 bis 1.6a) — Team, Einladungen und Inhaberübergabe im Client.
 *
 * Dünne Hüllen um die Team-RPCs. Der Server entscheidet jede Aktion selbst (Rollenmatrix, Betriebslizenz, Sperren);
 * die Oberfläche bietet nur an, was die Rolle erlaubt. Jede mutierende Aktion trägt eine Anfrage-ID: Eine Wiederholung
 * nach verlorener Antwort wirkt nicht doppelt. Fehler kommen als übersetzbarer Schlüssel zurück, nie als Servertext
 * (P-08.1); Tokens erscheinen in keinem Protokoll (M-17.4).
 */
import { getSupabaseClient, getSupabaseUrl } from '../../lib/supabase';
import { generateUuid } from '../sync/syncMetaService';
import { reportSessionInvalid } from '../auth/sessionInvalidationService';
import { unknownFailure, type TranslationKey } from '../../i18n';

export type TeamRole = 'owner' | 'admin' | 'member';
export type InvitableRole = 'admin' | 'member';

export interface TeamMember {
  userId: string;
  name: string | null;
  role: TeamRole;
  memberSince: string | null;
  isSelf: boolean;
  /** Nur für Inhaber und Admins (M-08.2). */
  email?: string | null;
  /** Nur für den Inhaber: zulässiges Übergabeziel (aktive Mitgliedschaft, Freigabe, wirksame eigene Lizenz). */
  transferEligible?: boolean;
}

export interface TeamInvitation {
  invitationId: string;
  email: string;
  role: InvitableRole;
  status: 'open' | 'expired';
  createdAt: string;
  expiresAt: string;
  invitedByName: string | null;
  resendCount: number;
  resendAvailableAt: string | null;
  canManage: boolean;
}

export interface TeamEvent {
  id: string;
  action: string;
  actorName: string | null;
  targetName: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface OpenTransfer {
  transferId: string;
  kind: 'owner' | 'platform_repair';
  toUserId: string;
  toName: string | null;
  expiresAt: string;
  expired: boolean;
}

export interface MyInvitation {
  invitationId: string;
  workspaceId: string;
  workspaceName: string;
  role: InvitableRole;
  inviterName: string | null;
  expiresAt: string;
}

export interface MyTransfer {
  transferId: string;
  workspaceId: string;
  workspaceName: string;
  kind: 'owner' | 'platform_repair';
  fromName: string | null;
  expiresAt: string;
}

export interface InvitationPreview {
  invitationId: string;
  workspaceName: string;
  role: InvitableRole;
  inviterName: string | null;
  expiresAt: string;
}

export interface CreatedInvitation {
  invitationId: string;
  status: 'created' | 'already_invited' | 'resent';
  role: InvitableRole;
  email: string;
  expiresAt: string;
  /** Nur direkt nach dem Anlegen bzw. Neusenden; gespeichert ist nur der Hash. */
  token: string | null;
}

/** `ref` nur bei unbekanntem Code oder Ausnahme (EINRICHTUNG-01, AP9; 1.30, Q-01.2) — Anzeige über `failureText`. */
export type TeamResult<T> = { ok: true; value: T } | { ok: false; code: string; errorKey: TranslationKey; ref?: string };

/** Strukturierte Codes des Servers, die die Oberfläche übersetzt (Vertrag 1.4, Fehlervertrag Team; 1.5 Meldungen). */
const KNOWN_CODES = new Set([
  'team_forbidden_role',
  'team_owner_protected',
  'team_target_invalid',
  'team_not_member',
  'team_already_member',
  'license_not_effective',
  'account_blocked',
  'account_not_approved',
  'profile_missing',
  'invitation_rate_limited',
  'invitation_limit_reached',
  'invitation_not_open',
  'invitation_resend_limit',
  'invitation_resend_too_soon',
  'invitation_invalid',
  'invitation_expired',
  'invitation_revoked',
  'invitation_declined',
  'invitation_email_unconfirmed',
  'transfer_not_open',
  'transfer_expired',
  'request_id_reused',
  'already_member',
]);

function codeFromMessage(message: string | undefined | null): string | null {
  const match = /^([a-z_]+):/.exec(message ?? '');
  return match ? match[1] : null;
}

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const message = (error as { message?: string } | null)?.message ?? '';
  return /Failed to fetch|NetworkError|network/i.test(message);
}

export function teamErrorKey(code: string): TranslationKey {
  return (KNOWN_CODES.has(code) ? `team.error.${code}` : 'team.error.unknown') as TranslationKey;
}

function failure<T>(code: string, raw?: unknown): TeamResult<T> {
  // EINRICHTUNG-01 (AP9; 1.30, Q-01.2) — ein unbekannter Code bekommt die Kurzreferenz; der Rohtext bleibt verborgen.
  if (KNOWN_CODES.has(code)) return { ok: false, code, errorKey: teamErrorKey(code) };
  return { ok: false, code, ...unknownFailure('team.error.unknown', raw ?? code) };
}

function classify<T>(error: unknown): TeamResult<T> {
  const message = (error as { message?: string } | null)?.message ?? '';
  if (/session_not_active/.test(message)) {
    reportSessionInvalid('session_not_active');
    return { ok: false, code: 'session_not_active', errorKey: 'team.error.session' };
  }
  if (isNetworkFailure(error)) return { ok: false, code: 'network', errorKey: 'team.error.network' };
  if (/Kein Zugriff auf Workspace/.test(message)) return failure('team_not_member');
  const code = codeFromMessage(message);
  return failure(code ?? 'unknown', message || error);
}

async function rpc<T>(name: string, args: Record<string, unknown>, map: (data: unknown) => T): Promise<TeamResult<T>> {
  const client = getSupabaseClient();
  if (!client) return failure('not_configured');
  try {
    const { data, error } = await client.rpc(name, args);
    if (error) return classify(error);
    return { ok: true, value: map(data) };
  } catch (thrown) {
    return classify(thrown);
  }
}

/** Weg C antwortet mit {ok:false, code}, damit Fehlversuche gezählt werden; Sperre und Sitzung kommen als Fehler. */
async function invitationRpc<T>(name: string, args: Record<string, unknown>, map: (data: Record<string, unknown>) => T): Promise<TeamResult<T>> {
  const result = await rpc(name, args, (data) => (data ?? {}) as Record<string, unknown>);
  if (!result.ok) return result;
  if (result.value.ok === false) return failure(String(result.value.code ?? 'unknown'));
  return { ok: true, value: map(result.value) };
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const asArray = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []);
const isRole = (value: unknown): value is TeamRole => value === 'owner' || value === 'admin' || value === 'member';
const isInvitable = (value: unknown): value is InvitableRole => value === 'admin' || value === 'member';

function mapCreated(data: unknown): CreatedInvitation {
  const row = (data ?? {}) as Record<string, unknown>;
  const status = row.status === 'already_invited' || row.status === 'resent' ? row.status : 'created';
  return {
    invitationId: text(row.invitation_id),
    status,
    role: isInvitable(row.role) ? row.role : 'member',
    email: text(row.email),
    expiresAt: text(row.expires_at),
    token: textOrNull(row.token),
  };
}

export function newRequestId(): string {
  return generateUuid();
}

/* ---- Mitglieder ---------------------------------------------------------- */

export function listTeamMembers(workspaceId: string): Promise<TeamResult<TeamMember[]>> {
  return rpc('team_list_members', { p_workspace_id: workspaceId }, (data) =>
    asArray(data)
      .filter((row) => typeof row.user_id === 'string' && isRole(row.role))
      .map((row) => ({
        userId: row.user_id as string,
        name: textOrNull(row.name),
        role: row.role as TeamRole,
        memberSince: textOrNull(row.member_since),
        isSelf: row.is_self === true,
        ...(Object.prototype.hasOwnProperty.call(row, 'email') ? { email: textOrNull(row.email) } : {}),
        ...(typeof row.transfer_eligible === 'boolean' ? { transferEligible: row.transfer_eligible } : {}),
      })),
  );
}

export function changeMemberRole(workspaceId: string, userId: string, role: InvitableRole, requestId = newRequestId()) {
  return rpc('team_change_role', { p_workspace_id: workspaceId, p_target_user_id: userId, p_new_role: role, p_request_id: requestId }, () => true);
}

export function removeMember(workspaceId: string, userId: string, requestId = newRequestId()) {
  return rpc('team_remove_member', { p_workspace_id: workspaceId, p_target_user_id: userId, p_request_id: requestId }, () => true);
}

export function leaveWorkspace(workspaceId: string, requestId = newRequestId()) {
  return rpc('team_leave', { p_workspace_id: workspaceId, p_request_id: requestId }, () => true);
}

export function renameWorkspace(workspaceId: string, name: string, requestId = newRequestId()) {
  return rpc('team_rename_workspace', { p_workspace_id: workspaceId, p_name: name, p_request_id: requestId }, (data) =>
    text((data as Record<string, unknown> | null)?.name),
  );
}

export function listTeamEvents(workspaceId: string, limit = 100): Promise<TeamResult<TeamEvent[]>> {
  return rpc('team_list_events', { p_workspace_id: workspaceId, p_limit: limit }, (data) =>
    asArray(data).map((row) => ({
      id: text(row.id),
      action: text(row.action),
      actorName: textOrNull(row.actor_name),
      targetName: textOrNull(row.target_name),
      details: (row.details && typeof row.details === 'object' ? row.details : {}) as Record<string, unknown>,
      createdAt: text(row.created_at),
    })),
  );
}

export function selectActiveWorkspace(workspaceId: string) {
  return rpc('select_active_workspace', { p_workspace_id: workspaceId }, () => true);
}

/* ---- Einladungen (Inhaber, Admins) --------------------------------------- */

export function listTeamInvitations(workspaceId: string): Promise<TeamResult<TeamInvitation[]>> {
  return rpc('team_list_invitations', { p_workspace_id: workspaceId }, (data) =>
    asArray(data)
      .filter((row) => typeof row.invitation_id === 'string' && isInvitable(row.role))
      .map((row) => ({
        invitationId: row.invitation_id as string,
        email: text(row.email),
        role: row.role as InvitableRole,
        status: row.status === 'expired' ? 'expired' : 'open',
        createdAt: text(row.created_at),
        expiresAt: text(row.expires_at),
        invitedByName: textOrNull(row.invited_by_name),
        resendCount: typeof row.resend_count === 'number' ? row.resend_count : 0,
        resendAvailableAt: textOrNull(row.resend_available_at),
        canManage: row.can_manage === true,
      })),
  );
}

export function inviteMember(workspaceId: string, email: string, role: InvitableRole, requestId = newRequestId()) {
  return rpc('team_invite', { p_workspace_id: workspaceId, p_email: email, p_role: role, p_request_id: requestId }, mapCreated);
}

export function resendInvitation(invitationId: string, requestId = newRequestId()) {
  return rpc('team_resend_invitation', { p_invitation_id: invitationId, p_request_id: requestId }, mapCreated);
}

export function revokeInvitation(invitationId: string, requestId = newRequestId()) {
  return rpc('team_revoke_invitation', { p_invitation_id: invitationId, p_request_id: requestId }, () => true);
}

/** Der Link zum Kopieren (immer) und für die Mail; die E-Mail füllt nur das Anmeldeformular vor. */
export function buildInvitationLink(token: string, email: string, origin = typeof window === 'undefined' ? '' : window.location.origin): string {
  return `${origin}/einladung/${encodeURIComponent(token)}?email=${encodeURIComponent(email)}`;
}

export type InvitationMailOutcome = 'sent' | 'not_sent';

/**
 * M-17 — die Einladungsmail über die Edge Function `send-team-invitation` (lokal Anbieter `stub`). Scheitert der
 * Versand, meldet die Oberfläche „nicht gesendet“ und bietet den Link zum Kopieren an; nie „gesendet“ ohne Zusage.
 */
export async function sendInvitationMail(input: { invitationId: string; token: string; language: string }): Promise<InvitationMailOutcome> {
  const client = getSupabaseClient();
  const baseUrl = getSupabaseUrl();
  if (!client || !baseUrl) return 'not_sent';
  try {
    const { data } = await client.auth.getSession();
    const accessToken = data?.session?.access_token;
    if (!accessToken) return 'not_sent';
    const response = await fetch(`${baseUrl}/functions/v1/send-team-invitation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invitationId: input.invitationId,
        token: input.token,
        language: input.language,
        linkBase: typeof window === 'undefined' ? '' : window.location.origin,
      }),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; sent?: boolean } | null;
    return response.ok && body?.ok === true && body.sent === true ? 'sent' : 'not_sent';
  } catch {
    return 'not_sent';
  }
}

/* ---- Einladungsweg C (eingeladene Person) -------------------------------- */

export function listMyInvitations(): Promise<TeamResult<MyInvitation[]>> {
  return rpc('list_my_invitations', {}, (data) =>
    asArray(data)
      .filter((row) => typeof row.invitation_id === 'string' && isInvitable(row.role))
      .map((row) => ({
        invitationId: row.invitation_id as string,
        workspaceId: text(row.workspace_id),
        workspaceName: text(row.workspace_name),
        role: row.role as InvitableRole,
        inviterName: textOrNull(row.inviter_name),
        expiresAt: text(row.expires_at),
      })),
  );
}

export function previewInvitation(token: string): Promise<TeamResult<InvitationPreview>> {
  return invitationRpc('invitation_preview', { p_token: token }, (row) => ({
    invitationId: text(row.invitation_id),
    workspaceName: text(row.workspace_name),
    role: isInvitable(row.role) ? row.role : 'member',
    inviterName: textOrNull(row.inviter_name),
    expiresAt: text(row.expires_at),
  }));
}

export interface AcceptedInvitation {
  workspaceId: string;
  role: InvitableRole;
  status: 'accepted' | 'already_member';
}

export function acceptInvitation(input: { invitationId?: string; token?: string }, requestId = newRequestId()) {
  return invitationRpc(
    'accept_invitation',
    { p_invitation_id: input.token ? null : (input.invitationId ?? null), p_token: input.token ?? null, p_request_id: requestId },
    (row): AcceptedInvitation => ({
      workspaceId: text(row.workspace_id),
      role: isInvitable(row.role) ? row.role : 'member',
      status: row.status === 'already_member' ? 'already_member' : 'accepted',
    }),
  );
}

export function declineInvitation(input: { invitationId?: string; token?: string }, requestId = newRequestId()) {
  return invitationRpc(
    'decline_invitation',
    { p_invitation_id: input.token ? null : (input.invitationId ?? null), p_token: input.token ?? null, p_request_id: requestId },
    () => true,
  );
}

/* ---- Inhaberübergabe ----------------------------------------------------- */

export function getOpenTransfer(workspaceId: string): Promise<TeamResult<OpenTransfer | null>> {
  return rpc('team_open_transfer', { p_workspace_id: workspaceId }, (data) => {
    const row = data as Record<string, unknown> | null;
    if (!row || typeof row.transfer_id !== 'string') return null;
    return {
      transferId: row.transfer_id,
      kind: row.kind === 'platform_repair' ? 'platform_repair' : 'owner',
      toUserId: text(row.to_user_id),
      toName: textOrNull(row.to_name),
      expiresAt: text(row.expires_at),
      expired: row.expired === true,
    };
  });
}

export function requestOwnershipTransfer(workspaceId: string, userId: string, requestId = newRequestId()) {
  return rpc('team_request_transfer', { p_workspace_id: workspaceId, p_target_user_id: userId, p_request_id: requestId }, (data) =>
    text((data as Record<string, unknown> | null)?.transfer_id),
  );
}

/** `changed: false` heißt: schon entschieden (z. B. kam die Annahme dem Widerruf zuvor); `status` nennt den Stand. */
export interface TransferRevokeOutcome {
  status: string;
  changed: boolean;
}

export function revokeOwnershipTransfer(transferId: string, requestId = newRequestId()) {
  return rpc('team_revoke_transfer', { p_transfer_id: transferId, p_request_id: requestId }, (data): TransferRevokeOutcome => {
    const row = (data ?? {}) as Record<string, unknown>;
    return { status: text(row.status), changed: row.changed === true };
  });
}

export function listMyTransfers(): Promise<TeamResult<MyTransfer[]>> {
  return rpc('list_my_transfers', {}, (data) =>
    asArray(data)
      .filter((row) => typeof row.transfer_id === 'string')
      .map((row) => ({
        transferId: row.transfer_id as string,
        workspaceId: text(row.workspace_id),
        workspaceName: text(row.workspace_name),
        kind: row.kind === 'platform_repair' ? 'platform_repair' : 'owner',
        fromName: textOrNull(row.from_name),
        expiresAt: text(row.expires_at),
      })),
  );
}

export function acceptOwnershipTransfer(transferId: string, requestId = newRequestId()) {
  return rpc('team_accept_transfer', { p_transfer_id: transferId, p_request_id: requestId }, (data) =>
    text((data as Record<string, unknown> | null)?.workspace_id),
  );
}

export function declineOwnershipTransfer(transferId: string, requestId = newRequestId()) {
  return rpc('team_decline_transfer', { p_transfer_id: transferId, p_request_id: requestId }, () => true);
}
