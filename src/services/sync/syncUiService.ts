import type { SyncCoordinatorReport, SyncOutboxEntry, SyncOutboxHold, SyncState } from '../../types/sync';
import type { AppPersistedState } from '../../types/models';
import type { SyncAdapterStatus } from './syncAdapter';
import { buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import { getSyncClient } from './syncClientService';
import {
  getSyncOutboxSnapshot,
  hasPendingCompanyCloudBackup,
  hydrateSyncOutbox,
  releaseHeldOutboxEntries,
  resendFinallyDeniedOutboxEntry,
} from './syncOutboxService';
import {
  appendOutboxOriginLog,
  isOutboxEntryHeld,
  resolveOutboxOriginFromActiveScope,
  toOutboxOriginLogEntity,
} from './syncOutboxOriginService';
import { getActiveStorageKey } from '../storage/storageScopeService';
import { getSupabaseClient } from '../../lib/supabase';
import { getSyncCoordinator } from './syncCoordinator';
import { applySyncPullCandidateSafely, captureSyncRunBase } from './syncPullPersistService';
import { runQueuedSyncOperation } from './syncOperationQueue';
import { createSyncAdapter, isSyncProviderAvailable } from './syncAdapterFactory';
import { isSupabaseConfigured } from '../../lib/supabase';
import { bootstrapWorkspaceCloudSyncIfNeeded } from '../workspace/workspaceCloudBootstrapService';
import { isSupabaseSyncAllowed } from './cloudSyncAllowlist';
import { isFinallyDeniedOutboxEntry } from './syncRoleDenial';
import {
  describeSyncEntity,
  describeSyncOutboxEntry,
  type SyncOutboxDescription,
} from './syncOutboxDescriptionService';
import {
  getPendingWorkspaceSettingsConflict,
  resolveWorkspaceSettingsConflict,
  type WorkspaceSettingsDecision,
  type WorkspaceSettingsFieldConflict,
} from '../workspace/workspaceSettingsConflictService';
import {
  listArchivedDocumentConflicts,
  resolveArchivedDocumentConflict,
  type ArchivedDocumentConflict,
  type ArchivedDocumentConflictResult,
  type ArchivedDocumentDecision,
} from '../document/archivedDocumentConflictService';
import {
  listEmployeeConflicts,
  resolveEmployeeConflict,
  type EmployeeConflict,
  type EmployeeConflictDecision,
  type EmployeeConflictResult,
} from '../employee/employeeConflictService';
import {
  listCustomerConflicts,
  resolveCustomerConflict,
  type CustomerConflict,
  type CustomerConflictDecision,
  type CustomerConflictResult,
} from '../customer/customerConflictService';
import {
  listOfferConflicts,
  resolveOfferConflict,
  type OfferConflict,
  type OfferConflictDecision,
  type OfferConflictResult,
} from '../offer/offerConflictService';

export interface SyncOutboxCounts {
  pending: number;
  completed: number;
  error: number;
  /** DOKUMENTE-01 R2 — zurückgehaltene Aufträge (nicht in `pending`/`error` enthalten); fehlt bei null. */
  held?: number;
}

/** DOKUMENTE-01 R2 — ein zurückgehaltener Auftrag, so beschrieben, dass er sich vor der Freigabe prüfen lässt. */
export interface HeldOutboxDescription {
  readonly id: string;
  readonly entityType: SyncOutboxEntry['entityType'];
  readonly entityId: string;
  readonly operation: SyncOutboxEntry['operation'];
  readonly status: SyncOutboxEntry['status'];
  /** Woran der Nutzer den Datensatz wiedererkennt; `null`, wenn er lokal nicht (mehr) vorliegt. */
  readonly label: string | null;
  readonly queuedAt: string;
  readonly heldSince: string;
  readonly source: SyncOutboxHold['source'];
}

const OPEN_STATUSES: ReadonlySet<SyncOutboxEntry['status']> = new Set(['pending', 'error', 'blocked']);

function isOpenHeldEntry(entry: SyncOutboxEntry): boolean {
  return isOutboxEntryHeld(entry) && OPEN_STATUSES.has(entry.status);
}

/** Wo der Datensatz eines zurückgehaltenen Auftrags im Bestand liegt — für eine erkennbare Bezeichnung. */
const HELD_ENTITY_COLLECTIONS: Partial<Record<SyncOutboxEntry['entityType'], keyof AppPersistedState>> = {
  document: 'documents',
  document_file: 'documentFileRefs',
  document_work_result: 'documentWorkResults',
  inbox_item: 'inboxItems',
  customer: 'customers',
  vorgang: 'vorgaenge',
  vorgang_note: 'vorgangNotes',
  task: 'tasks',
  business_letter: 'businessLetters',
  offer: 'offers',
  invoice_draft: 'invoiceDrafts',
  order_draft: 'orderDrafts',
  knowledge_fact: 'knowledgeFacts',
  bank_transaction: 'bankTransactions',
};

const HELD_LABEL_FIELDS = ['title', 'name', 'originalFileName', 'subject', 'displayText', 'number', 'invoiceNumber'];

function heldEntityLabel(entry: SyncOutboxEntry, state: AppPersistedState | null): string | null {
  const bekannt = describeSyncEntity(entry.entityType, entry.entityId);
  if (bekannt || !state) return bekannt;
  const sammlung = HELD_ENTITY_COLLECTIONS[entry.entityType];
  const liste = sammlung ? (state[sammlung] as unknown) : undefined;
  if (!Array.isArray(liste)) return null;
  const datensatz = liste.find((item) => (item as { id?: unknown })?.id === entry.entityId) as
    | Record<string, unknown>
    | undefined;
  if (!datensatz) return null;
  for (const feld of HELD_LABEL_FIELDS) {
    const wert = datensatz[feld];
    if (typeof wert === 'string' && wert.trim()) {
      const text = wert.trim();
      return text.length > 80 ? `${text.slice(0, 79)}…` : text;
    }
  }
  return null;
}

function describeHeldOutboxEntry(entry: SyncOutboxEntry, state: AppPersistedState | null): HeldOutboxDescription {
  return {
    id: entry.id,
    entityType: entry.entityType,
    entityId: entry.entityId,
    operation: entry.operation,
    status: entry.status,
    label: heldEntityLabel(entry, state),
    queuedAt: entry.queuedAt,
    heldSince: entry.hold?.since ?? entry.queuedAt,
    source: entry.hold?.source ?? 'load',
  };
}

export interface SyncUiSnapshot {
  deviceId: string;
  workspaceId: string;
  syncPolicy: string;
  status: SyncAdapterStatus;
  lastReport: SyncCoordinatorReport | null;
  outbox: SyncOutboxEntry[];
  outboxCounts: SyncOutboxCounts;
  pendingOutboxEntries: SyncOutboxEntry[];
  /**
   * FINANZ-SYNC-BLOCKER-01B — die nicht übertragenen Aufträge, benannt.
   *
   * Hier stehen auch die `error`-Einträge. Die Liste oben führte nur
   * `pending` und `blocked`, weshalb die Seite von genau den Einträgen, die
   * schiefgegangen waren, nur die Anzahl zeigen konnte.
   */
  failedOutboxEntries: SyncOutboxDescription[];
  /** Offener Feldkonflikt der Betriebseinstellungen, falls einer ansteht. */
  settingsConflict: WorkspaceSettingsFieldConflict[] | null;
  /**
   * 07B-FIX3B — offene Dokumentkonflikte mit Entscheidungsmöglichkeit. Sie
   * stehen nur hier und nicht zusätzlich als „Wartet" oder „Nicht übertragen"
   * — ein Auftrag, eine Zeile.
   */
  documentConflicts: ArchivedDocumentConflict[];
  /** P1 MITARBEITERZAHLUNGEN — offene Mitarbeiterkonflikte mit Entscheidung; wie Dokumentkonflikte genau eine Zeile. */
  employeeConflicts: EmployeeConflict[];
  /** FINANZ-CORE-01A (ANG-03) — offene Angebotskonflikte mit Entscheidung; genau eine Zeile je Auftrag. */
  offerConflicts: OfferConflict[];
  /** FINANZ-CORE-01A (WEISS-Nacharbeit N04) — offene Kundenkonflikte mit Entscheidung; genau eine Zeile je Auftrag. */
  customerConflicts: CustomerConflict[];
  /**
   * DOKUMENTE-01 R2 — Aufträge ohne nachweisbares Ursprungskonto, gegen automatischen Versand gesperrt. Sie stehen
   * nur hier und nicht zusätzlich als „Wartet", „Nicht übertragen" oder Konflikt — ein Auftrag, eine Zeile.
   */
  heldOutboxEntries?: HeldOutboxDescription[];
  isOffline: boolean;
  hasRetryableErrors: boolean;
}

function countOutbox(outbox: SyncOutboxEntry[]): SyncOutboxCounts {
  const held = outbox.filter(isOpenHeldEntry).length;
  return {
    pending: outbox.filter((entry) => entry.status === 'pending' && !isOutboxEntryHeld(entry)).length,
    completed: outbox.filter((entry) => entry.status === 'completed').length,
    error: outbox.filter(
      (entry) => (entry.status === 'error' || entry.status === 'failed') && !isOutboxEntryHeld(entry),
    ).length,
    ...(held > 0 ? { held } : {}),
  };
}

export function isLocalOnlySyncMode(
  snapshot: Pick<SyncUiSnapshot, 'syncPolicy' | 'isOffline'>,
): boolean {
  return (
    snapshot.syncPolicy === 'disabled' ||
    snapshot.syncPolicy === 'local_only' ||
    snapshot.isOffline
  );
}

export function getSyncUiSnapshot(): SyncUiSnapshot {
  const syncClient = getSyncClient();
  const outbox = getSyncOutboxSnapshot();
  const coordinator = getSyncCoordinator();
  const status = coordinator.getStatus();
  const isOffline = syncClient.syncPolicy === 'disabled' || status.syncState === 'offline';
  // DOKUMENTE-01 R2 — zurückgehaltene Aufträge erscheinen nur in ihrer eigenen Liste.
  const heldOpen = outbox.filter(isOpenHeldEntry);
  const heldState = heldOpen.length > 0 ? buildPersistedStateSnapshot() : null;
  const heldOutboxEntries = heldOpen.map((entry) => describeHeldOutboxEntry(entry, heldState));
  const sendable = outbox.filter((entry) => !isOutboxEntryHeld(entry));
  const documentConflicts = listArchivedDocumentConflicts(sendable);
  const employeeConflicts = listEmployeeConflicts(sendable);
  const offerConflicts = listOfferConflicts(sendable);
  const customerConflicts = listCustomerConflicts(sendable);
  const decidable = new Set(
    [...documentConflicts, ...employeeConflicts, ...offerConflicts, ...customerConflicts].map(
      (conflict) => conflict.outboxId,
    ),
  );
  const pendingOutboxEntries = sendable.filter(
    (entry) => (entry.status === 'pending' || entry.status === 'blocked') && !decidable.has(entry.id),
  );
  const failedOutboxEntries = sendable
    .filter(
      (entry) =>
        (entry.status === 'error' || entry.status === 'failed' || entry.status === 'blocked') &&
        !decidable.has(entry.id),
    )
    .map(describeSyncOutboxEntry);

  return {
    deviceId: syncClient.deviceId,
    workspaceId: syncClient.workspaceId,
    syncPolicy: syncClient.syncPolicy,
    status,
    lastReport: coordinator.getLastReport(),
    outbox,
    outboxCounts: countOutbox(outbox),
    pendingOutboxEntries,
    failedOutboxEntries,
    settingsConflict: getPendingWorkspaceSettingsConflict()?.undecided ?? null,
    documentConflicts,
    employeeConflicts,
    offerConflicts,
    customerConflicts,
    ...(heldOutboxEntries.length > 0 ? { heldOutboxEntries } : {}),
    isOffline,
    /*
     * KONTOSPERRE — ein endgültig abgewiesener Auftrag ist nichts, was ein neuer Versuch
     * ändert; „Erneut versuchen" belebt ihn auch nicht. Den Knopf deshalb nur, wenn ein
     * wiederholbarer Fehler da ist. DOKUMENTE-01 R2 — ein zurückgehaltener auch nicht.
     */
    hasRetryableErrors: sendable.some(
      (entry) => entry.status === 'error' || (entry.status === 'failed' && !isFinallyDeniedOutboxEntry(entry)),
    ),
  };
}

export type HeldOutboxReleaseResult =
  | { ok: true; released: number }
  | { ok: false; reason: 'no_account' | 'session_mismatch' | 'nothing_held' | 'persist_failed' };

/**
 * DOKUMENTE-01 R2 — die bewusste Freigabe zurückgehaltener Aufträge.
 *
 * Berechtigt ist allein das Konto dieses Bestands — und nur, wenn die Anmeldung dieses Konto nachweislich meldet:
 * Der aktive Speicherbereich muss ein Kontobestand sein, die Sitzung lesbar und dasselbe Konto. Freigegeben werden
 * genau die geprüften Aufträge; sie erhalten dieses Konto als Ursprung und eine Freigabespur. Erst speichern, dann
 * melden; gesendet wird danach über den normalen Abgleich, nichts geschieht heimlich sofort.
 */
export async function releaseHeldOutboxEntriesFromUi(entryIds: readonly string[]): Promise<HeldOutboxReleaseResult> {
  const origin = resolveOutboxOriginFromActiveScope();
  if (!origin?.workspaceId || !origin.access) return { ok: false, reason: 'no_account' };
  const storageKey = getActiveStorageKey();

  let sessionUserId: string | null = null;
  try {
    const client = getSupabaseClient();
    const { data } = (await client?.auth.getSession()) ?? { data: { session: null } };
    sessionUserId = data.session?.user?.id ?? null;
  } catch {
    sessionUserId = null;
  }
  // Nach dem Warten: noch derselbe Bestand, und die Anmeldung gehört genau diesem Konto.
  if (sessionUserId !== origin.userId || getActiveStorageKey() !== storageKey) {
    return { ok: false, reason: 'session_mismatch' };
  }

  const heldIds = new Set(getSyncOutboxSnapshot().filter(isOpenHeldEntry).map((entry) => entry.id));
  const ids = entryIds.filter((id) => heldIds.has(id));
  if (ids.length === 0) return { ok: false, reason: 'nothing_held' };

  const before = getSyncOutboxSnapshot();
  const at = new Date().toISOString();
  const released = releaseHeldOutboxEntries(ids, origin, at);
  if (released.length === 0) return { ok: false, reason: 'nothing_held' };
  if (!persistAll().success) {
    // Ohne gespeicherte Freigabe keine Freigabe: die Warteschlange wie vorher.
    hydrateSyncOutbox(before);
    return { ok: false, reason: 'persist_failed' };
  }
  appendOutboxOriginLog(storageKey, {
    at,
    action: 'released',
    by: origin.userId,
    entries: released.map(toOutboxOriginLogEntity),
  });
  return { ok: true, released: released.length };
}

export async function runSyncFromUi(): Promise<SyncCoordinatorReport> {
  // 01P4C: Netzwerk und anschließende Persistenz sind ein Queue-Lauf; der
  // Snapshot entsteht erst beim tatsächlichen Start.
  return runQueuedSyncOperation(async () => {
    // 01A: Stand beim Start — im selben synchronen Abschnitt wie der Lauf-Snapshot.
    const base = captureSyncRunBase();
    const result = await getSyncCoordinator().runSync(buildPersistedStateSnapshot());
    if (result.skipPersist) {
      return result.report;
    }
    return applySyncPullCandidateSafely({
      state: result.state,
      report: result.report,
      pendingInvoiceIntentClears: result.pendingInvoiceIntentClears,
      pendingAmendmentIntentClears: result.pendingAmendmentIntentClears,
      base,
    }).report;
  });
}

export interface PushOnlySyncResult {
  report: SyncCoordinatorReport;
  /** Ein Versionskonflikt beim Senden: erst ein vollständiger Abgleich zeigt den Cloud-Stand. */
  needsFullSync: boolean;
}

/**
 * SYNC-AUTOMATIK-01A-FIX1 — Anlass „lokale Änderung": nur senden.
 *
 * Derselbe Queue-Lauf und derselbe sichere Apply-Weg wie `runSyncFromUi`:
 * Wird während des Sendens gespeichert, setzt `applySyncPullCandidateSafely`
 * das Ergebnis auf den neueren lokalen Stand (Revisionsprüfung, Rebase), und
 * neu eingereihte Aufträge bleiben offen.
 */
export async function pushPendingChangesFromUi(): Promise<PushOnlySyncResult> {
  return runQueuedSyncOperation(async () => {
    const base = captureSyncRunBase();
    const result = await getSyncCoordinator().runPushOnly(buildPersistedStateSnapshot());
    if (result.skipPersist) {
      return { report: result.report, needsFullSync: result.needsFullSync };
    }
    const applied = applySyncPullCandidateSafely({ state: result.state, report: result.report, base });
    return { report: applied.report, needsFullSync: result.needsFullSync };
  });
}

/**
 * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — direkt nach dem Einrichtungsassistenten
 * einmalig in die Cloud sichern. Reihenfolge bleibt: Workspace ermitteln und
 * pullen (Bootstrap), erst danach die lokalen Firmendaten hochladen.
 *
 * Ein Doppelklick startet keinen zweiten Lauf: der laufende Versuch wird geteilt.
 */
let afterSetupSyncPromise: Promise<CloudBackupOutcome> | null = null;

export interface CloudBackupOutcome {
  /** True, wenn Firmendaten weiterhin nur lokal liegen. */
  pending: boolean;
  reason?: string;
}

export async function syncCompanyDataAfterSetup(): Promise<CloudBackupOutcome> {
  if (afterSetupSyncPromise) return afterSetupSyncPromise;

  afterSetupSyncPromise = (async (): Promise<CloudBackupOutcome> => {
    if (!isSupabaseConfigured()) {
      return { pending: hasPendingCompanyCloudBackup(), reason: 'not_configured' };
    }
    const bootstrap = await bootstrapWorkspaceCloudSyncIfNeeded();
    if (bootstrap.status === 'failed') {
      return { pending: hasPendingCompanyCloudBackup(), reason: bootstrap.reason ?? 'bootstrap' };
    }
    if (isSyncProviderAvailable('supabase')) {
      getSyncCoordinator().setAdapter(createSyncAdapter({ provider: 'supabase' }));
    }
    await runSyncFromUi();
    return { pending: hasPendingCompanyCloudBackup() };
  })();

  try {
    return await afterSetupSyncPromise;
  } catch (error) {
    return {
      pending: hasPendingCompanyCloudBackup(),
      reason: error instanceof Error ? error.message : 'unknown',
    };
  } finally {
    afterSetupSyncPromise = null;
  }
}

export async function retrySyncFromUi(): Promise<SyncCoordinatorReport> {
  // 01P4C: derselbe Queue-Vertrag wie in runSyncFromUi.
  return runQueuedSyncOperation(async () => {
    /*
     * FINANZ-SYNC-BLOCKER-01B — dieser Weg beginnt immer an einem Knopf, den
     * ein Mensch gedrückt hat. Das automatische Limit gilt für Selbstläufe, und
     * ein ausdrücklicher Versuch muss auch danach noch etwas bewirken.
     */
    const base = captureSyncRunBase();
    const result = await getSyncCoordinator().retrySync(buildPersistedStateSnapshot(), {
      manual: true,
    });
    if (result.skipPersist) {
      return result.report;
    }
    return applySyncPullCandidateSafely({
      state: result.state,
      report: result.report,
      pendingInvoiceIntentClears: result.pendingInvoiceIntentClears,
      pendingAmendmentIntentClears: result.pendingAmendmentIntentClears,
      base,
    }).report;
  });
}

export function shortenSyncId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/* -------------------------------------------------------------------------- */
/* REAL-PRODUCT-TEST-01D — verständlicher Gesamtstatus                        */
/* -------------------------------------------------------------------------- */

export type SyncStatusKind =
  | 'offline'
  | 'syncing'
  | 'failed'
  /** 01G — es steht eine Entscheidung aus; das ist kein Fehler. */
  | 'conflict'
  /** DOKUMENTE-01 R2 — zurückgehaltene Aufträge warten auf eine bewusste Prüfung und Freigabe. */
  | 'held'
  | 'waiting'
  | 'synced'
  | 'idle';

export interface SyncStatusSummary {
  /** 01G — blockierte Auftraege, die auf eine Entscheidung warten. */
  conflictCount: number;
  kind: SyncStatusKind;
  /** Änderungen, die noch nicht übertragen sind (ausstehend oder wartend). */
  waitingCount: number;
  /** Änderungen, deren Übertragung fehlgeschlagen ist. */
  failedCount: number;
  /** Im letzten Lauf automatisch behandelte Konflikte. */
  mergedCount: number;
  /** DOKUMENTE-01 R2 — zurückgehaltene Aufträge; fehlt bei null. */
  heldCount?: number;
}

const SYNCING: SyncState[] = ['checking', 'uploading', 'downloading', 'merging'];

/**
 * Der Engine-Zustand `synced` heißt nur: Der letzte Lauf hatte keine
 * fehlgeschlagene Sendung. Wartende Einträge und automatisch behandelte
 * Konflikte sind davon unabhängig — der Nutzer muss sie trotzdem sehen.
 * Reine Ableitung aus dem Snapshot, keine Änderung an der Engine.
 */
export function summarizeSyncStatus(
  snapshot: Pick<SyncUiSnapshot, 'status' | 'outbox' | 'lastReport' | 'isOffline'> &
    Partial<
      Pick<SyncUiSnapshot, 'settingsConflict' | 'documentConflicts' | 'employeeConflicts' | 'offerConflicts' | 'customerConflicts'>
    >,
): SyncStatusSummary {
  /*
   * 07B-FIX3B — ein entscheidbarer Dokumentkonflikt wartet nicht, er braucht
   * eine Entscheidung. Er zählt deshalb nur als Konflikt, nicht zusätzlich als
   * „1 Änderung wartet".
   */
  const documentConflicts = snapshot.documentConflicts ?? [];
  const employeeConflicts = snapshot.employeeConflicts ?? [];
  const offerConflicts = snapshot.offerConflicts ?? [];
  const customerConflicts = snapshot.customerConflicts ?? [];
  const decidable = new Set(
    [...documentConflicts, ...employeeConflicts, ...offerConflicts, ...customerConflicts].map(
      (conflict) => conflict.outboxId,
    ),
  );
  /* Nur-lokale Entitäten (z. B. Papierregister, Gedächtnis) warten auf nichts — sie werden nie gesendet. */
  /* DOKUMENTE-01 R2 — zurückgehaltene Aufträge warten nicht auf den Abgleich, sondern auf eine Freigabe. */
  const waitingCount = snapshot.outbox.filter(
    (entry) =>
      (entry.status === 'pending' || entry.status === 'blocked') &&
      isSupabaseSyncAllowed(entry.entityType) &&
      !decidable.has(entry.id) &&
      !isOutboxEntryHeld(entry),
  ).length;
  const failedCount = snapshot.outbox.filter(
    (entry) => (entry.status === 'error' || entry.status === 'failed') && !isOutboxEntryHeld(entry),
  ).length;
  const heldCount = snapshot.outbox.filter(isOpenHeldEntry).length;
  /*
   * FINANZ-SYNC-BLOCKER-01G — ein Konflikt ist kein technischer Fehler.
   *
   * Vorher stand im Kopf „Fehler", weil der Lauf nach einem Versionskonflikt in
   * den Fehlerzustand ging — während der Fehlerzähler null zeigte, weil ein
   * blockierter Auftrag weder `error` noch `failed` ist. Beides zugleich war
   * für den Betrieb nicht lesbar.
   *
   * Gezählt wird nur, was der Nutzer auch entscheiden **kann**. Ein Auftrag, der
   * im Testmodus blockiert ist oder für den es keine Auflösung gibt, wartet
   * weiterhin — ihn zur „Entscheidung nötig" zu erklären, wäre derselbe
   * halbfertige Zustand, nur an anderer Stelle.
   */
  const conflictCount =
    ((snapshot.settingsConflict?.length ?? 0) > 0
      ? snapshot.outbox.filter(
          (entry) =>
            entry.status === 'blocked' && entry.entityType === 'workspace_settings' && !isOutboxEntryHeld(entry),
        ).length
      : 0) +
    documentConflicts.length +
    employeeConflicts.length +
    offerConflicts.length +
    customerConflicts.length;
  /*
   * 07B-FIX3B — „automatisch zusammengeführt" nur für tatsächlich aufgelöste
   * Konflikte. Ein am Versionskonflikt gescheiterter Push steht im Bericht als
   * `conflict` und wurde bisher ebenfalls als „zusammengeführt" gemeldet —
   * obwohl gerade nichts zusammengeführt, sondern blockiert worden war.
   */
  const conflicts = snapshot.lastReport?.conflicts ?? [];
  const mergedCount =
    conflicts.length > 0
      ? conflicts.filter((conflict) => conflict.resolution !== 'conflict').length
      : snapshot.lastReport?.conflictCount ?? 0;
  const state = snapshot.status.syncState;

  let kind: SyncStatusKind;
  if (snapshot.isOffline) kind = 'offline';
  else if (SYNCING.includes(state)) kind = 'syncing';
  else if (failedCount > 0 || (state === 'error' && conflictCount === 0)) kind = 'failed';
  else if (conflictCount > 0) kind = 'conflict';
  else if (heldCount > 0) kind = 'held';
  else if (state === 'error') kind = 'failed';
  else if (state === 'synced') kind = waitingCount > 0 ? 'waiting' : 'synced';
  else kind = 'idle';

  return { kind, waitingCount, failedCount, mergedCount, conflictCount, ...(heldCount > 0 ? { heldCount } : {}) };
}

/**
 * FINANZ-SYNC-BLOCKER-01B — die Entscheidung des Nutzers zu den
 * Betriebseinstellungen übernehmen und den blockierten Auftrag freigeben.
 */
/**
 * 07B-FIX3B — die Entscheidung des Nutzers zu einem Dokumentkonflikt. Liest den
 * aktuellen Cloud-Stand, wendet die Entscheidung an und speichert — gesendet
 * wird danach über den normalen Sync (bei „Änderungen behalten").
 */
export async function resolveArchivedDocumentConflictFromUi(
  documentId: string,
  decision: ArchivedDocumentDecision,
): Promise<ArchivedDocumentConflictResult> {
  return resolveArchivedDocumentConflict(documentId, decision);
}

/** P1 MITARBEITERZAHLUNGEN — dieselbe Entscheidung für einen Mitarbeiterkonflikt. */
export async function resolveEmployeeConflictFromUi(
  employeeId: string,
  decision: EmployeeConflictDecision,
): Promise<EmployeeConflictResult> {
  return resolveEmployeeConflict(employeeId, decision);
}

/** FINANZ-CORE-01A (ANG-03) — dieselbe Entscheidung für einen Angebotskonflikt. */
export async function resolveOfferConflictFromUi(
  offerId: string,
  decision: OfferConflictDecision,
): Promise<OfferConflictResult> {
  return resolveOfferConflict(offerId, decision);
}

/** FINANZ-CORE-01A (WEISS-Nacharbeit N04) — dieselbe Entscheidung für einen Kundenkonflikt. */
export async function resolveCustomerConflictFromUi(
  customerId: string,
  decision: CustomerConflictDecision,
): Promise<CustomerConflictResult> {
  return resolveCustomerConflict(customerId, decision);
}

/**
 * FINANZ-CORE-01A (Bericht 20) — „Bewusst erneut senden“ an einer endgültig abgewiesenen Mitarbeiterzahlung oder
 * Kontierung. Erst speichern, dann melden (wie bei den Einstellungen); gesendet wird beim nächsten Abgleich.
 */
export function resendFinallyDeniedEntryFromUi(entryId: string): boolean {
  const neu = resendFinallyDeniedOutboxEntry(entryId);
  if (neu) persistAll();
  return neu !== null;
}

export function resolveSettingsConflictFromUi(decision: WorkspaceSettingsDecision): boolean {
  const aufgeloest = resolveWorkspaceSettingsConflict(decision);
  /*
   * FINANZ-SYNC-BLOCKER-01G — erst speichern, dann melden.
   *
   * Die Auflösung schrieb bisher nur in die Speicher. Zwischen Klick und dem
   * nächsten Persistenzlauf war der dauerhafte Stand ein anderer als der
   * angezeigte — in der Abnahme sah man den neuen Wert, während gespeichert
   * noch der alte samt blockiertem Auftrag stand. Eine Erfolgsmeldung darf
   * nicht vor dem Zustandswechsel kommen.
   */
  if (aufgeloest) persistAll();
  return aufgeloest;
}
