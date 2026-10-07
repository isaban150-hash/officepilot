/**
 * CLOUD-SYNC S6 — Cloud-Anbindung des Nachtragsentwurfs.
 *
 * Nur Transport: fachlicher Inhalt, Inhaltsschlüssel, Push-Form, Lesen der
 * Serverzeile, Abgleich mit Konfliktvertrag, Altbestand und Wiederanlauf. Die
 * Fachlogik (Vorbereiten, Bearbeiten, Verwerfen, Bestätigen) bleibt in
 * `orderAmendmentService` und im Bestätigungs-Orchestrator.
 *
 * Lokal bleibt ein Nachtragsentwurf, wo er immer lag: in
 * `Vorgang.orderAmendments`. Für die Sync-Kette wird er als eigene Entität
 * gelesen (Kennung = Entwurfskennung, Bezug = `vorgangId`); ein Grabstein
 * liegt bis zur Bestätigung durch die Cloud neben dem Vorgang
 * (`AppPersistedState.orderAmendmentDraftTombstones`). Nie im
 * Vorgang-Payload, nie mit Sequenz, Fingerprint oder Bestätigungsabsicht.
 *
 * Kein Last-Write-Wins, in keine Richtung; verworfen und bestätigt (verbraucht)
 * werden nie mit derselben Kennung wiederbelebt. Ein Entwurf mit offener
 * Bestätigungsabsicht gehört dem Wiederanlauf der Bestätigung und wird hier
 * nicht angefasst.
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
  AppPersistedState,
  OrderAmendment,
  OrderAmendmentChangeType,
  OrderAmendmentDraftPosition,
  OrderPositionCategory,
  OrderUnit,
  Vorgang,
} from '../../types/models';
import type {
  OrderAmendmentDraftCloudPayload,
  OrderAmendmentDraftTombstone,
  WorkspaceOrderAmendmentDraftRow,
} from '../../types/orderAmendmentDraftCloud';
import type { DraftCloudConflict, DraftCloudRemoteState, DraftCloudStatus } from '../../types/draftCloud';
import type { SyncMeta } from '../../types/sync';

const ORDER_UNITS: readonly string[] = ['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal'];
const CHANGE_TYPES: readonly string[] = ['add', 'quantity_increase'];
const CATEGORIES: readonly string[] = ['arbeit', 'material', 'sonstiges'];

/* -------------------------------------------------------------------------- */
/* Lesen als Entität                                                           */
/* -------------------------------------------------------------------------- */

/** Ein Grabstein als Entität der Sync-Kette — ohne Inhalt, mit stabilen Feldern. */
export function orderAmendmentDraftTombstoneEntity(tombstone: OrderAmendmentDraftTombstone): OrderAmendment {
  const at = tombstone.sync.deletedAt ?? tombstone.sync.updatedAt;
  return {
    id: tombstone.id,
    vorgangId: tombstone.vorgangId,
    status: 'entwurf',
    title: '',
    positions: [],
    createdAt: at,
    updatedAt: at,
    sync: tombstone.sync,
  };
}

/** Ein Vorgang, dessen Entwürfe die Kette sieht: nicht gelöscht. */
function isSyncActiveVorgang(vorgang: Vorgang): boolean {
  return vorgang.sync?.deleted !== true;
}

/**
 * Alle Nachtragsentwürfe als Entitäten: die lebenden aus den Vorgängen, dazu
 * die Grabsteine. Eine Kennung steht nie an beiden Stellen.
 */
export function listOrderAmendmentDraftEntities(
  state: Pick<AppPersistedState, 'vorgaenge' | 'orderAmendmentDraftTombstones'>,
): OrderAmendment[] {
  const live = (state.vorgaenge ?? [])
    .filter(isSyncActiveVorgang)
    .flatMap((vorgang) => (vorgang.orderAmendments ?? []).map((draft) => ({ ...draft, vorgangId: vorgang.id })));
  const liveIds = new Set(live.map((draft) => draft.id));
  const tombstones = (state.orderAmendmentDraftTombstones ?? [])
    .filter((tombstone) => !liveIds.has(tombstone.id))
    .map(orderAmendmentDraftTombstoneEntity);
  return [...live, ...tombstones];
}

export function findOrderAmendmentDraftEntity(
  state: Pick<AppPersistedState, 'vorgaenge' | 'orderAmendmentDraftTombstones'>,
  draftId: string,
): OrderAmendment | null {
  return listOrderAmendmentDraftEntities(state).find((entity) => entity.id === draftId) ?? null;
}

export function isOrderAmendmentDraftTombstoneEntity(entity: Pick<OrderAmendment, 'sync'>): boolean {
  return entity.sync?.deleted === true;
}

/* -------------------------------------------------------------------------- */
/* Der fachliche Inhalt                                                        */
/* -------------------------------------------------------------------------- */

function stripPositionForCloud(position: OrderAmendmentDraftPosition): OrderAmendmentDraftPosition {
  const core: OrderAmendmentDraftPosition = {
    id: position.id,
    changeType: position.changeType,
    description: position.description,
    quantity: position.quantity,
    unit: position.unit,
    unitPrice: position.unitPrice,
  };
  if (position.unitLabel !== undefined) core.unitLabel = position.unitLabel;
  if (position.category !== undefined) core.category = position.category;
  if (position.billable !== undefined) core.billable = position.billable;
  if (position.parentPositionId !== undefined) core.parentPositionId = position.parentPositionId;
  return core;
}

/**
 * Ausdrückliche Allowlist: kein `status` (immer Entwurf), keine Sync-Metadaten,
 * kein Konflikt — und erst recht keine Sequenz, Bestätigungskennung oder
 * Fingerprint: Die entstehen erst bei der Bestätigung bzw. bleiben gerätelokal.
 */
export function stripOrderAmendmentDraftForCloud(draft: OrderAmendment): OrderAmendmentDraftCloudPayload {
  const payload: OrderAmendmentDraftCloudPayload = {
    id: draft.id,
    vorgangId: draft.vorgangId,
    title: draft.title,
    positions: (draft.positions ?? []).map(stripPositionForCloud),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
  if (draft.reason !== undefined) payload.reason = draft.reason;
  return payload;
}

/** Stabiler fachlicher Vergleichsschlüssel — ohne `SyncMeta` und Konflikt. */
export function buildOrderAmendmentDraftCloudContentKey(draft: OrderAmendment): string {
  return canonicalDraftJson(stripOrderAmendmentDraftForCloud(draft));
}

export function buildOrderAmendmentDraftPayloadKey(payload: OrderAmendmentDraftCloudPayload): string {
  return canonicalDraftJson(payload);
}

/** Versandform: Kennung, Auftrag, Inhalt und — beim Verwerfen — der Grabstein ohne Inhalt. */
export function buildOrderAmendmentDraftCloudPushPayload(
  draft: OrderAmendment,
  deleted = false,
): Record<string, unknown> {
  return {
    draft_id: draft.id,
    vorgang_id: draft.vorgangId,
    payload: deleted ? {} : stripOrderAmendmentDraftForCloud(draft),
    deleted,
  };
}

/* -------------------------------------------------------------------------- */
/* Lesen der Serverzeile                                                       */
/* -------------------------------------------------------------------------- */

function parsePosition(value: unknown): OrderAmendmentDraftPosition | null {
  if (!isPlainDraftObject(value) || !isNonEmptyDraftString(value.id)) return null;
  if (typeof value.changeType !== 'string' || !CHANGE_TYPES.includes(value.changeType)) return null;
  if (typeof value.description !== 'string') return null;
  if (typeof value.unit !== 'string' || !ORDER_UNITS.includes(value.unit)) return null;
  const quantity = Number(value.quantity);
  const unitPrice = Number(value.unitPrice);
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) return null;
  const position: OrderAmendmentDraftPosition = {
    id: value.id,
    changeType: value.changeType as OrderAmendmentChangeType,
    description: value.description,
    quantity,
    unit: value.unit as OrderUnit,
    unitPrice,
  };
  if (typeof value.unitLabel === 'string') position.unitLabel = value.unitLabel;
  if (typeof value.category === 'string' && CATEGORIES.includes(value.category)) {
    position.category = value.category as OrderPositionCategory;
  }
  if (typeof value.billable === 'boolean') position.billable = value.billable;
  if (typeof value.parentPositionId === 'string') position.parentPositionId = value.parentPositionId;
  return position;
}

export function parseOrderAmendmentDraftCloudPayload(
  payload: unknown,
  expected: { draftId: string; vorgangId: string },
): OrderAmendmentDraftCloudPayload | null {
  if (!isPlainDraftObject(payload)) return null;
  if (payload.id !== expected.draftId || payload.vorgangId !== expected.vorgangId) return null;
  if (typeof payload.title !== 'string' || !Array.isArray(payload.positions)) return null;
  if (typeof payload.createdAt !== 'string' || typeof payload.updatedAt !== 'string') return null;
  const positions: OrderAmendmentDraftPosition[] = [];
  for (const item of payload.positions) {
    const position = parsePosition(item);
    if (!position) return null;
    positions.push(position);
  }
  const parsed: OrderAmendmentDraftCloudPayload = {
    id: expected.draftId,
    vorgangId: expected.vorgangId,
    title: payload.title,
    positions,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
  };
  if (typeof payload.reason === 'string') parsed.reason = payload.reason;
  return parsed;
}

export interface MappedOrderAmendmentDraftRow {
  draftId: string;
  vorgangId: string;
  status: DraftCloudStatus;
  deleted: boolean;
  payload: OrderAmendmentDraftCloudPayload | null;
  consumedClientAmendmentId?: string;
  rowVersion: number;
  updatedAt: string;
}

export function mapWorkspaceOrderAmendmentDraftRow(
  row: WorkspaceOrderAmendmentDraftRow,
): MappedOrderAmendmentDraftRow | null {
  if (!isNonEmptyDraftString(row.client_draft_id) || !isNonEmptyDraftString(row.vorgang_id)) return null;
  if (row.status !== 'active' && row.status !== 'consumed') return null;
  const rowVersion = Number(row.row_version);
  if (!Number.isInteger(rowVersion) || rowVersion < 1) return null;
  const consumed = isNonEmptyDraftString(row.consumed_client_amendment_id) ? row.consumed_client_amendment_id : undefined;
  if (row.status === 'consumed' && !consumed) return null;
  const deleted = Boolean(row.deleted);
  const ended = deleted || row.status === 'consumed';
  const payload = ended
    ? null
    : parseOrderAmendmentDraftCloudPayload(row.payload, { draftId: row.client_draft_id, vorgangId: row.vorgang_id });
  if (!ended && !payload) return null;
  return {
    draftId: row.client_draft_id,
    vorgangId: row.vorgang_id,
    status: row.status,
    deleted,
    payload,
    ...(consumed ? { consumedClientAmendmentId: consumed } : {}),
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

export function orderAmendmentDraftFromCloud(
  payload: OrderAmendmentDraftCloudPayload,
  rowVersion: number,
  updatedAt: string,
  deviceId: string,
  workspaceId: string,
): OrderAmendment {
  return {
    ...detachDraftValue(payload),
    status: 'entwurf',
    sync: syncMetaFor(rowVersion, updatedAt, false, deviceId, workspaceId),
  };
}

function remoteStateOf(mapped: MappedOrderAmendmentDraftRow): DraftCloudRemoteState<OrderAmendmentDraftCloudPayload> {
  return {
    rowVersion: mapped.rowVersion,
    status: mapped.status,
    deleted: mapped.deleted,
    payload: mapped.payload ? detachDraftValue(mapped.payload) : null,
    ...(mapped.consumedClientAmendmentId ? { consumedRef: mapped.consumedClientAmendmentId } : {}),
  };
}

type Conflict = DraftCloudConflict<OrderAmendmentDraftCloudPayload>;

/* -------------------------------------------------------------------------- */
/* Abgleich                                                                    */
/* -------------------------------------------------------------------------- */

export interface OrderAmendmentDraftPullMerge {
  vorgaenge: Vorgang[];
  tombstones: OrderAmendmentDraftTombstone[];
  conflicts: string[];
  /** Kennungen, deren offener Sendeauftrag gegenstandslos geworden ist. */
  settledIds: string[];
}

/**
 * Zeilenweiser Abgleich nach Entwurfskennung, eingehängt in den richtigen
 * Vorgang. Ein Cloud-Entwurf, dessen Auftrag hier (noch) fehlt, wird nicht
 * verloren und keinem falschen Vorgang zugeordnet: Er bleibt in der Cloud und
 * kommt mit dem nächsten Abzug wieder — dann mit seinem Auftrag.
 *
 * `dirtyIds` sind Entwürfe mit offenem Sendeauftrag, `lockedIds` Entwürfe mit
 * offener Bestätigungsabsicht auf diesem Gerät: Diese gehören dem
 * Wiederanlauf der Bestätigung und bleiben hier unberührt.
 */
export function mergeOrderAmendmentDraftsFromPull(input: {
  vorgaenge: Vorgang[];
  tombstones: OrderAmendmentDraftTombstone[];
  remoteRows: WorkspaceOrderAmendmentDraftRow[];
  deviceId: string;
  workspaceId: string;
  dirtyIds?: ReadonlySet<string>;
  lockedIds?: ReadonlySet<string>;
  now?: string;
}): OrderAmendmentDraftPullMerge {
  const now = input.now ?? new Date().toISOString();
  const dirtyIds = input.dirtyIds ?? new Set<string>();
  const lockedIds = input.lockedIds ?? new Set<string>();
  const conflicts: string[] = [];
  const settledIds: string[] = [];

  const vorgangById = new Map(input.vorgaenge.map((vorgang) => [vorgang.id, vorgang]));
  /** Lebende Entwürfe je Vorgang, in ihrer bisherigen Reihenfolge. */
  const draftsByVorgang = new Map<string, OrderAmendment[]>();
  const liveById = new Map<string, OrderAmendment>();
  for (const vorgang of input.vorgaenge) {
    if (!isSyncActiveVorgang(vorgang)) continue;
    const list = (vorgang.orderAmendments ?? []).map((draft) => ({ ...draft, vorgangId: vorgang.id }));
    draftsByVorgang.set(vorgang.id, list);
    for (const draft of list) liveById.set(draft.id, draft);
  }
  const tombById = new Map(input.tombstones.map((tombstone) => [tombstone.id, tombstone]));
  const seen = new Set<string>();
  const touched = new Set<string>();

  const replaceLive = (vorgangId: string, draftId: string, next: OrderAmendment | null) => {
    const list = draftsByVorgang.get(vorgangId) ?? [];
    const index = list.findIndex((draft) => draft.id === draftId);
    if (next === null) {
      if (index >= 0) list.splice(index, 1);
    } else if (index >= 0) {
      list[index] = next;
    } else {
      list.push(next);
    }
    draftsByVorgang.set(vorgangId, list);
    if (next === null) liveById.delete(draftId);
    else liveById.set(draftId, next);
    touched.add(vorgangId);
  };

  /** Nur ein bestehender, bestätigter, nicht gelöschter Auftrag nimmt einen Nachtragsentwurf auf. */
  const canHost = (vorgangId: string) => {
    const vorgang = vorgangById.get(vorgangId);
    return Boolean(vorgang && isSyncActiveVorgang(vorgang) && vorgang.contractConfirmation);
  };

  for (const row of input.remoteRows) {
    const mapped = mapWorkspaceOrderAmendmentDraftRow(row);
    if (!mapped) continue;
    seen.add(mapped.draftId);
    if (lockedIds.has(mapped.draftId)) continue;
    const live = liveById.get(mapped.draftId) ?? null;
    const tomb = tombById.get(mapped.draftId) ?? null;
    const dirty = dirtyIds.has(mapped.draftId);

    // Ein Entwurf wechselt nie seinen Auftrag; eine abweichende Zeile wird nicht übernommen.
    if (live && live.vorgangId !== mapped.vorgangId) continue;

    /* Endzustände: verworfen oder bestätigt. */
    if (mapped.deleted || mapped.status === 'consumed') {
      if (tomb) {
        tombById.delete(mapped.draftId);
        settledIds.push(mapped.draftId);
        continue;
      }
      if (!live) continue;
      if (dirty || live.conflict) {
        replaceLive(live.vorgangId, live.id, {
          ...live,
          conflict: {
            kind: mapped.status === 'consumed' ? 'consumed' : 'deleted',
            detectedAt: live.conflict?.detectedAt ?? now,
            remote: remoteStateOf(mapped),
          },
        });
        conflicts.push(`order_amendment_draft:${mapped.draftId}`);
        continue;
      }
      replaceLive(live.vorgangId, live.id, null);
      continue;
    }

    if (!mapped.payload) continue;
    const remote = orderAmendmentDraftFromCloud(mapped.payload, mapped.rowVersion, mapped.updatedAt, input.deviceId, input.workspaceId);

    if (tomb) {
      if (mapped.rowVersion <= (tomb.sync.version ?? 0)) continue;
      // Hier verworfen, anderswo inzwischen geändert: kein Löschen auf Verdacht.
      if (!canHost(mapped.vorgangId)) continue;
      tombById.delete(mapped.draftId);
      replaceLive(mapped.vorgangId, mapped.draftId, {
        ...remote,
        conflict: { kind: 'discard_rejected', detectedAt: now, remote: remoteStateOf(mapped) },
      });
      settledIds.push(mapped.draftId);
      conflicts.push(`order_amendment_draft:${mapped.draftId}`);
      continue;
    }

    if (!live) {
      if (canHost(mapped.vorgangId)) replaceLive(mapped.vorgangId, mapped.draftId, remote);
      continue;
    }

    const localVersion = live.sync?.version ?? 0;
    const sameContent = buildOrderAmendmentDraftCloudContentKey(live) === buildOrderAmendmentDraftCloudContentKey(remote);

    if (live.conflict) {
      if (live.conflict.kind === 'discard_rejected') {
        replaceLive(live.vorgangId, live.id, { ...remote, conflict: { ...live.conflict, remote: remoteStateOf(mapped) } });
        continue;
      }
      if (sameContent && mapped.rowVersion >= localVersion) {
        replaceLive(live.vorgangId, live.id, remote);
        continue;
      }
      replaceLive(live.vorgangId, live.id, {
        ...live,
        conflict: { ...live.conflict, kind: 'version', remote: remoteStateOf(mapped) } satisfies Conflict,
      });
      conflicts.push(`order_amendment_draft:${mapped.draftId}`);
      continue;
    }

    if (mapped.rowVersion === localVersion) {
      if (sameContent) replaceLive(live.vorgangId, live.id, remote);
      continue;
    }

    if (mapped.rowVersion > localVersion) {
      if (!dirty || sameContent) {
        replaceLive(live.vorgangId, live.id, remote);
        continue;
      }
      replaceLive(live.vorgangId, live.id, {
        ...live,
        conflict: { kind: 'version', detectedAt: now, remote: remoteStateOf(mapped) },
      });
      conflicts.push(`order_amendment_draft:${mapped.draftId}`);
    }
  }

  // Ein Grabstein, den die Cloud nie gesehen hat und der nicht mehr unterwegs ist, ist gegenstandslos.
  for (const tombstone of [...tombById.values()]) {
    if (!seen.has(tombstone.id) && !dirtyIds.has(tombstone.id)) tombById.delete(tombstone.id);
  }

  const vorgaenge = input.vorgaenge.map((vorgang) => {
    if (!touched.has(vorgang.id)) return vorgang;
    const drafts = (draftsByVorgang.get(vorgang.id) ?? []).map((draft) => ({ ...draft, vorgangId: vorgang.id }));
    return { ...vorgang, orderAmendments: drafts.length > 0 ? drafts : undefined };
  });

  return { vorgaenge, tombstones: [...tombById.values()], conflicts, settledIds };
}

/**
 * Altbestand — lebende Entwürfe, die die Cloud noch nicht kennt. Gegen
 * **alle** Serverzeilen verglichen, Endzustände eingeschlossen. Nur Entwürfe,
 * deren Auftrag die Cloud als bestätigten Auftrag kennt; nie mit offenem
 * Konflikt, nie mit Bestätigungsabsicht, nie bereits unterwegs.
 */
export function planOrderAmendmentDraftBackfill(input: {
  vorgaenge: Vorgang[];
  remoteRows: WorkspaceOrderAmendmentDraftRow[];
  /** Vorgänge, die die Cloud als bestätigten Auftrag kennt. */
  cloudOrderIds: ReadonlySet<string>;
  dirtyIds?: ReadonlySet<string>;
  intentDraftIds?: ReadonlySet<string>;
}): string[] {
  const remoteIds = new Set(
    input.remoteRows.map((row) => row.client_draft_id).filter((id): id is string => isNonEmptyDraftString(id)),
  );
  const dirtyIds = input.dirtyIds ?? new Set<string>();
  const intentIds = input.intentDraftIds ?? new Set<string>();
  return input.vorgaenge
    .filter(isSyncActiveVorgang)
    .filter((vorgang) => input.cloudOrderIds.has(vorgang.id))
    .flatMap((vorgang) => vorgang.orderAmendments ?? [])
    .filter((draft) => !draft.conflict)
    .filter((draft) => (draft.sync?.version ?? 0) === 0)
    .filter((draft) => !remoteIds.has(draft.id) && !dirtyIds.has(draft.id) && !intentIds.has(draft.id))
    .map((draft) => draft.id);
}

/**
 * Nach erfolgreichem Versand: Die Serverversion wird am lebenden Entwurf
 * vermerkt — ohne Inhalt. Ein bestätigter Grabstein verschwindet: Ab jetzt
 * verhindert der Server ein Wiederbeleben.
 */
export function applyOrderAmendmentDraftPushResultToState(
  state: Pick<AppPersistedState, 'vorgaenge' | 'orderAmendmentDraftTombstones'>,
  draftId: string,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): Pick<AppPersistedState, 'vorgaenge' | 'orderAmendmentDraftTombstones'> {
  if (deleted) {
    return {
      vorgaenge: state.vorgaenge,
      orderAmendmentDraftTombstones: (state.orderAmendmentDraftTombstones ?? []).filter(
        (tombstone) => tombstone.id !== draftId,
      ),
    };
  }
  return {
    vorgaenge: (state.vorgaenge ?? []).map((vorgang) => {
      if (!(vorgang.orderAmendments ?? []).some((draft) => draft.id === draftId)) return vorgang;
      return {
        ...vorgang,
        orderAmendments: (vorgang.orderAmendments ?? []).map((draft) =>
          draft.id === draftId
            ? { ...draft, sync: { ...draft.sync, ...syncMetaFor(rowVersion, updatedAt, false, deviceId, workspaceId) } }
            : draft,
        ),
      };
    }),
    orderAmendmentDraftTombstones: state.orderAmendmentDraftTombstones,
  };
}

/** SYNC-DURABILITY-HARDENING-01G4 bis 01G7 — derselbe Wiederanlauf wie bei S3 und S5. */
export function planOrderAmendmentDraftLostAckAdoption(
  entities: OrderAmendment[],
  remoteRows: WorkspaceOrderAmendmentDraftRow[],
  activeOutboxDraftIds: ReadonlySet<string>,
  sentWrites?: ReadonlyMap<string, LostAckSentWrite>,
): LostAckAdoptionPlan {
  const remotes = new Map<string, LostAckRemoteRow>();
  for (const row of remoteRows) {
    const mapped = mapWorkspaceOrderAmendmentDraftRow(row);
    if (!mapped) continue;
    remotes.set(mapped.draftId, {
      rowVersion: mapped.rowVersion,
      deleted: mapped.deleted || mapped.status === 'consumed',
      contentKey: mapped.payload ? buildOrderAmendmentDraftPayloadKey(mapped.payload) : undefined,
    });
  }
  return planLostAckAdoption(entities, remotes, activeOutboxDraftIds, {
    sentWrites,
    localContentKey: buildOrderAmendmentDraftCloudContentKey,
  });
}

/**
 * Übernahme der Lost-Ack-Basisversion in die verschachtelte Ablage: lebende
 * Entwürfe im Vorgang, Grabsteine nebenan.
 */
export function adoptOrderAmendmentDraftBaseVersions(
  vorgaenge: Vorgang[],
  tombstones: OrderAmendmentDraftTombstone[],
  baseVersions: ReadonlyMap<string, number>,
  ids: ReadonlySet<string>,
  meta: { deviceId: string; workspaceId: string },
): { vorgaenge: Vorgang[]; tombstones: OrderAmendmentDraftTombstone[] } {
  if (ids.size === 0) return { vorgaenge, tombstones };
  const adopt = <T extends { id: string; sync?: SyncMeta }>(entity: T): T => {
    if (!ids.has(entity.id)) return entity;
    return {
      ...entity,
      sync: {
        ...entity.sync,
        updatedAt: entity.sync?.updatedAt ?? new Date().toISOString(),
        version: baseVersions.get(entity.id) ?? 1,
        deleted: entity.sync?.deleted ?? false,
        deviceId: meta.deviceId,
        workspaceId: meta.workspaceId,
      },
    };
  };
  return {
    vorgaenge: vorgaenge.map((vorgang) =>
      (vorgang.orderAmendments ?? []).some((draft) => ids.has(draft.id))
        ? { ...vorgang, orderAmendments: (vorgang.orderAmendments ?? []).map(adopt) }
        : vorgang,
    ),
    tombstones: tombstones.map((tombstone) => adopt(tombstone)),
  };
}
