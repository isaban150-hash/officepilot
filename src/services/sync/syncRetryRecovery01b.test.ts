/**
 * FINANZ-SYNC-BLOCKER-01B — der Wiederholungsknopf darf nicht absterben.
 *
 * Die Analyse 01A hatte gezeigt: `retryAttempts` wurde nur hochgezählt und
 * ausserhalb der Tests nie zurückgesetzt. Nach dem dritten Versuch brach
 * `retrySync` sofort ab — sichtbar löste „Fehler erneut versuchen" gar keine
 * Anfrage mehr aus, dauerhaft, auch nach einem zwischenzeitlich erfolgreichen
 * Lauf.
 *
 * Die Grenze selbst bleibt richtig; sie schützt vor einem Selbstläufer. Sie
 * gilt nur nicht mehr für eine ausdrückliche Handlung eines Menschen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState } from '../../types/models';
import type { SyncAdapter } from './syncAdapter';
import { MAX_RETRY_ATTEMPTS, SyncCoordinator } from './syncCoordinator';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import { resetSyncOutboxForTests } from './syncOutboxService';
import { STORAGE_VERSION } from './syncMigrationService';
import { generateUuid } from './syncMetaService';

const DEVICE = 'device-retry-01b';
const WORKSPACE = 'ws-retry-01b';
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

/** Ein Adapter, dessen Push sich pro Lauf umschalten lässt. */
function adapterStub(): { adapter: SyncAdapter; setPushFails: (value: boolean) => void; pushRuns: () => number } {
  let fails = true;
  let runs = 0;

  const adapter = {
    providerKind: 'local' as const,
    pushChanges: vi.fn(async (input: Parameters<SyncAdapter['pushChanges']>[0]) => {
      runs += 1;
      return {
        success: !fails,
        state: input.state,
        completedOutboxIds: [],
        failedOutbox: fails ? [{ outboxId: 'o-1', message: 'Cloud abgelehnt', retryable: true }] : [],
        report: emptyReport(),
      };
    }),
    pullChanges: vi.fn(async (input: Parameters<SyncAdapter['pullChanges']>[0]) => ({
      success: true,
      state: input.state,
      report: emptyReport(),
    })),
    acknowledgeChanges: vi.fn(async () => undefined),
    reserveInvoiceNumber: vi.fn(async () => ({ year: 2026, sequenceNumber: 1, formatted: '2026-0001' })),
    uploadBlob: vi.fn(async () => ({ blobId: 'b-1' })),
    downloadBlob: vi.fn(async () => null),
    getSyncStatus: vi.fn(() => ({ syncState: 'idle' as const, pendingChanges: 1 })),
  } as unknown as SyncAdapter;

  return { adapter, setPushFails: (value) => { fails = value; }, pushRuns: () => runs };
}

function state(): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, deviceId: DEVICE, workspaceId: WORKSPACE, serverWorkspaceId: WORKSPACE, syncPolicy: 'cloud' },
    syncOutbox: [
      {
        id: generateUuid(),
        entityType: 'accounting_assignment',
        entityId: 'k-retry',
        operation: 'update',
        version: 1,
        queuedAt: AT,
        retryCount: 0,
        status: 'error',
      },
    ],
    setup: DEFAULT_SETUP,
    vorgaenge: [],
    customers: [],
    inboxItems: [],
    tasks: [],
    documents: [],
    expenses: [],
    savedAt: AT,
  } as AppPersistedState;
}

beforeEach(() => {
  localStorage.clear();
  resetSyncOutboxForTests([]);
  resetSyncClientForTests(createSyncClient());
});

describe('J — Wiederholen', () => {
  it('J1: das automatische Limit greift weiterhin', async () => {
    const stub = adapterStub();
    const coordinator = new SyncCoordinator(stub.adapter);

    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i += 1) {
      await coordinator.retrySync(state());
    }
    const ueberzaehlig = await coordinator.retrySync(state());

    expect(ueberzaehlig.success).toBe(false);
    expect(ueberzaehlig.report.errors[0].message).toBe('Maximale Retry-Anzahl erreicht');
    expect(stub.pushRuns(), 'kein weiterer Selbstlauf').toBe(MAX_RETRY_ATTEMPTS);
    expect(coordinator.canRetryAutomatically()).toBe(false);
  });

  it('J2: ein manueller Versuch wirkt auch nach dem Limit', async () => {
    const stub = adapterStub();
    const coordinator = new SyncCoordinator(stub.adapter);
    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i += 1) await coordinator.retrySync(state());
    const vorher = stub.pushRuns();

    await coordinator.retrySync(state(), { manual: true });

    expect(stub.pushRuns(), 'der Knopf löst wieder eine Anfrage aus').toBe(vorher + 1);
  });

  it('J3: ein erfolgreicher Lauf beendet die Fehlerserie', async () => {
    const stub = adapterStub();
    const coordinator = new SyncCoordinator(stub.adapter);
    await coordinator.retrySync(state());
    await coordinator.retrySync(state());
    expect(coordinator.getRetryAttempts()).toBe(2);

    stub.setPushFails(false);
    const lauf = await coordinator.runSync(state());

    expect(lauf.success).toBe(true);
    expect(coordinator.getRetryAttempts(), 'sonst verbraucht ein alter Fehler das nächste Kontingent').toBe(0);
    expect(coordinator.canRetryAutomatically()).toBe(true);
  });

  it('J4: nach dem Zurücksetzen begrenzt dieselbe Regel erneut', async () => {
    const stub = adapterStub();
    const coordinator = new SyncCoordinator(stub.adapter);
    stub.setPushFails(false);
    await coordinator.runSync(state());

    stub.setPushFails(true);
    const laeufeVorher = stub.pushRuns();
    for (let i = 0; i < MAX_RETRY_ATTEMPTS + 2; i += 1) {
      await coordinator.retrySync(state());
    }

    expect(stub.pushRuns() - laeufeVorher, 'keine Endlosschleife').toBe(MAX_RETRY_ATTEMPTS);
  });

  it('J5: zwei Klicks hintereinander senden nicht doppelt', async () => {
    const stub = adapterStub();
    const coordinator = new SyncCoordinator(stub.adapter);

    const [erster, zweiter] = await Promise.all([
      coordinator.retrySync(state(), { manual: true }),
      coordinator.retrySync(state(), { manual: true }),
    ]);

    expect(stub.pushRuns(), 'ein Lauf, nicht zwei').toBe(1);
    expect([erster.success, zweiter.success].filter(Boolean).length).toBeLessThanOrEqual(1);
  });
});
