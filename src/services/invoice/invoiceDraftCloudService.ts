/**
 * CLOUD-SYNC S5 — Cloud-Anbindung des fachlichen Rechnungsentwurfs.
 *
 * Diese Datei trägt ausschliesslich Transport: fachlicher Kern, Inhaltsschlüssel,
 * Push-Form, Lesen der Serverzeile, Abgleich mit Konfliktvertrag, Altbestand und
 * Wiederanlauf nach verlorener Bestätigung. **Keine** Fachlogik und keine
 * IndexedDB: Der Entwurf selbst entsteht und ändert sich weiterhin im
 * Entwurfskern (`invoiceDraftDurabilityService`); die Brücke zwischen beiden
 * liegt in `invoiceDraftCloudBridge`.
 *
 * Aufgebaut nach dem Muster von `knowledgeFactCloudService` (S3) — dieselbe
 * Versionssemantik, derselbe Wiederanlauf aus 01G bis 01G7. Bewusst keine
 * zweite Sync-Architektur. Anders als dort hängt ein Konflikt **am Spiegel**
 * und trägt den Serverstand: Ein Rechnungsentwurf ist Arbeit des Nutzers, und
 * die Entscheidung darüber trifft er sichtbar, nicht der Abgleich.
 */
import { mergeSyncEntities } from '../sync/syncMergeEngine';
import {
  planLostAckAdoption,
  type LostAckAdoptionPlan,
  type LostAckRemoteRow,
  type LostAckSentWrite,
} from '../sync/syncLostAckAdoptionService';
import { INVOICE_DOCUMENT_TYPES } from '../invoiceTypeService';
import type {
  CompanyProfile,
  InvoiceDocumentType,
  InvoiceDraft,
  InvoiceDraftPosition,
} from '../../types/models';
import type {
  InvoiceDraftCloudConflict,
  InvoiceDraftCloudCore,
  InvoiceDraftCloudEntity,
  InvoiceDraftCloudPosition,
  InvoiceDraftCloudRemoteState,
  InvoiceDraftCloudStatus,
  WorkspaceInvoiceDraftRow,
} from '../../types/invoiceDraftCloud';
import type { SyncMeta } from '../../types/sync';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInvoiceDocumentType(value: unknown): value is InvoiceDocumentType {
  return typeof value === 'string' && INVOICE_DOCUMENT_TYPES.includes(value as InvoiceDocumentType);
}

/**
 * Schlüsselstabile Textform. `jsonb` bewahrt die Schlüsselreihenfolge nicht —
 * ein roher `JSON.stringify`-Vergleich hielte denselben Kern nach einem Abzug
 * für verändert, und jede Rückschreibung löste den nächsten Push aus. Arrays
 * behalten ihre Reihenfolge (sie ist fachlich), `undefined` entfällt wie in
 * JSON, `null` bleibt eine Aussage.
 */
export function canonicalInvoiceDraftJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalInvoiceDraftJson(item === undefined ? null : item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalInvoiceDraftJson(entry)}`).join(',')}}`;
}

/** Tiefe, JSON-treue Kopie — der Kern teilt nie Referenzen mit dem Entwurf. */
function detach<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/* -------------------------------------------------------------------------- */
/* Der fachliche Kern                                                          */
/* -------------------------------------------------------------------------- */

/** Positionskern: Auftragsprojektion bleibt draussen, sie wird neu abgeleitet. */
function stripPositionForCloud(position: InvoiceDraftPosition): InvoiceDraftCloudPosition {
  const core: InvoiceDraftCloudPosition = {
    id: position.id,
    description: position.description,
    quantity: position.quantity,
    unit: position.unit,
    unitPrice: position.unitPrice,
    billable: position.billable,
  };
  if (position.orderPositionId !== undefined) core.orderPositionId = position.orderPositionId;
  if (position.unitLabel !== undefined) core.unitLabel = position.unitLabel;
  if (position.category !== undefined) core.category = position.category;
  return core;
}

/** Der eingefrorene Firmenblock — ohne das gerätelokale Legacy-Logo. */
function stripCompanySnapshotForCloud(snapshot: CompanyProfile): CompanyProfile {
  const { logoDataUrl: _logoDataUrl, ...rest } = snapshot;
  return detach(rest);
}

/**
 * Ausdrückliche Allowlist statt Rest-Spread: Ein später ergänztes Pflichtfeld
 * im Entwurf bricht hier den Build, statt unbemerkt in die Cloud zu wandern
 * oder unbemerkt zu fehlen. Optionale Felder reisen nur mit, wenn sie belegt
 * sind.
 */
export function stripInvoiceDraftForCloud(draft: InvoiceDraft): InvoiceDraftCloudCore {
  const core: InvoiceDraftCloudCore = {
    id: draft.id,
    vorgangId: draft.vorgangId,
    customer: draft.customer,
    baustelle: draft.baustelle,
    type: draft.type,
    taxStatus: draft.taxStatus,
    materialSource: draft.materialSource,
    positions: draft.positions.map(stripPositionForCloud),
    issueDate: draft.issueDate,
    servicePeriodFrom: draft.servicePeriodFrom,
    servicePeriodTo: draft.servicePeriodTo,
    paymentDueDate: draft.paymentDueDate,
    paymentTermsText: draft.paymentTermsText,
    skontoText: draft.skontoText,
    customerBilling: detach(draft.customerBilling),
    companySnapshot: stripCompanySnapshotForCloud(draft.companySnapshot),
    legalNotices: [...draft.legalNotices],
    introText: draft.introText,
    closingText: draft.closingText,
  };
  if (draft.currencyCode !== undefined) core.currencyCode = draft.currencyCode;
  if (draft.vorgangTitle !== undefined) core.vorgangTitle = draft.vorgangTitle;
  if (draft.abschlagNumber !== undefined) core.abschlagNumber = draft.abschlagNumber;
  if (draft.calculationMode !== undefined) core.calculationMode = draft.calculationMode;
  if (draft.fixedAmountNet !== undefined) core.fixedAmountNet = draft.fixedAmountNet;
  if (draft.servicePeriodConfirmed !== undefined) core.servicePeriodConfirmed = draft.servicePeriodConfirmed;
  if (draft.customerId !== undefined) core.customerId = draft.customerId;
  if (draft.brandingSnapshot !== undefined) core.brandingSnapshot = detach(draft.brandingSnapshot);
  if (draft.expectedAmendmentSequence !== undefined) {
    core.expectedAmendmentSequence = draft.expectedAmendmentSequence;
  }
  return core;
}

/** Stabiler Vergleichsschlüssel des fachlichen Kerns. */
export function buildInvoiceDraftCoreKey(core: InvoiceDraftCloudCore): string {
  return canonicalInvoiceDraftJson(core);
}

/** Der Kern eines lokalen Entwurfs, unmittelbar als Vergleichsschlüssel. */
export function buildInvoiceDraftCoreKeyFromDraft(draft: InvoiceDraft): string {
  return buildInvoiceDraftCoreKey(stripInvoiceDraftForCloud(draft));
}

/**
 * Inhaltsschlüssel des Spiegels für den Änderungsverfolger. Enthält bewusst
 * keine `SyncMeta`, keinen Status (den setzt nur der Server), keine lokale
 * Verknüpfung und keinen Konflikt: Sonst löste jede Rückschreibung und jede
 * rein lokale Notiz den nächsten Push aus.
 */
export function buildInvoiceDraftCloudContentKey(entity: InvoiceDraftCloudEntity): string {
  return canonicalInvoiceDraftJson({
    id: entity.id,
    vorgangId: entity.vorgangId,
    invoiceType: entity.invoiceType,
    core: entity.core,
  });
}

/** Versandform: Kennung, Slot, Kern und — beim Verwerfen — der Grabstein. */
export function buildInvoiceDraftCloudPushPayload(
  entity: InvoiceDraftCloudEntity,
  deleted = false,
): Record<string, unknown> {
  return {
    draft_id: entity.id,
    vorgang_id: entity.vorgangId,
    invoice_type: entity.invoiceType,
    payload: deleted || !entity.core ? {} : detach(entity.core),
    deleted,
  };
}

/* -------------------------------------------------------------------------- */
/* Lesen der Serverzeile                                                       */
/* -------------------------------------------------------------------------- */

/** Mindestprüfung des Kerns; der Server hat Nummer, Projektion und Lokales bereits abgewiesen. */
export function parseInvoiceDraftCloudCore(
  payload: unknown,
  expected: { draftId: string; vorgangId: string | null; invoiceType: InvoiceDocumentType },
): InvoiceDraftCloudCore | null {
  if (!isPlainObject(payload)) return null;
  if (payload.id !== expected.draftId) return null;
  if (payload.type !== expected.invoiceType) return null;
  const vorgangId = payload.vorgangId ?? null;
  if (vorgangId !== expected.vorgangId) return null;
  if (!Array.isArray(payload.positions)) return null;
  if (!payload.positions.every((position) => isPlainObject(position) && isNonEmptyString(position.id))) {
    return null;
  }
  if (!isPlainObject(payload.customerBilling) || !isPlainObject(payload.companySnapshot)) return null;
  if (!Array.isArray(payload.legalNotices)) return null;
  return detach(payload) as unknown as InvoiceDraftCloudCore;
}

export interface MappedInvoiceDraftRow {
  draftId: string;
  vorgangId: string | null;
  invoiceType: InvoiceDocumentType;
  status: InvoiceDraftCloudStatus;
  deleted: boolean;
  core: InvoiceDraftCloudCore | null;
  finalizedClientInvoiceId?: string;
  rowVersion: number;
  updatedAt: string;
}

export function mapWorkspaceInvoiceDraftRow(row: WorkspaceInvoiceDraftRow): MappedInvoiceDraftRow | null {
  if (!isNonEmptyString(row.client_draft_id)) return null;
  if (!isInvoiceDocumentType(row.invoice_type)) return null;
  const vorgangId = isNonEmptyString(row.vorgang_id) ? row.vorgang_id : null;
  if (vorgangId === null && row.invoice_type !== 'rechnung') return null;
  const status: InvoiceDraftCloudStatus = row.status === 'finalized' ? 'finalized' : 'active';
  if (row.status !== 'finalized' && row.status !== 'active') return null;
  const rowVersion = Number(row.row_version);
  if (!Number.isInteger(rowVersion) || rowVersion < 1) return null;
  const finalizedClientInvoiceId = isNonEmptyString(row.finalized_client_invoice_id)
    ? row.finalized_client_invoice_id
    : undefined;
  if (status === 'finalized' && !finalizedClientInvoiceId) return null;

  const deleted = Boolean(row.deleted);
  const tombstone = deleted || status === 'finalized';
  /*
   * Ein Grabstein trägt im Spiegel keinen Inhalt mehr: Der Server bewahrt ihn
   * als Nachweis, das Gerät braucht nur das Ende — und der Spiegel wüchse sonst
   * mit jeder Rechnung um einen vollständigen Entwurf.
   */
  const core = tombstone
    ? null
    : parseInvoiceDraftCloudCore(row.payload, {
        draftId: row.client_draft_id,
        vorgangId,
        invoiceType: row.invoice_type,
      });
  if (!tombstone && !core) return null;

  return {
    draftId: row.client_draft_id,
    vorgangId,
    invoiceType: row.invoice_type,
    status,
    deleted,
    core,
    ...(finalizedClientInvoiceId ? { finalizedClientInvoiceId } : {}),
    rowVersion,
    updatedAt: row.updated_at,
  };
}

function syncMetaFor(
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): SyncMeta {
  return {
    updatedAt,
    version: rowVersion,
    deleted,
    deletedAt: deleted ? updatedAt : undefined,
    deviceId,
    workspaceId,
  };
}

export function invoiceDraftEntityFromCloud(
  mapped: MappedInvoiceDraftRow,
  deviceId: string,
  workspaceId: string,
): InvoiceDraftCloudEntity {
  return {
    id: mapped.draftId,
    vorgangId: mapped.vorgangId,
    invoiceType: mapped.invoiceType,
    status: mapped.status,
    core: mapped.core ? detach(mapped.core) : null,
    ...(mapped.finalizedClientInvoiceId ? { finalizedClientInvoiceId: mapped.finalizedClientInvoiceId } : {}),
    sync: syncMetaFor(mapped.rowVersion, mapped.updatedAt, mapped.deleted, deviceId, workspaceId),
  };
}

function remoteStateOf(mapped: MappedInvoiceDraftRow): InvoiceDraftCloudRemoteState {
  return {
    rowVersion: mapped.rowVersion,
    status: mapped.status,
    deleted: mapped.deleted,
    core: mapped.core ? detach(mapped.core) : null,
    ...(mapped.finalizedClientInvoiceId ? { finalizedClientInvoiceId: mapped.finalizedClientInvoiceId } : {}),
  };
}

/** Grabstein im Spiegel: verworfen oder zur Rechnung geworden. */
export function isInvoiceDraftCloudTombstone(entity: Pick<InvoiceDraftCloudEntity, 'status' | 'sync'>): boolean {
  return entity.status === 'finalized' || entity.sync?.deleted === true;
}

/* -------------------------------------------------------------------------- */
/* Abgleich                                                                    */
/* -------------------------------------------------------------------------- */

function withConflict(
  local: InvoiceDraftCloudEntity,
  conflict: InvoiceDraftCloudConflict,
): InvoiceDraftCloudEntity {
  return { ...local, conflict };
}

/**
 * Zeilenweiser Abgleich nach Entwurfskennung, aufgebaut auf der vorhandenen
 * Merge-Engine. Kein Feldmerge und keine Last-Write-Wins-Regel.
 *
 * `dirtyIds` sind die Kennungen mit **offenem Sendeauftrag** (eigene, noch
 * nicht bestätigte Arbeit). Trifft eine solche auf einen neueren oder
 * endgültigen Serverstand, bleibt der eigene Stand vollständig stehen — mit
 * seiner alten Version, damit der Server ihn als Konflikt abweist — und der
 * Serverstand wird **am Spiegel** festgehalten. Die Entscheidung trifft der
 * Nutzer im Rechnungseditor.
 *
 * Grabsteine bleiben im Spiegel (ohne Inhalt): Nur so weiss ein Gerät mit
 * einem alten lokalen Entwurf, dass es ihn nicht wieder hochladen darf.
 */
export function mergeInvoiceDraftsFromPull(
  localEntities: InvoiceDraftCloudEntity[],
  remoteRows: WorkspaceInvoiceDraftRow[],
  deviceId: string,
  workspaceId: string,
  dirtyIds: ReadonlySet<string> = new Set(),
  now: string = new Date().toISOString(),
): { entities: InvoiceDraftCloudEntity[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const byId = new Map(localEntities.map((entity) => [entity.id, entity]));

  for (const row of remoteRows) {
    const mapped = mapWorkspaceInvoiceDraftRow(row);
    if (!mapped) continue;

    const local = byId.get(mapped.draftId) ?? null;
    const remote = invoiceDraftEntityFromCloud(mapped, deviceId, workspaceId);
    const tombstone = mapped.deleted || mapped.status === 'finalized';

    if (!local) {
      byId.set(remote.id, remote);
      continue;
    }

    /* Endgültige Zustände. */
    if (tombstone) {
      if (isInvoiceDraftCloudTombstone(local) && (local.sync?.version ?? 0) >= mapped.rowVersion) {
        continue;
      }
      if (dirtyIds.has(mapped.draftId) && !local.sync?.deleted) {
        // Eigene ungesendete Arbeit trifft auf ein Ende anderswo: festhalten, nicht verwerfen.
        byId.set(
          mapped.draftId,
          withConflict(local, {
            kind: mapped.status === 'finalized' ? 'finalized' : 'deleted',
            detectedAt: now,
            remote: remoteStateOf(mapped),
          }),
        );
        conflicts.push(`invoice_draft:${mapped.draftId}`);
        continue;
      }
      /*
       * Lokal sauber: Der Grabstein ist die jüngere Wahrheit. Die Verknüpfung
       * zum IndexedDB-Stand bleibt stehen — der Editor meldet das Ende beim
       * nächsten Öffnen sichtbar, statt den lokalen Entwurf still zu löschen.
       */
      byId.set(mapped.draftId, {
        ...remote,
        ...(local.localLink ? { localLink: local.localLink } : {}),
      });
      continue;
    }

    if (!mapped.core) continue;

    // Lokal verworfen, remote noch aktiv: Der Grabstein wartet und ist die jüngere Absicht.
    if (local.sync?.deleted === true) continue;

    const localVersion = local.sync?.version ?? 0;
    const sameContent = buildInvoiceDraftCloudContentKey(local) === buildInvoiceDraftCloudContentKey(remote);

    if (localVersion === mapped.rowVersion) {
      if (sameContent) {
        byId.set(mapped.draftId, {
          ...remote,
          ...(local.localLink ? { localLink: local.localLink } : {}),
        });
      }
      // Sonst: eigene Änderung auf genau dieser Version — sie geht beim nächsten Push hinaus.
      continue;
    }

    if (dirtyIds.has(mapped.draftId) && mapped.rowVersion !== localVersion) {
      if (sameContent) {
        // Verlorene Bestätigung: Die Serverfassung ist die eigene.
        byId.set(mapped.draftId, {
          ...remote,
          ...(local.localLink ? { localLink: local.localLink } : {}),
        });
        continue;
      }
      byId.set(
        mapped.draftId,
        withConflict(local, { kind: 'version', detectedAt: now, remote: remoteStateOf(mapped) }),
      );
      conflicts.push(`invoice_draft:${mapped.draftId}`);
      continue;
    }

    const merged = mergeSyncEntities(local, remote, 'invoice_draft');
    if (merged.conflict) {
      byId.set(
        mapped.draftId,
        withConflict(local, { kind: 'version', detectedAt: now, remote: remoteStateOf(mapped) }),
      );
      conflicts.push(`invoice_draft:${mapped.draftId}`);
      continue;
    }
    if (merged.entity) {
      /*
       * Vorlauf ohne eigene ungesendete Arbeit: Der Spiegel übernimmt die
       * Serverfassung. Ob der lokale Entwurf seither verändert wurde, prüft die
       * Brücke über `localLink` — dort, wo der IndexedDB-Stand bekannt ist.
       */
      const { conflict: _conflict, ...rest } = merged.entity;
      byId.set(merged.entity.id, {
        ...rest,
        ...(local.localLink ? { localLink: local.localLink } : {}),
      });
    }
  }

  /*
   * Slot-Vertrag: Ein lokal angelegter Entwurf, den der Server nicht kennt, trifft
   * auf einen anderen aktiven Entwurf desselben Slots — typischerweise zwei offline
   * angelegte Entwürfe. Das ist ein ausdrücklicher Konflikt am eigenen Entwurf;
   * ohne ihn liefe der Altbestand bei jedem Abzug erneut gegen dieselbe Abweisung.
   */
  const remoteIds = new Set(
    remoteRows
      .map((row) => row.client_draft_id)
      .filter((id): id is string => isNonEmptyString(id)),
  );
  for (const entity of [...byId.values()]) {
    if (remoteIds.has(entity.id) || entity.conflict || isInvoiceDraftCloudTombstone(entity)) continue;
    const owner = [...byId.values()].find(
      (other) =>
        other.id !== entity.id &&
        remoteIds.has(other.id) &&
        !isInvoiceDraftCloudTombstone(other) &&
        other.vorgangId === entity.vorgangId &&
        other.invoiceType === entity.invoiceType,
    );
    if (!owner) continue;
    byId.set(entity.id, withConflict(entity, { kind: 'slot', detectedAt: now, slotDraftId: owner.id }));
    conflicts.push(`invoice_draft_slot:${entity.id}`);
  }

  return { entities: [...byId.values()], conflicts };
}

/**
 * Altbestand im Spiegel — Entwürfe, die die Cloud noch nicht kennt. Verglichen
 * wird ausschliesslich über Kennungen, und zwar gegen **alle** Serverzeilen
 * einschliesslich der Grabsteine: Sonst lüde ein zweites Gerät einen anderswo
 * verworfenen oder finalisierten Entwurf wieder hoch.
 */
export function planInvoiceDraftBackfill(
  localEntities: InvoiceDraftCloudEntity[],
  remoteRows: WorkspaceInvoiceDraftRow[],
): string[] {
  const remoteIds = new Set(
    remoteRows
      .map((row) => row.client_draft_id)
      .filter((id): id is string => isNonEmptyString(id)),
  );
  return localEntities
    .filter((entity) => !isInvoiceDraftCloudTombstone(entity))
    .filter((entity) => entity.core !== null)
    .filter((entity) => !entity.conflict)
    .filter((entity) => !remoteIds.has(entity.id))
    .map((entity) => entity.id);
}

/** Setzt nach erfolgreichem Versand die Serverversion — ohne den Kern anzufassen. */
export function applyInvoiceDraftPushResultToState(
  entities: InvoiceDraftCloudEntity[],
  draftId: string,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): InvoiceDraftCloudEntity[] {
  return entities.map((entity) => {
    if (entity.id !== draftId) return entity;
    const sync: SyncMeta = {
      ...entity.sync,
      ...syncMetaFor(rowVersion, updatedAt, deleted, deviceId, workspaceId),
      deletedAt: deleted ? updatedAt : entity.sync?.deletedAt,
    };
    return { ...entity, sync };
  });
}

/**
 * SYNC-DURABILITY-HARDENING-01G4 bis 01G7 — Wiederanlauf nach verlorener
 * Bestätigung und nach einem Schreibvorgang, der den Server nie erreicht hat.
 * Die Bewertung selbst liegt in `planLostAckAdoption`.
 */
export function planInvoiceDraftLostAckAdoption(
  localEntities: InvoiceDraftCloudEntity[],
  remoteRows: WorkspaceInvoiceDraftRow[],
  activeOutboxDraftIds: ReadonlySet<string>,
  sentWrites?: ReadonlyMap<string, LostAckSentWrite>,
): LostAckAdoptionPlan {
  const remotes = new Map<string, LostAckRemoteRow>();
  for (const row of remoteRows) {
    const mapped = mapWorkspaceInvoiceDraftRow(row);
    if (!mapped) continue;
    remotes.set(mapped.draftId, {
      rowVersion: mapped.rowVersion,
      deleted: mapped.deleted || mapped.status === 'finalized',
      contentKey: mapped.core
        ? buildInvoiceDraftCloudContentKey(invoiceDraftEntityFromCloud(mapped, '', ''))
        : undefined,
    });
  }
  return planLostAckAdoption(localEntities, remotes, activeOutboxDraftIds, {
    sentWrites,
    localContentKey: buildInvoiceDraftCloudContentKey,
  });
}
