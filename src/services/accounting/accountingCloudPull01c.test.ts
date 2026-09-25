/**
 * FINANZ-SYNC-BLOCKER-01C — die Gegenrichtung zu 01B.
 *
 * 01B hat den Sendeweg repariert; geladen wurde weiterhin nichts. Eine frische
 * Anmeldung und jedes zweite Gerät standen deshalb ohne Kontierung und ohne
 * Abschlusshistorie da, obwohl beides in der Cloud lag — und das Export-Gate
 * hätte einen längst abgeschlossenen Monat als „nicht abgeschlossen" gemeldet.
 *
 * Geprüft wird der **produktive** Weg: derselbe `pullChanges`, den Anmeldung,
 * Arbeitsbereichswechsel und der Sync-Knopf nehmen, und dieselbe Hydration, die
 * ein Neuladen auslöst. Kein isolierter Dienst, der nur im Test existiert.
 *
 * Neutrale Beispieldaten. Kein Netz: Der Supabase-Client ist ein Stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';
import type { AccountingAssignment } from '../../types/accounting';
import type { AccountingPeriodClosure } from '../../types/accountingPeriod';
import { createSupabaseSyncAdapter } from '../sync/supabaseSyncAdapter';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { STORAGE_VERSION } from '../sync/syncMigrationService';
import { generateUuid } from '../sync/syncMetaService';
import { applyStateToStores, buildPersistedStateSnapshot } from '../persistenceService';
import { getAllAccountingAssignments } from './accountingStore';
import {
  getAllAccountingPeriodClosures,
  getActiveClosureForMonth,
  getClosuresForMonth,
} from './accountingPeriodStore';
import { mergeAccountingFromPull } from './accountingCloudSyncService';
import {
  mergeAccountingPeriodClosuresFromPull,
  rowToAccountingPeriodClosure,
  type CloudAccountingPeriodRow,
} from './accountingPeriodCloudSyncService';
import { applyAccountingPullToState } from './accountingCloudPullService';
import { evaluateAccountingExportReadiness } from './accountingExportGateService';
import type { CloudAccountingRow } from './accountingCloudSyncService';
import * as orderAmendmentOrchestrator from '../orderAmendment/orderAmendmentCloudPullOrchestrator';

const WORKSPACE = '00000000-0000-0000-0000-00000000f01d';
const DEVICE = 'device-01c';
const AT = '2026-07-10T09:00:00.000Z';
const SPAETER = '2026-07-12T09:00:00.000Z';

/* ------------------------------------------------------------------ */
/* Beispieldaten                                                       */
/* ------------------------------------------------------------------ */

function assignment(overrides: Partial<AccountingAssignment> = {}): AccountingAssignment {
  return {
    id: 'k1',
    sourceType: 'expense',
    sourceId: 'exp-01c',
    chartOfAccounts: 'SKR03',
    accountNumber: '3400',
    accountLabel: 'Wareneingang',
    taxTreatment: 'standard_19',
    bookingText: 'Beispiel GmbH · RE-1',
    suggestionReason: 'Lieferant bekannt',
    status: 'confirmed',
    origin: 'manual',
    suggestedAt: AT,
    confirmedAt: AT,
    confirmedBy: 'user-1',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function assignmentRow(
  overrides: Partial<CloudAccountingRow> = {},
  payload: Partial<AccountingAssignment> = {},
): CloudAccountingRow {
  return {
    client_assignment_id: 'k1',
    source_type: 'expense',
    source_id: 'exp-01c',
    payload: { ...assignment(payload) } as unknown as Record<string, unknown>,
    deleted: false,
    row_version: 3,
    updated_at: SPAETER,
    ...overrides,
  };
}

function closureRow(overrides: Partial<CloudAccountingPeriodRow> = {}): CloudAccountingPeriodRow {
  return {
    client_closure_id: 'c1',
    period_year: 2026,
    period_month: 7,
    revision: 1,
    fingerprint: 'p1:abcd:100',
    manifest: {
      monthKey: '2026-07',
      chartOfAccounts: 'SKR03',
      documentCount: 1,
      totalBrutto: 119,
      totalNetto: 100,
      totalSteuer: 19,
      entries: [],
    },
    closed_at: AT,
    closed_by: 'user-1',
    reopened_at: null,
    reopened_by: null,
    reopen_reason: null,
    row_version: 1,
    ...overrides,
  };
}

function outboxEntry(
  entityType: SyncOutboxEntry['entityType'],
  entityId: string,
  status: SyncOutboxEntry['status'] = 'pending',
): SyncOutboxEntry {
  return {
    id: generateUuid(),
    entityType,
    entityId,
    operation: 'update',
    version: 1,
    queuedAt: AT,
    retryCount: 0,
    status,
  } as SyncOutboxEntry;
}

function buildState(input: {
  assignments?: AccountingAssignment[];
  closures?: AccountingPeriodClosure[];
  outbox?: SyncOutboxEntry[];
}): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, deviceId: DEVICE, serverWorkspaceId: WORKSPACE, workspaceId: WORKSPACE },
    syncOutbox: input.outbox ?? [],
    setup: DEFAULT_SETUP,
    vorgaenge: [],
    customers: [],
    inboxItems: [],
    tasks: [],
    documents: [],
    expenses: [],
    accountingAssignments: input.assignments ?? [],
    accountingPeriodClosures: input.closures ?? [],
    savedAt: AT,
  } as AppPersistedState;
}

const KONTEXT = { deviceId: DEVICE, workspaceId: WORKSPACE };

beforeEach(() => {
  localStorage.clear();
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests(createSyncClient());
  applyStateToStores(buildState({}));

  /*
   * Der Nachtrags-Abzug ist die einzige Stelle des Pull-Pfads, die nicht über
   * den eingereichten Client läuft, sondern über den globalen. Ohne ihn bräche
   * `pullChanges` vor allem Weiteren ab — geprüft werden soll hier aber das,
   * was danach kommt. Alles Übrige des Produktpfads bleibt echt.
   */
  vi.spyOn(
    orderAmendmentOrchestrator,
    'pullAndMergeWorkspaceOrderAmendmentsInMemory',
  ).mockImplementation(async (input) => ({
    ok: true,
    merge: {
      vorgaenge: input.vorgaenge,
      appliedCount: 0,
      skippedDuplicateCount: 0,
      sequenceConflictCount: 0,
      positionConflictCount: 0,
      duplicateContentWarningCount: 0,
      reconciledIntentCount: 0,
      pendingIntentClearCount: 0,
      affectedVorgangIds: [],
      issues: [],
      orphanReferences: [],
      pendingIntentClears: [],
      changed: false,
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ================================================================== */
/* B/C — Kontierungs-Pull und Merge                                    */
/* ================================================================== */

describe('B/C — Kontierungen kommen vollständig an', () => {
  it('C1: nur Cloud vorhanden — jedes Feld kommt an', () => {
    const merged = mergeAccountingFromPull([], { assignments: [assignmentRow()] }, new Set(), KONTEXT);
    const k = merged.assignments[0];

    expect(merged.counts.added).toBe(1);
    expect(k).toMatchObject({
      id: 'k1',
      sourceType: 'expense',
      sourceId: 'exp-01c',
      chartOfAccounts: 'SKR03',
      accountNumber: '3400',
      accountLabel: 'Wareneingang',
      taxTreatment: 'standard_19',
      bookingText: 'Beispiel GmbH · RE-1',
      status: 'confirmed',
      origin: 'manual',
      suggestedAt: AT,
      confirmedAt: AT,
      confirmedBy: 'user-1',
      createdAt: AT,
      updatedAt: AT,
    });
  });

  it('C2: die Serverversion wird übernommen, nicht die lokale', () => {
    /*
     * Der eigentliche Fehler im alten Mapping: Es behielt die **lokale**
     * Sync-Meta. Für eine Kontierung, die es lokal gar nicht gab, blieb sie
     * leer — der nächste Push hätte Version 0 gemeldet und wäre am
     * Versionsvertrag gescheitert.
     */
    const merged = mergeAccountingFromPull([], { assignments: [assignmentRow()] }, new Set(), KONTEXT);

    expect(merged.assignments[0].sync?.version).toBe(3);
    expect(merged.assignments[0].sync?.workspaceId).toBe(WORKSPACE);
    expect(merged.assignments[0].sync?.deleted).toBe(false);
  });

  it('C3: identischer Stand erzeugt kein Duplikat', () => {
    const merged = mergeAccountingFromPull(
      [assignment()],
      { assignments: [assignmentRow()] },
      new Set(),
      KONTEXT,
    );

    expect(merged.assignments).toHaveLength(1);
    expect(merged.counts.added).toBe(0);
    expect(merged.counts.updated).toBe(1);
  });

  it('C4: Cloud neuer und lokal unverändert — die Cloud gewinnt', () => {
    const merged = mergeAccountingFromPull(
      [assignment({ accountNumber: '3400' })],
      { assignments: [assignmentRow({ row_version: 7 }, { accountNumber: '4930' })] },
      new Set(),
      KONTEXT,
    );

    expect(merged.assignments[0].accountNumber).toBe('4930');
    expect(merged.assignments[0].sync?.version).toBe(7);
  });

  it('C5: eine noch nicht übertragene lokale Änderung wird nicht überschrieben', () => {
    const merged = mergeAccountingFromPull(
      [assignment({ accountNumber: '3400', status: 'confirmed' })],
      { assignments: [assignmentRow({ row_version: 9 }, { accountNumber: '9999' })] },
      new Set(['k1']),
      KONTEXT,
    );

    expect(merged.assignments[0].accountNumber, 'die eigene Bestätigung bleibt').toBe('3400');
    expect(merged.conflicts).toContain('k1');
    expect(merged.counts.keptLocal).toBe(1);
  });

  it('C6: alle drei Prüfstände überleben den Pull', () => {
    const rows = (['needs_review', 'confirmed', 'needs_clarification'] as const).map((status, i) =>
      assignmentRow(
        { client_assignment_id: `k${i}`, source_id: `exp-${i}` },
        { id: `k${i}`, sourceId: `exp-${i}`, status },
      ),
    );

    const merged = mergeAccountingFromPull([], { assignments: rows }, new Set(), KONTEXT);

    expect(merged.assignments.map((item) => item.status)).toEqual([
      'needs_review',
      'confirmed',
      'needs_clarification',
    ]);
  });
});

/* ================================================================== */
/* D — Grabsteine                                                      */
/* ================================================================== */

describe('D — Grabsteine', () => {
  it('D1: ein Grabstein entfernt die lokale Kontierung', () => {
    const merged = mergeAccountingFromPull(
      [assignment()],
      { assignments: [assignmentRow({ deleted: true, payload: {} })] },
      new Set(),
      KONTEXT,
    );

    expect(merged.assignments).toHaveLength(0);
    expect(merged.counts.removed).toBe(1);
  });

  it('D2: ein Grabstein löscht keine noch nicht übertragene lokale Änderung', () => {
    const merged = mergeAccountingFromPull(
      [assignment()],
      { assignments: [assignmentRow({ deleted: true, payload: {} })] },
      new Set(['k1']),
      KONTEXT,
    );

    expect(merged.assignments, 'sonst verschwände Arbeit, die nie gesendet wurde').toHaveLength(1);
    expect(merged.conflicts).toContain('k1');
  });

  it('D3: ein Grabstein zu einer unbekannten Kennung tut nichts', () => {
    const merged = mergeAccountingFromPull(
      [],
      { assignments: [assignmentRow({ deleted: true, payload: {} })] },
      new Set(),
      KONTEXT,
    );

    expect(merged.assignments).toHaveLength(0);
    expect(merged.counts.removed).toBe(0);
  });
});

/* ================================================================== */
/* E/F/G/H/I — Abschlüsse                                              */
/* ================================================================== */

describe('E/F/G/H — die Abschlusshistorie kommt vollständig an', () => {
  it('E1: Cloud Revision 1, lokal leer — alle Felder kommen an', () => {
    const c = rowToAccountingPeriodClosure(closureRow(), KONTEXT);

    expect(c).toMatchObject({
      id: 'c1',
      monthKey: '2026-07',
      revision: 1,
      closedAt: AT,
      closedBy: 'user-1',
      fingerprint: 'p1:abcd:100',
    });
    expect(c.manifest.totalBrutto).toBe(119);
    expect(c.manifest.monthKey).toBe('2026-07');
    expect(c.sync?.version).toBe(1);
  });

  it('F1: ein geschlossener Monat trägt keine Öffnungsspur', () => {
    const c = rowToAccountingPeriodClosure(closureRow(), KONTEXT);
    expect(c.reopenedAt).toBeUndefined();
    expect(c.reopenedBy).toBeUndefined();
    expect(c.reopenReason).toBeUndefined();
  });

  it('G1: die Öffnungsspur überlebt den Pull vollständig', () => {
    /*
     * Ohne `reopenedAt` sähe ein zweites Gerät einen Monat als geschlossen, den
     * jemand längst wieder geöffnet hat — und das Export-Gate gäbe ihn frei.
     */
    const c = rowToAccountingPeriodClosure(
      closureRow({
        reopened_at: SPAETER,
        reopened_by: 'user-2',
        reopen_reason: 'Beleg nachgereicht',
        row_version: 2,
      }),
      KONTEXT,
    );

    expect(c.reopenedAt).toBe(SPAETER);
    expect(c.reopenedBy).toBe('user-2');
    expect(c.reopenReason).toBe('Beleg nachgereicht');
    expect(c.updatedAt, 'zuletzt geändert beim Öffnen').toBe(SPAETER);
    expect(c.createdAt, 'angelegt mit dem Abschluss').toBe(AT);
  });

  it('H1: mehrere Revisionen eines Monats kommen alle an, neueste zuerst', () => {
    const merged = mergeAccountingPeriodClosuresFromPull(
      [],
      {
        closures: [
          closureRow({ client_closure_id: 'c1', revision: 1, reopened_at: SPAETER, row_version: 2 }),
          closureRow({ client_closure_id: 'c2', revision: 2, fingerprint: 'p1:efgh:200' }),
        ],
      },
      new Set(),
      KONTEXT,
    );

    expect(merged.closures.map((item) => item.revision), 'nicht nur die aktive').toEqual([2, 1]);
    expect(merged.closures[1].reopenedAt, 'die alte Revision behält ihre Öffnung').toBe(SPAETER);
    expect(merged.closures[1].fingerprint, 'und ihren eigenen Fingerprint').toBe('p1:abcd:100');
  });

  it('H2: mehrere Monate werden absteigend geordnet', () => {
    const merged = mergeAccountingPeriodClosuresFromPull(
      [],
      {
        closures: [
          closureRow({ client_closure_id: 'a', period_month: 6 }),
          closureRow({ client_closure_id: 'b', period_month: 8 }),
        ],
      },
      new Set(),
      KONTEXT,
    );

    expect(merged.closures.map((item) => item.monthKey)).toEqual(['2026-08', '2026-06']);
  });

  it('E2: identische Daten erzeugen kein Duplikat', () => {
    const lokal = rowToAccountingPeriodClosure(closureRow(), KONTEXT);
    const merged = mergeAccountingPeriodClosuresFromPull(
      [lokal],
      { closures: [closureRow()] },
      new Set(),
      KONTEXT,
    );

    expect(merged.closures).toHaveLength(1);
    expect(merged.counts.added).toBe(0);
  });

  it('I1: eine lokal noch nicht übertragene Revision wird geschützt', () => {
    const lokal = rowToAccountingPeriodClosure(
      closureRow({ reopened_at: SPAETER, reopen_reason: 'lokal geöffnet' }),
      KONTEXT,
    );
    const merged = mergeAccountingPeriodClosuresFromPull(
      [lokal],
      { closures: [closureRow({ reopened_at: null, reopen_reason: null })] },
      new Set(['c1']),
      KONTEXT,
    );

    expect(merged.closures[0].reopenedAt, 'die eigene Öffnung bleibt').toBe(SPAETER);
    expect(merged.conflicts).toContain('c1');
  });

  it('I2: eine lokale Revision, die die Cloud noch nicht kennt, bleibt erhalten', () => {
    /*
     * Für Abschlüsse gibt es keinen Grabstein. Eine lokale Revision, die der
     * Pull nicht nennt, ist fast immer eine gerade entstandene — sie zu
     * entfernen hiesse, einen Nachweis vor seiner Übertragung zu verlieren.
     */
    const lokal = rowToAccountingPeriodClosure(closureRow({ client_closure_id: 'neu' }), KONTEXT);
    const merged = mergeAccountingPeriodClosuresFromPull([lokal], { closures: [] }, new Set(), KONTEXT);

    expect(merged.closures).toHaveLength(1);
    expect(merged.closures[0].id).toBe('neu');
  });
});

/* ================================================================== */
/* J — der produktive Pull-Pfad                                        */
/* ================================================================== */

/** Ein Stub, der jede Lesefunktion beantwortet und die Aufrufe mitschreibt. */
function pullStub(
  responses: Record<string, unknown> = {},
): { client: never; calls: string[] } {
  const calls: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    calls.push(name);
    return { data: responses[name] ?? {}, error: null };
  });
  return { client: { rpc } as never, calls };
}

async function pull(state: AppPersistedState, client: never) {
  const adapter = createSupabaseSyncAdapter(client);
  return adapter.pullChanges({
    deviceId: DEVICE,
    workspaceId: WORKSPACE,
    state,
  });
}

describe('J — der Pull hängt im normalen Produktpfad', () => {
  it('J1: pullChanges ruft beide Kontierungs-Lesefunktionen auf', async () => {
    const stub = pullStub({
      pull_workspace_accounting_assignments: { assignments: [assignmentRow()] },
      pull_workspace_accounting_period_closures: { closures: [closureRow()] },
    });

    await pull(buildState({}), stub.client);

    expect(stub.calls, 'ohne diese Aufrufe lud das Gerät nie etwas').toContain(
      'pull_workspace_accounting_assignments',
    );
    expect(stub.calls).toContain('pull_workspace_accounting_period_closures');
  });

  it('J2: der gezogene Stand liegt im Ergebniszustand', async () => {
    const stub = pullStub({
      pull_workspace_accounting_assignments: { assignments: [assignmentRow()] },
      pull_workspace_accounting_period_closures: { closures: [closureRow()] },
    });

    const result = await pull(buildState({}), stub.client);

    expect(result.state.accountingAssignments).toHaveLength(1);
    expect(result.state.accountingPeriodClosures).toHaveLength(1);
    expect(result.state.accountingAssignments?.[0].accountNumber).toBe('3400');
  });

  it('J3: „Kein Zugriff" ist die Rollenregel, kein Fehler', async () => {
    const calls: string[] = [];
    const rpc = vi.fn(async (name: string) => {
      calls.push(name);
      if (name.startsWith('pull_workspace_accounting')) {
        return { data: null, error: { message: 'Kein Zugriff auf Workspace', code: '42501' } };
      }
      return { data: {}, error: null };
    });
    const result = await pull(buildState({}), { rpc } as never);

    expect(result.report.errors.some((e) => e.outboxId === 'accounting-pull')).toBe(false);
  });

  it('J4: ein echter Lesefehler wird gemeldet und verwirft nichts', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'pull_workspace_accounting_assignments') {
        return { data: null, error: { message: 'Failed to fetch' } };
      }
      return { data: {}, error: null };
    });
    const bestand = [assignment()];
    const result = await pull(buildState({ assignments: bestand }), { rpc } as never);

    expect(result.report.errors.some((e) => e.outboxId === 'accounting-pull')).toBe(true);
    expect(result.state.accountingAssignments, 'der lokale Bestand bleibt').toHaveLength(1);
  });

  it('J5: eine ungesyncte lokale Kontierung überlebt den produktiven Pull', async () => {
    const stub = pullStub({
      pull_workspace_accounting_assignments: {
        assignments: [assignmentRow({ row_version: 9 }, { accountNumber: '9999' })],
      },
    });
    const state = buildState({
      assignments: [assignment({ accountNumber: '3400' })],
      outbox: [outboxEntry('accounting_assignment', 'k1')],
    });

    const result = await pull(state, stub.client);

    expect(result.state.accountingAssignments?.[0].accountNumber).toBe('3400');
    expect(
      result.report.conflicts.some((c) => c.entityType === 'accounting_assignment' && c.entityId === 'k1'),
    ).toBe(true);
  });
});

/* ================================================================== */
/* K — Zweitgerät und Reload                                           */
/* ================================================================== */

describe('K — Gerät B startet leer und bekommt alles zurück', () => {
  it('K1: leerer lokaler Stand, normaler Pull, vollständige Wiederherstellung', async () => {
    const stub = pullStub({
      pull_workspace_accounting_assignments: { assignments: [assignmentRow()] },
      pull_workspace_accounting_period_closures: {
        closures: [
          closureRow({ client_closure_id: 'c1', revision: 1, reopened_at: SPAETER, row_version: 2 }),
          closureRow({ client_closure_id: 'c2', revision: 2, fingerprint: 'p1:efgh:200' }),
        ],
      },
    });

    // Gerät B: nichts lokal.
    const geraetB = buildState({});
    expect(geraetB.accountingAssignments).toHaveLength(0);

    const result = await pull(geraetB, stub.client);

    // Der normale Persistenzweg: derselbe, den ein Sync-Lauf nimmt.
    applyStateToStores(result.state);

    expect(getAllAccountingAssignments(), 'die Kontierung fehlte hier bisher').toHaveLength(1);
    expect(getAllAccountingPeriodClosures()).toHaveLength(2);
    expect(getClosuresForMonth('2026-07').map((c) => c.revision)).toEqual([2, 1]);
    expect(getActiveClosureForMonth('2026-07')?.revision, 'Revision 1 ist geöffnet').toBe(2);
  });

  it('K2: ein Neuladen reproduziert denselben Stand', async () => {
    const stub = pullStub({
      pull_workspace_accounting_assignments: { assignments: [assignmentRow()] },
      pull_workspace_accounting_period_closures: { closures: [closureRow()] },
    });
    const result = await pull(buildState({}), stub.client);
    applyStateToStores(result.state);

    // Reload: Was gespeichert würde, wird erneut in die Speicher gelegt.
    const gespeichert = buildPersistedStateSnapshot();
    expect(gespeichert.accountingAssignments).toHaveLength(1);
    expect(gespeichert.accountingPeriodClosures).toHaveLength(1);

    applyStateToStores(gespeichert);

    expect(getAllAccountingAssignments()[0].accountNumber).toBe('3400');
    expect(getAllAccountingPeriodClosures()[0].fingerprint).toBe('p1:abcd:100');
    expect(getAllAccountingAssignments()[0].sync?.version, 'die Serverversion überlebt').toBe(3);
  });
});

/* ================================================================== */
/* L — Export-Gate nach dem Pull                                       */
/* ================================================================== */

describe('L — das Export-Gate urteilt nach dem Pull wie zuvor', () => {
  function hydriereAusCloud(closures: CloudAccountingPeriodRow[]): void {
    const applied = applyAccountingPullToState(
      buildState({}),
      { assignments: { assignments: [] }, closures: { closures } },
      { deviceId: DEVICE, workspaceId: WORKSPACE, outbox: [] },
    );
    applyStateToStores(applied.state);
  }

  it('L1: ein gezogener, gültiger Abschluss gibt den Export frei', () => {
    hydriereAusCloud([closureRow()]);
    const state = { ...evaluateAccountingExportReadiness('2026-07').state };

    expect(state.activeClosure?.revision).toBe(1);
    expect(state.activeClosure?.fingerprint).toBe('p1:abcd:100');
  });

  it('L2: „seit dem Abschluss geändert" wird nach dem Pull erkannt', () => {
    /*
     * Der Fingerprint des gezogenen Abschlusses passt nicht zum heutigen
     * Datenstand des leeren Monats. Genau dafür ist er da — und diese Aussage
     * muss nach einer Hydration dieselbe sein wie nach einem lokalen Abschluss.
     */
    hydriereAusCloud([closureRow()]);
    const readiness = evaluateAccountingExportReadiness('2026-07');

    expect(readiness.state.isCurrentClosureValid).toBe(false);
    expect(readiness.packageAllowed).toBe(false);
    expect(readiness.packageBlockers.map((b) => b.code)).toContain('changed_after_close');
  });

  it('L3: ein gezogener, wieder geöffneter Monat gilt als nicht abgeschlossen', () => {
    hydriereAusCloud([closureRow({ reopened_at: SPAETER, row_version: 2 })]);
    const readiness = evaluateAccountingExportReadiness('2026-07');

    expect(readiness.state.activeClosure, 'eine geöffnete Revision ist nicht aktiv').toBeNull();
    expect(readiness.packageBlockers.map((b) => b.code)).toContain('not_closed');
  });

  it('L4: DATEV bleibt auch nach dem Pull verschlossen', () => {
    hydriereAusCloud([closureRow()]);
    expect(evaluateAccountingExportReadiness('2026-07').datevAllowed).toBe(false);
  });
});

/* ================================================================== */
/* 01H — closedBy nach Pull und Reload                                  */
/* ================================================================== */

describe('01H — closedBy kommt aus der Cloud zurück, nichts wird erfunden', () => {
  it('ein vom Server gesetzter Actor kommt über den Pull an', () => {
    const closure = rowToAccountingPeriodClosure(
      closureRow({ closed_by: '7f1c2d3e-0000-4000-8000-000000000001' }),
      KONTEXT,
    );
    expect(closure.closedBy).toBe('7f1c2d3e-0000-4000-8000-000000000001');
  });

  it('ein historisch unbekannter Actor bleibt unbekannt', () => {
    const closure = rowToAccountingPeriodClosure(closureRow({ closed_by: null }), KONTEXT);
    expect(closure.closedBy).toBeUndefined();
  });

  it('der Pull überschreibt einen lokal fehlenden Actor mit dem Serverwert', () => {
    const lokal = rowToAccountingPeriodClosure(closureRow({ closed_by: null }), KONTEXT);
    const merged = mergeAccountingPeriodClosuresFromPull(
      [lokal],
      { closures: [closureRow({ closed_by: 'user-server' })] },
      new Set(),
      KONTEXT,
    );
    expect(merged.closures[0].closedBy).toBe('user-server');
  });

  it('Reload: der Actor überlebt Speichern und Laden', () => {
    const closure = rowToAccountingPeriodClosure(closureRow({ closed_by: 'user-reload' }), KONTEXT);
    applyStateToStores({ ...buildPersistedStateSnapshot(), accountingPeriodClosures: [closure] });
    // Wie ein Reload: serialisiert, wieder gelesen, neu hydriert.
    const gespeichert = JSON.parse(JSON.stringify(buildPersistedStateSnapshot())) as AppPersistedState;
    applyStateToStores(gespeichert);
    expect(getAllAccountingPeriodClosures().find((c) => c.id === closure.id)?.closedBy).toBe(
      'user-reload',
    );
  });
});
