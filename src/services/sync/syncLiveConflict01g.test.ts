/**
 * FINANZ-SYNC-BLOCKER-01G — der Konflikt muss in derselben Sitzung erscheinen.
 *
 * Beobachtet wurde: Direkt nach einem Sync, der die Einstellungen in einen
 * Versionskonflikt brachte, standen „Bitte entscheiden" und ein blockierter
 * Auftrag da — aber weder beide Werte noch die Knöpfe. Erst ein vollständiger
 * Neustart brachte sie.
 *
 * Die Ursache liegt im Ablauf des Laufs: Ein gescheiterter Sendeversuch kehrte
 * zurück, **bevor** der Abgleich lief. Der Konflikt mit beiden Werten entsteht
 * aber erst im Abgleich. Nach einem Neustart hatte die Sendeschleife nichts
 * mehr zu tun — der Abgleich kam durch, und der Konflikt erschien.
 *
 * Dieser Test ruft deshalb bewusst **kein** Hydrate und kein Reload, bevor er
 * die Entscheidung erwartet. Genau das war der blinde Fleck in 01F.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState } from '../../types/models';
import type { SyncAdapter, SyncPullInput, SyncPushInput } from './syncAdapter';
import type { SyncOutboxEntry } from '../../types/sync';
import type { WorkspaceSettings } from '../../types/workspace';
import { SyncCoordinator } from './syncCoordinator';
import { summarizeSyncStatus, type SyncUiSnapshot } from './syncUiService';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from './syncOutboxService';
import { STORAGE_VERSION } from './syncMigrationService';
import { applyStateToStores } from '../persistenceService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import {
  getPendingWorkspaceSettingsConflict,
  resolveWorkspaceSettingsConflict,
} from '../workspace/workspaceSettingsConflictService';
import {
  getWorkspaceSettingsSnapshot,
  hydrateWorkspaceStore,
  resetWorkspaceStore,
} from '../workspace/workspaceStore';
import { describeSyncOutboxEntry } from './syncOutboxDescriptionService';

const WORKSPACE = '00000000-0000-0000-0000-00000000f01g';
const DEVICE = 'device-01g';
const AT = '2026-07-10T09:00:00.000Z';

function emptyReport() {
  return {
    startedAt: AT,
    finishedAt: AT,
    durationMs: 0,
    pushCount: 0,
    pullCount: 0,
    mergedEntityCount: 0,
    conflictCount: 0,
    errorCount: 0,
    completedOutboxCount: 0,
    syncedEntities: [],
    conflicts: [],
    errors: [],
  };
}

function settings(values: Record<string, unknown>, version: number, extra: Partial<WorkspaceSettings> = {}): WorkspaceSettings {
  return { workspaceId: WORKSPACE, settings: values, version, updatedAt: AT, ...extra };
}

/** Der lokale Auftrag, der gleich am Versionsvertrag scheitert. */
function pendingEntry(): SyncOutboxEntry {
  return {
    id: 'ob-settings-01g',
    entityType: 'workspace_settings',
    entityId: WORKSPACE,
    operation: 'update',
    version: 2,
    queuedAt: AT,
    retryCount: 0,
    status: 'pending',
  } as SyncOutboxEntry;
}

function state(local: WorkspaceSettings, outbox: SyncOutboxEntry[]): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: {
      ...client,
      deviceId: DEVICE,
      serverWorkspaceId: WORKSPACE,
      workspaceId: WORKSPACE,
      syncPolicy: 'cloud',
    },
    syncOutbox: outbox,
    setup: DEFAULT_SETUP,
    vorgaenge: [],
    customers: [],
    inboxItems: [],
    tasks: [],
    documents: [],
    expenses: [],
    workspaceSettings: local,
    savedAt: AT,
  } as AppPersistedState;
}

function pullPayload(cloud: WorkspaceSettings) {
  return {
    workspace: null,
    members: [],
    settings: cloud,
    setupPayload: null,
    setupRowVersion: 0,
    setupUpdatedAt: null,
    companyProfilePayload: null,
    companyProfileRowVersion: 0,
    companyProfileUpdatedAt: null,
    vorgaenge: [],
    customers: [],
  } as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

/**
 * Ein Adapter, der sich wie der echte verhält: Der Sendeversuch scheitert am
 * Versionskonflikt und markiert den Auftrag `blocked`; der Abgleich liefert den
 * neueren Cloud-Stand und führt ihn über den **echten** Merge zusammen.
 */
function konfliktAdapter(cloud: WorkspaceSettings): { adapter: SyncAdapter; pullLief: () => boolean } {
  let pullLief = false;

  const adapter = {
    providerKind: 'supabase' as const,
    pushChanges: vi.fn(async (input: SyncPushInput) => {
      const outbox = (input.outbox ?? []).map((entry) =>
        entry.entityType === 'workspace_settings'
          ? { ...entry, status: 'blocked' as const, retryCount: entry.retryCount + 1, lastErrorMessage: 'Versionskonflikt' }
          : entry,
      );
      return {
        success: false,
        state: { ...input.state, syncOutbox: outbox },
        completedOutboxIds: [],
        failedOutbox: [
          { outboxId: 'ob-settings-01g', message: 'Versionskonflikt', retryable: false },
        ],
        report: { ...emptyReport(), errorCount: 1, conflictCount: 1 },
      };
    }),
    pullChanges: vi.fn(async (input: SyncPullInput) => {
      pullLief = true;
      const merged = mergeRemoteWorkspacePullIntoState(input.state, pullPayload(cloud));
      return { success: true, state: merged.state, report: emptyReport() };
    }),
    acknowledgeChanges: vi.fn(async () => undefined),
    reserveInvoiceNumber: vi.fn(async () => ({ year: 2026, sequenceNumber: 1, formatted: '2026-0001' })),
    uploadBlob: vi.fn(async () => ({ blobId: 'b' })),
    downloadBlob: vi.fn(async () => null),
    getSyncStatus: vi.fn(() => ({ syncState: 'idle' as const, pendingChanges: 1 })),
  } as unknown as SyncAdapter;

  return { adapter, pullLief: () => pullLief };
}

/**
 * Ein Konflikt zaehlt nur, wenn er auch entscheidbar ist. Deshalb reist die
 * offene Entscheidung im Snapshot mit — ein im Testmodus blockierter Auftrag
 * ohne Auflösung bleibt „wartet".
 */
function snapshotFuerStatus(
  outbox: SyncOutboxEntry[],
  syncState: SyncUiSnapshot['status']['syncState'],
  entscheidbar = true,
) {
  return {
    status: { syncState, pendingChanges: outbox.length },
    outbox,
    lastReport: null,
    isOffline: false,
    settingsConflict: entscheidbar
      ? [{ key: 'chartOfAccounts', localValue: 'SKR04', cloudValue: 'SKR03' }]
      : null,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetWorkspaceStore();
  resetSyncOutboxForTests([]);
  resetSyncClientForTests(createSyncClient());
});

/* ================================================================== */
/* A/B — der Konflikt entsteht im selben Lauf                          */
/* ================================================================== */

describe('A/B — kein Reload mehr nötig', () => {
  async function laufMitKonflikt(cloudWert = 'SKR03') {
    const lokal = settings({ chartOfAccounts: 'SKR04' }, 2, { pendingKeys: ['chartOfAccounts'] });
    const ausgang = state(lokal, [pendingEntry()]);
    resetSyncOutboxForTests([pendingEntry()]);
    applyStateToStores(ausgang);

    const { adapter, pullLief } = konfliktAdapter(settings({ chartOfAccounts: cloudWert }, 5));
    const coordinator = new SyncCoordinator(adapter);
    const ergebnis = await coordinator.runSync(ausgang);

    // Der normale Persistenzweg, wie ihn die Oberfläche nach dem Lauf geht.
    if (!ergebnis.skipPersist) applyStateToStores(ergebnis.state);
    return { ergebnis, pullLief, coordinator };
  }

  it('A1: der Abgleich läuft trotz Sendekonflikt', async () => {
    const { pullLief } = await laufMitKonflikt();
    expect(pullLief(), 'vorher kehrte der Lauf vor dem Abgleich zurück').toBe(true);
  });

  it('A2: der Konflikt steht sofort im laufenden Speicher — ohne Reload', async () => {
    await laufMitKonflikt();

    const offen = getPendingWorkspaceSettingsConflict();
    expect(offen, 'genau das fehlte in der Abnahme').not.toBeNull();
    expect(offen?.undecided).toEqual([
      { key: 'chartOfAccounts', localValue: 'SKR04', cloudValue: 'SKR03' },
    ]);
  });

  it('A3: beide Werte sind sofort lesbar', async () => {
    await laufMitKonflikt();
    const felder = getWorkspaceSettingsSnapshot()?.conflict?.fields ?? [];

    expect(felder[0]?.localValue, 'der Wert dieses Geräts').toBe('SKR04');
    expect(felder[0]?.cloudValue, 'der Cloud-Wert').toBe('SKR03');
  });

  it('A4: der blockierte Auftrag bleibt blockiert', async () => {
    const { ergebnis } = await laufMitKonflikt();
    const auftrag = (ergebnis.state.syncOutbox ?? []).find((e) => e.id === 'ob-settings-01g');
    expect(auftrag?.status).toBe('blocked');
  });

  it('A5: ein echter Sendefehler bricht den Lauf weiterhin ab', async () => {
    /*
     * Die Ausnahme gilt nur für Konflikte. Ein Transportfehler darf nicht
     * stillschweigend in einen Abgleich übergehen.
     */
    const lokal = settings({ chartOfAccounts: 'SKR04' }, 2);
    const ausgang = state(lokal, [pendingEntry()]);
    const { adapter } = konfliktAdapter(settings({ chartOfAccounts: 'SKR03' }, 5));
    (adapter.pushChanges as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: SyncPushInput) => ({
        success: false,
        state: {
          ...input.state,
          syncOutbox: (input.outbox ?? []).map((e) => ({ ...e, status: 'error' as const })),
        },
        completedOutboxIds: [],
        failedOutbox: [{ outboxId: 'ob-settings-01g', message: 'Failed to fetch', retryable: true }],
        report: { ...emptyReport(), errorCount: 1 },
      }),
    );

    const coordinator = new SyncCoordinator(adapter);
    const ergebnis = await coordinator.runSync(ausgang);

    expect(ergebnis.success).toBe(false);
    expect(adapter.pullChanges, 'kein Abgleich nach einem Transportfehler').not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/* D/E — atomarer Zustand und Statuswort                               */
/* ================================================================== */

describe('D/E — kein halbfertiger Zustand, kein falsches Wort', () => {
  it('D1: ohne aufgebauten Konflikt wird nicht zur Entscheidung aufgefordert', () => {
    hydrateWorkspaceStore({ workspaceSettings: settings({ chartOfAccounts: 'SKR04' }, 2) });
    const beschreibung = describeSyncOutboxEntry({
      ...pendingEntry(),
      status: 'blocked',
      lastErrorMessage: 'Versionskonflikt',
    });

    expect(beschreibung.reasonKey, 'sonst stünde „bitte entscheiden" ohne Entscheidung').toBe(
      'sync.failure.reason.conflictPending',
    );
  });

  it('D2: mit aufgebautem Konflikt steht die Aufforderung', () => {
    hydrateWorkspaceStore({
      workspaceSettings: settings({ chartOfAccounts: 'SKR03' }, 5, {
        conflict: {
          fields: [{ key: 'chartOfAccounts', localValue: 'SKR04', cloudValue: 'SKR03' }],
          detectedAt: AT,
        },
      }),
    });
    const beschreibung = describeSyncOutboxEntry({
      ...pendingEntry(),
      status: 'blocked',
      lastErrorMessage: 'Versionskonflikt',
    });

    expect(beschreibung.reasonKey).toBe('sync.failure.reason.conflict');
  });

  it('E1: nur ein Konflikt heisst „Entscheidung nötig", nicht „Fehler"', () => {
    const outbox = [{ ...pendingEntry(), status: 'blocked' as const }];
    const summary = summarizeSyncStatus(snapshotFuerStatus(outbox, 'synced'));

    expect(summary.kind).toBe('conflict');
    expect(summary.conflictCount).toBe(1);
    expect(summary.failedCount, 'kein technischer Fehler').toBe(0);
  });

  it('E2: ein echter Fehler bleibt ein Fehler', () => {
    const outbox = [{ ...pendingEntry(), status: 'error' as const }];
    const summary = summarizeSyncStatus(snapshotFuerStatus(outbox, 'error'));

    expect(summary.kind).toBe('failed');
    expect(summary.failedCount).toBe(1);
  });

  it('E3: Fehler und Konflikt zugleich — der Fehler hat Vorrang', () => {
    const outbox = [
      { ...pendingEntry(), id: 'a', status: 'error' as const },
      { ...pendingEntry(), id: 'b', status: 'blocked' as const },
    ];
    const summary = summarizeSyncStatus(snapshotFuerStatus(outbox, 'error'));

    expect(summary.kind).toBe('failed');
    expect(summary.conflictCount).toBe(1);
  });

  it('E4: ohne alles bleibt es bei „Synchronisiert"', () => {
    const summary = summarizeSyncStatus(snapshotFuerStatus([], 'synced', false));
    expect(summary.kind).toBe('synced');
    expect(summary.conflictCount).toBe(0);
  });

  it('E6: ein blockierter Auftrag ohne Auflösung wartet, statt zu fragen', () => {
    /*
     * Etwa im Testmodus: blockiert, aber es gibt nichts zu entscheiden. „Bitte
     * entscheiden" wäre hier derselbe halbfertige Zustand an anderer Stelle.
     */
    const outbox = [{ ...pendingEntry(), status: 'blocked' as const }];
    const summary = summarizeSyncStatus(snapshotFuerStatus(outbox, 'synced', false));

    expect(summary.kind).toBe('waiting');
    expect(summary.conflictCount).toBe(0);
  });
});

/* ================================================================== */
/* F/G — die Entscheidung wirkt sofort                                 */
/* ================================================================== */

describe('F/G — Entscheidung ohne Verzögerung', () => {
  async function konfliktLage() {
    const lokal = settings({ chartOfAccounts: 'SKR04' }, 2, { pendingKeys: ['chartOfAccounts'] });
    const ausgang = state(lokal, [pendingEntry()]);
    resetSyncOutboxForTests([pendingEntry()]);
    applyStateToStores(ausgang);
    const { adapter } = konfliktAdapter(settings({ chartOfAccounts: 'SKR03', companySettingA: 1 }, 5));
    const ergebnis = await new SyncCoordinator(adapter).runSync(ausgang);
    applyStateToStores(ergebnis.state);
  }

  it('F1: „Wert dieses Geräts behalten" wirkt sofort im Speicher', async () => {
    await konfliktLage();
    expect(resolveWorkspaceSettingsConflict('keep_local')).toBe(true);

    const danach = getWorkspaceSettingsSnapshot()!;
    expect(danach.settings.chartOfAccounts).toBe('SKR04');
    expect(danach.settings.companySettingA, 'andere Cloud-Felder bleiben').toBe(1);
    expect(danach.conflict).toBeUndefined();
    expect(danach.version, 'die Cloud-Version ist die Basis').toBe(5);
    expect(getSyncOutboxSnapshot()[0].status).toBe('pending');
    expect(getSyncOutboxSnapshot()[0].version).toBe(5);
  });

  it('G1: „Cloud-Wert übernehmen" wirkt sofort und lässt nichts offen', async () => {
    await konfliktLage();
    expect(resolveWorkspaceSettingsConflict('take_cloud')).toBe(true);

    const danach = getWorkspaceSettingsSnapshot()!;
    expect(danach.settings.chartOfAccounts).toBe('SKR03');
    expect(danach.conflict).toBeUndefined();
    expect(getSyncOutboxSnapshot()[0].status).toBe('completed');
    expect(
      getSyncOutboxSnapshot().some((e) => e.status === 'pending' || e.status === 'blocked'),
      'kein Rest',
    ).toBe(false);
  });

  it('H1: nach „lokal behalten" übersteht der Stand einen Neustart', async () => {
    await konfliktLage();
    resolveWorkspaceSettingsConflict('keep_local');
    const gespeichert = getWorkspaceSettingsSnapshot()!;

    resetWorkspaceStore();
    hydrateWorkspaceStore({ workspaceSettings: gespeichert });

    expect(getWorkspaceSettingsSnapshot()?.settings.chartOfAccounts).toBe('SKR04');
    expect(getPendingWorkspaceSettingsConflict()).toBeNull();
  });

  it('H2: nach „Cloud übernehmen" ebenso', async () => {
    await konfliktLage();
    resolveWorkspaceSettingsConflict('take_cloud');
    const gespeichert = getWorkspaceSettingsSnapshot()!;

    resetWorkspaceStore();
    hydrateWorkspaceStore({ workspaceSettings: gespeichert });

    expect(getWorkspaceSettingsSnapshot()?.settings.chartOfAccounts).toBe('SKR03');
    expect(getPendingWorkspaceSettingsConflict()).toBeNull();
  });

  it('H3: ein offener Konflikt übersteht einen Neustart unverändert', async () => {
    await konfliktLage();
    const gespeichert = getWorkspaceSettingsSnapshot()!;

    resetWorkspaceStore();
    hydrateWorkspaceStore({ workspaceSettings: gespeichert });

    expect(getPendingWorkspaceSettingsConflict()?.undecided).toEqual([
      { key: 'chartOfAccounts', localValue: 'SKR04', cloudValue: 'SKR03' },
    ]);
  });
});
