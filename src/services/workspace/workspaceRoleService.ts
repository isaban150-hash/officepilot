import { getWorkspaceMembersSnapshot, getWorkspaceStoreSnapshot } from './workspaceStore';
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
 */
export type WorkspaceWriteAccess =
  | { canWrite: true; role: WorkspaceRole; reason: 'owner_or_admin' }
  | { canWrite: true; role: null; reason: 'local_only' }
  | { canWrite: false; role: 'member'; reason: 'member' }
  | { canWrite: false; role: null; reason: 'membership_unknown' };

export function resolveWorkspaceWriteAccess(input: {
  userId: string | null | undefined;
  cloudConfigured: boolean;
}): WorkspaceWriteAccess {
  if (!input.cloudConfigured) return { canWrite: true, role: null, reason: 'local_only' };

  const workspace = getWorkspaceStoreSnapshot();
  const userId = input.userId?.trim() ?? '';
  if (!workspace || !userId) return { canWrite: false, role: null, reason: 'membership_unknown' };

  const member = getWorkspaceMembersSnapshot().find(
    (item) => item.workspaceId === workspace.id && item.userId === userId && item.status === 'active',
  );
  if (!member) {
    // Der Eigentümer laut Workspace-Zeile ist auch ohne Mitgliedsliste eindeutig.
    if (workspace.ownerUserId === userId) return { canWrite: true, role: 'owner', reason: 'owner_or_admin' };
    return { canWrite: false, role: null, reason: 'membership_unknown' };
  }
  if (member.role === 'owner' || member.role === 'admin') {
    return { canWrite: true, role: member.role, reason: 'owner_or_admin' };
  }
  return { canWrite: false, role: 'member', reason: 'member' };
}
