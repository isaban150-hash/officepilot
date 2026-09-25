/**
 * FINANZ-SYNC-BLOCKER-01B — die vier Blocker der Gesamtabnahme, technisch geprüft.
 *
 * Grundlage ist die Ursachenanalyse 01A. Sie hatte gezeigt, dass die drei
 * Kontierungsfehler **nie eine Anfrage erzeugt** hatten: Der Payload-Dienst
 * kannte die Entitäten nicht, gab `null` zurück, und der Adapter brach mit
 * „Entity nicht gefunden" ab — mit hochgezähltem Versuchszähler, ohne Netz.
 *
 * Die Tests prüfen deshalb nicht nur, dass „irgendetwas" gesendet wird, sondern
 * **welcher RPC mit welcher Nutzlast**. Ein Test, der nur `rpc` zählt, hätte
 * den ursprünglichen Fehler nicht gefunden.
 *
 * Neutrale Beispieldaten. Kein Netzwerk: Der Supabase-Client ist ein Stub, der
 * die Aufrufe mitschreibt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';
import type { AccountingAssignment } from '../../types/accounting';
import type { AccountingPeriodClosure } from '../../types/accountingPeriod';
import type { WorkspaceSettings } from '../../types/workspace';
import { createSupabaseSyncAdapter } from './supabaseSyncAdapter';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import {
  getSyncOutboxSnapshot,
  releaseBlockedOutboxEntry,
  resetSyncOutboxForTests,
} from './syncOutboxService';
import { resetSyncChangeTrackerForTests } from './syncChangeTrackerService';
import { STORAGE_VERSION } from './syncMigrationService';
import { generateUuid } from './syncMetaService';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';
import {
  buildAccountingPeriodClosePayload,
  pushAccountingPeriodClosure,
} from '../accounting/accountingPeriodCloudSyncService';
import { findAccountingServerRuleViolation } from '../accounting/accountingCloudSyncService';
import {
  applyWorkspaceSettingsDecision,
  mergeWorkspaceSettings,
} from '../workspace/workspaceSettingsConflictService';
import { describeSyncOutboxEntry, mapSyncErrorReason } from './syncOutboxDescriptionService';

const WORKSPACE = '00000000-0000-0000-0000-00000000f01b';
const DEVICE = 'device-01b';
const AT = '2026-07-10T09:00:00.000Z';

/* ------------------------------------------------------------------ */
/* Beispieldaten                                                       */
/* ------------------------------------------------------------------ */

function assignment(overrides: Partial<AccountingAssignment> = {}): AccountingAssignment {
  return {
    id: 'k-01b',
    sourceType: 'expense',
    sourceId: 'exp-01b',
    chartOfAccounts: 'SKR03',
    accountNumber: '3400',
    accountLabel: 'Wareneingang',
    taxTreatment: 'standard_19',
    bookingText: 'Beispiel GmbH · RE-1',
    status: 'confirmed',
    origin: 'manual',
    confirmedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function closure(overrides: Partial<AccountingPeriodClosure> = {}): AccountingPeriodClosure {
  return {
    id: 'c-01b',
    monthKey: '2026-07',
    revision: 1,
    closedAt: AT,
    closedBy: 'user-1',
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
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function entry(
  entityType: SyncOutboxEntry['entityType'],
  entityId: string,
  overrides: Partial<SyncOutboxEntry> = {},
): SyncOutboxEntry {
  return {
    id: generateUuid(),
    entityType,
    entityId,
    operation: 'update',
    version: 1,
    queuedAt: AT,
    retryCount: 0,
    status: 'pending',
    ...overrides,
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

/** Ein Stub, der pro RPC-Name antwortet und jeden Aufruf mitschreibt. */
function stubClient(
  responses: Record<string, unknown | (() => unknown)> = {},
): { client: never; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const value = responses[name];
    const resolved = typeof value === 'function' ? (value as () => unknown)() : value;
    if (resolved instanceof Error) return { data: null, error: { message: resolved.message } };
    return { data: resolved ?? { row_version: 1 }, error: null };
  });
  return { client: { rpc } as never, calls };
}

async function push(state: AppPersistedState, client: never) {
  const adapter = createSupabaseSyncAdapter(client);
  return adapter.pushChanges({
    deviceId: DEVICE,
    workspaceId: WORKSPACE,
    state,
    outbox: state.syncOutbox ?? [],
  });
}

beforeEach(() => {
  localStorage.clear();
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests(createSyncClient());
});

/* ================================================================== */
/* D — Extraktion                                                      */
/* ================================================================== */

describe('D — der Payload-Dienst kennt die Kontierungsentitäten', () => {
  it('D1: eine Kontierung wird mit ihrer Serverversion extrahiert', () => {
    const k = assignment({ sync: { updatedAt: AT, version: 4, deleted: false, deviceId: DEVICE, workspaceId: WORKSPACE } });
    const extracted = extractCloudSyncEntity(buildState({ assignments: [k] }), 'accounting_assignment', k.id);

    expect(extracted, 'vorher stand hier null — genau das war der Blocker').not.toBeNull();
    expect(extracted?.entityType).toBe('accounting_assignment');
    expect(extracted?.rowVersion).toBe(4);
  });

  it('D2: needs_review ohne Sachkonto bleibt synchronisierbar', () => {
    const k = assignment({ status: 'needs_review', accountNumber: '', confirmedAt: undefined, origin: 'suggested' });
    const extracted = extractCloudSyncEntity(buildState({ assignments: [k] }), 'accounting_assignment', k.id);

    expect(extracted).not.toBeNull();
    expect(findAccountingServerRuleViolation(k), 'der Normalfall darf nicht blockiert werden').toBeNull();
  });

  it('D3: ein Abschluss wird extrahiert und nie als Grabstein', () => {
    const c = closure({ reopenedAt: AT });
    const extracted = extractCloudSyncEntity(buildState({ closures: [c] }), 'accounting_period_closure', c.id);

    expect(extracted?.entityType).toBe('accounting_period_closure');
    expect(extracted && 'deleted' in extracted ? extracted.deleted : true, 'ein Nachweis wird nicht gelöscht').toBe(false);
  });

  it('D4: eine unbekannte Kennung bleibt null', () => {
    expect(extractCloudSyncEntity(buildState({}), 'accounting_assignment', 'gibt-es-nicht')).toBeNull();
  });
});

/* ================================================================== */
/* E/F — Kontierung über den echten Adapterpfad                        */
/* ================================================================== */

describe('E/F — die Kontierung geht über ihren eigenen RPC', () => {
  it('E1: create landet bei upsert_workspace_accounting_assignment, nicht beim generischen Upsert', async () => {
    const k = assignment();
    const e = entry('accounting_assignment', k.id, { operation: 'create' });
    const stub = stubClient({ upsert_workspace_accounting_assignment: { row_version: 1, deleted: false } });

    const result = await push(buildState({ assignments: [k], outbox: [e] }), stub.client);

    expect(stub.calls.map((call) => call.name)).toEqual(['upsert_workspace_accounting_assignment']);
    expect(
      stub.calls.some((call) => call.name === 'upsert_workspace_sync_entity'),
      'das generische Upsert kennt den Typ nicht und würde 400 werfen',
    ).toBe(false);
    expect(result.success).toBe(true);
    expect(result.completedOutboxIds).toEqual([e.id]);
  });

  it('E2: die Nutzlast trägt Kennung, Beleg und den vollständigen Stand', async () => {
    const k = assignment();
    const e = entry('accounting_assignment', k.id, { operation: 'create' });
    const stub = stubClient({ upsert_workspace_accounting_assignment: { row_version: 1, deleted: false } });

    await push(buildState({ assignments: [k], outbox: [e] }), stub.client);

    const payload = stub.calls[0].args.p_payload as Record<string, unknown>;
    expect(payload.client_assignment_id).toBe(k.id);
    expect(payload.source_type).toBe('expense');
    expect(payload.source_id).toBe(k.sourceId);
    expect((payload.payload as AccountingAssignment).accountNumber).toBe('3400');
    expect((payload.payload as Record<string, unknown>).sync, 'Gerätewissen gehört nicht in die Cloud').toBeUndefined();
  });

  it('F: create, dann lokal geändert, noch nie gesendet — der aktuelle Stand legt die Zeile an', async () => {
    /*
     * Die Outbox fasst beides zu einem einzigen `update` mit Version 0
     * zusammen. Der RPC ist ein echtes Upsert: Kennt der Server die Kennung
     * nicht, legt er sie an und ignoriert die Version. Genau das wird hier
     * nachgewiesen — mit dem **geänderten** Stand.
     */
    const k = assignment({ accountNumber: '3401', accountLabel: 'Wareneingang neu' });
    const e = entry('accounting_assignment', k.id, { operation: 'update' });
    const stub = stubClient({ upsert_workspace_accounting_assignment: { row_version: 1, deleted: false } });

    const result = await push(buildState({ assignments: [k], outbox: [e] }), stub.client);

    expect(stub.calls[0].args.p_row_version, 'noch nie gesendet').toBe(0);
    const payload = stub.calls[0].args.p_payload as Record<string, unknown>;
    expect((payload.payload as AccountingAssignment).accountNumber).toBe('3401');
    expect(result.success).toBe(true);
  });

  it('E3: eine bestätigte Kontierung ohne Sachkonto geht gar nicht erst raus', async () => {
    /*
     * Der Server lehnt sie mit `accounting_confirmed_without_account` ab —
     * jedes Mal gleich. Ohne diese Grenze entstünde ein Auftrag, der bei jedem
     * Lauf erneut scheitert.
     */
    const k = assignment({ accountNumber: '  ' });
    const e = entry('accounting_assignment', k.id);
    const stub = stubClient();

    const result = await push(buildState({ assignments: [k], outbox: [e] }), stub.client);

    expect(stub.calls, 'kein sinnloser Aufruf').toEqual([]);
    expect(result.success).toBe(true);
    expect(result.completedOutboxIds, 'der Auftrag bleibt nicht liegen').toEqual([e.id]);
  });

  it('E4: ein abgelehnter Inhalt wird als nicht wiederholbarer Fehler festgehalten', async () => {
    const k = assignment();
    const e = entry('accounting_assignment', k.id);
    const stub = stubClient({
      upsert_workspace_accounting_assignment: () => new Error('accounting_chart_invalid: SKR05'),
    });

    const result = await push(buildState({ assignments: [k], outbox: [e] }), stub.client);

    expect(result.success).toBe(false);
    expect(result.failedOutbox[0].retryable, 'derselbe Inhalt scheitert erneut').toBe(false);
    const gespeichert = result.state.syncOutbox?.find((item) => item.id === e.id);
    expect(gespeichert?.status).toBe('error');
    expect(gespeichert?.lastErrorMessage, 'der Grund bleibt am Auftrag').toContain('accounting_chart_invalid');
  });
});

/* ================================================================== */
/* G/H/I — der Monatsabschluss                                         */
/* ================================================================== */

describe('G/H/I — Abschluss und Wiedereröffnen als Aktionen', () => {
  it('G: lokal abgeschlossen, danach Sync — es entsteht genau ein Close', async () => {
    const stub = stubClient({ close_workspace_accounting_period: { revision: 1, row_version: 1, noop: false } });

    const outcome = await pushAccountingPeriodClosure(closure(), 0, WORKSPACE, stub.client);

    expect(stub.calls.map((call) => call.name)).toEqual(['close_workspace_accounting_period']);
    expect(outcome).toMatchObject({ kind: 'pushed', steps: ['close'] });
  });

  it('G2: die Close-Nutzlast trägt Fingerprint und Manifest unverändert', () => {
    const c = closure();
    const payload = buildAccountingPeriodClosePayload(c);

    expect(payload).toMatchObject({
      client_closure_id: 'c-01b',
      period_year: 2026,
      period_month: 7,
      fingerprint: 'p1:abcd:100',
    });
    expect(payload.manifest).toBe(c.manifest);
  });

  it('H: bereits remote, danach lokal geöffnet — es entsteht nur ein Reopen', async () => {
    const stub = stubClient({ reopen_workspace_accounting_period: { revision: 1, row_version: 4 } });

    const outcome = await pushAccountingPeriodClosure(
      closure({ reopenedAt: AT, reopenReason: 'Beleg nachgereicht' }),
      3,
      WORKSPACE,
      stub.client,
    );

    expect(stub.calls.map((call) => call.name)).toEqual(['reopen_workspace_accounting_period']);
    expect(stub.calls[0].args).toMatchObject({
      p_period_year: 2026,
      p_period_month: 7,
      p_reason: 'Beleg nachgereicht',
      p_expected_revision: 1,
    });
    expect(outcome).toMatchObject({ kind: 'pushed', rowVersion: 4, steps: ['reopen'] });
  });

  it('I: lokal geschlossen UND geöffnet vor dem ersten Sync — remote entsteht dieselbe Historie', async () => {
    /*
     * Der Kernfall. Die Outbox hat beides zu einem `update` verschmolzen. Ein
     * blosses Reopen liefe ins Leere: Es gibt remote nichts zu öffnen. Aus dem
     * lokalen Stand wird deshalb beides abgeleitet — erst die Revision, dann
     * ihre Öffnung.
     */
    const stub = stubClient({
      close_workspace_accounting_period: { revision: 1, row_version: 1, noop: false },
      reopen_workspace_accounting_period: { revision: 1, row_version: 2 },
    });

    const outcome = await pushAccountingPeriodClosure(
      closure({ reopenedAt: AT, reopenedBy: 'user-1', reopenReason: 'Korrektur' }),
      0,
      WORKSPACE,
      stub.client,
    );

    expect(stub.calls.map((call) => call.name)).toEqual([
      'close_workspace_accounting_period',
      'reopen_workspace_accounting_period',
    ]);
    // Die Revision bleibt mit ihren Abschlussdaten bestehen; sie wird nicht ersetzt.
    const closePayload = stub.calls[0].args.p_payload as Record<string, unknown>;
    expect(closePayload.fingerprint).toBe('p1:abcd:100');
    expect(closePayload.manifest).toBeTruthy();
    expect(stub.calls[1].args.p_reason).toBe('Korrektur');
    expect(outcome).toMatchObject({ kind: 'pushed', steps: ['close', 'reopen'], rowVersion: 2 });
  });

  it('I2: die Revisionsnummer des Servers gewinnt, nicht die lokale', async () => {
    const stub = stubClient({
      close_workspace_accounting_period: { revision: 3, row_version: 1, noop: false },
      reopen_workspace_accounting_period: { revision: 3, row_version: 2 },
    });

    await pushAccountingPeriodClosure(closure({ revision: 1, reopenedAt: AT }), 0, WORKSPACE, stub.client);

    expect(stub.calls[1].args.p_expected_revision, 'sonst öffnet der Client die falsche Revision').toBe(3);
  });

  it('I3: ein wiederholtes Öffnen ist kein Fehler und hängt den Auftrag nicht auf', async () => {
    const stub = stubClient({
      reopen_workspace_accounting_period: () =>
        new Error('period_not_closed: kein offener Abschluss fuer 2026-7'),
    });

    const outcome = await pushAccountingPeriodClosure(closure({ reopenedAt: AT }), 3, WORKSPACE, stub.client);

    expect(outcome).toMatchObject({ kind: 'pushed', steps: ['reopen_noop'] });
  });

  it('I4: über den echten Adapterpfad landet der Abschluss bei den Abschluss-RPCs', async () => {
    const c = closure({ reopenedAt: AT });
    const e = entry('accounting_period_closure', c.id);
    const stub = stubClient({
      close_workspace_accounting_period: { revision: 1, row_version: 1, noop: false },
      reopen_workspace_accounting_period: { revision: 1, row_version: 2 },
    });

    const result = await push(buildState({ closures: [c], outbox: [e] }), stub.client);

    expect(stub.calls.map((call) => call.name)).toEqual([
      'close_workspace_accounting_period',
      'reopen_workspace_accounting_period',
    ]);
    expect(result.success).toBe(true);
    expect(result.state.accountingPeriodClosures?.[0].sync?.version).toBe(2);
  });
});

/* ================================================================== */
/* K/L — Betriebseinstellungen                                         */
/* ================================================================== */

function settings(
  values: Record<string, unknown>,
  version: number,
  pendingKeys?: string[],
): WorkspaceSettings {
  return { workspaceId: WORKSPACE, settings: values, version, updatedAt: AT, pendingKeys };
}

describe('K/L — Einstellungen zusammenführen statt überschreiben', () => {
  it('K1: Cloud neuer, lokal nichts geändert — der Cloud-Stand gilt', () => {
    const merge = mergeWorkspaceSettings(
      settings({ chartOfAccounts: 'SKR03' }, 2, []),
      settings({ chartOfAccounts: 'SKR04', dunningEnabled: true }, 5),
    );

    expect(merge.outcome).toBe('cloud_applied');
    expect(merge.settings.settings).toEqual({ chartOfAccounts: 'SKR04', dunningEnabled: true });
  });

  /*
   * FINANZ-SYNC-BLOCKER-01G — hier stand bis 01F, dass eine bekannte Absicht
   * den Wertwiderspruch stillschweigend zugunsten des lokalen Werts auflöst.
   * Das wäre dasselbe Raten in die andere Richtung. Ohne Rückfrage ergänzt wird
   * nur noch, was die Cloud gar nicht führt.
   */
  it('K2: Cloud neuer plus ein bewusst geändertes Feld, das die Cloud nicht kennt', () => {
    const merge = mergeWorkspaceSettings(
      settings({ chartOfAccounts: 'SKR03' }, 2, ['chartOfAccounts']),
      settings({ dunningEnabled: true, mahnstufen: 3 }, 5),
    );

    expect(merge.outcome).toBe('merged');
    expect(merge.settings.settings.chartOfAccounts, 'die bewusste Änderung bleibt').toBe('SKR03');
    expect(merge.settings.settings.dunningEnabled, 'unberührte Cloud-Felder bleiben').toBe(true);
    expect(merge.settings.settings.mahnstufen).toBe(3);
    expect(merge.settings.version, 'die Cloud-Version ist die Basis für den nächsten Push').toBe(5);
    expect(merge.settings.pendingKeys).toEqual(['chartOfAccounts']);
  });

  it('K3: ohne Vermerk wird nicht geraten — ein neues Feld wird ergänzt', () => {
    /*
     * Altbestand: Es ist nicht bekannt, welches Feld absichtlich gesetzt wurde.
     * Sicher ist nur, dass ein Schlüssel, den die Cloud gar nicht kennt, dort
     * nichts überschreiben kann.
     */
    const merge = mergeWorkspaceSettings(
      settings({ chartOfAccounts: 'SKR03' }, 2),
      settings({ dunningEnabled: true }, 5),
    );

    expect(merge.outcome).toBe('merged');
    expect(merge.settings.settings).toEqual({ dunningEnabled: true, chartOfAccounts: 'SKR03' });
  });

  it('K4: ohne Vermerk und mit echtem Widerspruch entscheidet der Nutzer', () => {
    const merge = mergeWorkspaceSettings(
      settings({ chartOfAccounts: 'SKR03' }, 2),
      settings({ chartOfAccounts: 'SKR04', dunningEnabled: true }, 5),
    );

    expect(merge.outcome).toBe('needs_decision');
    expect(merge.undecided).toEqual([
      { key: 'chartOfAccounts', localValue: 'SKR03', cloudValue: 'SKR04' },
    ]);
    expect(merge.settings.settings.dunningEnabled, 'das Eindeutige ist trotzdem schon da').toBe(true);
    expect(merge.settings.settings.chartOfAccounts, 'bis zur Entscheidung gilt die Cloud').toBe('SKR04');
  });

  it('L1: „Wert dieses Geräts behalten" setzt genau das strittige Feld', () => {
    const merge = mergeWorkspaceSettings(
      settings({ chartOfAccounts: 'SKR03' }, 2),
      settings({ chartOfAccounts: 'SKR04', dunningEnabled: true }, 5),
    );
    const entschieden = applyWorkspaceSettingsDecision(merge.settings, merge.undecided, 'keep_local');

    expect(entschieden.settings).toEqual({ chartOfAccounts: 'SKR03', dunningEnabled: true });
    expect(entschieden.pendingKeys).toContain('chartOfAccounts');
  });

  it('L2: „Cloud-Wert übernehmen" verliert kein anderes Feld', () => {
    const merge = mergeWorkspaceSettings(
      settings({ chartOfAccounts: 'SKR03', nurLokal: 'x' }, 2),
      settings({ chartOfAccounts: 'SKR04', dunningEnabled: true }, 5),
    );
    const entschieden = applyWorkspaceSettingsDecision(merge.settings, merge.undecided, 'take_cloud');

    expect(entschieden.settings).toEqual({
      chartOfAccounts: 'SKR04',
      dunningEnabled: true,
      nurLokal: 'x',
    });
  });

  it('M: ein blockierter Auftrag wird nach der Auflösung wieder sendbar', () => {
    const blockiert = entry('workspace_settings', WORKSPACE, {
      status: 'blocked',
      lastErrorMessage: 'Versionskonflikt',
    });
    resetSyncOutboxForTests([blockiert]);

    expect(releaseBlockedOutboxEntry('workspace_settings', WORKSPACE, 5)).toBe(true);

    const danach = getSyncOutboxSnapshot()[0];
    expect(danach.status, 'ohne diesen Ausgang hängt der Auftrag für immer').toBe('pending');
    expect(danach.version, 'mit der Cloud-Version als Basis').toBe(5);
    expect(danach.lastErrorMessage).toBeUndefined();
  });

  it('M2: was nicht blockiert ist, wird nicht angefasst', () => {
    const fehler = entry('workspace_settings', WORKSPACE, { status: 'error' });
    resetSyncOutboxForTests([fehler]);

    expect(releaseBlockedOutboxEntry('workspace_settings', WORKSPACE)).toBe(false);
    expect(getSyncOutboxSnapshot()[0].status).toBe('error');
  });
});

/* ================================================================== */
/* N — Fehlertransparenz                                               */
/* ================================================================== */

describe('N — die Sync-Seite benennt, was nicht durchkam', () => {
  it('N1: ein Konflikt ist kein Fehler und nicht wiederholbar', () => {
    const beschreibung = describeSyncOutboxEntry(
      entry('workspace_settings', WORKSPACE, { status: 'blocked', lastErrorMessage: 'Versionskonflikt' }),
    );

    expect(beschreibung.kind).toBe('conflict');
    expect(beschreibung.retryable, 'ein Konflikt wartet auf eine Entscheidung').toBe(false);
    /*
     * FINANZ-SYNC-BLOCKER-01G — ohne aufgebauten Feldkonflikt wird nicht zur
     * Entscheidung aufgefordert; sonst stünde „bitte entscheiden" ohne
     * Entscheidungsmöglichkeit da. Der Zustand mit Konflikt ist in
     * syncLiveConflict01g (D2) geprüft.
     */
    expect(beschreibung.reasonKey).toBe('sync.failure.reason.conflictPending');
  });

  it('N2: ein fehlendes Cloud-Schema wird als ausstehende Freischaltung benannt', () => {
    expect(mapSyncErrorReason('Unbekannter Entity-Typ: accounting_assignment', 'error')).toBe(
      'sync.failure.reason.notDeployed',
    );
    expect(mapSyncErrorReason('relation "x" does not exist', 'error')).toBe(
      'sync.failure.reason.notDeployed',
    );
    /*
     * Der Satz, den PostgREST tatsaechlich schickt, solange die
     * Kontierungs-Migrationen remote fehlen. Genau er darf nicht roh
     * dastehen.
     */
    expect(
      mapSyncErrorReason(
        'Could not find the function public.pull_workspace_accounting_period_closures(p_workspace_id) in the schema cache',
        'error',
      ),
    ).toBe('sync.failure.reason.notDeployed');
  });

  it('N3: ein unbekannter Rohtext wird nicht durchgereicht', () => {
    expect(mapSyncErrorReason('TypeError: undefined is not a function', 'error')).toBe(
      'sync.failure.reason.unknown',
    );
  });

  it('N4: ein nicht wiederholbarer Fehler sagt das auch', () => {
    const beschreibung = describeSyncOutboxEntry(
      entry('accounting_assignment', 'k-01b', {
        status: 'error',
        lastErrorMessage: 'accounting_chart_invalid: SKR05',
        lastErrorRetryable: false,
      }),
    );

    expect(beschreibung.kind).toBe('error');
    expect(beschreibung.retryable).toBe(false);
    expect(beschreibung.reasonKey).toBe('sync.failure.reason.rejected');
  });
});
