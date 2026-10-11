import { vi } from 'vitest';
import * as workspaceRole from '../services/workspace/workspaceRoleService';

/**
 * GO-LIVE-SECURITY-01 — die Rolle für UI-Tests ausdrücklich setzen.
 *
 * Die Testumgebung meldet Supabase als eingerichtet; ohne geladene
 * Mitgliedschaft ist die Rolle deshalb unbekannt, und die Oberfläche bietet
 * fail-closed keine verbindlichen Aktionen an (Angebot freigeben, Nachtrag
 * bestätigen). Tests, die diese Aktionen bedienen, laufen als Inhaber.
 */
export function alsInhaber(): void {
  vi.spyOn(workspaceRole, 'resolveWorkspaceWriteAccess').mockReturnValue({
    canWrite: true,
    canIntake: true,
    role: 'owner',
    reason: 'owner_or_admin',
  });
}

/** Ein aktives Mitglied: vorbereiten ja, verbindlich freigeben oder bestätigen nein. */
export function alsMitglied(): void {
  vi.spyOn(workspaceRole, 'resolveWorkspaceWriteAccess').mockReturnValue({
    canWrite: false,
    canIntake: true,
    role: 'member',
    reason: 'member',
  });
}
