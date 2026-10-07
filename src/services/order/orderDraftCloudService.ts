/**
 * CLOUD-SYNC S6 — Cloud-Anbindung des Auftragsentwurfs.
 *
 * Diese Datei trägt ausschliesslich Transport: fachlicher Inhalt,
 * Inhaltsschlüssel, Push-Form, Lesen der Serverzeile, Abgleich mit
 * Konfliktvertrag, Altbestand und Wiederanlauf nach verlorener Bestätigung.
 * **Keine** Fachlogik: Anlegen, Ändern und Verwerfen bleiben in
 * `orderDraftService`, und dort wird kein Cloud-Aufruf gemacht — der Weg in
 * die Cloud führt über den Änderungsverfolger und die bestehende
 * Warteschlange.
 *
 * Aufgebaut nach dem Muster von S3 und S5: dieselbe Versionssemantik,
 * derselbe Wiederanlauf aus 01G bis 01G7, keine zweite Sync-Architektur. Wie
 * bei S5 hängt ein Konflikt am lokalen Entwurf und trägt den Serverstand: Ein
 * Auftragsentwurf ist Arbeit des Nutzers, die Entscheidung trifft er sichtbar.
 *
 * Kein Last-Write-Wins, in keine Richtung:
 *  - Cloud neuer, lokal ohne offene Änderung → die Cloud-Fassung wird übernommen;
 *  - Cloud neuer, lokal mit offener Änderung → sichtbarer Konflikt, beide Stände bleiben;
 *  - verworfen oder verbraucht → nie mit derselben Kennung wiederbelebt.
 */
import {
  planLostAckAdoption,
  type LostAckAdoptionPlan,
  type LostAckRemoteRow,
  type LostAckSentWrite,
} from '../sync/syncLostAckAdoptionService';
import {
  canonicalDraftJson,
  detachDraftValue,
  isNonEmptyDraftString,
  isPlainDraftObject,
} from '../sync/draftCloudCanonical';
import type {
  OrderDraft,
  OrderDraftCloudPayload,
  OrderDraftPosition,
  WorkspaceOrderDraftRow,
} from '../../types/orderDraft';
import type { DraftCloudConflict, DraftCloudRemoteState, DraftCloudStatus } from '../../types/draftCloud';
import type { CustomerBilling, OrderUnit, TaxStatus } from '../../types/models';
import type { SyncMeta } from '../../types/sync';

const ORDER_UNITS: readonly string[] = ['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal'];

/** Ein lokaler Grabstein: verworfen, das Verwerfen ist noch nicht bestätigt. */
export function isOrderDraftTombstone(draft: Pick<OrderDraft, 'sync'>): boolean {
  return draft.sync?.deleted === true;
}

/* -------------------------------------------------------------------------- */
/* Der fachliche Inhalt                                                        */
/* -------------------------------------------------------------------------- */

function stripPositionForCloud(position: OrderDraftPosition): OrderDraftPosition {
  return {
    id: position.id,
    description: position.description,
    plannedQuantity: position.plannedQuantity,
    unit: position.unit,
    unitPrice: position.unitPrice,
  };
}

/**
 * Ausdrückliche Allowlist statt Rest-Spread: Ein später ergänztes Feld soll
 * nicht unbemerkt in Cloud und Inhaltsschlüssel wandern. Nicht darin:
 * `workspaceId` (der Workspace ist der Scope der Zeile), `sync`, `conflict`.
 * Optionale Felder reisen nur mit, wenn sie belegt sind.
 */
export function stripOrderDraftForCloud(draft: OrderDraft): OrderDraftCloudPayload {
  const payload: OrderDraftCloudPayload = {
    id: draft.id,
    customerBilling: detachDraftValue(draft.customerBilling),
    title: draft.title,
    baustelle: draft.baustelle,
    positions: (draft.positions ?? []).map(stripPositionForCloud),
    taxStatus: draft.taxStatus,
    paymentTermsText: draft.paymentTermsText,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
  if (isNonEmptyDraftString(draft.customerId)) payload.customerId = draft.customerId;
  if (draft.introText !== undefined) payload.introText = draft.introText;
  if (draft.closingText !== undefined) payload.closingText = draft.closingText;
  return payload;
}

/**
 * Stabiler fachlicher Vergleichsschlüssel. Enthält bewusst keine `SyncMeta`
 * und keinen Konflikt: Der Server schreibt nach jedem Versand eine neue
 * Version zurück; flösse sie hier ein, löste jede Rückschreibung den nächsten
 * Versand aus.
 */
export function buildOrderDraftCloudContentKey(draft: OrderDraft): string {
  return canonicalDraftJson(stripOrderDraftForCloud(draft));
}

/** Derselbe Schlüssel für einen Cloud-Inhalt. */
export function buildOrderDraftPayloadKey(payload: OrderDraftCloudPayload): string {
  return canonicalDraftJson(payload);
}

/** Versandform: Kennung, Inhalt und — beim Verwerfen — der Grabstein ohne Inhalt. */
export function buildOrderDraftCloudPushPayload(draft: OrderDraft, deleted = false): Record<string, unknown> {
  return {
    draft_id: draft.id,
    payload: deleted ? {} : stripOrderDraftForCloud(draft),
    deleted,
  };
}

/* -------------------------------------------------------------------------- */
/* Lesen der Serverzeile                                                       */
/* -------------------------------------------------------------------------- */

function parseBilling(value: unknown): CustomerBilling | null {
  if (!isPlainDraftObject(value)) return null;
  if (typeof value.name !== 'string') return null;
  return detachDraftValue(value) as unknown as CustomerBilling;
}

function parsePosition(value: unknown): OrderDraftPosition | null {
  if (!isPlainDraftObject(value) || !isNonEmptyDraftString(value.id)) return null;
  const quantity = Number(value.plannedQuantity);
  const unitPrice = Number(value.unitPrice);
  if (typeof value.description !== 'string' || !Number.isFinite(quantity) || !Number.isFinite(unitPrice)) return null;
  const unit = typeof value.unit === 'string' && ORDER_UNITS.includes(value.unit) ? (value.unit as OrderUnit) : null;
  if (!unit) return null;
  return { id: value.id, description: value.description, plannedQuantity: quantity, unit, unitPrice };
}

/** Mindestprüfung; der Server hat Nummern, Bestätigungsstand und Lokales bereits abgewiesen. */
export function parseOrderDraftCloudPayload(payload: unknown, draftId: string): OrderDraftCloudPayload | null {
  if (!isPlainDraftObject(payload) || payload.id !== draftId) return null;
  const customerBilling = parseBilling(payload.customerBilling);
  if (!customerBilling || !Array.isArray(payload.positions)) return null;
  const positions: OrderDraftPosition[] = [];
  for (const item of payload.positions) {
    const position = parsePosition(item);
    if (!position) return null;
    positions.push(position);
  }
  if (
    typeof payload.title !== 'string' ||
    typeof payload.baustelle !== 'string' ||
    typeof payload.taxStatus !== 'string' ||
    typeof payload.paymentTermsText !== 'string' ||
    typeof payload.createdAt !== 'string' ||
    typeof payload.updatedAt !== 'string'
  ) {
    return null;
  }
  const parsed: OrderDraftCloudPayload = {
    id: draftId,
    customerBilling,
    title: payload.title,
    baustelle: payload.baustelle,
    positions,
    taxStatus: payload.taxStatus as TaxStatus,
    paymentTermsText: payload.paymentTermsText,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
  };
  if (isNonEmptyDraftString(payload.customerId)) parsed.customerId = payload.customerId;
  if (typeof payload.introText === 'string') parsed.introText = payload.introText;
  if (typeof payload.closingText === 'string') parsed.closingText = payload.closingText;
  return parsed;
}

export interface MappedOrderDraftRow {
  draftId: string;
  status: DraftCloudStatus;
  deleted: boolean;
  /** `null` bei einem Endzustand. */
  payload: OrderDraftCloudPayload | null;
  consumedVorgangId?: string;
  rowVersion: number;
  updatedAt: string;
}

export function mapWorkspaceOrderDraftRow(row: WorkspaceOrderDraftRow): MappedOrderDraftRow | null {
  if (!isNonEmptyDraftString(row.client_draft_id)) return null;
  if (row.status !== 'active' && row.status !== 'consumed') return null;
  const rowVersion = Number(row.row_version);
  if (!Number.isInteger(rowVersion) || rowVersion < 1) return null;
  const consumedVorgangId = isNonEmptyDraftString(row.consumed_vorgang_id) ? row.consumed_vorgang_id : undefined;
  if (row.status === 'consumed' && !consumedVorgangId) return null;
  const deleted = Boolean(row.deleted);
  const ended = deleted || row.status === 'consumed';
  const payload = ended ? null : parseOrderDraftCloudPayload(row.payload, row.client_draft_id);
  if (!ended && !payload) return null;
  return {
    draftId: row.client_draft_id,
    status: row.status,
    deleted,
    payload,
    ...(consumedVorgangId ? { consumedVorgangId } : {}),
    rowVersion,
    updatedAt: row.updated_at,
  };
}

function syncMetaFor(rowVersion: number, updatedAt: string, deleted: boolean, deviceId: string, workspaceId: string): SyncMeta {
  return {
    updatedAt,
    version: rowVersion,
    deleted,
    deletedAt: deleted ? updatedAt : undefined,
    deviceId,
    workspaceId,
  };
}

/** Ein aktiver Cloud-Entwurf als lokaler Entwurf dieses Workspace. */
export function orderDraftFromCloud(
  mapped: MappedOrderDraftRow & { payload: OrderDraftCloudPayload },
  deviceId: string,
  workspaceId: string,
): OrderDraft {
  const payload = detachDraftValue(mapped.payload);
  return {
    ...payload,
    workspaceId,
    sync: syncMetaFor(mapped.rowVersion, mapped.updatedAt, false, deviceId, workspaceId),
  };
}

function remoteStateOf(mapped: MappedOrderDraftRow): DraftCloudRemoteState<OrderDraftCloudPayload> {
  return {
    rowVersion: mapped.rowVersion,
    status: mapped.status,
    deleted: mapped.deleted,
    payload: mapped.payload ? detachDraftValue(mapped.payload) : null,
    ...(mapped.consumedVorgangId ? { consumedRef: mapped.consumedVorgangId } : {}),
  };
}

function withConflict(draft: OrderDraft, conflict: DraftCloudConflict<OrderDraftCloudPayload>): OrderDraft {
  return { ...draft, conflict };
}

/* -------------------------------------------------------------------------- */
/* Abgleich                                                                    */
/* -------------------------------------------------------------------------- */

export interface OrderDraftPullMerge {
  drafts: OrderDraft[];
  conflicts: string[];
  /**
   * Kennungen, deren offener Sendeauftrag gegenstandslos geworden ist (beide
   * Seiten beendet, oder ein abgewiesenes Verwerfen) — der Aufrufer schliesst
   * ihn ab, damit er nicht dauerhaft als Konflikt in der Warteschlange steht.
   */
  settledIds: string[];
}

/**
 * Zeilenweiser Abgleich nach Entwurfskennung. Kein Feldmerge, keine
 * Last-Write-Wins-Regel.
 *
 * `dirtyIds` sind die Kennungen mit **offenem Sendeauftrag** (eigene, noch
 * nicht bestätigte Arbeit). `orderIds` sind die Vorgänge des gemergten
 * Bestands: Eine Entwurfskennung, die dort steht, ist zum Auftrag geworden.
 * Entwürfe eines fremden Workspace bleiben unberührt.
 */
export function mergeOrderDraftsFromPull(
  localDrafts: OrderDraft[],
  remoteRows: WorkspaceOrderDraftRow[],
  deviceId: string,
  workspaceId: string,
  dirtyIds: ReadonlySet<string> = new Set(),
  orderIds: ReadonlySet<string> = new Set(),
  now: string = new Date().toISOString(),
): OrderDraftPullMerge {
  const conflicts: string[] = [];
  const settledIds: string[] = [];
  const byId = new Map(localDrafts.map((draft) => [draft.id, draft]));
  const seen = new Set<string>();
  const foreign = (draft: OrderDraft) => Boolean(draft.workspaceId) && draft.workspaceId !== workspaceId;

  for (const row of remoteRows) {
    const mapped = mapWorkspaceOrderDraftRow(row);
    if (!mapped) continue;
    seen.add(mapped.draftId);
    const local = byId.get(mapped.draftId) ?? null;
    if (local && foreign(local)) continue;
    const dirty = dirtyIds.has(mapped.draftId);

    /* Endzustände: verworfen oder verbraucht. */
    if (mapped.deleted || mapped.status === 'consumed') {
      if (!local) continue;
      if (isOrderDraftTombstone(local)) {
        // Beide Seiten beendet: Der lokale Grabstein hat seinen Zweck erfüllt.
        byId.delete(mapped.draftId);
        settledIds.push(mapped.draftId);
        continue;
      }
      if (dirty || local.conflict) {
        // Eigene, nicht übertragene Arbeit trifft auf ein Ende anderswo: festhalten, nicht verwerfen.
        byId.set(
          mapped.draftId,
          withConflict(local, {
            kind: mapped.status === 'consumed' ? 'consumed' : 'deleted',
            detectedAt: local.conflict?.detectedAt ?? now,
            remote: remoteStateOf(mapped),
          }),
        );
        conflicts.push(`order_draft:${mapped.draftId}`);
        continue;
      }
      // Lokal ohne offene Änderung: Das Ende anderswo ist die jüngere Wahrheit.
      byId.delete(mapped.draftId);
      continue;
    }

    if (!mapped.payload) continue;
    const remote = orderDraftFromCloud({ ...mapped, payload: mapped.payload }, deviceId, workspaceId);

    if (!local) {
      // Eine Kennung, die hier bereits ein Auftrag ist, wird kein Entwurf mehr.
      if (orderIds.has(mapped.draftId)) continue;
      byId.set(remote.id, remote);
      continue;
    }

    if (isOrderDraftTombstone(local)) {
      if (mapped.rowVersion <= (local.sync?.version ?? 0)) {
        // Der Grabstein wartet auf seinen Push genau auf dieser Version.
        continue;
      }
      /*
       * Hier verworfen, anderswo inzwischen geändert: Das Verwerfen wird nicht
       * übernommen — das wäre ein Löschen auf Verdacht. Der geänderte Entwurf
       * ist wieder da, mit dem Hinweis, warum.
       */
      byId.set(mapped.draftId, {
        ...remote,
        conflict: { kind: 'discard_rejected', detectedAt: now, remote: remoteStateOf(mapped) },
      });
      settledIds.push(mapped.draftId);
      conflicts.push(`order_draft:${mapped.draftId}`);
      continue;
    }

    const localVersion = local.sync?.version ?? 0;
    const sameContent = buildOrderDraftCloudContentKey(local) === buildOrderDraftCloudContentKey(remote);

    if (local.conflict) {
      if (local.conflict.kind === 'discard_rejected') {
        // Ein Hinweis, den der Nutzer noch nicht gesehen hat: Der Inhalt folgt der Cloud, der Hinweis bleibt.
        byId.set(mapped.draftId, { ...remote, conflict: { ...local.conflict, remote: remoteStateOf(mapped) } });
        continue;
      }
      if (sameContent && mapped.rowVersion >= localVersion) {
        // Beide Fassungen sind inzwischen gleich: Der Konflikt hat sich erledigt.
        byId.set(mapped.draftId, remote);
        continue;
      }
      byId.set(mapped.draftId, withConflict(local, { ...local.conflict, kind: 'version', remote: remoteStateOf(mapped) }));
      conflicts.push(`order_draft:${mapped.draftId}`);
      continue;
    }

    if (mapped.rowVersion === localVersion) {
      // Gleiche Version: gleicher Inhalt wird bestätigt; sonst geht die eigene Änderung beim nächsten Push hinaus.
      if (sameContent) byId.set(mapped.draftId, remote);
      continue;
    }

    if (mapped.rowVersion > localVersion) {
      if (!dirty) {
        // Cloud neuer, lokal nichts offen: Die Cloud-Fassung wird übernommen.
        byId.set(mapped.draftId, remote);
        continue;
      }
      if (sameContent) {
        // Verlorene Bestätigung: Die Serverfassung ist die eigene.
        byId.set(mapped.draftId, remote);
        continue;
      }
      byId.set(
        mapped.draftId,
        withConflict(local, { kind: 'version', detectedAt: now, remote: remoteStateOf(mapped) }),
      );
      conflicts.push(`order_draft:${mapped.draftId}`);
    }
    // Ältere Serverfassung als lokal bestätigt: kann es nicht geben — der lokale Stand bleibt.
  }

  for (const draft of [...byId.values()]) {
    if (foreign(draft)) continue;
    const dirty = dirtyIds.has(draft.id);

    if (isOrderDraftTombstone(draft)) {
      /*
       * Ein Grabstein, den die Cloud nie gesehen hat und der auch nicht mehr
       * unterwegs ist: Der Entwurf war nie dort — es gibt nichts zu melden.
       */
      if (!seen.has(draft.id) && !dirty) byId.delete(draft.id);
      continue;
    }

    /*
     * Eine Kennung, die zum Auftrag geworden ist, ohne dass eine verbrauchte
     * Entwurfszeile kam (Anlage ohne Bindung, vor S6): ohne offene Änderung
     * erledigt, mit offener Änderung ein sichtbarer Konflikt.
     */
    if (orderIds.has(draft.id) && !draft.conflict && !seen.has(draft.id)) {
      if (!dirty) {
        byId.delete(draft.id);
        continue;
      }
      byId.set(
        draft.id,
        withConflict(draft, {
          kind: 'consumed',
          detectedAt: now,
          remote: {
            rowVersion: (draft.sync?.version ?? 0) + 1,
            status: 'consumed',
            deleted: false,
            payload: null,
            consumedRef: draft.id,
          },
        }),
      );
      conflicts.push(`order_draft:${draft.id}`);
    }
  }

  return { drafts: [...byId.values()], conflicts, settledIds };
}

/**
 * Altbestand — lokale Entwürfe, die die Cloud noch nicht kennt. Verglichen wird
 * ausschliesslich über Kennungen, und zwar gegen **alle** Serverzeilen
 * einschliesslich der Endzustände: Sonst lüde ein zweites Gerät einen anderswo
 * verworfenen oder verbrauchten Entwurf wieder hoch.
 *
 * Nicht dabei: Grabsteine, Entwürfe mit offenem Konflikt, bereits gesendete
 * (Version > 0), solche eines fremden Workspace und jede Kennung, die bereits
 * ein Auftrag ist.
 */
export function planOrderDraftBackfill(
  drafts: OrderDraft[],
  remoteRows: WorkspaceOrderDraftRow[],
  workspaceId: string,
  orderIds: ReadonlySet<string> = new Set(),
  dirtyIds: ReadonlySet<string> = new Set(),
): string[] {
  const remoteIds = new Set(
    remoteRows.map((row) => row.client_draft_id).filter((id): id is string => isNonEmptyDraftString(id)),
  );
  return drafts
    .filter((draft) => !isOrderDraftTombstone(draft))
    .filter((draft) => !draft.conflict)
    .filter((draft) => (draft.sync?.version ?? 0) === 0)
    .filter((draft) => !draft.workspaceId || draft.workspaceId === workspaceId)
    .filter((draft) => !remoteIds.has(draft.id) && !orderIds.has(draft.id) && !dirtyIds.has(draft.id))
    .map((draft) => draft.id);
}

/**
 * Nach erfolgreichem Versand: Die Serverversion wird übernommen — ohne den
 * Inhalt anzufassen. Ein bestätigter Grabstein hat seinen Zweck erfüllt und
 * verschwindet: Ein Wiederbeleben verhindert ab jetzt der Server.
 */
export function applyOrderDraftPushResultToState(
  drafts: OrderDraft[],
  draftId: string,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): OrderDraft[] {
  if (deleted) return drafts.filter((draft) => draft.id !== draftId);
  return drafts.map((draft) => {
    if (draft.id !== draftId) return draft;
    return {
      ...draft,
      sync: { ...draft.sync, ...syncMetaFor(rowVersion, updatedAt, false, deviceId, workspaceId) },
    };
  });
}

/**
 * SYNC-DURABILITY-HARDENING-01G4 bis 01G7 — Wiederanlauf nach verlorener
 * Bestätigung und nach einem Schreibvorgang, der den Server nie erreicht hat.
 * Die Bewertung selbst liegt in `planLostAckAdoption`.
 */
export function planOrderDraftLostAckAdoption(
  drafts: OrderDraft[],
  remoteRows: WorkspaceOrderDraftRow[],
  activeOutboxDraftIds: ReadonlySet<string>,
  sentWrites?: ReadonlyMap<string, LostAckSentWrite>,
): LostAckAdoptionPlan {
  const remotes = new Map<string, LostAckRemoteRow>();
  for (const row of remoteRows) {
    const mapped = mapWorkspaceOrderDraftRow(row);
    if (!mapped) continue;
    remotes.set(mapped.draftId, {
      rowVersion: mapped.rowVersion,
      deleted: mapped.deleted || mapped.status === 'consumed',
      contentKey: mapped.payload ? buildOrderDraftPayloadKey(mapped.payload) : undefined,
    });
  }
  return planLostAckAdoption(drafts, remotes, activeOutboxDraftIds, {
    sentWrites,
    localContentKey: buildOrderDraftCloudContentKey,
  });
}
