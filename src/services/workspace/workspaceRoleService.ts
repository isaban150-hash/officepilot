import { getWorkspaceMembersSnapshot, getWorkspaceStoreSnapshot } from './workspaceStore';
import { isWorkspaceDeletionPending, isWorkspaceLicenseReadOnly } from './workspaceAccessService';
import { isCloudRightsUnconfirmed } from '../auth/cloudRightsState';
import type { WorkspaceRole } from '../../types/workspace';

/**
 * SETTINGS-01B2 — die Rolle des angemeldeten Nutzers im aktiven Betrieb.
 *
 * Keine neue Rollenarchitektur: gelesen wird die vorhandene Mitgliedschaft
 * (`workspace_members`, per Sync-State gezogen und lokal im Workspace-Store).
 * Der Server bleibt autoritativ (`can_write_workspace` = owner/admin); diese
 * Auskunft steuert nur, ob die Oberfläche Schreibfelder anbietet.
 *
 * Fail-closed: Ohne bekannte, aktive Mitgliedschaft wird **nicht** geraten —
 * es gibt dann keine Schreibrechte in der Oberfläche, und der Grund wird
 * genannt. Einzige Ausnahme ist der bewusst lokale Betrieb ohne Cloud
 * (`localOnly`): dort gibt es keinen Server, der Rechte prüfen könnte, und
 * die Daten gehören dem Gerät.
 *
 * EINRICHTUNG-01 (AP1; Vertrag 1.3, E5) — ist die Betriebslizenz laut Server nicht
 * wirksam, gilt Nur-Lesen: `canWrite` und `canIntake` sind dann für jede Rolle
 * false, `licenseReadOnly` ist true. `role` und `reason` bleiben die der
 * Mitgliedschaft, denn rollenabhängige Lese- und Ausgaberechte (Ausgabeprüfung,
 * Sicherung und Export für Inhaber und Admins) ändern sich dadurch nicht.
 *
 * EINRICHTUNG-01 (AP2; A-01.4, A-02.3, Vertrag 1.11) — `rightsUnconfirmed`: Die App läuft gerade auf Rechten aus dem
 * Zwischenspeicher (Profil unbestätigt oder Offline-Start). Lokale Änderungen bleiben, wie die Rolle sie erlaubt;
 * cloudbestätigte Aktionen fragen `resolveCloudConfirmedActionAccess`.
 *
 * EINRICHTUNG-01 (AP7; Vertrag 1.26, K7) — ist für den Betrieb die Löschung beantragt, gilt Nur-Lesen wie bei einer
 * nicht wirksamen Lizenz (dieselben Schreibsperren, Team nach E16). `readOnlyReason` nennt den Grund für die Hinweise;
 * ohne Angabe ist es die Lizenz.
 */
export type WorkspaceReadOnlyReason = 'license' | 'deletion';

export type WorkspaceWriteAccess = WorkspaceWriteAccessBase & { rightsUnconfirmed?: true };

type WorkspaceWriteAccessBase =
  | { canWrite: true; canIntake: true; role: WorkspaceRole; reason: 'owner_or_admin'; licenseReadOnly?: false }
  | { canWrite: true; canIntake: true; role: null; reason: 'local_only'; licenseReadOnly?: false }
  /** FINANZ-CORE-DURABILITY-01B — member: Upload/Intake ja, Finanz-/Einstellungs-/Loeschpfade nein. */
  | { canWrite: false; canIntake: true; role: 'member'; reason: 'member'; licenseReadOnly?: false }
  | { canWrite: false; canIntake: false; role: null; reason: 'membership_unknown'; licenseReadOnly?: false }
  /** EINRICHTUNG-01 (Vertrag 1.3) — Betriebslizenz nicht wirksam: Nur-Lesen mit unveränderter Rolle. */
  | { canWrite: false; canIntake: false; role: 'owner' | 'admin'; reason: 'owner_or_admin'; licenseReadOnly: true; readOnlyReason?: WorkspaceReadOnlyReason }
  | { canWrite: false; canIntake: false; role: 'member'; reason: 'member'; licenseReadOnly: true; readOnlyReason?: WorkspaceReadOnlyReason };

/** GO-LIVE-SECURITY-01 — wer eine verbindliche Aktion auslöst. */
export interface WorkspaceActor {
  userId: string | null | undefined;
  cloudConfigured: boolean;
}

/**
 * GO-LIVE-SECURITY-01 — die strengste Annahme für einen Dienstaufruf ohne
 * Angabe: Cloud eingerichtet, Nutzer unbekannt. Das ergibt fail-closed keine
 * Schreibrechte; ein Aufrufer, der die Rolle nicht mitgibt, ändert nichts.
 */
export const UNKNOWN_CLOUD_ACTOR: WorkspaceActor = Object.freeze({ userId: null, cloudConfigured: true });

export function resolveWorkspaceWriteAccess(input: WorkspaceActor): WorkspaceWriteAccess {
  const access = resolveLicenseWriteAccess(input);
  if (access.reason === 'local_only' || !isCloudRightsUnconfirmed(input.userId?.trim())) return access;
  return { ...access, rightsUnconfirmed: true };
}

/**
 * EINRICHTUNG-01 (AP2) — darf die Oberfläche eine cloudbestätigte Aktion anbieten (Finanz, Versand, Team)? Nur mit
 * Schreibrecht und bestätigten Rechten. Der Server prüft unabhängig davon jede Aktion selbst.
 */
export function resolveCloudConfirmedActionAccess(access: WorkspaceWriteAccess): boolean {
  return access.canWrite && access.rightsUnconfirmed !== true;
}

function resolveLicenseWriteAccess(input: WorkspaceActor): WorkspaceWriteAccessBase {
  const access = resolveMembershipWriteAccess(input);
  if (access.reason === 'local_only' || access.role === null) return access;
  const workspaceId = getWorkspaceStoreSnapshot()?.id;
  const userId = input.userId?.trim();
  const deletionPending = isWorkspaceDeletionPending(workspaceId, userId);
  if (!deletionPending && !isWorkspaceLicenseReadOnly(workspaceId, userId)) return access;
  // Ohne Angabe ist der Grund die Lizenz; nur der Löschantrag trägt `readOnlyReason` (Auskunft wie in AP1 unverändert).
  const extra = deletionPending ? { readOnlyReason: 'deletion' as const } : {};
  return access.role === 'member'
    ? { canWrite: false, canIntake: false, role: 'member', reason: 'member', licenseReadOnly: true, ...extra }
    : { canWrite: false, canIntake: false, role: access.role === 'admin' ? 'admin' : 'owner', reason: 'owner_or_admin', licenseReadOnly: true, ...extra };
}

/** Die Auskunft allein aus der Mitgliedschaft, wie vor EINRICHTUNG-01. */
function resolveMembershipWriteAccess(input: WorkspaceActor): WorkspaceWriteAccessBase {
  if (!input.cloudConfigured) return { canWrite: true, canIntake: true, role: null, reason: 'local_only' };

  const workspace = getWorkspaceStoreSnapshot();
  const userId = input.userId?.trim() ?? '';
  if (!workspace || !userId) return { canWrite: false, canIntake: false, role: null, reason: 'membership_unknown' };

  const member = getWorkspaceMembersSnapshot().find(
    (item) => item.workspaceId === workspace.id && item.userId === userId && item.status === 'active',
  );
  if (!member) {
    /*
     * EINRICHTUNG-01 (AP4; EIN-32, M-18) — kein Rückfall auf den Inhaber laut Betriebszeile mehr. Ist die
     * Mitgliedschaft unbekannt, noch nicht geladen oder entzogen, gibt es kein Schreibrecht — wie auf dem Server, der
     * jede Aktion an der aktiven Mitgliedschaft prüft. `ensure_personal_workspace` liefert die eigene Mitgliedschaft
     * mit; der Abzug bestätigt sie.
     */
    return { canWrite: false, canIntake: false, role: null, reason: 'membership_unknown' };
  }
  if (member.role === 'owner' || member.role === 'admin') {
    return { canWrite: true, canIntake: true, role: member.role, reason: 'owner_or_admin' };
  }
  return { canWrite: false, canIntake: true, role: 'member', reason: 'member' };
}

/**
 * EINRICHTUNG-01 (E9; Z-05.10, Z-06.5) — Sicherung und Datenexport nur für
 * Inhaber und Admins bzw. im bewusst lokalen Betrieb. Maßgeblich ist die Rolle,
 * nicht das Schreibrecht: Im Nur-Lese-Betrieb bleibt der Export für Inhaber und
 * Admins erreichbar, Mitglieder bekommen ihn nie angeboten.
 */
export function resolveWorkspaceDataExportAccess(access: WorkspaceWriteAccess): boolean {
  if (access.reason === 'local_only') return true;
  return access.role === 'owner' || access.role === 'admin';
}
