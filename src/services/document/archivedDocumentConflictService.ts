/**
 * E-MAIL-07B-FIX3B — Entscheidung bei einem Konflikt um ein archiviertes
 * Dokument.
 *
 * Bis hierher gab es eine sichtbare Entscheidung nur für die
 * Betriebseinstellungen. Ein blockierter Dokument-Auftrag („Versionskonflikt
 * archived_document") stand auf der Sync-Seite als „Bitte entscheiden" — ohne
 * Möglichkeit dazu — und blieb für immer blockiert. Der Versand des Dokuments
 * ist in diesem Zustand zu Recht gesperrt (07B-FIX2), der Nutzer kam also
 * nicht weiter.
 *
 * Zwei Wege, dieselbe Grundhaltung wie bei den Einstellungen
 * (`resolveWorkspaceSettingsConflict`):
 *
 *   - **Online-Version verwenden**: Der aktuelle Cloud-Datensatz wird lokal
 *     übernommen, wie ein Pull es täte; der blockierte Auftrag ist erledigt
 *     (nichts mehr zu senden), und der Change-Tracker wird auf den neuen Stand
 *     ausgerichtet — kein erneuter Push der alten Änderung.
 *   - **Änderungen dieses Geräts behalten**: Der lokale Inhalt bleibt, der
 *     Auftrag geht mit der **soeben gelesenen** Cloud-Version als Basis zurück
 *     in die Warteschlange. Der Server prüft diese Version exakt: Hat sich die
 *     Cloud inzwischen erneut geändert, entsteht wieder ein Konflikt — nie ein
 *     stilles Überschreiben.
 *
 * Beide Wege lesen den Cloud-Stand **frisch** und entscheiden nie auf einem
 * veralteten Bild.
 *
 * Dateien und Dateibindungen sind eigene Entitäten und werden hier nicht
 * gelöscht. Beim eigenen Geschäftsbrief bleibt das PDF versendbar: Hat die
 * Cloud keine Datei, das Gerät aber das PDF, wird es — rein additiv, ohne die
 * Dokumentzeile zu ändern — als Archiv-Bindung gesichert (wie 07B-FIX2).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase';
import { getDocumentById, hydrateDocumentStore, getDocumentStoreSnapshot } from '../documentService';
import { getDocumentFileRefById } from '../documentFileStoreService';
import { getDocumentFileRepresentationBindingStoreSnapshot } from '../documentFileRepresentationBindingStoreService';
import { persistDerivedArchiveRepresentationBinding } from '../documentFileRepresentationDerivedArchiveBindingPersistenceService';
import { buildPersistedStateSnapshot, persistAll, seedSyncChangeTrackerFromCurrentStores } from '../persistenceService';
import { completeBlockedOutboxEntry, getSyncOutboxSnapshot, releaseBlockedOutboxEntry } from '../sync/syncOutboxService';
import { getSyncClient } from '../sync/syncClientService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { isBusinessLetterDocument } from '../letter/businessLetterArchiveService';
import {
  mapCloudArchivedDocumentRow,
  rpcPullWorkspaceIntakeState,
  type CloudArchivedDocumentRow,
  type IntakeCloudPull,
} from './intakeCloudSyncService';
import type { SyncOutboxEntry } from '../../types/sync';
import type { CompanyDocument } from '../../types/models';

const ARCHIVED_DOCUMENT_VERSION_CONFLICT = 'Versionskonflikt archived_document';

export interface ArchivedDocumentConflict {
  readonly outboxId: string;
  readonly documentId: string;
  /** Dokumenttitel, soweit vorhanden — nie eine technische Kennung als Ersatz. */
  readonly title: string | null;
}

/** Ist dieser Auftrag ein entscheidbarer Dokumentkonflikt? */
export function isArchivedDocumentConflictEntry(entry: SyncOutboxEntry): boolean {
  return (
    entry.entityType === 'document' &&
    entry.status === 'blocked' &&
    (entry.lastErrorMessage ?? '').includes(ARCHIVED_DOCUMENT_VERSION_CONFLICT) &&
    Boolean(getDocumentById(entry.entityId))
  );
}

/** Die offenen Dokumentkonflikte — jeder Auftrag genau einmal. */
export function listArchivedDocumentConflicts(outbox: SyncOutboxEntry[] = getSyncOutboxSnapshot()): ArchivedDocumentConflict[] {
  const seen = new Set<string>();
  const conflicts: ArchivedDocumentConflict[] = [];
  for (const entry of outbox) {
    if (!isArchivedDocumentConflictEntry(entry) || seen.has(entry.entityId)) continue;
    seen.add(entry.entityId);
    conflicts.push({
      outboxId: entry.id,
      documentId: entry.entityId,
      title: getDocumentById(entry.entityId)?.title?.trim() || null,
    });
  }
  return conflicts;
}

export type ArchivedDocumentDecision = 'take_cloud' | 'keep_local';

export type ArchivedDocumentConflictResult =
  | { ok: true; decision: ArchivedDocumentDecision; cloudVersion: number }
  | {
      ok: false;
      reason: 'not_found' | 'not_configured' | 'cloud_unavailable' | 'cloud_row_missing' | 'cloud_deleted' | 'persist_failed';
    };

export interface ArchivedDocumentConflictDeps {
  client?: SupabaseClient | null;
  /** Testbar: liest den aktuellen Cloud-Stand. */
  pullIntake?: (workspaceId: string) => Promise<IntakeCloudPull>;
}

function isCommittedPdf(fileRefId: string | undefined): boolean {
  if (!fileRefId) return false;
  const ref = getDocumentFileRefById(fileRefId);
  return ref?.mimeType === 'application/pdf' && ref.lifecycleStatus === 'committed';
}

/**
 * Nach „Online-Version verwenden": Das PDF des eigenen Geschäftsbriefs darf
 * nicht verloren gehen, nur weil die Cloud-Zeile keine Datei kennt. Liegt es
 * auf dem Gerät, wird es als Archiv-Bindung gesichert — eigene Entität, eigene
 * Version, die Dokumentzeile bleibt der Cloud-Stand.
 */
function keepLetterPdfAvailable(cloudDocument: CompanyDocument, localFileRefId: string | undefined): void {
  if (!isBusinessLetterDocument(cloudDocument)) return;
  if (isCommittedPdf(cloudDocument.fileRefId)) return;
  const hatArchivBindung = getDocumentFileRepresentationBindingStoreSnapshot().some(
    (binding) => binding.documentId === cloudDocument.id && binding.kind === 'archive',
  );
  if (hatArchivBindung || !isCommittedPdf(localFileRefId)) return;
  try {
    persistDerivedArchiveRepresentationBinding({ documentId: cloudDocument.id, archiveFileRefId: localFileRefId! });
  } catch {
    /* Ohne Bindung bleibt der Brief nicht versendbar — die Briefseite rüstet sie nach (07B-FIX2). */
  }
}

async function readCloudRow(
  documentId: string,
  deps: ArchivedDocumentConflictDeps,
): Promise<{ ok: true; row: CloudArchivedDocumentRow; originalFileRefId: string | undefined } | { ok: false; reason: 'not_configured' | 'cloud_unavailable' | 'cloud_row_missing' }> {
  const workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
  const client = deps.client ?? getSupabaseClient();
  if (!workspaceId || (!deps.pullIntake && !client)) return { ok: false, reason: 'not_configured' };
  let pull: IntakeCloudPull;
  try {
    pull = deps.pullIntake ? await deps.pullIntake(workspaceId) : await rpcPullWorkspaceIntakeState(workspaceId, client);
  } catch {
    return { ok: false, reason: 'cloud_unavailable' };
  }
  const row = pull.archivedDocuments.find(
    (candidate) => candidate.client_document_id === documentId && candidate.document_kind === 'archived_document',
  );
  if (!row) return { ok: false, reason: 'cloud_row_missing' };
  const original = pull.bindings.find(
    (binding) => binding.client_document_id === documentId && binding.binding_kind === 'original' && !binding.deleted,
  );
  return { ok: true, row, originalFileRefId: original?.client_file_ref_id };
}

/**
 * Die Entscheidung des Nutzers wirksam machen. Erst der frische Cloud-Stand,
 * dann eine lokale Änderung — schlägt das Lesen fehl, bleibt alles, wie es war.
 */
export async function resolveArchivedDocumentConflict(
  documentId: string,
  decision: ArchivedDocumentDecision,
  deps: ArchivedDocumentConflictDeps = {},
): Promise<ArchivedDocumentConflictResult> {
  const entry = getSyncOutboxSnapshot().find((candidate) => candidate.entityId === documentId && isArchivedDocumentConflictEntry(candidate));
  const local = getDocumentById(documentId);
  if (!entry || !local) return { ok: false, reason: 'not_found' };

  const cloud = await readCloudRow(documentId, deps);
  if (!cloud.ok) return { ok: false, reason: cloud.reason };
  const cloudVersion = Number(cloud.row.row_version);

  if (decision === 'keep_local') {
    /*
     * Eine gelöschte Cloud-Zeile würde ein lokaler Push wieder aufleben
     * lassen. Das ist keine „lokale Änderung behalten", sondern eine
     * Wiederherstellung — dafür gibt es diesen Weg nicht.
     */
    if (cloud.row.deleted) return { ok: false, reason: 'cloud_deleted' };
    const rebased = getDocumentStoreSnapshot().map((document) =>
      document.id === documentId
        ? ({ ...document, sync: { ...(document.sync ?? { updatedAt: cloud.row.updated_at, deleted: false }), version: cloudVersion } } as CompanyDocument)
        : document,
    );
    hydrateDocumentStore(rebased);
    releaseBlockedOutboxEntry('document', documentId, cloudVersion);
    // Inhalt unverändert → der Tracker sieht keine neue Änderung; die freigegebene trägt sie.
    const gesichert = persistAll();
    if (!gesichert.success) return { ok: false, reason: 'persist_failed' };
    return { ok: true, decision, cloudVersion };
  }

  /* take_cloud */
  const client = getSyncClient();
  const cloudDocument = mapCloudArchivedDocumentRow(cloud.row, local, cloud.originalFileRefId, {
    deviceId: client.deviceId,
    workspaceId: client.workspaceId ?? '',
    dirty: new Set(),
  });
  // Die Datei der Dokumentzeile ist die, die die Cloud kennt — keine Rückmutation aus dem lokalen Stand.
  const uebernommen = { ...cloudDocument, fileRefId: cloud.originalFileRefId } as CompanyDocument;
  hydrateDocumentStore(getDocumentStoreSnapshot().map((document) => (document.id === documentId ? uebernommen : document)));
  completeBlockedOutboxEntry('document', documentId);
  // Wie nach einem Pull: der übernommene Cloud-Stand ist keine lokale Änderung.
  seedSyncChangeTrackerFromCurrentStores();
  keepLetterPdfAvailable(uebernommen, local.fileRefId);
  const gesichert = persistAll();
  if (!gesichert.success) return { ok: false, reason: 'persist_failed' };
  return { ok: true, decision, cloudVersion };
}
