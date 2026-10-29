import { getSupabaseClient } from '../../lib/supabase';
import { errorReference } from '../../i18n';
import { newRequestId, requestDestructiveConfirmation } from '../account/destructiveActionService';
import { requestWorkspaceAccessRefresh } from './workspaceAccessService';

/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.26, E11 b, E19, K1, K3) — Antrag und Widerruf der Betriebslöschung aus Sicht der App.
 *
 * Antrag: Nachweis über das Passwort (1.25a) für genau diesen Betrieb und diese Anfrage-ID → `workspace_request_deletion`
 * mit genauem Firmennamen und der bestätigten Fassung des Aufbewahrungs- und Exporthinweises. Der Server prüft Inhaber,
 * Namen, Fassung und Nachweis; Frist 30 Tage. Widerruf: nur der Inhaber, nur im Zustand „beantragt“.
 */
export const WORKSPACE_DELETION_NOTICE_VERSION = '2026-10-25';

export type WorkspaceDeletionRequestResult =
  | { ok: true; executeAfter: string | null }
  | {
      ok: false;
      reason:
        | 'password_invalid'
        | 'rate_limited'
        | 'name_mismatch'
        | 'notice_outdated'
        | 'forbidden'
        | 'confirmation_invalid'
        | 'session'
        | 'unavailable';
      /** EINRICHTUNG-01 (AP9; 1.30) — Kurzreferenz bei unbekanntem Code oder Ausnahme. */
      ref?: string;
    };

export type WorkspaceDeletionRevokeResult =
  | { ok: true }
  | { ok: false; reason: 'in_progress' | 'not_requested' | 'forbidden' | 'session' | 'unavailable'; ref?: string };

function codeOf(message: string | undefined): string {
  const text = message ?? '';
  for (const code of ['confirmation_invalid', 'team_forbidden_role', 'team_not_member', 'deletion_in_progress', 'session_not_active', 'account_blocked']) {
    if (text.includes(code)) return code;
  }
  return 'unavailable';
}

export async function requestWorkspaceDeletion(input: {
  workspaceId: string;
  typedName: string;
  password: string;
  requestId?: string;
}): Promise<WorkspaceDeletionRequestResult> {
  const client = getSupabaseClient();
  if (!client) return { ok: false, reason: 'unavailable' };
  const requestId = input.requestId ?? newRequestId();
  const nachweis = await requestDestructiveConfirmation({
    action: 'workspace_delete_request',
    workspaceId: input.workspaceId,
    requestId,
    password: input.password,
  });
  if (!nachweis.ok) {
    if (nachweis.reason === 'password_invalid') return { ok: false, reason: 'password_invalid' };
    if (nachweis.reason === 'rate_limited') return { ok: false, reason: 'rate_limited' };
    if (nachweis.reason === 'session') return { ok: false, reason: 'session' };
    return { ok: false, reason: 'unavailable', ...(nachweis.ref ? { ref: nachweis.ref } : {}) };
  }
  try {
    const { data, error } = await client.rpc('workspace_request_deletion', {
      p_workspace_id: input.workspaceId,
      p_typed_name: input.typedName,
      p_retention_notice_version: WORKSPACE_DELETION_NOTICE_VERSION,
      p_confirmation_token: nachweis.confirmationToken,
      p_request_id: requestId,
    });
    if (error) {
      const code = codeOf(error.message);
      if (code === 'confirmation_invalid') return { ok: false, reason: 'confirmation_invalid' };
      if (code === 'team_forbidden_role' || code === 'team_not_member' || code === 'account_blocked') return { ok: false, reason: 'forbidden' };
      if (code === 'session_not_active') return { ok: false, reason: 'session' };
      return { ok: false, reason: 'unavailable', ref: errorReference(error.message) };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    if (row.ok === true) {
      requestWorkspaceAccessRefresh({ force: true });
      return { ok: true, executeAfter: typeof row.execute_after === 'string' ? row.execute_after : null };
    }
    if (row.code === 'name_mismatch') return { ok: false, reason: 'name_mismatch' };
    if (row.code === 'notice_outdated') return { ok: false, reason: 'notice_outdated' };
    return { ok: false, reason: 'unavailable', ref: errorReference(row.code ?? 'no_code') };
  } catch (thrown) {
    return { ok: false, reason: 'unavailable', ref: errorReference(thrown) };
  }
}

export async function revokeWorkspaceDeletion(workspaceId: string): Promise<WorkspaceDeletionRevokeResult> {
  const client = getSupabaseClient();
  if (!client) return { ok: false, reason: 'unavailable' };
  try {
    const { data, error } = await client.rpc('workspace_revoke_deletion', { p_workspace_id: workspaceId, p_request_id: newRequestId() });
    if (error) {
      const code = codeOf(error.message);
      if (code === 'deletion_in_progress') return { ok: false, reason: 'in_progress' };
      if (code === 'team_forbidden_role' || code === 'team_not_member') return { ok: false, reason: 'forbidden' };
      if (code === 'session_not_active') return { ok: false, reason: 'session' };
      return { ok: false, reason: 'unavailable', ref: errorReference(error.message) };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    if (row.ok === true) {
      requestWorkspaceAccessRefresh({ force: true });
      return { ok: true };
    }
    if (row.code === 'deletion_not_requested') return { ok: false, reason: 'not_requested' };
    return { ok: false, reason: 'unavailable', ref: errorReference(row.code ?? 'no_code') };
  } catch (thrown) {
    return { ok: false, reason: 'unavailable', ref: errorReference(thrown) };
  }
}
