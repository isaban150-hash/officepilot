/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N04) — Entscheidung bei einem Versionskonflikt um
 * einen Kunden.
 *
 * Bisher überschrieb der Abzug eine noch nicht übertragene Kundenänderung, sobald die
 * Cloud eine höhere Version hatte — Rechnungsanschrift und Kundendaten gingen still
 * verloren. Seit N04 bleibt die lokale Fassung stehen und der Konflikt wird gemeldet;
 * der Sendeauftrag steht dann am Versionskonflikt („Versionskonflikt customer:N").
 *
 * Dieselben zwei Wege wie bei Mitarbeitern und Angeboten:
 *
 *   - **Online-Version verwenden**: Der frisch gelesene Cloud-Stand wird lokal
 *     übernommen, der blockierte Auftrag ist erledigt, der Change-Tracker folgt dem
 *     neuen Stand — kein erneuter Push der alten Änderung.
 *   - **Änderungen dieses Geräts behalten**: Der lokale Inhalt bleibt, die soeben
 *     gelesene Cloud-Version wird Basis, der Auftrag geht zurück in die Warteschlange.
 *     Hat sich die Cloud inzwischen erneut geändert, entsteht wieder ein Konflikt —
 *     nie ein stilles Überschreiben.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SyncOutboxEntry } from '../../types/sync';
import { getSupabaseClient } from '../../lib/supabase';
import { buildPersistedStateSnapshot, persistAll, seedSyncChangeTrackerFromCurrentStores } from '../persistenceService';
import { completeBlockedOutboxEntry, getSyncOutboxSnapshot, releaseBlockedOutboxEntry } from '../sync/syncOutboxService';
import { getSyncClient } from '../sync/syncClientService';
import { rpcPullWorkspaceSyncState } from '../workspace/workspaceCloudService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { getCustomerById, getCustomerStoreSnapshot, hydrateCustomerStore } from '../customerStoreService';
import { customerFromCloudRow, type WorkspaceCustomerRow } from './customerCloudService';

const CUSTOMER_VERSION_CONFLICT = 'Versionskonflikt customer';

export interface CustomerConflict {
  readonly outboxId: string;
  readonly customerId: string;
  /** Name des Kunden auf diesem Gerät — nie eine technische Kennung als Ersatz. */
  readonly name: string | null;
}

/** Ist dieser Auftrag ein entscheidbarer Kundenkonflikt? */
export function isCustomerConflictEntry(entry: SyncOutboxEntry): boolean {
  return (
    entry.entityType === 'customer' &&
    entry.status === 'blocked' &&
    (entry.lastErrorMessage ?? '').includes(CUSTOMER_VERSION_CONFLICT) &&
    Boolean(getCustomerById(entry.entityId))
  );
}

/** Die offenen Kundenkonflikte — jeder Auftrag genau einmal. */
export function listCustomerConflicts(outbox: SyncOutboxEntry[] = getSyncOutboxSnapshot()): CustomerConflict[] {
  const seen = new Set<string>();
  const conflicts: CustomerConflict[] = [];
  for (const entry of outbox) {
    if (!isCustomerConflictEntry(entry) || seen.has(entry.entityId)) continue;
    seen.add(entry.entityId);
    conflicts.push({
      outboxId: entry.id,
      customerId: entry.entityId,
      name: getCustomerById(entry.entityId)?.name?.trim() || null,
    });
  }
  return conflicts;
}

export type CustomerConflictDecision = 'take_cloud' | 'keep_local';

export type CustomerConflictResult =
  | { ok: true; decision: CustomerConflictDecision; cloudVersion: number }
  | { ok: false; reason: 'not_found' | 'not_configured' | 'cloud_unavailable' | 'cloud_row_missing' | 'persist_failed' };

export interface CustomerConflictDeps {
  client?: SupabaseClient | null;
  /** Testbar: liest die aktuellen Cloud-Zeilen der Kunden. */
  pullCustomers?: (workspaceId: string) => Promise<WorkspaceCustomerRow[]>;
}

async function readCloudRow(
  customerId: string,
  deps: CustomerConflictDeps,
): Promise<
  | { ok: true; row: WorkspaceCustomerRow; workspaceId: string }
  | { ok: false; reason: 'not_configured' | 'cloud_unavailable' | 'cloud_row_missing' }
> {
  const workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
  const client = deps.client ?? getSupabaseClient();
  if (!workspaceId || (!deps.pullCustomers && !client)) return { ok: false, reason: 'not_configured' };
  let rows: WorkspaceCustomerRow[];
  try {
    rows = deps.pullCustomers
      ? await deps.pullCustomers(workspaceId)
      : ((await rpcPullWorkspaceSyncState(workspaceId, client)).customers ?? []);
  } catch {
    return { ok: false, reason: 'cloud_unavailable' };
  }
  const row = rows.find((candidate) => candidate.customer_id === customerId);
  if (!row) return { ok: false, reason: 'cloud_row_missing' };
  return { ok: true, row, workspaceId };
}

function replaceCustomer(customerId: string, next: ReturnType<typeof customerFromCloudRow>): void {
  const rest = getCustomerStoreSnapshot().filter((customer) => customer.id !== customerId);
  hydrateCustomerStore(next && !next.sync?.deleted ? [...rest, next] : rest);
}

/**
 * Die Entscheidung des Nutzers wirksam machen. Erst der frische Cloud-Stand, dann eine
 * lokale Änderung — schlägt das Lesen fehl, bleibt alles, wie es war.
 */
export async function resolveCustomerConflict(
  customerId: string,
  decision: CustomerConflictDecision,
  deps: CustomerConflictDeps = {},
): Promise<CustomerConflictResult> {
  const entry = getSyncOutboxSnapshot().find(
    (candidate) => candidate.entityId === customerId && isCustomerConflictEntry(candidate),
  );
  const local = getCustomerById(customerId);
  if (!entry || !local) return { ok: false, reason: 'not_found' };

  const cloud = await readCloudRow(customerId, deps);
  if (!cloud.ok) return { ok: false, reason: cloud.reason };
  const cloudVersion = Number(cloud.row.row_version);
  const syncClient = getSyncClient();
  const workspaceId = syncClient.workspaceId || cloud.workspaceId;

  if (decision === 'keep_local') {
    if (cloud.row.deleted) return { ok: false, reason: 'cloud_row_missing' };
    const base = local.sync ?? {
      updatedAt: new Date().toISOString(),
      version: cloudVersion,
      deleted: false,
      deviceId: syncClient.deviceId,
      workspaceId,
    };
    replaceCustomer(customerId, { ...local, sync: { ...base, version: cloudVersion } });
    releaseBlockedOutboxEntry('customer', customerId, cloudVersion);
    // Inhalt unverändert → der Tracker sieht keine neue Änderung; die freigegebene trägt sie.
    const gesichert = persistAll();
    if (!gesichert.success) return { ok: false, reason: 'persist_failed' };
    return { ok: true, decision, cloudVersion };
  }

  /* take_cloud */
  replaceCustomer(customerId, customerFromCloudRow(cloud.row, syncClient.deviceId, workspaceId));
  completeBlockedOutboxEntry('customer', customerId);
  // Wie nach einem Pull: der übernommene Cloud-Stand ist keine lokale Änderung.
  seedSyncChangeTrackerFromCurrentStores();
  const gesichert = persistAll();
  if (!gesichert.success) return { ok: false, reason: 'persist_failed' };
  return { ok: true, decision, cloudVersion };
}
