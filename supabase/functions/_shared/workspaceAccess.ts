/**
 * EINRICHTUNG-01 (AP1, Vertrag 1.1) — die zentrale Zugriffsregel für Edge Functions.
 *
 * Die Funktionen laufen mit der Dienstrolle; die Person stammt aus dem geprüften Token (auth.getUser). Die
 * Entscheidung trifft der Server in einer Stelle (`workspace_user_access_denial`, nur service_role): Sperre,
 * Freigabe, aktive Mitgliedschaft im Zielbetrieb, Rolle je Aktionsklasse und die Betriebslizenz (Lizenz des
 * Inhabers, E3). Die eigene Lizenz einer Person spielt keine Rolle.
 *
 *   'write'   owner oder admin (Versand, Postfach)
 *   'member'  jede aktive Rolle (KI)
 *
 * Fail-closed: ein Abfragefehler oder eine unbekannte Antwort gewährt nie Zugang.
 */

export type WorkspaceAccessAction = 'write' | 'member';

export type WorkspaceAccessDenial =
  | 'account_blocked'
  | 'account_not_approved'
  | 'not_member'
  | 'forbidden_role'
  | 'license_not_effective'
  | 'invalid_request';

const BEKANNT: ReadonlySet<string> = new Set<WorkspaceAccessDenial>([
  'account_blocked',
  'account_not_approved',
  'not_member',
  'forbidden_role',
  'license_not_effective',
  'invalid_request',
]);

export interface WorkspaceAccessRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export type WorkspaceAccessResult =
  | { ok: true; denial: WorkspaceAccessDenial | null }
  | { ok: false };

export async function readWorkspaceAccessDenial(
  client: WorkspaceAccessRpcClient,
  workspaceId: string,
  userId: string,
  action: WorkspaceAccessAction,
): Promise<WorkspaceAccessResult> {
  const { data, error } = await client.rpc('workspace_user_access_denial', {
    p_workspace_id: workspaceId,
    p_user_id: userId,
    p_action: action,
  });
  if (error) return { ok: false };
  if (data === null) return { ok: true, denial: null };
  if (typeof data === 'string' && BEKANNT.has(data)) return { ok: true, denial: data as WorkspaceAccessDenial };
  // Unbekannte Antwort: wie eine fehlende Freigabe behandeln, nie als Zugang.
  return { ok: true, denial: 'account_not_approved' };
}

/**
 * Der Fehlercode nach aussen. Eine nicht wirksame Betriebslizenz wird eigens benannt (Katalog Z-05.5), damit die
 * Oberfläche den Nur-Lesen-Hinweis zeigen kann; alles andere bleibt `forbidden` und verrät nichts über fremde
 * Betriebe.
 */
export function workspaceAccessErrorCode(denial: WorkspaceAccessDenial): 'license_not_effective' | 'forbidden' | 'invalid_request' {
  if (denial === 'license_not_effective') return 'license_not_effective';
  if (denial === 'invalid_request') return 'invalid_request';
  return 'forbidden';
}
