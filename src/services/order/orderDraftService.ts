/**
 * AUFTRAG-02C — Auftragsentwürfe.
 *
 * Bewusst klein gehalten: Ein Entwurf ist kein Geschäftsobjekt. Er erzeugt
 * keinen Vorgang und verbraucht keine Auftragsnummer. Dadurch kann ein
 * unfertiger Entwurf gar nicht erst wie ein Auftrag wirken: Er taucht in
 * keiner Vorgangsliste und keiner Rechnung auf.
 *
 * Seine Kennung ist zugleich die spätere Vorgangskennung. Sie entsteht genau
 * einmal und überlebt Wiederaufnahme und Retry — daran hängt die Idempotenz
 * der serverseitigen Anlage.
 *
 * CLOUD-SYNC S6 — mit freigegebenem Entwurfs-Sync (`order_draft`) reist der
 * fachliche Inhalt über die bestehende Kette (Änderungsverfolger,
 * Warteschlange); hier selbst gibt es keinen Cloud-Aufruf. Dafür gilt:
 *  - Verwerfen hinterlässt einen Grabstein, solange die Cloud den Entwurf
 *    kennen kann; er verschwindet erst, wenn sie das Verwerfen bestätigt hat.
 *  - Ein offener Konflikt sperrt Bearbeiten und Verwerfen, bis der Nutzer
 *    entschieden hat.
 *  - Verworfen oder verbraucht wird nie mit derselben Kennung wiederbelebt.
 *  - Ein Speicherfehler meldet nie Erfolg.
 * Ohne Freigabe verhält sich alles wie vor S6.
 */
import type {
  OrderDraft,
  OrderDraftBlocker,
  OrderDraftCloudBinding,
  OrderDraftInput,
  OrderDraftPosition,
} from '../../types/orderDraft';
import type { CustomerBilling, OrderUnit, TaxStatus } from '../../types/models';
import type { SyncMeta } from '../../types/sync';
import { generateEntityId } from '../sync/syncMetaService';
import { buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import { getVorgangById } from '../vorgangService';
import { isSupabaseSyncAllowed } from '../sync/cloudSyncAllowlist';
import {
  enqueueSyncOutbox,
  getSyncOutboxSnapshot,
  hydrateSyncOutbox,
  markOutboxEntriesCompleted,
  releaseBlockedOutboxEntry,
} from '../sync/syncOutboxService';
import {
  acknowledgeTrackedEntityFromState,
  captureSyncChangeTrackerState,
  restoreSyncChangeTrackerState,
} from '../sync/syncChangeTrackerService';
import { buildOrderDraftCloudContentKey, isOrderDraftTombstone } from './orderDraftCloudService';

const ORDER_UNITS: readonly OrderUnit[] = ['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal'];

let drafts: OrderDraft[] = [];

function now(): string {
  return new Date().toISOString();
}

function cloneDraft(draft: OrderDraft): OrderDraft {
  return {
    ...draft,
    customerBilling: { ...draft.customerBilling },
    positions: (draft.positions ?? []).map((p) => ({ ...p })),
    ...(draft.sync ? { sync: { ...draft.sync } } : {}),
    ...(draft.conflict ? { conflict: JSON.parse(JSON.stringify(draft.conflict)) as OrderDraft['conflict'] } : {}),
  };
}

export function normalizeOrderDraftPosition(position: Partial<OrderDraftPosition>): OrderDraftPosition {
  const quantity = Number(position.plannedQuantity);
  const unitPrice = Number(position.unitPrice);
  return {
    id: position.id?.trim() || generateEntityId('op'),
    description: (position.description ?? '').trim(),
    plannedQuantity: Number.isFinite(quantity) ? quantity : 0,
    unit: (ORDER_UNITS as readonly string[]).includes(position.unit ?? '')
      ? (position.unit as OrderUnit)
      : 'Stunden',
    unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
  };
}

function normalizeDraft(draft: OrderDraft): OrderDraft {
  return {
    ...draft,
    customerBilling: { ...draft.customerBilling },
    positions: (draft.positions ?? []).map(normalizeOrderDraftPosition),
  };
}

/** CLOUD-SYNC S6 — ob die Cloud-Seite freigegeben ist (Migration remote angewendet). */
export function isOrderDraftCloudSyncAllowed(): boolean {
  return isSupabaseSyncAllowed('order_draft');
}

/** Ein lebender Entwurf — kein Grabstein. */
function isLive(draft: OrderDraft): boolean {
  return !isOrderDraftTombstone(draft);
}

/** Aktive Sendeaufträge eines Entwurfs (ausstehend, blockiert, fehlerhaft). */
function activeOutboxEntries(draftId: string) {
  return getSyncOutboxSnapshot().filter(
    (entry) =>
      entry.entityType === 'order_draft' &&
      entry.entityId === draftId &&
      (entry.status === 'pending' || entry.status === 'blocked' || entry.status === 'error'),
  );
}

/** Ob dieser Entwurf noch eine nicht übertragene Änderung trägt. */
export function hasPendingOrderDraftCloudChange(draftId: string): boolean {
  return activeOutboxEntries(draftId).length > 0;
}

export function getOrderDraftStoreSnapshot(): OrderDraft[] {
  return drafts.map(cloneDraft);
}

export function hydrateOrderDrafts(items: OrderDraft[]): void {
  drafts = (items ?? []).map((item) => normalizeDraft(cloneDraft(item)));
}

export function resetOrderDrafts(): void {
  drafts = [];
}

/**
 * Ändert den Speicher und speichert genau einmal. Scheitert das Speichern,
 * steht alles wieder wie vorher — Entwürfe, Warteschlange und
 * Änderungsverfolger — und der Aufrufer bekommt den Fehler, nie einen
 * scheinbaren Erfolg.
 */
function commit(mutate: () => void, options: { acknowledge?: string[] } = {}): boolean {
  const previous = drafts;
  const outboxBefore = getSyncOutboxSnapshot();
  const trackerBefore = captureSyncChangeTrackerState();
  mutate();
  if (options.acknowledge && options.acknowledge.length > 0) {
    const snapshot = buildPersistedStateSnapshot();
    for (const id of options.acknowledge) acknowledgeTrackedEntityFromState(snapshot, 'order_draft', id);
  }
  const persisted = persistAll();
  if (!persisted.success) {
    drafts = previous;
    hydrateSyncOutbox(outboxBefore);
    restoreSyncChangeTrackerState(trackerBefore);
    return false;
  }
  return true;
}

function completeActiveOutbox(draftId: string): void {
  const ids = activeOutboxEntries(draftId).map((entry) => entry.id);
  if (ids.length > 0) markOutboxEntriesCompleted(ids);
}

/**
 * Entwürfe, deren Auftrag es bereits gibt, sind erledigt — egal ob die eigene
 * Antwort ankam oder der Auftrag erst über einen Pull von einem anderen Gerät
 * eintraf. Der Serverauftrag gewinnt immer; der Entwurf wird nie darüber
 * geschrieben. Entwürfe mit offener Änderung oder offenem Konflikt bleiben —
 * über sie entscheidet der Nutzer.
 */
export function pruneConfirmedOrderDrafts(): number {
  const removable = drafts.filter(
    (draft) => isLive(draft) && !draft.conflict && getVorgangById(draft.id) && !hasPendingOrderDraftCloudChange(draft.id),
  );
  if (removable.length === 0) return 0;
  const ids = new Set(removable.map((draft) => draft.id));
  const ok = commit(() => {
    drafts = drafts.filter((draft) => !ids.has(draft.id));
  });
  return ok ? removable.length : 0;
}

/**
 * Die sichtbaren Entwürfe: lebend, noch kein Auftrag — oder mit offenem
 * Konflikt, damit der Nutzer ihn auch dann findet, wenn der Auftrag anderswo
 * schon entstanden ist.
 */
export function listOrderDrafts(): OrderDraft[] {
  return drafts
    .filter((draft) => isLive(draft) && (Boolean(draft.conflict) || !getVorgangById(draft.id)))
    .map(cloneDraft);
}

/**
 * AUFTRAG-02C2 — was eine konkrete Entwurfsadresse zeigen soll.
 *
 * Die Entwurfskennung ist zugleich die Vorgangskennung. Nach der Bestätigung
 * gibt es den Entwurf nicht mehr, wohl aber den Auftrag — eine alte Adresse
 * (Lesezeichen, offener Tab, Zurück-Taste) darf dann weder ins Leere laufen
 * noch stillschweigend einen zweiten Auftrag beginnen. CLOUD-SYNC S6: Ein
 * Entwurf mit offenem Konflikt bleibt erreichbar, auch wenn sein Auftrag
 * anderswo entstanden ist — sonst gingen seine eigenen Änderungen still unter.
 */
export type OrderDraftRoute =
  | { kind: 'draft'; draft: OrderDraft }
  | { kind: 'order'; vorgangId: string }
  | { kind: 'missing' };

export function resolveOrderDraftRoute(draftId: string | undefined): OrderDraftRoute {
  const id = draftId?.trim();
  if (!id) return { kind: 'missing' };
  const draft = drafts.find((item) => item.id === id && isLive(item));
  if (draft?.conflict) return { kind: 'draft', draft: cloneDraft(draft) };
  const vorgang = getVorgangById(id);
  if (vorgang) return { kind: 'order', vorgangId: vorgang.id };
  return draft ? { kind: 'draft', draft: cloneDraft(draft) } : { kind: 'missing' };
}

export function getOrderDraftById(draftId: string): OrderDraft | null {
  const found = drafts.find((draft) => draft.id === draftId && isLive(draft));
  if (!found) return null;
  if (!found.conflict && getVorgangById(draftId)) return null;
  return cloneDraft(found);
}

export type OrderDraftMutationResult =
  | { success: true; draft: OrderDraft }
  | { success: false; errorKey: string };

export type OrderDraftRemovalResult = { success: true } | { success: false; errorKey: string };

export function createOrderDraft(workspaceId: string, input: OrderDraftInput): OrderDraftMutationResult {
  const timestamp = now();
  const draft: OrderDraft = normalizeDraft({
    // Genau hier entsteht die Vorgangskennung — einmal, und sie bleibt.
    id: generateEntityId('v'),
    workspaceId,
    customerId: input.customerId?.trim() || undefined,
    customerBilling: { ...input.customerBilling },
    title: input.title,
    baustelle: input.baustelle,
    positions: input.positions,
    taxStatus: input.taxStatus,
    paymentTermsText: input.paymentTermsText,
    introText: input.introText,
    closingText: input.closingText,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const ok = commit(() => {
    drafts = [...drafts, draft];
  });
  if (!ok) return { success: false, errorKey: 'order.draft.saveFailed' };
  return { success: true, draft: cloneDraft(draft) };
}

export function updateOrderDraft(draftId: string, changes: Partial<OrderDraftInput>): OrderDraftMutationResult {
  const index = drafts.findIndex((draft) => draft.id === draftId && isLive(draft));
  if (index === -1) return { success: false, errorKey: 'order.draft.notFound' };
  const previous = drafts[index]!;
  // CLOUD-SYNC S6 — bis zur Entscheidung über einen Konflikt nimmt der Entwurf keine Änderung an.
  if (previous.conflict) return { success: false, errorKey: 'order.draft.conflictOpen' };
  const updated = normalizeDraft({
    ...previous,
    ...changes,
    customerId: changes.customerId !== undefined ? changes.customerId?.trim() || undefined : previous.customerId,
    customerBilling: changes.customerBilling ? { ...changes.customerBilling } : previous.customerBilling,
    positions: changes.positions ?? previous.positions,
    updatedAt: now(),
  });
  /*
   * CLOUD-SYNC S6 — Speichern ohne inhaltliche Änderung ist kein neuer Stand:
   * keine neue Fassung, kein Sendeauftrag. Sonst erzeugte jeder Klick auf
   * „Speichern" oder „Auftrag anlegen" eine weitere Cloud-Version, und eine
   * Wiederholung nach verlorener Antwort käme nie mit derselben Bindung an.
   */
  if (buildOrderDraftCloudContentKey({ ...updated, updatedAt: previous.updatedAt }) === buildOrderDraftCloudContentKey(previous)) {
    return { success: true, draft: cloneDraft(previous) };
  }
  const ok = commit(() => {
    drafts = drafts.map((draft) => (draft.id === draftId ? updated : draft));
  });
  if (!ok) return { success: false, errorKey: 'order.draft.saveFailed' };
  return { success: true, draft: cloneDraft(updated) };
}

/** Kann die Cloud diesen Entwurf kennen? Dann braucht sein Verwerfen einen Grabstein. */
function needsCloudTombstone(draft: OrderDraft): boolean {
  if (!isOrderDraftCloudSyncAllowed()) return false;
  if ((draft.sync?.version ?? 0) > 0) return true;
  return hasPendingOrderDraftCloudChange(draft.id);
}

function asTombstone(draft: OrderDraft): OrderDraft {
  const at = now();
  const { conflict: _conflict, ...rest } = draft;
  const base: SyncMeta = draft.sync ?? { updatedAt: at, version: 0, deleted: false, deviceId: '', workspaceId: draft.workspaceId };
  return { ...rest, sync: { ...base, deleted: true, deletedAt: at, updatedAt: at } };
}

/**
 * Sichtbares „Entwurf verwerfen". Kennt die Cloud den Entwurf (oder ist er
 * unterwegs), bleibt ein Grabstein, bis sie das Verwerfen bestätigt hat —
 * sonst verschwindet er sofort. Scheitert das Speichern, bleibt der Entwurf
 * vollständig erhalten und der Aufrufer erfährt es.
 */
export function deleteOrderDraft(draftId: string): OrderDraftRemovalResult {
  const draft = drafts.find((item) => item.id === draftId && isLive(item));
  if (!draft) return { success: false, errorKey: 'order.draft.notFound' };
  if (draft.conflict) return { success: false, errorKey: 'order.draft.conflictOpen' };
  const tombstone = needsCloudTombstone(draft);
  const ok = commit(() => {
    drafts = tombstone
      ? drafts.map((item) => (item.id === draftId ? asTombstone(item) : item))
      : drafts.filter((item) => item.id !== draftId);
  });
  return ok ? { success: true } : { success: false, errorKey: 'order.draft.discardFailed' };
}

/**
 * Nach einer gelungenen Auftragsanlage: Der Entwurf ist zum Auftrag geworden.
 * Mit Bindung hat der Server ihn in derselben Transaktion verbraucht; es gibt
 * nichts zu senden — kein Grabstein, kein Löschauftrag.
 */
export function removeConsumedOrderDraft(draftId: string): OrderDraftRemovalResult {
  if (!drafts.some((draft) => draft.id === draftId)) return { success: true };
  const ok = commit(
    () => {
      drafts = drafts.filter((draft) => draft.id !== draftId);
      completeActiveOutbox(draftId);
    },
    { acknowledge: [draftId] },
  );
  return ok ? { success: true } : { success: false, errorKey: 'order.draft.saveFailed' };
}

/* -------------------------------------------------------------------------- */
/* CLOUD-SYNC S6 — Entscheidungen bei einem Konflikt                           */
/* -------------------------------------------------------------------------- */

export type OrderDraftCloudDecisionResult =
  | { ok: true; draftId?: string }
  | { ok: false; reason: 'no_conflict' | 'not_allowed' | 'storage' };

function findConflict(draftId: string) {
  const draft = drafts.find((item) => item.id === draftId && isLive(item));
  return draft?.conflict ? { draft, conflict: draft.conflict } : null;
}

/** „Cloud-Fassung übernehmen" — die eigene Fassung wird bewusst ersetzt. */
export function takeCloudOrderDraftVersion(draftId: string): OrderDraftCloudDecisionResult {
  const found = findConflict(draftId);
  if (!found || found.conflict.kind !== 'version') return { ok: false, reason: 'no_conflict' };
  const remote = found.conflict.remote;
  if (!remote.payload || remote.deleted || remote.status !== 'active') return { ok: false, reason: 'not_allowed' };
  const at = now();
  const next: OrderDraft = normalizeDraft({
    ...JSON.parse(JSON.stringify(remote.payload)),
    workspaceId: found.draft.workspaceId,
    sync: {
      ...(found.draft.sync ?? { deviceId: '', workspaceId: found.draft.workspaceId }),
      version: remote.rowVersion,
      deleted: false,
      updatedAt: at,
    } as SyncMeta,
  });
  const ok = commit(
    () => {
      drafts = drafts.map((item) => (item.id === draftId ? next : item));
      completeActiveOutbox(draftId);
    },
    { acknowledge: [draftId] },
  );
  return ok ? { ok: true } : { ok: false, reason: 'storage' };
}

/**
 * „Meine Fassung behalten" — ein bewusster neuer Schreibversuch gegen die
 * zuletzt gesehene Serverversion. Kein Überschreiben auf Verdacht: Hat sich
 * der Server inzwischen erneut bewegt, weist er auch diesen Versuch ab. Nur bei
 * einer Fassungsabweichung — ein verworfener oder verbrauchter Entwurf wird
 * nie mit derselben Kennung wieder aktiv.
 */
export function keepLocalOrderDraftVersion(draftId: string): OrderDraftCloudDecisionResult {
  const found = findConflict(draftId);
  if (!found || found.conflict.kind !== 'version') return { ok: false, reason: 'no_conflict' };
  const remote = found.conflict.remote;
  if (remote.deleted || remote.status !== 'active') return { ok: false, reason: 'not_allowed' };
  const { conflict: _conflict, ...rest } = found.draft;
  const next: OrderDraft = {
    ...rest,
    sync: {
      ...(found.draft.sync ?? { updatedAt: now(), deviceId: '', workspaceId: found.draft.workspaceId }),
      version: remote.rowVersion,
      deleted: false,
    } as SyncMeta,
  };
  const ok = commit(() => {
    drafts = drafts.map((item) => (item.id === draftId ? next : item));
    if (!releaseBlockedOutboxEntry('order_draft', draftId, remote.rowVersion) && !hasPendingOrderDraftCloudChange(draftId)) {
      enqueueSyncOutbox({ entityType: 'order_draft', entityId: draftId, operation: 'update', version: remote.rowVersion });
    }
  });
  return ok ? { ok: true } : { ok: false, reason: 'storage' };
}

/** Verworfen oder zum Auftrag geworden auf einem anderen Gerät: Der Nutzer nimmt das Ende an. */
export function acceptOrderDraftCloudEnd(draftId: string): OrderDraftCloudDecisionResult {
  const found = findConflict(draftId);
  if (!found || (found.conflict.kind !== 'deleted' && found.conflict.kind !== 'consumed')) {
    return { ok: false, reason: 'no_conflict' };
  }
  const ok = commit(
    () => {
      drafts = drafts.filter((item) => item.id !== draftId);
      completeActiveOutbox(draftId);
    },
    { acknowledge: [draftId] },
  );
  return ok ? { ok: true } : { ok: false, reason: 'storage' };
}

/**
 * „Als neuen Entwurf behalten" — nur nach einem Ende anderswo und nur auf
 * ausdrücklichen Wunsch: Der eigene Inhalt wird unter einer **neuen**
 * Entwurfs- und damit Vorgangskennung fortgesetzt. Die alte Kennung bleibt
 * beendet; es entsteht kein zweiter Auftrag aus ihr.
 */
export function continueOrderDraftAsNew(draftId: string): OrderDraftCloudDecisionResult {
  const found = findConflict(draftId);
  if (!found || (found.conflict.kind !== 'deleted' && found.conflict.kind !== 'consumed')) {
    return { ok: false, reason: 'not_allowed' };
  }
  const at = now();
  const { conflict: _conflict, sync: _sync, ...content } = found.draft;
  const fresh: OrderDraft = normalizeDraft({ ...content, id: generateEntityId('v'), createdAt: at, updatedAt: at });
  const ok = commit(
    () => {
      drafts = [...drafts.filter((item) => item.id !== draftId), fresh];
      completeActiveOutbox(draftId);
    },
    { acknowledge: [draftId] },
  );
  return ok ? { ok: true, draftId: fresh.id } : { ok: false, reason: 'storage' };
}

/** Hier verworfen, anderswo geändert: Der Nutzer behält den geänderten Entwurf. */
export function keepOrderDraftAfterRejectedDiscard(draftId: string): OrderDraftCloudDecisionResult {
  const found = findConflict(draftId);
  if (!found || found.conflict.kind !== 'discard_rejected') return { ok: false, reason: 'no_conflict' };
  const { conflict: _conflict, ...rest } = found.draft;
  const ok = commit(
    () => {
      drafts = drafts.map((item) => (item.id === draftId ? rest : item));
    },
    { acknowledge: [draftId] },
  );
  return ok ? { ok: true } : { ok: false, reason: 'storage' };
}

/** Hier verworfen, anderswo geändert: Der Nutzer verwirft bewusst erneut — auf der neuen Fassung. */
export function discardOrderDraftAgain(draftId: string): OrderDraftCloudDecisionResult {
  const found = findConflict(draftId);
  if (!found || found.conflict.kind !== 'discard_rejected') return { ok: false, reason: 'no_conflict' };
  const ok = commit(() => {
    drafts = drafts.map((item) => (item.id === draftId ? asTombstone(item) : item));
  });
  return ok ? { ok: true } : { ok: false, reason: 'storage' };
}

/* -------------------------------------------------------------------------- */
/* CLOUD-SYNC S6 — Bindung der Auftragsanlage                                  */
/* -------------------------------------------------------------------------- */

export type OrderDraftCloudBindingResult =
  | { ok: true; binding: OrderDraftCloudBinding | null }
  | { ok: false; reason: 'draft_not_synced' | 'draft_conflict' | 'draft_ended' };

/**
 * Die Bindung der Auftragsanlage an den Cloud-Entwurf. Ohne freigegebene
 * Cloud-Seite gibt es keine (der Server kennt den Entwurf nicht). Mit ihr muss
 * der Entwurf vollständig angekommen sein: keine offene Übertragung, kein
 * Konflikt, und die Cloud kennt genau diese Version.
 */
export function resolveOrderDraftCloudBinding(draftId: string): OrderDraftCloudBindingResult {
  if (!isOrderDraftCloudSyncAllowed()) return { ok: true, binding: null };
  const draft = drafts.find((item) => item.id === draftId);
  if (!draft || !isLive(draft)) return { ok: false, reason: 'draft_ended' };
  if (draft.conflict) return { ok: false, reason: 'draft_conflict' };
  const version = draft.sync?.version ?? 0;
  if (version < 1 || hasPendingOrderDraftCloudChange(draftId)) return { ok: false, reason: 'draft_not_synced' };
  return { ok: true, binding: { clientDraftId: draftId, expectedDraftRowVersion: version } };
}

/**
 * Ein Schlüssel, der sich ändert, sobald sich am Cloud-Zustand eines Entwurfs
 * etwas ändert (Version, Konflikt, offene Übertragung, Inhalt). Der Editor
 * vergleicht ihn, um eine neuere Fassung nur dann zu übernehmen, wenn er
 * selbst nichts Ungespeichertes trägt.
 */
export function getOrderDraftCloudWatchKey(draftId: string | null): string {
  if (!draftId) return '';
  const draft = drafts.find((item) => item.id === draftId);
  return JSON.stringify([
    draft ? isOrderDraftTombstone(draft) : null,
    draft?.sync?.version ?? null,
    draft?.conflict?.kind ?? null,
    draft?.conflict?.remote.rowVersion ?? null,
    draft && isLive(draft) ? buildOrderDraftCloudContentKey(draft) : null,
    activeOutboxEntries(draftId).map((entry) => entry.status),
    Boolean(getVorgangById(draftId)),
  ]);
}

/**
 * Was den Nutzer noch vom verbindlichen Auftrag trennt. Dieselben Regeln
 * prüft der Server noch einmal — hier geht es darum, sie vorher zu sagen.
 */
export function getOrderDraftBlockers(draft: Pick<OrderDraft, 'customerBilling' | 'title' | 'positions'>): OrderDraftBlocker[] {
  const blockers: OrderDraftBlocker[] = [];
  if (!draft.customerBilling?.name?.trim()) blockers.push('customer_missing');
  if (!draft.title?.trim()) blockers.push('title_missing');
  const positions = draft.positions ?? [];
  if (positions.length === 0) {
    blockers.push('positions_missing');
  } else {
    const ids = new Set<string>();
    const invalid = positions.some((p) => {
      const duplicate = ids.has(p.id);
      ids.add(p.id);
      return (
        duplicate ||
        !p.id.trim() ||
        !p.description.trim() ||
        !(p.plannedQuantity > 0) ||
        !(p.unitPrice >= 0) ||
        !(ORDER_UNITS as readonly string[]).includes(p.unit)
      );
    });
    if (invalid) blockers.push('position_invalid');
  }
  return blockers;
}

export function emptyOrderDraftCustomerBilling(name = ''): CustomerBilling {
  return { name, contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' };
}

export function isOrderDraftReady(draft: OrderDraft, _taxStatus?: TaxStatus): boolean {
  return getOrderDraftBlockers(draft).length === 0;
}
