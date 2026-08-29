import type {
  ContractConfirmationSnapshot,
  Vorgang,
  VorgangStatus,
} from '../../types/models';
import type { SyncMeta } from '../../types/sync';
import { mergeSyncEntities } from '../sync/syncMergeEngine';
import { repairContractPlanFromSnapshot } from '../orderPlanIntegrityService';
import {
  canTransitionVorgangStatus,
  migrateVorgangStatus,
} from '../vorgangLifecycleService';

/** Cloud-syncable subset of Vorgang – ohne Rechnungen, Dokumente, Aufgaben, Fotos, Negotiation. */
export interface VorgangCloudPayload {
  id: string;
  title: string;
  customer: string;
  baustelle: string;
  status: Vorgang['status'];
  materialSource: Vorgang['materialSource'];
  customerBilling?: Vorgang['customerBilling'];
  /**
   * PRODUCT-FOUNDATION-03B — die stabile Beziehung zum Kundenstamm.
   *
   * Bewusst nur der Zeiger, nicht die Auflösung: `customer` und
   * `customerBilling` bleiben historische Snapshots und werden davon nie
   * berührt. Legacy-Vorgänge ohne Relation lassen das Feld weg — kein leerer
   * String.
   */
  customerId?: string;
  orderPositions: Vorgang['orderPositions'];
  createdFromInboxId?: string;
  /** CLOUD-ORDER-CHAIN-01: immutable confirm snapshot (write-once on merge). */
  contractConfirmation?: ContractConfirmationSnapshot;
  /** CLOUD-ORDER-CHAIN-01: execution start timestamp (write-once on merge). */
  executionStartedAt?: string;
}

export interface WorkspaceVorgangRow {
  workspace_id: string;
  vorgang_id: string;
  payload: Record<string, unknown>;
  row_version: number;
  deleted: boolean;
  deleted_at: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface ResolveVorgangStatusForCloudMergeInput {
  /** Local status before merge (undefined when creating from cloud only). */
  localStatus: VorgangStatus | undefined;
  /**
   * VORGANG-STATUS-CLOUD-PULL-01 — der Status aus der Cloud-Zeile.
   *
   * Er greift ausschliesslich dort, wo die Chain-Facts keinen Zustand
   * erzwingen. Ohne ihn gehen genau die Status verloren, die sich nicht aus
   * Facts rekonstruieren lassen: `in_pruefung` und `in_verhandlung`.
   */
  cloudStatus?: VorgangStatus | undefined;
  contractConfirmation: ContractConfirmationSnapshot | undefined;
  executionStartedAt: string | undefined;
}

/**
 * Status ohne Chain-Fact-Grundlage. Nur diese dürfen aus dem Cloud-Payload
 * übernommen werden: Alles ab `beauftragt` folgt den Facts, sonst entstünde
 * ein Zustand, den die Invariantenprüfung unmittelbar wieder zurücknähme.
 */
const FACT_FREE_STATUSES: ReadonlySet<VorgangStatus> = new Set([
  'eingegangen',
  'in_pruefung',
  'in_verhandlung',
]);

const EXECUTION_STATUSES: ReadonlySet<VorgangStatus> = new Set([
  'in_bearbeitung',
  'wartet',
  'abgeschlossen',
]);

function cloneCloudContractConfirmation(
  snapshot: ContractConfirmationSnapshot,
): ContractConfirmationSnapshot {
  return {
    ...snapshot,
    immutable: true,
    positions: (snapshot.positions ?? []).map((p) => ({ ...p })),
    negotiation: {
      conducted: snapshot.negotiation?.conducted ?? true,
      notes: [...(snapshot.negotiation?.notes ?? [])],
      generalHints: [...(snapshot.negotiation?.generalHints ?? [])],
      priceProposals: (snapshot.negotiation?.priceProposals ?? []).map((p) => ({ ...p })),
      positionProposals: (snapshot.negotiation?.positionProposals ?? []).map((p) => ({ ...p })),
      drafts: (snapshot.negotiation?.drafts ?? []).map((d) => ({
        ...d,
        sendConfirmed: false as const,
      })),
    },
  };
}

function readCloudContractConfirmation(
  value: unknown,
): ContractConfirmationSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as ContractConfirmationSnapshot;
  if (typeof raw.id !== 'string' || !raw.id) return undefined;
  return cloneCloudContractConfirmation({
    ...raw,
    immutable: true,
    positions: raw.positions ?? [],
    negotiation: {
      conducted: raw.negotiation?.conducted ?? true,
      notes: raw.negotiation?.notes ?? [],
      generalHints: raw.negotiation?.generalHints ?? [],
      priceProposals: raw.negotiation?.priceProposals ?? [],
      positionProposals: raw.negotiation?.positionProposals ?? [],
      drafts: raw.negotiation?.drafts ?? [],
    },
  });
}

function readCloudExecutionStartedAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

/** Sanitize chain facts: start without snapshot is invalid and dropped. */
export function sanitizeOrderChainCloudFacts(
  contractConfirmation: ContractConfirmationSnapshot | undefined,
  executionStartedAt: string | undefined,
): {
  contractConfirmation: ContractConfirmationSnapshot | undefined;
  executionStartedAt: string | undefined;
} {
  const confirmation = contractConfirmation
    ? cloneCloudContractConfirmation(contractConfirmation)
    : undefined;
  let startedAt = readCloudExecutionStartedAt(executionStartedAt);
  if (startedAt && !confirmation) {
    startedAt = undefined;
  }
  return { contractConfirmation: confirmation, executionStartedAt: startedAt };
}

/**
 * CLOUD-ORDER-CHAIN-02: derive merge status from lifecycle + chain facts.
 * No UI events / updateVorgangStatus calls.
 *
 * VORGANG-STATUS-CLOUD-PULL-01: Die Facts entscheiden weiterhin zuerst. Erst
 * wenn sie keinen Zustand erzwingen, kommt der Cloud-Status zum Zug — und dann
 * vor dem lokalen Status, weil eine neuere `row_version` den bestätigten
 * neueren Stand darstellt. Ein Konflikt ist zu diesem Zeitpunkt bereits
 * entschieden; hierher gelangt nur, was übernommen werden darf.
 */
export function resolveVorgangStatusForCloudMerge(
  input: ResolveVorgangStatusForCloudMergeInput,
): VorgangStatus {
  const { contractConfirmation, executionStartedAt } = sanitizeOrderChainCloudFacts(
    input.contractConfirmation,
    input.executionStartedAt,
  );
  const localStatus =
    input.localStatus !== undefined ? migrateVorgangStatus(input.localStatus) : undefined;

  // Terminal local status: never silently downgrade to beauftragt / in_bearbeitung.
  if (localStatus === 'abgeschlossen') {
    if (contractConfirmation && executionStartedAt) {
      return 'abgeschlossen';
    }
    // Corrupt terminal without facts — fall through to fact floors.
  }

  if (executionStartedAt && contractConfirmation) {
    if (localStatus === 'abgeschlossen') {
      return 'abgeschlossen';
    }
    if (
      localStatus === 'wartet' &&
      (canTransitionVorgangStatus('in_bearbeitung', 'wartet') ||
        canTransitionVorgangStatus('wartet', 'in_bearbeitung'))
    ) {
      return 'wartet';
    }
    return 'in_bearbeitung';
  }

  if (contractConfirmation) {
    return 'beauftragt';
  }

  // No chain facts: keep a pre-confirm local status when it does not require facts.
  const localIsPreConfirm =
    localStatus !== undefined && localStatus !== 'beauftragt' && !EXECUTION_STATUSES.has(localStatus);

  /*
   * VORGANG-STATUS-CLOUD-PULL-01 — der Cloud-Status gilt, sofern er ohne Facts
   * tragfähig ist. Ein lokaler Vorbestätigungsstatus tritt dahinter zurück:
   * Der Aufrufer reicht `cloudStatus` nur bei einer berechtigten Übernahme
   * herein, ein Versionskonflikt ist vorher abgefangen.
   *
   * Bewusst ohne zweite Übergangsprüfung: `ALLOWED_TRANSITIONS` gehört in den
   * UI-Lebenszyklus. Hier steht kein Übergang zur Entscheidung, sondern ein
   * bereits bestätigter fremder Zustand.
   */
  const cloudStatus =
    input.cloudStatus !== undefined ? migrateVorgangStatus(input.cloudStatus) : undefined;
  if (cloudStatus && FACT_FREE_STATUSES.has(cloudStatus)) {
    // Ein terminaler oder in Ausführung befindlicher lokaler Zustand ohne Facts
    // ist bereits defekt — er wird hier so wenig wiederhergestellt wie zuvor.
    if (localIsPreConfirm || localStatus === undefined) {
      return cloudStatus;
    }
  }

  if (localIsPreConfirm) {
    return localStatus;
  }

  return 'eingegangen';
}

/** Write-once: local wins when present; otherwise take cloud. */
export function resolveWriteOnceContractConfirmation(
  local: ContractConfirmationSnapshot | undefined,
  cloud: ContractConfirmationSnapshot | undefined,
): ContractConfirmationSnapshot | undefined {
  if (local) return cloneCloudContractConfirmation(local);
  if (cloud) return cloneCloudContractConfirmation(cloud);
  return undefined;
}

/** Write-once: local wins when present; otherwise take cloud. */
export function resolveWriteOnceExecutionStartedAt(
  local: string | undefined,
  cloud: string | undefined,
): string | undefined {
  if (local) return local;
  return cloud;
}

/**
 * Order-chain invariant check after status resolution.
 * Sanitizes facts and ensures status matches the fact-derived end state.
 */
export function applyOrderChainCloudInvariants(
  vorgang: Vorgang,
  options: { protectLocalStatus?: VorgangStatus; cloudStatus?: VorgangStatus } = {},
): Vorgang {
  const { contractConfirmation, executionStartedAt } = sanitizeOrderChainCloudFacts(
    vorgang.contractConfirmation,
    vorgang.executionStartedAt,
  );

  const status = resolveVorgangStatusForCloudMerge({
    localStatus: options.protectLocalStatus ?? vorgang.status,
    cloudStatus: options.cloudStatus,
    contractConfirmation,
    executionStartedAt,
  });

  return {
    ...vorgang,
    status,
    contractConfirmation,
    executionStartedAt,
  };
}

export function stripVorgangForCloud(vorgang: Vorgang): VorgangCloudPayload {
  // Avoid pushing reparable contract-plan drift from this client.
  const planSource = repairContractPlanFromSnapshot(vorgang).vorgang;

  const payload: VorgangCloudPayload = {
    id: planSource.id,
    title: planSource.title,
    customer: planSource.customer,
    baustelle: planSource.baustelle,
    status: planSource.status,
    materialSource: planSource.materialSource,
    customerBilling: planSource.customerBilling ? { ...planSource.customerBilling } : undefined,
    orderPositions: (planSource.orderPositions ?? []).map((p) => ({ ...p })),
    createdFromInboxId: planSource.createdFromInboxId,
  };

  /*
   * PRODUCT-FOUNDATION-03B — nur eine echte Relation reist mit. Ein leeres
   * Feld für Legacy-Vorgänge würde deren Content-Key ohne fachlichen Anlass
   * ändern und damit eine Push-Welle auslösen.
   */
  const customerId = planSource.customerId?.trim();
  if (customerId) {
    payload.customerId = customerId;
  }

  if (planSource.contractConfirmation) {
    payload.contractConfirmation = cloneCloudContractConfirmation(planSource.contractConfirmation);
  }
  if (planSource.executionStartedAt) {
    payload.executionStartedAt = planSource.executionStartedAt;
  }

  return payload;
}

export function buildVorgangCloudContentKey(vorgang: Vorgang): string {
  return JSON.stringify(stripVorgangForCloud(vorgang));
}

export function buildVorgangCloudPushPayload(
  vorgang: Vorgang,
  deleted = false,
): Record<string, unknown> {
  return {
    vorgang_id: vorgang.id,
    id: vorgang.id,
    deleted,
    payload: stripVorgangForCloud(vorgang),
  };
}

export function parseVorgangCloudPayload(payload: Record<string, unknown> | null): VorgangCloudPayload | null {
  if (!payload) return null;
  const inner =
    (payload.payload as VorgangCloudPayload | undefined) ??
    (payload as unknown as VorgangCloudPayload);
  if (!inner || typeof inner !== 'object' || !inner.id) return null;

  return {
    id: inner.id,
    title: inner.title,
    customer: inner.customer,
    baustelle: inner.baustelle,
    // Parsed for payload compatibility only — merge must not treat this as authority.
    status: migrateVorgangStatus(inner.status),
    materialSource: inner.materialSource,
    customerBilling: inner.customerBilling,
    // 03B: ausschliesslich das ausdrückliche Feld — niemals über den Namen.
    customerId: typeof inner.customerId === 'string' && inner.customerId.trim()
      ? inner.customerId.trim()
      : undefined,
    orderPositions: inner.orderPositions ?? [],
    createdFromInboxId: inner.createdFromInboxId,
    contractConfirmation: readCloudContractConfirmation(inner.contractConfirmation),
    executionStartedAt: readCloudExecutionStartedAt(inner.executionStartedAt),
  };
}

/**
 * ORDER-AMENDMENT-01B3B: defer snapshot repair when the merged plan still carries
 * amendment positions whose sources are not yet in confirmedOrderAmendments.
 * Keeps cloud orderPositions (incl. executedQuantity) as quantity basis until amendment pull.
 */
export function shouldDeferContractPlanRepair(vorgang: Pick<
  Vorgang,
  'orderPositions' | 'confirmedOrderAmendments'
>): boolean {
  const sourceIds = new Set<string>();
  for (const position of vorgang.orderPositions ?? []) {
    const sourceId = position.sourceAmendmentId?.trim();
    if (sourceId) sourceIds.add(sourceId);
  }
  if (sourceIds.size === 0) return false;

  const confirmedIds = new Set(
    (vorgang.confirmedOrderAmendments ?? []).map((item) => item.clientAmendmentId),
  );
  for (const sourceId of sourceIds) {
    if (!confirmedIds.has(sourceId)) return true;
  }
  return false;
}

function buildMergedVorgangFromFacts(
  shell: Vorgang,
  local: Vorgang | null,
  cloudPayload: VorgangCloudPayload,
  sync: SyncMeta,
): Vorgang {
  // 2–3 write-once chain facts
  const contractConfirmation = resolveWriteOnceContractConfirmation(
    local?.contractConfirmation,
    cloudPayload.contractConfirmation,
  );
  const executionStartedAtRaw = resolveWriteOnceExecutionStartedAt(
    local?.executionStartedAt,
    cloudPayload.executionStartedAt,
  );
  const { contractConfirmation: confirmation, executionStartedAt } = sanitizeOrderChainCloudFacts(
    contractConfirmation,
    executionStartedAtRaw,
  );

  // 4 orderPositions already on shell from merge / cloud row
  const withFacts: Vorgang = {
    ...shell,
    sync,
    documents: local?.documents ?? [],
    tasks: local?.tasks ?? [],
    photos: local?.photos ?? [],
    invoices: local?.invoices ?? [],
    customerBilling: shell.customerBilling ?? local?.customerBilling,
    /*
     * PRODUCT-FOUNDATION-03B — die Relation reist jetzt mit, die Vorrangregel
     * ist aber bewusst asymmetrisch: Eine vorhandene lokale Relation gewinnt
     * immer, Remote füllt ausschliesslich eine Lücke. So kann weder ein alter
     * Client, der das Feld nicht kennt, noch eine fremde Fassung eine bereits
     * getroffene Zuordnung stillschweigend ersetzen.
     *
     * Eine echte konkurrierende Umverknüpfung erzeugt einen Versionsunterschied
     * und bleibt damit dem bestehenden `row_version`-Konflikt überlassen —
     * kein Feld-Merge, keine Namensauflösung.
     */
    customerId: local?.customerId?.trim() ? local.customerId : cloudPayload.customerId,
    customerExplicitlyUnknown: local?.customerExplicitlyUnknown,
    negotiation: local?.negotiation,
    // Local-only Nachtragsentwürfe — never taken from cloud payload.
    orderAmendments: local?.orderAmendments,
    // Local confirmed amendments (01B2) — never taken from vorgang cloud payload.
    confirmedOrderAmendments: local?.confirmedOrderAmendments,
    contractConfirmation: confirmation,
    executionStartedAt,
    orderPositions: shell.orderPositions ?? [],
  };

  /*
   * 5 resolve status: facts first, then the cloud status.
   *
   * VORGANG-STATUS-CLOUD-PULL-01 — die einzige Stelle der Statusauflösung für
   * Create **und** Merge. Der Shell-Status bleibt bewusst aussen vor; eine
   * zweite Statuslogik im Create-Pfad soll nicht entstehen.
   */
  const cloudStatus = migrateVorgangStatus(cloudPayload.status);
  const resolvedStatus = resolveVorgangStatusForCloudMerge({
    localStatus: local?.status,
    cloudStatus,
    contractConfirmation: confirmation,
    executionStartedAt,
  });

  // 6 invariant check
  const withInvariants = applyOrderChainCloudInvariants(
    {
      ...withFacts,
      status: resolvedStatus,
    },
    { protectLocalStatus: local?.status, cloudStatus },
  );

  // 7 ORDER-PLAN-INTEGRITY-01 / ORDER-AMENDMENT-01B3B:
  // Canonicalize from snapshot only when amendment sources are already locally known.
  // Otherwise keep merged cloud orderPositions until amendment pull + composer.
  if (shouldDeferContractPlanRepair(withInvariants)) {
    return withInvariants;
  }
  return repairContractPlanFromSnapshot(withInvariants).vorgang;
}

export function mergeCloudVorgangIntoLocal(
  local: Vorgang | null,
  cloudPayload: VorgangCloudPayload,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
  /**
   * SYNC-VERSION-CONTRACT-02 — trägt dieser Vorgang lokale, noch nicht
   * bestätigte Änderungen? Fehlt die Angabe, wird der vorsichtige Altstand
   * angenommen (jede Abweichung ist ein Konflikt), damit ein Aufrufer ohne
   * diese Kenntnis nichts stillschweigend verlieren kann.
   */
  options?: { dirty?: boolean },
): { vorgang: Vorgang | null; conflict: boolean } {
  if (!local) {
    return {
      vorgang: createVorgangFromCloudRow(
        cloudPayload,
        rowVersion,
        updatedAt,
        deleted,
        deviceId,
        workspaceId,
      ),
      conflict: false,
    };
  }

  /**
   * `sync.version` ist die zuletzt vom Server bestätigte `row_version` — nicht
   * eine lokale Revision. Lokale Fachänderungen lassen sie unberührt; ob etwas
   * zu senden ist, sagt der Dirty-Zustand.
   *
   * Daraus folgen vier Fälle:
   *   gleich                 → nichts hat sich entfernt getan, lokal behalten
   *   Remote neuer, sauber   → Remote übernehmen und Version nachziehen
   *   Remote neuer, dirty    → echter Konflikt zweier Geräte
   *   Remote älter           → inkonsistenter Altstand (früheres lokales
   *                            Hochzählen); lokal behalten, nichts automatisch
   *                            normalisieren.
   */
  const localVersion = local.sync?.version ?? 0;
  const dirty = options?.dirty;

  if (dirty === undefined) {
    // Ohne Kenntnis des lokalen Zustands bleibt es beim vorsichtigen
    // Altverhalten: jede Versionsabweichung gilt als Konflikt.
    if (localVersion > 0 && rowVersion > 0 && localVersion !== rowVersion) {
      return { vorgang: local, conflict: true };
    }
  } else {
    if (localVersion > 0 && rowVersion > 0 && localVersion > rowVersion) {
      return { vorgang: local, conflict: true };
    }
    if (localVersion > 0 && rowVersion > localVersion && dirty) {
      return { vorgang: local, conflict: true };
    }
    /*
     * Ein lokal neu angelegter, noch nie bestätigter Vorgang (`localVersion`
     * 0) mit ungesendeten Änderungen darf von einer überraschend vorhandenen
     * Remote-Zeile nicht überschrieben werden.
     */
    if (localVersion === 0 && rowVersion > 0 && dirty) {
      return { vorgang: local, conflict: true };
    }
  }

  if (rowVersion < localVersion) {
    return { vorgang: local, conflict: false };
  }

  // 1 Shell merge — status on remoteShell is a placeholder; final status comes from resolver.
  const remoteShell: Vorgang = {
    id: cloudPayload.id,
    title: cloudPayload.title,
    customer: cloudPayload.customer,
    baustelle: cloudPayload.baustelle,
    status: migrateVorgangStatus(local.status),
    materialSource: cloudPayload.materialSource,
    customerBilling: cloudPayload.customerBilling,
    orderPositions: cloudPayload.orderPositions ?? [],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
    createdFromInboxId: cloudPayload.createdFromInboxId,
    sync: {
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : undefined,
      deviceId,
      workspaceId,
    },
  };

  const mergeResult = mergeSyncEntities(local, remoteShell, 'vorgang');
  if (mergeResult.conflict) {
    return { vorgang: local, conflict: true };
  }

  if (!mergeResult.entity) {
    return { vorgang: null, conflict: false };
  }

  const sync: SyncMeta = {
    updatedAt,
    version: rowVersion,
    deleted,
    deletedAt: deleted ? updatedAt : undefined,
    deviceId,
    workspaceId,
  };

  const vorgang = buildMergedVorgangFromFacts(mergeResult.entity, local, cloudPayload, sync);
  return { vorgang, conflict: false };
}

export function applyVorgangPushResultToState(
  vorgaenge: Vorgang[],
  vorgangId: string,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): Vorgang[] {
  return vorgaenge.map((v) => {
    if (v.id !== vorgangId) return v;
    const sync: SyncMeta = {
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : v.sync?.deletedAt,
      deviceId,
      workspaceId,
    };
    return { ...v, sync };
  });
}

export function mapWorkspaceVorgangRow(row: WorkspaceVorgangRow): {
  vorgangId: string;
  payload: VorgangCloudPayload;
  rowVersion: number;
  deleted: boolean;
  updatedAt: string;
} | null {
  const parsed = parseVorgangCloudPayload(row.payload);
  if (!parsed) return null;
  return {
    vorgangId: row.vorgang_id,
    payload: parsed,
    rowVersion: Number(row.row_version),
    deleted: Boolean(row.deleted),
    updatedAt: row.updated_at,
  };
}

export function createVorgangFromCloudRow(
  cloudPayload: VorgangCloudPayload,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): Vorgang {
  const sync: SyncMeta = {
    updatedAt,
    version: rowVersion,
    deleted,
    deletedAt: deleted ? updatedAt : undefined,
    deviceId,
    workspaceId,
  };

  /*
   * Shell aus der Cloud-Zeile. Der Status hier ist nur ein Platzhalter: Den
   * endgültigen Wert bestimmt `buildMergedVorgangFromFacts` aus Facts und
   * `cloudPayload.status` (VORGANG-STATUS-CLOUD-PULL-01).
   */
  const shell: Vorgang = {
    id: cloudPayload.id,
    title: cloudPayload.title,
    customer: cloudPayload.customer,
    baustelle: cloudPayload.baustelle,
    status: 'eingegangen',
    materialSource: cloudPayload.materialSource,
    customerBilling: cloudPayload.customerBilling,
    orderPositions: cloudPayload.orderPositions ?? [],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
    createdFromInboxId: cloudPayload.createdFromInboxId,
    sync,
  };

  return buildMergedVorgangFromFacts(shell, null, cloudPayload, sync);
}

/**
 * PRODUCT-FOUNDATION-03B — Relation-Backfill für Bestandsvorgänge.
 *
 * Cloud-Zeilen aus der Zeit vor 03B tragen keine `customerId`, und der
 * Change-Tracker meldet sie nicht nach: Er macht den vorhandenen Zustand beim
 * Start zur Basislinie, sodass ein Bestandsvorgang als unverändert gilt.
 *
 * Geplant wird ausschliesslich der **fehlende Zeiger**:
 *  - lokal existiert eine echte Relation,
 *  - dieselbe Vorgangs-ID existiert entfernt,
 *  - die Remote-Zeile ist kein Grabstein,
 *  - und der Remote-Payload trägt keine Relation.
 *
 * Trägt die Remote-Zeile bereits eine **andere** Relation, ist das kein
 * fehlender Zeiger, sondern ein fachlicher Unterschied — dann geschieht hier
 * nichts. Das Überschreiben bliebe dem Nutzer und dem Versionskonflikt
 * überlassen.
 *
 * Zusätzlich muss die lokale Version der Remote-Version entsprechen. Sonst
 * stünde das Scheitern des Pushs bereits fest: Er sendet die lokale Version als
 * Erwartung, und die RPC lehnt bei Abweichung mit `Versionskonflikt` ab. Weil
 * ein erneut eingereihter Eintrag den `blocked`-Status wieder auf `pending`
 * hebt, entstünde daraus eine Endlosschleife aus Nachmeldung und Zurückweisung.
 *
 * Bewusst zustandslos und ohne Migrationsmarker: Der Plan muss bei jedem Pull
 * erneut greifen können, sobald die Bedingungen wieder erfüllt sind.
 *
 * Ausdrücklich **nicht** heilbar: Hat ein Client ohne 03B den Payload
 * zurückgeschrieben, ist damit zwangsläufig auch die `row_version` gestiegen —
 * der Fall fällt unter die Versionsdivergenz und bleibt dem bestehenden
 * Konfliktmechanismus überlassen. Die lokale Relation bleibt erhalten, die
 * lokale Version wird **nicht** angehoben. Eine aus der Cloud verschwundene
 * Relation lässt sich nicht über den Firmennamen rekonstruieren.
 */
export function planVorgangCustomerRelationBackfill(
  localVorgaenge: Vorgang[],
  remoteRows: WorkspaceVorgangRow[],
): string[] {
  const remoteById = new Map(remoteRows.map((row) => [row.vorgang_id, row]));
  const planned: string[] = [];

  for (const vorgang of localVorgaenge) {
    const localRelation = vorgang.customerId?.trim();
    if (!localRelation) continue;

    const row = remoteById.get(vorgang.id);
    if (!row) continue;
    // Ein Grabstein wird niemals wegen einer Relation wiederbelebt.
    if (row.deleted) continue;

    /*
     * Nur bei Versionsgleichstand. Eine real existierende Zeile trägt immer
     * `row_version >= 1` — der Insert der RPC beginnt bei 1 und jedes Update
     * erhöht. Die Prüfung auf `> 0` schliesst deshalb aus, dass ein fehlender
     * lokaler Sync-Stand (0) versehentlich als Gleichstand durchgeht.
     */
    const remoteVersion = Number(row.row_version);
    const localVersion = Number(vorgang.sync?.version ?? 0);
    if (!Number.isFinite(remoteVersion) || remoteVersion <= 0) continue;
    if (localVersion !== remoteVersion) continue;

    const parsed = parseVorgangCloudPayload(row.payload);
    if (!parsed) continue;
    // Nur der fehlende Zeiger — eine abweichende Relation bleibt unberührt.
    if (parsed.customerId) continue;

    planned.push(vorgang.id);
  }

  return planned;
}

/**
 * CREATE-RETRY-CONFLICT-02 — Wiederanlauf nach verlorener Create-Bestätigung.
 *
 * Ausgangslage: Der erste Push eines neuen Vorgangs sendet `p_row_version = 0`.
 * Der Server fügt ein (`row_version = 1`), die Antwort erreicht den Client
 * nicht. Lokal bleibt `sync` leer, der Outbox-Eintrag aktiv. Mit dem
 * verschärften Serververtrag („0 heisst: darf noch nicht existieren") endet
 * jeder Wiederholungsversuch in einem Versionskonflikt — der Vorgang käme nie
 * mehr in die Cloud.
 *
 * Der Beweis, dass die Übernahme hier gefahrlos ist, steht im Serververtrag
 * selbst: **Jeder** Schreibvorgang erhöht `row_version`, auch ein Grabstein.
 * `row_version === 1` bedeutet daher zwingend, dass seit dem Einfügen kein
 * weiterer Server-Write stattfand. Es kann also nichts überschrieben werden,
 * was ein anderes Gerät geschrieben hätte — es existiert nichts.
 *
 * Bewusst **nicht** verlangt:
 *  - Inhaltsgleichheit: Nach dem verlorenen Ack arbeitet der Nutzer weiter.
 *    Genau dann unterscheiden sich die Inhalte — und genau dann wird die
 *    Wiederherstellung gebraucht.
 *  - `operation === 'create'`: Die Outbox überschreibt die Operation mit der
 *    jeweils letzten (`create` → `update` → `delete`). Die Ursprungsabsicht ist
 *    dort nicht mehr ablesbar. Stabil ist allein `sync.version === 0`.
 */
export interface LostAckAdoptionPlan {
  /** Basisversion übernehmen, lokalen Fachstand behalten, erneut senden. */
  adopt: string[];
  /** Der gewünschte Remote-Zustand besteht bereits — nichts mehr zu senden. */
  settle: string[];
}

function planLostAckAdoption<T extends { id: string; sync?: { version?: number; deleted?: boolean } }>(
  locals: T[],
  remotes: Map<string, { rowVersion: number; deleted: boolean }>,
  activeOutboxIds: ReadonlySet<string>,
): LostAckAdoptionPlan {
  const adopt: string[] = [];
  const settle: string[] = [];

  for (const local of locals) {
    if ((local.sync?.version ?? 0) !== 0) continue;
    if (!activeOutboxIds.has(local.id)) continue;

    const remote = remotes.get(local.id);
    // Nur die unberührte Erstzeile beweist, dass kein fremder Write erfolgte.
    if (!remote || remote.rowVersion !== 1) continue;

    if (!remote.deleted) {
      adopt.push(local.id);
      continue;
    }

    /*
     * Grabstein: Nur wenn auch lokal gelöscht werden sollte, ist der Wunsch
     * bereits erfüllt. Gegen einen lokal **aktiven** Datensatz bleibt es beim
     * regulären Konflikt — eine Übernahme führte beim nächsten Push zur
     * stillen Wiederbelebung.
     */
    if (local.sync?.deleted === true) {
      settle.push(local.id);
    }
  }

  return { adopt, settle };
}

export function planVorgangLostAckAdoption(
  localVorgaenge: Vorgang[],
  remoteRows: WorkspaceVorgangRow[],
  activeOutboxVorgangIds: ReadonlySet<string>,
): LostAckAdoptionPlan {
  const remotes = new Map(
    remoteRows.map((row) => [
      row.vorgang_id,
      { rowVersion: Number(row.row_version), deleted: Boolean(row.deleted) },
    ]),
  );
  return planLostAckAdoption(localVorgaenge, remotes, activeOutboxVorgangIds);
}

export function mergeVorgaengeFromPull(
  localVorgaenge: Vorgang[],
  remoteRows: WorkspaceVorgangRow[],
  deviceId: string,
  workspaceId: string,
  /**
   * SYNC-VERSION-CONTRACT-02 — die Vorgänge mit lokalen, noch nicht
   * bestätigten Änderungen. Der Aufrufer leitet sie aus **der Outbox
   * desjenigen Zustands** ab, der im laufenden Sync weiterverarbeitet wird —
   * nicht aus dem globalen Store, der die Push-Ergebnisse dieses Laufs noch
   * nicht kennt. Ohne Angabe bleibt es beim vorsichtigen Altverhalten.
   */
  options?: { dirtyVorgangIds?: ReadonlySet<string> },
): { vorgaenge: Vorgang[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const byId = new Map(localVorgaenge.map((v) => [v.id, v]));
  const dirtyIds = options?.dirtyVorgangIds;

  for (const row of remoteRows) {
    const mapped = mapWorkspaceVorgangRow(row);
    if (!mapped) continue;

    const local = byId.get(mapped.vorgangId) ?? null;
    const { vorgang, conflict } = mergeCloudVorgangIntoLocal(
      local,
      mapped.payload,
      mapped.rowVersion,
      mapped.updatedAt,
      mapped.deleted,
      deviceId,
      workspaceId,
      dirtyIds ? { dirty: dirtyIds.has(mapped.vorgangId) } : undefined,
    );

    if (conflict) {
      conflicts.push(`vorgang:${mapped.vorgangId}`);
      continue;
    }

    if (vorgang) {
      byId.set(vorgang.id, vorgang);
    } else if (mapped.deleted) {
      byId.delete(mapped.vorgangId);
    }
  }

  return { vorgaenge: [...byId.values()], conflicts };
}

export function isVorgangCloudEmpty(vorgaenge: Vorgang[]): boolean {
  return vorgaenge.length === 0;
}
