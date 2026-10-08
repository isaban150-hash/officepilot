/**
 * P1 MITARBEITERZAHLUNGEN — Entscheidung bei einem Konflikt um einen Mitarbeiter.
 *
 * Die Abnahme mit zwei Geräten zeigte denselben halbfertigen Zustand, den
 * 07B-FIX3B für Dokumente behoben hat: Ein Gerät änderte einen Mitarbeiter,
 * während ein zweites, veraltetes Gerät ihn ebenfalls änderte. Der Server wies
 * die zweite Änderung zu Recht ab („Versionskonflikt employee:N"). Danach blieb
 * der Auftrag blockiert, der Abgleich übernahm den neueren Cloud-Stand wegen
 * des offenen Auftrags nicht, und jede weitere Änderung lief mit der alten
 * Basisversion erneut in denselben Konflikt. Die Sync-Seite bat um eine
 * Entscheidung — ohne Möglichkeit dazu.
 *
 * Dieselben zwei Wege wie bei Dokumenten (`archivedDocumentConflictService`):
 *
 *   - **Online-Version verwenden**: Der frisch gelesene Cloud-Stand wird lokal
 *     übernommen, der blockierte Auftrag ist erledigt, und der Change-Tracker
 *     wird auf den neuen Stand ausgerichtet — kein erneuter Push der alten
 *     Änderung.
 *   - **Änderungen dieses Geräts behalten**: Der lokale Inhalt bleibt, die
 *     **soeben gelesene** Cloud-Version wird Basis, der Auftrag geht zurück in
 *     die Warteschlange. Hat sich die Cloud inzwischen erneut geändert, entsteht
 *     wieder ein Konflikt — nie ein stilles Überschreiben.
 *
 * Zahlungen brauchen das nicht: Sie sind append-only und tragen keine
 * Basisversion. Eine Wiederholung ist ein Replay, ein abweichender Inhalt unter
 * derselben Kennung ein Zahlungskonflikt — keine Frage des Stands.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SyncOutboxEntry } from '../../types/sync';
import { getSupabaseClient } from '../../lib/supabase';
import { buildPersistedStateSnapshot, persistAll, seedSyncChangeTrackerFromCurrentStores } from '../persistenceService';
import { completeBlockedOutboxEntry, getSyncOutboxSnapshot, releaseBlockedOutboxEntry } from '../sync/syncOutboxService';
import { getSyncClient } from '../sync/syncClientService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import {
  mapEmployeeRow,
  rpcPullWorkspaceEmployeeData,
  type CloudEmployeeRow,
  type EmployeeCloudPull,
} from './employeeCloudSyncService';
import { getEmployeeFromStore, putEmployeeInStore } from './employeeStore';

const EMPLOYEE_VERSION_CONFLICT = 'Versionskonflikt employee';

export interface EmployeeConflict {
  readonly outboxId: string;
  readonly employeeId: string;
  /** Name des Mitarbeiters auf diesem Gerät — nie eine technische Kennung als Ersatz. */
  readonly name: string | null;
}

/** Ist dieser Auftrag ein entscheidbarer Mitarbeiterkonflikt? */
export function isEmployeeConflictEntry(entry: SyncOutboxEntry): boolean {
  return (
    entry.entityType === 'employee' &&
    entry.status === 'blocked' &&
    (entry.lastErrorMessage ?? '').includes(EMPLOYEE_VERSION_CONFLICT) &&
    Boolean(getEmployeeFromStore(entry.entityId))
  );
}

/** Die offenen Mitarbeiterkonflikte — jeder Auftrag genau einmal. */
export function listEmployeeConflicts(outbox: SyncOutboxEntry[] = getSyncOutboxSnapshot()): EmployeeConflict[] {
  const seen = new Set<string>();
  const conflicts: EmployeeConflict[] = [];
  for (const entry of outbox) {
    if (!isEmployeeConflictEntry(entry) || seen.has(entry.entityId)) continue;
    seen.add(entry.entityId);
    conflicts.push({
      outboxId: entry.id,
      employeeId: entry.entityId,
      name: getEmployeeFromStore(entry.entityId)?.name?.trim() || null,
    });
  }
  return conflicts;
}

export type EmployeeConflictDecision = 'take_cloud' | 'keep_local';

export type EmployeeConflictResult =
  | { ok: true; decision: EmployeeConflictDecision; cloudVersion: number }
  | { ok: false; reason: 'not_found' | 'not_configured' | 'cloud_unavailable' | 'cloud_row_missing' | 'persist_failed' };

export interface EmployeeConflictDeps {
  client?: SupabaseClient | null;
  /** Testbar: liest den aktuellen Cloud-Stand. */
  pullEmployees?: (workspaceId: string) => Promise<EmployeeCloudPull>;
}

async function readCloudRow(
  employeeId: string,
  deps: EmployeeConflictDeps,
): Promise<{ ok: true; row: CloudEmployeeRow; workspaceId: string } | { ok: false; reason: 'not_configured' | 'cloud_unavailable' | 'cloud_row_missing' }> {
  const workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
  const client = deps.client ?? getSupabaseClient();
  if (!workspaceId || (!deps.pullEmployees && !client)) return { ok: false, reason: 'not_configured' };
  let pull: EmployeeCloudPull;
  try {
    pull = deps.pullEmployees ? await deps.pullEmployees(workspaceId) : await rpcPullWorkspaceEmployeeData(workspaceId, client);
  } catch {
    return { ok: false, reason: 'cloud_unavailable' };
  }
  const row = pull.employees.find((candidate) => candidate.client_employee_id === employeeId);
  if (!row) return { ok: false, reason: 'cloud_row_missing' };
  return { ok: true, row, workspaceId };
}

/**
 * Die Entscheidung des Nutzers wirksam machen. Erst der frische Cloud-Stand,
 * dann eine lokale Änderung — schlägt das Lesen fehl, bleibt alles, wie es war.
 */
export async function resolveEmployeeConflict(
  employeeId: string,
  decision: EmployeeConflictDecision,
  deps: EmployeeConflictDeps = {},
): Promise<EmployeeConflictResult> {
  const entry = getSyncOutboxSnapshot().find((candidate) => candidate.entityId === employeeId && isEmployeeConflictEntry(candidate));
  const local = getEmployeeFromStore(employeeId);
  if (!entry || !local || !local.sync) return { ok: false, reason: 'not_found' };

  const cloud = await readCloudRow(employeeId, deps);
  if (!cloud.ok) return { ok: false, reason: cloud.reason };
  const cloudVersion = Number(cloud.row.row_version);

  if (decision === 'keep_local') {
    putEmployeeInStore({ ...local, sync: { ...local.sync, version: cloudVersion } });
    releaseBlockedOutboxEntry('employee', employeeId, cloudVersion);
    // Inhalt unverändert → der Tracker sieht keine neue Änderung; die freigegebene trägt sie.
    const gesichert = persistAll();
    if (!gesichert.success) return { ok: false, reason: 'persist_failed' };
    return { ok: true, decision, cloudVersion };
  }

  /* take_cloud */
  const syncClient = getSyncClient();
  putEmployeeInStore(mapEmployeeRow(cloud.row, local, syncClient.deviceId, syncClient.workspaceId ?? cloud.workspaceId));
  completeBlockedOutboxEntry('employee', employeeId);
  // Wie nach einem Pull: der übernommene Cloud-Stand ist keine lokale Änderung.
  seedSyncChangeTrackerFromCurrentStores();
  const gesichert = persistAll();
  if (!gesichert.success) return { ok: false, reason: 'persist_failed' };
  return { ok: true, decision, cloudVersion };
}
