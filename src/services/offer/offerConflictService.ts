/**
 * FINANZ-CORE-01A (ANG-03) — Entscheidung bei einem Versionskonflikt um ein
 * Angebot.
 *
 * Der Befund war dieselbe Sackgasse, die P1 MITARBEITERZAHLUNGEN für
 * Mitarbeiter und 07B-FIX3B für Dokumente beseitigt haben: Ein Gerät änderte
 * einen Angebotsentwurf, ein zweites, veraltetes Gerät ebenfalls. Der Server
 * wies die zweite Änderung zu Recht ab („Versionskonflikt offer:N"), der
 * Sendeauftrag blieb `blocked`, der Abgleich übernahm den Cloud-Stand wegen
 * des offenen Auftrags nicht — und Freigabe wie Annahme meldeten dauerhaft
 * „wird noch gespeichert". Die Sync-Seite bot keine Entscheidung an.
 *
 * Dieselben zwei Wege wie bei Mitarbeitern (`employeeConflictService`):
 *
 *   - **Online-Version verwenden**: Der frisch gelesene Cloud-Stand wird lokal
 *     übernommen, der blockierte Auftrag ist erledigt, der Change-Tracker folgt
 *     dem neuen Stand — kein erneuter Push der alten Änderung.
 *   - **Änderungen dieses Geräts behalten**: Der lokale Inhalt bleibt, die
 *     soeben gelesene Cloud-Version wird Basis, der Auftrag geht zurück in die
 *     Warteschlange. Hat sich die Cloud inzwischen erneut geändert, entsteht
 *     wieder ein Konflikt — nie ein stilles Überschreiben. Ist das Angebot
 *     online schon freigegeben oder angenommen, gibt es nichts zu behalten:
 *     Ein Beleg mit Nummer wird nie durch einen Entwurf überschrieben.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SyncOutboxEntry } from '../../types/sync';
import type { Offer } from '../../types/offer';
import { getSupabaseClient } from '../../lib/supabase';
import { buildPersistedStateSnapshot, persistAll, seedSyncChangeTrackerFromCurrentStores } from '../persistenceService';
import { completeBlockedOutboxEntry, getSyncOutboxSnapshot, releaseBlockedOutboxEntry } from '../sync/syncOutboxService';
import { getSyncClient } from '../sync/syncClientService';
import { rpcPullWorkspaceSyncState } from '../workspace/workspaceCloudService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { mapWorkspaceOfferRow, offerFromCloud, type WorkspaceOfferRow } from './offerCloudService';
import { getOfferById, getOfferStoreSnapshot, hydrateOffers } from './offerService';

const OFFER_VERSION_CONFLICT = 'Versionskonflikt offer';

export interface OfferConflict {
  readonly outboxId: string;
  readonly offerId: string;
  /** Betreff des Angebots auf diesem Gerät — nie eine technische Kennung als Ersatz. */
  readonly title: string | null;
}

/** Ist dieser Auftrag ein entscheidbarer Angebotskonflikt? */
export function isOfferConflictEntry(entry: SyncOutboxEntry): boolean {
  return (
    entry.entityType === 'offer' &&
    entry.status === 'blocked' &&
    (entry.lastErrorMessage ?? '').includes(OFFER_VERSION_CONFLICT) &&
    Boolean(getOfferById(entry.entityId))
  );
}

/** Steht für dieses Angebot eine Entscheidung auf der Sync-Seite an? */
export function hasOfferSyncConflict(offerId: string, outbox: SyncOutboxEntry[] = getSyncOutboxSnapshot()): boolean {
  return outbox.some((entry) => entry.entityId === offerId && isOfferConflictEntry(entry));
}

/** Die offenen Angebotskonflikte — jeder Auftrag genau einmal. */
export function listOfferConflicts(outbox: SyncOutboxEntry[] = getSyncOutboxSnapshot()): OfferConflict[] {
  const seen = new Set<string>();
  const conflicts: OfferConflict[] = [];
  for (const entry of outbox) {
    if (!isOfferConflictEntry(entry) || seen.has(entry.entityId)) continue;
    seen.add(entry.entityId);
    conflicts.push({
      outboxId: entry.id,
      offerId: entry.entityId,
      title: getOfferById(entry.entityId)?.title?.trim() || null,
    });
  }
  return conflicts;
}

export type OfferConflictDecision = 'take_cloud' | 'keep_local';

export type OfferConflictResult =
  | { ok: true; decision: OfferConflictDecision; cloudVersion: number }
  | {
      ok: false;
      reason: 'not_found' | 'not_configured' | 'cloud_unavailable' | 'cloud_row_missing' | 'cloud_frozen' | 'persist_failed';
    };

export interface OfferConflictDeps {
  client?: SupabaseClient | null;
  /** Testbar: liest die aktuellen Cloud-Zeilen der Angebote. */
  pullOffers?: (workspaceId: string) => Promise<WorkspaceOfferRow[]>;
}

async function readCloudRow(
  offerId: string,
  deps: OfferConflictDeps,
): Promise<
  | { ok: true; row: WorkspaceOfferRow; workspaceId: string }
  | { ok: false; reason: 'not_configured' | 'cloud_unavailable' | 'cloud_row_missing' }
> {
  const workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
  const client = deps.client ?? getSupabaseClient();
  if (!workspaceId || (!deps.pullOffers && !client)) return { ok: false, reason: 'not_configured' };
  let rows: WorkspaceOfferRow[];
  try {
    rows = deps.pullOffers
      ? await deps.pullOffers(workspaceId)
      : (await rpcPullWorkspaceSyncState(workspaceId, client)).offers;
  } catch {
    return { ok: false, reason: 'cloud_unavailable' };
  }
  const row = rows.find((candidate) => candidate.client_offer_id === offerId);
  if (!row) return { ok: false, reason: 'cloud_row_missing' };
  return { ok: true, row, workspaceId };
}

function replaceOffer(offerId: string, next: Offer | null): void {
  const rest = getOfferStoreSnapshot().filter((offer) => offer.id !== offerId);
  hydrateOffers(next ? [...rest, next] : rest);
}

/**
 * Die Entscheidung des Nutzers wirksam machen. Erst der frische Cloud-Stand,
 * dann eine lokale Änderung — schlägt das Lesen fehl, bleibt alles, wie es war.
 */
export async function resolveOfferConflict(
  offerId: string,
  decision: OfferConflictDecision,
  deps: OfferConflictDeps = {},
): Promise<OfferConflictResult> {
  const entry = getSyncOutboxSnapshot().find((candidate) => candidate.entityId === offerId && isOfferConflictEntry(candidate));
  const local = getOfferById(offerId);
  if (!entry || !local || !local.sync) return { ok: false, reason: 'not_found' };

  const cloud = await readCloudRow(offerId, deps);
  if (!cloud.ok) return { ok: false, reason: cloud.reason };
  const mapped = mapWorkspaceOfferRow(cloud.row);
  if (!mapped) return { ok: false, reason: 'cloud_row_missing' };
  const cloudVersion = mapped.rowVersion;

  if (decision === 'keep_local') {
    if (mapped.deleted || !mapped.payload) return { ok: false, reason: 'cloud_row_missing' };
    if (mapped.payload.status !== 'entwurf') return { ok: false, reason: 'cloud_frozen' };
    replaceOffer(offerId, { ...local, sync: { ...local.sync, version: cloudVersion } });
    releaseBlockedOutboxEntry('offer', offerId, cloudVersion);
    // Inhalt unverändert → der Tracker sieht keine neue Änderung; die freigegebene trägt sie.
    const gesichert = persistAll();
    if (!gesichert.success) return { ok: false, reason: 'persist_failed' };
    return { ok: true, decision, cloudVersion };
  }

  /* take_cloud */
  const syncClient = getSyncClient();
  const workspaceId = syncClient.workspaceId || cloud.workspaceId;
  replaceOffer(
    offerId,
    mapped.deleted || !mapped.payload
      ? null
      : offerFromCloud(mapped.offerId, mapped.payload, mapped.rowVersion, mapped.updatedAt, false, syncClient.deviceId, workspaceId),
  );
  completeBlockedOutboxEntry('offer', offerId);
  // Wie nach einem Pull: der übernommene Cloud-Stand ist keine lokale Änderung.
  seedSyncChangeTrackerFromCurrentStores();
  const gesichert = persistAll();
  if (!gesichert.success) return { ok: false, reason: 'persist_failed' };
  return { ok: true, decision, cloudVersion };
}
