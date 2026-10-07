/**
 * CLOUD-SYNC S5 — die Brücke zwischen dem lokalen Entwurfskern (IndexedDB) und
 * dem Workspace-Spiegel des Cloud-Entwurfs.
 *
 * Grundsätze:
 *  - Der lokale Speicher bleibt zuerst sicher. Gespiegelt wird ausschliesslich
 *    ein Stand, den der Entwurfskern bereits dauerhaft bestätigt hat — nie
 *    davor, nie stattdessen. Ein fehlendes Netz blockiert keinen lokalen Edit.
 *  - Nur der fachliche Kern reist (`stripInvoiceDraftForCloud`). Eine reine
 *    IndexedDB-Änderung (Revision, Zeitstempel, Hash, Auffrischung der
 *    Auftragsprojektion) ändert den Kern nicht und erzeugt keinen Push.
 *  - Kein Last-Write-Wins in keine Richtung. Ob der lokale Stand seit dem
 *    letzten Abgleich verändert wurde, belegt `localLink`; ob der Spiegel seither
 *    einen fremden Stand trägt, belegt der Vergleich mit derselben Basis. Sind
 *    beide verändert, entsteht ein sichtbarer Konflikt mit beiden Ständen.
 *  - Endgültige Cloud-Zustände (verworfen, finalisiert) werden nie
 *    wiederbelebt: Eine Entwurfskennung, die der Spiegel als Grabstein kennt,
 *    wird nie mehr gesendet.
 *  - Keine zweite Sync-Engine: Gesendet wird ausschliesslich über den
 *    Änderungsverfolger und die bestehende Warteschlange.
 *  - Solange die Cloud-Seite nicht freigegeben ist (Migration nicht remote
 *    angewendet), ist der Spiegel ein rein lokaler Schatten der IndexedDB: Er
 *    folgt dem bestätigten Stand, aber es gibt keine Fortsetzung aus dem
 *    Spiegel, keinen Abgleich und keinen Konflikt — die Editoren verhalten
 *    sich wie vor S5.
 */
import type { InvoiceDraft, Vorgang } from '../../types/models';
import type { InvoiceDraftIdentity, InvoiceDraftRecord } from '../../types/invoiceDraftDurability';
import type {
  InvoiceDraftCloudBinding,
  InvoiceDraftCloudConflict,
  InvoiceDraftCloudCore,
  InvoiceDraftCloudEntity,
  InvoiceDraftCloudLocalLink,
} from '../../types/invoiceDraftCloud';
import { INVOICE_DRAFT_LABEL } from '../invoiceNumberService';
import { refreshDraftOrderProjection } from '../invoiceService';
import { getVorgangById } from '../vorgangService';
import { buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import { isSupabaseSyncAllowed } from '../sync/cloudSyncAllowlist';
import { acknowledgeTrackedEntityFromState } from '../sync/syncChangeTrackerService';
import {
  getSyncOutboxSnapshot,
  markOutboxEntriesCompleted,
  releaseBlockedOutboxEntry,
} from '../sync/syncOutboxService';
import {
  createInvoiceDraftRecord,
  deleteInvoiceDraftRecord,
  listInvoiceDraftRecordsForWorkspace,
  saveInvoiceDraftRecord,
} from './invoiceDraftDurabilityService';
import {
  buildInvoiceDraftCoreKey,
  buildInvoiceDraftCoreKeyFromDraft,
  isInvoiceDraftCloudTombstone,
  stripInvoiceDraftForCloud,
} from './invoiceDraftCloudService';
import {
  getInvoiceDraftCloudEntity,
  getInvoiceDraftCloudSnapshot,
  listInvoiceDraftCloudEntitiesForSlot,
  putInvoiceDraftCloudEntity,
  registerInvoiceDraftCloudStoreResetHook,
  removeInvoiceDraftCloudEntity,
} from './invoiceDraftCloudStore';
import { getActiveStorageScope } from '../storage/storageScopeService';
import { buildDocumentBlobScopeKey } from '../storage/documentBlobScopeService';
import { clearReverseChargeConfirmation } from './reverseChargeConfirmationService';

/** Bündelung der Spiegelung: ein Tastendruck ist kein Sendeauftrag. */
export const INVOICE_DRAFT_MIRROR_DEBOUNCE_MS = 1200;

/** Ob die Cloud-Seite freigegeben ist (Migration remote angewendet). */
export function isInvoiceDraftCloudSyncAllowed(): boolean {
  return isSupabaseSyncAllowed('invoice_draft');
}

/**
 * Der Spiegel gehört zum aktiven Speicherbereich. Ein Entwurf eines anderen
 * Bereichs — etwa ein nach einem Workspace-Wechsel noch gebündelter Commit —
 * wird nie hineingeschrieben; sonst landete er im Spiegel des neuen Workspace.
 * Dieselbe Ableitung wie in beiden Editoren und im Preflight.
 */
function belongsToActiveScope(record: Pick<InvoiceDraftRecord, 'sourceScopeKey'>): boolean {
  try {
    return record.sourceScopeKey === buildDocumentBlobScopeKey(getActiveStorageScope());
  } catch {
    return false;
  }
}

function detach<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function linkFor(
  record: Pick<InvoiceDraftRecord, 'draftSha256' | 'createdAt' | 'revision'>,
  draft: InvoiceDraft,
): InvoiceDraftCloudLocalLink {
  return {
    draftSha256: record.draftSha256,
    coreKey: buildInvoiceDraftCoreKeyFromDraft(draft),
    recordCreatedAt: record.createdAt,
    revision: record.revision,
  };
}

function sameLink(a: InvoiceDraftCloudLocalLink | undefined, b: InvoiceDraftCloudLocalLink): boolean {
  return (
    Boolean(a) &&
    a!.draftSha256 === b.draftSha256 &&
    a!.coreKey === b.coreKey &&
    a!.recordCreatedAt === b.recordCreatedAt &&
    a!.revision === b.revision
  );
}

/**
 * Rang eines lokalen Stands gegenüber dem zuletzt gespiegelten. Jünger ist eine
 * später angelegte Datensatz-Linie (z. B. nach verlorener IndexedDB) oder eine
 * höhere Revision derselben Linie. Älter — oder gleichrangig mit anderem
 * Inhalt — ist veraltet: Der erste Stand bleibt, der Spiegel wird nie
 * zwischen zwei Editoren hin- und hergeschrieben.
 */
function rankAgainstLink(
  known: InvoiceDraftCloudLocalLink | undefined,
  next: InvoiceDraftCloudLocalLink,
): 'newer' | 'same' | 'stale' {
  if (!known || known.recordCreatedAt === undefined || known.revision === undefined) return 'newer';
  const createdAt = next.recordCreatedAt ?? '';
  if (createdAt !== known.recordCreatedAt) return createdAt > known.recordCreatedAt ? 'newer' : 'stale';
  const revision = next.revision ?? 0;
  if (revision !== known.revision) return revision > known.revision ? 'newer' : 'stale';
  return next.draftSha256 === known.draftSha256 ? 'same' : 'stale';
}

/** Aktive Sendeaufträge eines Entwurfs (ausstehend, blockiert, fehlerhaft). */
function activeOutboxEntries(draftId: string) {
  return getSyncOutboxSnapshot().filter(
    (entry) =>
      entry.entityType === 'invoice_draft' &&
      entry.entityId === draftId &&
      (entry.status === 'pending' || entry.status === 'blocked' || entry.status === 'error'),
  );
}

/** Kennung des aktiven Slot-Inhabers aus der letzten Serverabweisung, falls vorhanden. */
function slotOwnerFromOutbox(draftId: string): string | undefined {
  for (const entry of activeOutboxEntries(draftId)) {
    const match = /invoice_draft_slot:([^\s"']+)/.exec(entry.lastErrorMessage ?? '');
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Speichert den Spiegel. `acknowledge` nennt Entwürfe, deren Änderung einen
 * bereits bekannten Serverstand übernimmt: Sie werden vor dem Speichern als
 * abgeglichen quittiert und erzeugen keinen Sendeauftrag.
 */
function persistMirror(acknowledge: string[] = []): void {
  if (acknowledge.length > 0) {
    const snapshot = buildPersistedStateSnapshot();
    for (const id of acknowledge) acknowledgeTrackedEntityFromState(snapshot, 'invoice_draft', id);
  }
  persistAll();
}

/* -------------------------------------------------------------------------- */
/* Rehydrierung: Cloud-Kern → vollständiger Editor-Entwurf                     */
/* -------------------------------------------------------------------------- */

/**
 * Baut aus dem Cloud-Kern einen vollständigen Entwurf. Die ableitbaren Werte
 * entstehen genau so neu, wie es der Entwurfskern beim Laden ohnehin tut
 * (`refreshDraftOrderProjection`): Plan-, Ist-, abgerechnete und offene Menge
 * aus dem aktuellen Auftrag, Abschlagsabzüge aus dem aktuellen
 * Rechnungsbestand. Eingefrorenes bleibt eingefroren — es wird nichts aus dem
 * Profil dieses Geräts neu gebaut.
 *
 * Das Legacy-Logo ist gerätelokal: Es kommt nur aus einem lokalen Vorgänger
 * desselben Entwurfs, nie aus der Cloud.
 */
export function rehydrateInvoiceDraftFromCloudCore(
  core: InvoiceDraftCloudCore,
  options: { vorgang?: Vorgang | null; localBase?: InvoiceDraft | null } = {},
): InvoiceDraft {
  const base = detach(core);
  const companySnapshot = { ...base.companySnapshot };
  const legacyLogo = options.localBase?.companySnapshot?.logoDataUrl;
  if (typeof legacyLogo === 'string' && legacyLogo.length > 0) {
    companySnapshot.logoDataUrl = legacyLogo;
  }
  const draft: InvoiceDraft = {
    ...base,
    positions: base.positions.map((position) => ({ ...position })),
    companySnapshot,
    previousAbschlagDeductions: [],
    invoiceNumberPreview: INVOICE_DRAFT_LABEL,
  };
  const vorgang =
    options.vorgang !== undefined
      ? options.vorgang
      : draft.vorgangId !== null
        ? (getVorgangById(draft.vorgangId) ?? null)
        : null;
  if (!vorgang) return draft;
  return refreshDraftOrderProjection(draft, vorgang).draft;
}

/* -------------------------------------------------------------------------- */
/* Lokaler Commit → Spiegel                                                    */
/* -------------------------------------------------------------------------- */

export type InvoiceDraftMirrorOutcome =
  | 'skipped'
  | 'created'
  | 'mirrored'
  | 'in_sync'
  | 'cloud_newer'
  | 'conflict'
  | 'blocked'
  /** Ein älterer lokaler Stand als der zuletzt gespiegelte — er berührt den Spiegel nicht. */
  | 'stale';

function activeSlotOwner(entity: Pick<InvoiceDraftCloudEntity, 'id' | 'vorgangId' | 'invoiceType'>): InvoiceDraftCloudEntity | null {
  return (
    listInvoiceDraftCloudEntitiesForSlot(entity.vorgangId, entity.invoiceType).find(
      (other) => other.id !== entity.id && !isInvoiceDraftCloudTombstone(other) && (other.sync?.version ?? 0) > 0,
    ) ?? null
  );
}

/**
 * Überträgt einen **bestätigten** lokalen Stand in den Spiegel, sofern sich der
 * fachliche Kern geändert hat. Synchron; speichert nur, wenn sich etwas ändert.
 */
export function applyLocalDraftCommitToMirror(
  record: InvoiceDraftRecord,
  draft: InvoiceDraft,
  now: string = new Date().toISOString(),
): InvoiceDraftMirrorOutcome {
  if (record.status !== 'active' || draft.id !== record.draftId || !belongsToActiveScope(record)) return 'skipped';

  const link = linkFor(record, draft);
  const entity = getInvoiceDraftCloudEntity(record.draftId);

  if (!entity) {
    const created: InvoiceDraftCloudEntity = {
      id: record.draftId,
      vorgangId: record.vorgangId,
      invoiceType: record.invoiceType,
      status: 'active',
      core: stripInvoiceDraftForCloud(draft),
      localLink: link,
    };
    // Slot belegt: sichtbarer Konflikt statt eines Versuchs, den der Server abweist — nur mit Cloud-Wahrheit.
    const owner = isInvoiceDraftCloudSyncAllowed() ? activeSlotOwner(created) : null;
    if (owner) {
      created.conflict = { kind: 'slot', detectedAt: now, slotDraftId: owner.id };
    }
    putInvoiceDraftCloudEntity(created);
    persistMirror();
    return owner ? 'conflict' : 'created';
  }

  // Ein beendeter oder umstrittener Entwurf wird nicht weiter gespiegelt.
  if (isInvoiceDraftCloudTombstone(entity) || entity.conflict) return 'blocked';

  const relation = classifyAgainstMirror(entity, link);
  if (relation === 'stale') return 'stale';
  if (relation === 'in_sync') {
    if (!sameLink(entity.localLink, link)) {
      putInvoiceDraftCloudEntity({ ...entity, localLink: link });
      persistMirror();
    }
    return 'in_sync';
  }
  /*
   * Ohne freigegebene Cloud-Seite ist der Spiegel ein rein lokaler Schatten der
   * IndexedDB — es gibt keine fremde Fassung, gegen die abzuwägen wäre: Der
   * bestätigte lokale Stand gilt.
   */
  if (relation === 'local_newer' || !isInvoiceDraftCloudSyncAllowed()) {
    putInvoiceDraftCloudEntity({ ...entity, core: stripInvoiceDraftForCloud(draft), localLink: link });
    persistMirror();
    return 'mirrored';
  }
  // Lokal unverändert, der Spiegel trägt eine neuere Serverfassung.
  if (relation === 'cloud_newer') return 'cloud_newer';
  markVersionConflict(entity, now);
  return 'conflict';
}

/**
 * Wie der bestätigte lokale Stand zum Spiegel steht — rein lesend.
 *
 *  - `stale`        ein älterer Stand als der zuletzt gespiegelte (veralteter Editor)
 *  - `in_sync`      derselbe fachliche Kern
 *  - `local_newer`  nur lokal verändert: der Speicherweg spiegelt ihn
 *  - `cloud_newer`  lokal unverändert, der Spiegel trägt eine neuere Serverfassung
 *  - `conflict`     beide Seiten verändert (oder keine belegbare Basis)
 */
function classifyAgainstMirror(
  entity: InvoiceDraftCloudEntity,
  link: InvoiceDraftCloudLocalLink,
): 'stale' | 'in_sync' | 'local_newer' | 'cloud_newer' | 'conflict' {
  if (rankAgainstLink(entity.localLink, link) === 'stale') return 'stale';
  const mirrorKey = entity.core ? buildInvoiceDraftCoreKey(entity.core) : '';
  if (mirrorKey === link.coreKey) return 'in_sync';
  const base = entity.localLink?.coreKey;
  const neverSynced = (entity.sync?.version ?? 0) === 0;
  if (base === mirrorKey || (base === undefined && neverSynced)) return 'local_newer';
  if (base !== undefined && link.coreKey === base) return 'cloud_newer';
  return 'conflict';
}

/** Hält beide Stände fest — einmalig: ein vermerkter Konflikt wird nicht erneut geschrieben. */
function markVersionConflict(entity: InvoiceDraftCloudEntity, now: string): InvoiceDraftCloudConflict {
  const conflict: InvoiceDraftCloudConflict = {
    kind: 'version',
    detectedAt: now,
    remote: {
      rowVersion: entity.sync?.version ?? 0,
      status: entity.status,
      deleted: entity.sync?.deleted === true,
      core: entity.core ? detach(entity.core) : null,
    },
  };
  putInvoiceDraftCloudEntity({ ...entity, conflict });
  persistMirror();
  return conflict;
}

const pendingCommits = new Map<string, { record: InvoiceDraftRecord; draft: InvoiceDraft }>();
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function dropPendingCommits(): void {
  pendingCommits.clear();
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
}

// Wird der Spiegel zurückgesetzt (Bereichswechsel, Abmelden), verfallen auch die wartenden Commits.
registerInvoiceDraftCloudStoreResetHook(dropPendingCommits);

/**
 * Vom Entwurfskern nach jedem bestätigten Speichern gemeldet. Gebündelt: Der
 * Spiegel folgt dem letzten bestätigten Stand nach kurzer Ruhe, beim
 * Verlassen des Editors und vor der Freigabe sofort.
 */
export function noteInvoiceDraftCommitted(record: InvoiceDraftRecord, draft: InvoiceDraft): void {
  if (record.status !== 'active') return;
  pendingCommits.set(record.draftId, { record: { ...record }, draft: detach(draft) });
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    flushInvoiceDraftCloudMirror();
  }, INVOICE_DRAFT_MIRROR_DEBOUNCE_MS);
}

/** Überträgt alle (oder genau einen) gebündelten lokalen Stände sofort in den Spiegel. */
export function flushInvoiceDraftCloudMirror(draftId?: string): InvoiceDraftMirrorOutcome[] {
  const ids = draftId !== undefined ? [draftId] : [...pendingCommits.keys()];
  const outcomes: InvoiceDraftMirrorOutcome[] = [];
  for (const id of ids) {
    const pending = pendingCommits.get(id);
    if (!pending) continue;
    pendingCommits.delete(id);
    try {
      outcomes.push(applyLocalDraftCommitToMirror(pending.record, pending.draft));
    } catch {
      // Der Spiegel darf den lokalen Arbeitsstand nie gefährden; der nächste Commit versucht es erneut.
      outcomes.push('skipped');
    }
  }
  if (pendingCommits.size === 0 && pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  return outcomes;
}

export function resetInvoiceDraftCloudBridgeForTests(): void {
  dropPendingCommits();
  backfillDone.clear();
}

/* -------------------------------------------------------------------------- */
/* Öffnen eines Slots                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Fall B — nur in der Cloud: Für einen leeren lokalen Slot liefert der Spiegel
 * den aktiven Entwurf, sofern es einen gibt. Der Editor legt ihn dann mit
 * **derselben** Entwurfskennung lokal an, statt still einen neuen zu beginnen.
 */
export function resolveCloudDraftForEmptySlot(
  vorgangId: string | null,
  invoiceType: InvoiceDraftRecord['invoiceType'],
): InvoiceDraft | null {
  // Ohne freigegebene Cloud-Seite beginnt ein leerer Slot wie bisher neu.
  if (!isInvoiceDraftCloudSyncAllowed()) return null;
  const active = listInvoiceDraftCloudEntitiesForSlot(vorgangId, invoiceType).filter(
    (entity) => !isInvoiceDraftCloudTombstone(entity) && entity.core && !entity.conflict,
  );
  if (active.length !== 1) return null;
  return rehydrateInvoiceDraftFromCloudCore(active[0]!.core!);
}

/** Nach dem lokalen Anlegen aus der Cloud: die Basis festhalten (kein Push). */
export function linkCreatedDraftToCloud(record: InvoiceDraftRecord, draft: InvoiceDraft): void {
  if (!belongsToActiveScope(record)) return;
  const entity = getInvoiceDraftCloudEntity(record.draftId);
  if (!entity || isInvoiceDraftCloudTombstone(entity)) return;
  const link = linkFor(record, draft);
  if (sameLink(entity.localLink, link) || rankAgainstLink(entity.localLink, link) === 'stale') return;
  putInvoiceDraftCloudEntity({ ...entity, localLink: link });
  persistMirror();
}

export type InvoiceDraftCloudOpenDecision =
  | { kind: 'none' }
  /** Fall D — Cloud neuer, lokal unverändert: der Editor übernimmt still und sicher. */
  | { kind: 'adopt_remote'; draft: InvoiceDraft }
  /** Fälle E–H — sichtbarer Konflikt. */
  | { kind: 'conflict'; draftId: string; conflict: InvoiceDraftCloudConflict };

/**
 * Abgleich beim Öffnen eines lokal vorhandenen Entwurfs — und erneut, sobald
 * sich der Cloud-Zustand dieses Entwurfs ändert. Er spiegelt nichts und legt
 * nichts an; geschrieben wird allein über den Speicherweg. Nur ein Konflikt
 * oder ein Ende wird einmalig am Spiegel vermerkt.
 *
 *  - A  nur lokal          → nichts hier: der Speicherweg spiegelt ihn (das
 *                            Öffnen meldet den Stand als bestätigt), sonst der Altbestand
 *  - C  identisch          → nichts
 *  -    veralteter Editor  → nichts (ein jüngerer lokaler Stand ist bereits gespiegelt)
 *  - D  Cloud neuer, lokal sauber → Übernahme
 *  - E  beide verändert    → Konflikt
 *  - F  verworfen          → Konflikt (sichtbarer Hinweis, nie still gelöscht)
 *  - G  finalisiert        → Konflikt (sichtbarer Hinweis)
 *  - H  Slot belegt        → Konflikt
 */
export function reconcileInvoiceDraftOnOpen(input: {
  record: InvoiceDraftRecord;
  draft: InvoiceDraft;
  vorgang?: Vorgang | null;
  now?: string;
}): InvoiceDraftCloudOpenDecision {
  const { record, draft } = input;
  const now = input.now ?? new Date().toISOString();
  if (record.status !== 'active' || !isInvoiceDraftCloudSyncAllowed() || !belongsToActiveScope(record)) {
    return { kind: 'none' };
  }

  const entity = getInvoiceDraftCloudEntity(record.draftId);
  // Noch nie gespiegelt: Das übernimmt der Speicherweg (das Öffnen meldet den Stand als bestätigt).
  if (!entity) return { kind: 'none' };

  if (entity.conflict) return { kind: 'conflict', draftId: entity.id, conflict: entity.conflict };

  if (isInvoiceDraftCloudTombstone(entity)) {
    const conflict: InvoiceDraftCloudConflict = {
      kind: entity.status === 'finalized' ? 'finalized' : 'deleted',
      detectedAt: now,
      remote: {
        rowVersion: entity.sync?.version ?? 0,
        status: entity.status,
        deleted: entity.sync?.deleted === true,
        core: null,
        ...(entity.finalizedClientInvoiceId ? { finalizedClientInvoiceId: entity.finalizedClientInvoiceId } : {}),
      },
    };
    putInvoiceDraftCloudEntity({ ...entity, conflict });
    persistMirror();
    return { kind: 'conflict', draftId: entity.id, conflict };
  }

  // Rein lesend — ein lokal neuerer Stand wird vom Speicherweg gespiegelt, ein veralteter Editor schreibt nie.
  const relation = classifyAgainstMirror(entity, linkFor(record, draft));
  if (relation === 'cloud_newer' && entity.core) {
    return {
      kind: 'adopt_remote',
      draft: rehydrateInvoiceDraftFromCloudCore(entity.core, { vorgang: input.vorgang, localBase: draft }),
    };
  }
  if (relation === 'conflict') {
    return { kind: 'conflict', draftId: entity.id, conflict: markVersionConflict(entity, now) };
  }
  return { kind: 'none' };
}

/**
 * Was ein geöffneter Editor beobachten muss: Serverstand, Ende, Konflikt und
 * Sendezustand **dieses** Entwurfs. Ändert sich nichts davon, gibt es nichts
 * neu abzugleichen — der eigene Speicherweg allein löst keinen Abgleich aus.
 */
export function getInvoiceDraftCloudWatchKey(draftId: string | null): string {
  if (!draftId) return '';
  const entity = getInvoiceDraftCloudEntity(draftId);
  const outbox = activeOutboxEntries(draftId);
  // Dem Spiegel unbekannt (noch nie gespiegelt, oder nach Bereichswechsel geleert): nichts abzugleichen.
  if (!entity && outbox.length === 0) return '';
  return JSON.stringify([
    entity ? entity.status : null,
    entity?.sync?.version ?? null,
    entity?.sync?.deleted ?? null,
    entity?.finalizedClientInvoiceId ?? null,
    entity?.conflict?.kind ?? null,
    entity?.conflict?.slotDraftId ?? null,
    outbox.map((entry) => [entry.status, entry.lastErrorMessage ?? '']),
  ]);
}

/** Ein offener Konflikt am Spiegel, für die Anzeige. */
export function getInvoiceDraftCloudConflict(draftId: string): InvoiceDraftCloudConflict | null {
  if (!isInvoiceDraftCloudSyncAllowed()) return null;
  const entity = getInvoiceDraftCloudEntity(draftId);
  if (!entity) return null;
  if (entity.conflict) return entity.conflict;
  // Eine Serverabweisung „Slot belegt" vor dem ersten Abgleich.
  const owner = slotOwnerFromOutbox(draftId);
  if (owner) return { kind: 'slot', detectedAt: new Date().toISOString(), slotDraftId: owner };
  return null;
}

/* -------------------------------------------------------------------------- */
/* Entscheidungen des Nutzers                                                  */
/* -------------------------------------------------------------------------- */

export type InvoiceDraftCloudDecisionResult =
  | { ok: true; reload: boolean; finalizedInvoiceId?: string }
  | { ok: false; reason: 'no_conflict' | 'not_allowed' | 'storage' | 'slot_taken' | 'remote_missing' };

function completeActiveOutbox(draftId: string): void {
  const ids = activeOutboxEntries(draftId).map((entry) => entry.id);
  if (ids.length > 0) markOutboxEntriesCompleted(ids);
}

function identityOf(record: InvoiceDraftRecord, draftId = record.draftId): InvoiceDraftIdentity {
  return {
    sourceScopeKey: record.sourceScopeKey,
    workspaceId: record.workspaceId,
    vorgangId: record.vorgangId,
    invoiceType: record.invoiceType,
    draftId,
  };
}

function clearConfirmation(record: InvoiceDraftRecord): void {
  try {
    clearReverseChargeConfirmation({
      sourceScopeKey: record.sourceScopeKey,
      vorgangId: record.vorgangId,
      invoiceType: record.invoiceType,
      draftId: record.draftId,
    });
  } catch {
    /* eine fehlende Bestätigung ist der sichere Zustand */
  }
}

/**
 * „Cloud-Fassung übernehmen" — die lokale Fassung wird kontrolliert ersetzt:
 * über den regulären Speicherweg mit Revisionsprüfung, die ableitbaren Werte
 * neu berechnet, die §13b-Bestätigung **nicht** übernommen (sie ist an den
 * lokalen Rohtext gebunden und verfällt mit ihm).
 */
export async function takeCloudDraftVersion(
  record: InvoiceDraftRecord,
  localDraft: InvoiceDraft,
): Promise<InvoiceDraftCloudDecisionResult> {
  const entity = getInvoiceDraftCloudEntity(record.draftId);
  const remote = entity?.conflict?.kind === 'version' ? entity.conflict.remote : undefined;
  if (!entity || !remote) return { ok: false, reason: 'no_conflict' };
  if (!remote.core) return { ok: false, reason: 'remote_missing' };

  const draft = rehydrateInvoiceDraftFromCloudCore(remote.core, { localBase: localDraft });
  const saved = await saveInvoiceDraftRecord({ identity: identityOf(record), draft, expectedRevision: record.revision });
  if (!saved.ok) return { ok: false, reason: 'storage' };

  putInvoiceDraftCloudEntity({
    id: entity.id,
    vorgangId: entity.vorgangId,
    invoiceType: entity.invoiceType,
    status: remote.status,
    core: detach(remote.core),
    localLink: linkFor(saved.record, draft),
    sync: {
      ...(entity.sync ?? { updatedAt: new Date().toISOString(), deviceId: '', workspaceId: record.workspaceId }),
      version: remote.rowVersion,
      deleted: false,
      updatedAt: new Date().toISOString(),
    },
  });
  completeActiveOutbox(entity.id);
  persistMirror([entity.id]);
  clearConfirmation(record);
  return { ok: true, reload: true };
}

/**
 * „Meine Fassung behalten" — ein bewusster neuer Schreibversuch gegen die
 * zuletzt geladene Serverversion. Kein Überschreiben auf Verdacht: Hat sich
 * der Server inzwischen erneut bewegt, weist er auch diesen Versuch ab.
 * Nur bei einer Fassungsabweichung; ein verworfener oder finalisierter
 * Entwurf wird nie mit derselben Kennung wieder aktiv.
 */
export function keepLocalDraftVersion(
  record: InvoiceDraftRecord,
  localDraft: InvoiceDraft,
): InvoiceDraftCloudDecisionResult {
  const entity = getInvoiceDraftCloudEntity(record.draftId);
  const remote = entity?.conflict?.kind === 'version' ? entity.conflict.remote : undefined;
  if (!entity || !remote) return { ok: false, reason: 'no_conflict' };
  if (remote.deleted || remote.status !== 'active') return { ok: false, reason: 'not_allowed' };

  const { conflict: _conflict, ...rest } = entity;
  putInvoiceDraftCloudEntity({
    ...rest,
    core: stripInvoiceDraftForCloud(localDraft),
    localLink: linkFor(record, localDraft),
    sync: {
      ...(entity.sync ?? { updatedAt: new Date().toISOString(), deviceId: '', workspaceId: record.workspaceId }),
      version: remote.rowVersion,
      deleted: false,
    },
  });
  releaseBlockedOutboxEntry('invoice_draft', entity.id, remote.rowVersion);
  persistMirror();
  return { ok: true, reload: false };
}

/**
 * Verworfen oder finalisiert auf einem anderen Gerät: Der Nutzer nimmt das
 * Ende zur Kenntnis. Zuerst hält der Spiegel den Grabstein fest (kein Push),
 * erst danach verschwindet der lokale Entwurf — bricht der Ablauf dazwischen
 * ab, meldet der Editor das Ende beim nächsten Öffnen erneut.
 */
export async function acceptCloudDraftEnd(record: InvoiceDraftRecord): Promise<InvoiceDraftCloudDecisionResult> {
  const entity = getInvoiceDraftCloudEntity(record.draftId);
  const conflict = entity?.conflict;
  if (!entity || !conflict || (conflict.kind !== 'deleted' && conflict.kind !== 'finalized')) {
    return { ok: false, reason: 'no_conflict' };
  }
  const remote = conflict.remote;
  putInvoiceDraftCloudEntity({
    id: entity.id,
    vorgangId: entity.vorgangId,
    invoiceType: entity.invoiceType,
    status: remote?.status ?? (conflict.kind === 'finalized' ? 'finalized' : 'active'),
    core: null,
    ...(remote?.finalizedClientInvoiceId ? { finalizedClientInvoiceId: remote.finalizedClientInvoiceId } : {}),
    sync: {
      ...(entity.sync ?? { updatedAt: new Date().toISOString(), deviceId: '', workspaceId: record.workspaceId }),
      version: remote?.rowVersion ?? entity.sync?.version ?? 0,
      deleted: conflict.kind === 'deleted',
    },
  });
  completeActiveOutbox(entity.id);
  persistMirror([entity.id]);

  const deleted = await deleteInvoiceDraftRecord({ identity: identityOf(record), expectedRevision: record.revision });
  if (!deleted.ok && deleted.reason !== 'not_found') return { ok: false, reason: 'storage' };
  clearConfirmation(record);
  return {
    ok: true,
    reload: true,
    ...(remote?.finalizedClientInvoiceId ? { finalizedInvoiceId: remote.finalizedClientInvoiceId } : {}),
  };
}

function newDraftId(): string {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function slotHasOtherActive(entity: Pick<InvoiceDraftCloudEntity, 'id' | 'vorgangId' | 'invoiceType'>): boolean {
  return listInvoiceDraftCloudEntitiesForSlot(entity.vorgangId, entity.invoiceType).some(
    (other) => other.id !== entity.id && !isInvoiceDraftCloudTombstone(other),
  );
}

/**
 * Anderswo verworfen, hier weitergearbeitet: Der lokale Inhalt wird als
 * **neuer** Entwurf mit neuer Kennung fortgesetzt — nie die alte Kennung
 * wiederbelebt, und nur, wenn der Slot frei ist. Der neue Spiegeleintrag wird
 * zuerst gespeichert; bricht der Ablauf danach ab, legt der Editor den neuen
 * Entwurf beim nächsten Öffnen aus dem Spiegel an.
 */
export async function continueDraftAsNew(
  record: InvoiceDraftRecord,
  localDraft: InvoiceDraft,
): Promise<InvoiceDraftCloudDecisionResult> {
  const entity = getInvoiceDraftCloudEntity(record.draftId);
  if (!entity || entity.conflict?.kind !== 'deleted') return { ok: false, reason: 'not_allowed' };
  if (slotHasOtherActive(entity)) return { ok: false, reason: 'slot_taken' };

  const nextId = newDraftId();
  const nextDraft: InvoiceDraft = { ...detach(localDraft), id: nextId };
  const remote = entity.conflict.remote;

  putInvoiceDraftCloudEntity({
    id: entity.id,
    vorgangId: entity.vorgangId,
    invoiceType: entity.invoiceType,
    status: remote?.status ?? 'active',
    core: null,
    sync: {
      ...(entity.sync ?? { updatedAt: new Date().toISOString(), deviceId: '', workspaceId: record.workspaceId }),
      version: remote?.rowVersion ?? entity.sync?.version ?? 0,
      deleted: true,
    },
  });
  putInvoiceDraftCloudEntity({
    id: nextId,
    vorgangId: entity.vorgangId,
    invoiceType: entity.invoiceType,
    status: 'active',
    core: stripInvoiceDraftForCloud(nextDraft),
  });
  completeActiveOutbox(entity.id);
  persistMirror([entity.id]);

  const deleted = await deleteInvoiceDraftRecord({ identity: identityOf(record), expectedRevision: record.revision });
  if (!deleted.ok && deleted.reason !== 'not_found') return { ok: false, reason: 'storage' };
  const created = await createInvoiceDraftRecord({ identity: identityOf(record, nextId), draft: nextDraft });
  if (!created.ok) return { ok: true, reload: true };
  linkCreatedDraftToCloud(created.record, nextDraft);
  clearConfirmation(record);
  return { ok: true, reload: true };
}

/**
 * Slot-Konflikt, „Entwurf des anderen Geräts übernehmen": Der eigene, nie in
 * der Cloud angekommene Entwurf weicht dem aktiven Cloud-Entwurf desselben
 * Slots. Bewusst eine Nutzerentscheidung — der eigene Inhalt geht damit verloren.
 */
export async function adoptSlotOwnerDraft(
  record: InvoiceDraftRecord,
): Promise<InvoiceDraftCloudDecisionResult> {
  const conflict = getInvoiceDraftCloudConflict(record.draftId);
  if (!conflict || conflict.kind !== 'slot' || !conflict.slotDraftId) return { ok: false, reason: 'no_conflict' };
  const owner = getInvoiceDraftCloudEntity(conflict.slotDraftId);
  if (!owner || !owner.core || isInvoiceDraftCloudTombstone(owner)) return { ok: false, reason: 'remote_missing' };

  removeInvoiceDraftCloudEntity(record.draftId);
  completeActiveOutbox(record.draftId);
  persistMirror();

  const deleted = await deleteInvoiceDraftRecord({ identity: identityOf(record), expectedRevision: record.revision });
  if (!deleted.ok && deleted.reason !== 'not_found') return { ok: false, reason: 'storage' };
  const draft = rehydrateInvoiceDraftFromCloudCore(owner.core);
  const created = await createInvoiceDraftRecord({ identity: identityOf(record, owner.id), draft });
  if (created.ok) linkCreatedDraftToCloud(created.record, draft);
  clearConfirmation(record);
  return { ok: true, reload: true };
}

/**
 * Slot-Konflikt, „Meinen Entwurf behalten": Der Cloud-Entwurf des anderen
 * Geräts wird bewusst verworfen (Grabstein, über die bestehende Kette), danach
 * gelangt der eigene über den Altbestand in die Cloud. Nichts wird
 * zusammengeführt.
 */
export function keepOwnDraftDiscardSlotOwner(record: InvoiceDraftRecord): InvoiceDraftCloudDecisionResult {
  const conflict = getInvoiceDraftCloudConflict(record.draftId);
  if (!conflict || conflict.kind !== 'slot' || !conflict.slotDraftId) return { ok: false, reason: 'no_conflict' };
  const owner = getInvoiceDraftCloudEntity(conflict.slotDraftId);
  if (!owner || isInvoiceDraftCloudTombstone(owner)) return { ok: false, reason: 'remote_missing' };

  putInvoiceDraftCloudEntity({
    ...owner,
    sync: {
      ...(owner.sync ?? { updatedAt: new Date().toISOString(), deviceId: '', workspaceId: record.workspaceId, version: 0 }),
      deleted: true,
    },
  });
  const own = getInvoiceDraftCloudEntity(record.draftId);
  if (own) {
    const { conflict: _conflict, ...rest } = own;
    putInvoiceDraftCloudEntity(rest);
  }
  completeActiveOutbox(record.draftId);
  persistMirror();
  return { ok: true, reload: false };
}

/**
 * Sichtbares „Entwurf verwerfen" (confirm-first im Editor). Erzeugt einen
 * Grabstein — keine Rechnung wird berührt. Reihenfolge: erst der Grabstein im
 * Spiegel, dann das lokale Löschen; so kann ein Abbruch dazwischen den Entwurf
 * nie wiederbeleben.
 */
export async function discardInvoiceDraft(
  record: InvoiceDraftRecord,
  draft: InvoiceDraft,
): Promise<InvoiceDraftCloudDecisionResult> {
  if (record.status !== 'active') return { ok: false, reason: 'not_allowed' };
  const entity = getInvoiceDraftCloudEntity(record.draftId);
  if (entity && entity.status === 'finalized') return { ok: false, reason: 'not_allowed' };

  const base: InvoiceDraftCloudEntity = entity ?? {
    id: record.draftId,
    vorgangId: record.vorgangId,
    invoiceType: record.invoiceType,
    status: 'active',
    core: stripInvoiceDraftForCloud(draft),
  };
  const { conflict: _conflict, localLink: _link, ...rest } = base;
  putInvoiceDraftCloudEntity({
    ...rest,
    sync: {
      ...(base.sync ?? { updatedAt: new Date().toISOString(), deviceId: '', workspaceId: record.workspaceId, version: 0 }),
      deleted: true,
      deletedAt: new Date().toISOString(),
    },
  });
  persistMirror();

  const deleted = await deleteInvoiceDraftRecord({ identity: identityOf(record), expectedRevision: record.revision });
  if (!deleted.ok && deleted.reason !== 'not_found') return { ok: false, reason: 'storage' };
  clearConfirmation(record);
  return { ok: true, reload: true };
}

/* -------------------------------------------------------------------------- */
/* Freigabe                                                                    */
/* -------------------------------------------------------------------------- */

export type InvoiceDraftCloudBindingResult =
  | { ok: true; binding: InvoiceDraftCloudBinding | null }
  | { ok: false; reason: 'draft_not_synced' | 'draft_conflict' | 'draft_ended' };

/**
 * Die Bindung der Freigabe an den Cloud-Entwurf. Ohne freigegebene
 * Cloud-Seite gibt es keine (der Server kennt sie noch nicht). Mit ihr muss der
 * Entwurf vollständig angekommen sein: keine offene Übertragung, kein
 * Konflikt, und die Cloud trägt genau diesen fachlichen Kern.
 */
export function resolveInvoiceDraftCloudBinding(draft: InvoiceDraft): InvoiceDraftCloudBindingResult {
  if (!isInvoiceDraftCloudSyncAllowed()) return { ok: true, binding: null };
  const entity = getInvoiceDraftCloudEntity(draft.id);
  if (!entity) return { ok: false, reason: 'draft_not_synced' };
  if (isInvoiceDraftCloudTombstone(entity)) return { ok: false, reason: 'draft_ended' };
  if (entity.conflict) return { ok: false, reason: 'draft_conflict' };
  const version = entity.sync?.version ?? 0;
  if (version < 1 || activeOutboxEntries(entity.id).length > 0 || !entity.core) {
    return { ok: false, reason: 'draft_not_synced' };
  }
  if (buildInvoiceDraftCoreKey(entity.core) !== buildInvoiceDraftCoreKeyFromDraft(draft)) {
    return { ok: false, reason: 'draft_not_synced' };
  }
  return { ok: true, binding: { clientDraftId: entity.id, expectedDraftRowVersion: version } };
}

/**
 * Nach einer abgeschlossenen Freigabe: Der Spiegel hält fest, dass dieser
 * Entwurf zur Rechnung geworden ist — ohne Sendeauftrag. Mit Bindung hat der
 * Server den Entwurf in derselben Transaktion verbraucht (`version + 1`). Ohne
 * Bindung (Altbestand) bleibt der Eintrag rein lokal beendet; kennt die Cloud
 * ihn bereits, wird er dort verworfen, damit kein anderes Gerät ihn erneut
 * zur Rechnung macht.
 */
export function markInvoiceDraftFinalizedInMirror(input: {
  draftId: string;
  finalizedInvoiceId: string;
  binding: InvoiceDraftCloudBinding | null;
}): void {
  const entity = getInvoiceDraftCloudEntity(input.draftId);
  if (!entity || entity.status === 'finalized') return;
  if (input.binding) {
    putInvoiceDraftCloudEntity({
      id: entity.id,
      vorgangId: entity.vorgangId,
      invoiceType: entity.invoiceType,
      status: 'finalized',
      core: null,
      finalizedClientInvoiceId: input.finalizedInvoiceId,
      sync: {
        ...(entity.sync ?? { updatedAt: new Date().toISOString(), deviceId: '', workspaceId: '' }),
        version: input.binding.expectedDraftRowVersion + 1,
        deleted: false,
      },
    });
    completeActiveOutbox(entity.id);
    persistMirror([entity.id]);
    return;
  }
  if ((entity.sync?.version ?? 0) > 0 && isInvoiceDraftCloudSyncAllowed()) {
    const { conflict: _conflict, ...rest } = entity;
    putInvoiceDraftCloudEntity({ ...rest, sync: { ...entity.sync!, deleted: true } });
    persistMirror();
    return;
  }
  putInvoiceDraftCloudEntity({
    id: entity.id,
    vorgangId: entity.vorgangId,
    invoiceType: entity.invoiceType,
    status: 'finalized',
    core: null,
    finalizedClientInvoiceId: input.finalizedInvoiceId,
    ...(entity.sync ? { sync: entity.sync } : {}),
  });
  completeActiveOutbox(entity.id);
  persistMirror([entity.id]);
}

/**
 * Ein lokal abgeschlossener Entwurf (Grabstein `finalized` in der IndexedDB)
 * wird im Spiegel als beendet vermerkt — aus dem Datensatz selbst: Die
 * gespeicherte Vorbereitung belegt, ob die Freigabe an den Cloud-Entwurf
 * gebunden war. Idempotent. Läuft, bevor ein Slot nach dem Abschluss wieder frei
 * wird; sonst könnte der noch aktive Spiegeleintrag den abgeschlossenen
 * Entwurf beim nächsten Öffnen als neuen Entwurf zurückbringen.
 */
export function markInvoiceDraftCloudFromFinalizedRecord(record: InvoiceDraftRecord): void {
  const finalizedInvoiceId = record.finalization?.finalizedInvoiceId;
  if (record.status !== 'finalized' || !finalizedInvoiceId || !belongsToActiveScope(record)) return;
  const entity = getInvoiceDraftCloudEntity(record.draftId);
  if (!entity || entity.status === 'finalized') return;
  let binding: InvoiceDraftCloudBinding | null = null;
  try {
    const preparation = record.preparationRawJson
      ? (JSON.parse(record.preparationRawJson) as { request?: Record<string, unknown> })
      : null;
    const request = preparation?.request;
    const draftId = request?.clientDraftId;
    const version = request?.expectedDraftRowVersion;
    if (typeof draftId === 'string' && typeof version === 'number' && Number.isInteger(version) && version >= 1) {
      binding = { clientDraftId: draftId, expectedDraftRowVersion: version };
    }
  } catch {
    binding = null;
  }
  markInvoiceDraftFinalizedInMirror({ draftId: record.draftId, finalizedInvoiceId, binding });
}

/* -------------------------------------------------------------------------- */
/* Altbestand                                                                  */
/* -------------------------------------------------------------------------- */

const backfillDone = new Set<string>();

/** Öffnet die Entwurfsdatenbank nur, wenn es sie gibt — sonst legte `open()` sie an. */
async function invoiceDraftDatabaseMayExist(): Promise<boolean> {
  try {
    const factory = typeof indexedDB !== 'undefined' ? indexedDB : null;
    if (!factory) return false;
    if (typeof factory.databases !== 'function') return true;
    const list = await factory.databases();
    return list.some((entry) => entry.name === 'officepilot-invoice-drafts');
  } catch {
    return true;
  }
}

export interface InvoiceDraftCloudBackfillReport {
  scanned: number;
  mirrored: number;
  skippedNotActive: number;
  skippedKnown: number;
  skippedInvalid: number;
  conflicts: number;
}

/**
 * Einmaliger Altbestand je Workspace und App-Lauf: aktive lokale Entwürfe, die
 * der Spiegel noch nicht kennt, werden mit ihrer **vorhandenen** Kennung
 * gespiegelt. Gesendet wird mit Version 0 über die bestehende Kette — der
 * Server erkennt eine identische Wiederholung und weist alles andere als
 * Konflikt ab; eine neuere Cloud-Fassung wird nie überschrieben.
 *
 * Nicht übernommen: `finalizing` (laufende Freigabe mit eigenem Journal),
 * `finalized` (Grabstein), fremde Workspaces, und jede Kennung, die der
 * Spiegel bereits kennt — auch als Grabstein.
 */
export async function runInvoiceDraftCloudBackfillOnce(workspaceId: string): Promise<InvoiceDraftCloudBackfillReport | null> {
  if (!workspaceId || backfillDone.has(workspaceId)) return null;
  backfillDone.add(workspaceId);
  const report: InvoiceDraftCloudBackfillReport = {
    scanned: 0,
    mirrored: 0,
    skippedNotActive: 0,
    skippedKnown: 0,
    skippedInvalid: 0,
    conflicts: 0,
  };
  if (!(await invoiceDraftDatabaseMayExist())) return report;

  const listed = await listInvoiceDraftRecordsForWorkspace(workspaceId);
  if (!listed.ok) {
    backfillDone.delete(workspaceId);
    return null;
  }
  report.skippedInvalid = listed.skipped;
  const known = new Set(getInvoiceDraftCloudSnapshot().map((entity) => entity.id));
  for (const { record, draft } of listed.entries) {
    report.scanned += 1;
    if (record.workspaceId !== workspaceId) continue;
    if (record.status !== 'active') {
      report.skippedNotActive += 1;
      continue;
    }
    if (known.has(record.draftId)) {
      report.skippedKnown += 1;
      continue;
    }
    const outcome = applyLocalDraftCommitToMirror(record, draft);
    if (outcome === 'created') report.mirrored += 1;
    if (outcome === 'conflict') report.conflicts += 1;
  }
  return report;
}

export function resetInvoiceDraftCloudBackfillForTests(): void {
  backfillDone.clear();
}
