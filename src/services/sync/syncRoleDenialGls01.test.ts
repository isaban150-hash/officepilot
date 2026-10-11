/**
 * GO-LIVE-SECURITY-01 — Rollenabweisungen im Sync.
 *
 * Ein vom Server wegen der Rolle abgewiesener Auftrag ist endgültig und kein
 * Übertragungsfehler. Der Abgleich läuft trotzdem, damit der Serverstand eine
 * abgewiesene Löschung zurücknehmen kann; jeder andere Sendefehler hält den
 * Abgleich weiterhin an. Kein Netzwerk.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState } from '../../types/models';
import type { SyncOutboxEntry, SyncSimulationReport } from '../../types/sync';
import type { SyncAdapter } from './syncAdapter';
import { SyncCoordinator } from './syncCoordinator';
import { createSyncClient } from './syncClientService';
import { applySyncMetadataToState, STORAGE_VERSION } from './syncMigrationService';
import { isRoleDenialFailure, isRoleDeniedOutboxEntry, planRoleDeniedTombstoneRestore } from './syncRoleDenial';

function auftrag(overrides: Partial<SyncOutboxEntry> = {}): SyncOutboxEntry {
  return {
    id: 'out-1',
    entityType: 'paper_register_entry',
    entityId: 'paper-1',
    operation: 'delete',
    version: 2,
    queuedAt: '2026-10-09T18:00:00.000Z',
    retryCount: 1,
    status: 'error',
    lastErrorMessage: 'Keine Schreibberechtigung',
    lastErrorRetryable: false,
    ...overrides,
  };
}

const META = { updatedAt: '2026-10-09T18:00:00.000Z', version: 2, deleted: true };

describe('GLS01 Sync — die Regel', () => {
  it('erkennt nur die endgültige Rollenabweisung', () => {
    expect(isRoleDenialFailure({ message: 'Keine Schreibberechtigung', retryable: false })).toBe(true);
    expect(isRoleDenialFailure({ message: 'Keine Schreibberechtigung', retryable: true })).toBe(false);
    expect(isRoleDenialFailure({ message: 'Failed to fetch', retryable: false })).toBe(false);
    expect(isRoleDeniedOutboxEntry(auftrag())).toBe(true);
    expect(isRoleDeniedOutboxEntry(auftrag({ status: 'pending' }))).toBe(false);
    expect(isRoleDeniedOutboxEntry(auftrag({ lastErrorMessage: 'Versionskonflikt' }))).toBe(false);
  });

  it('ABSCHLUSS: erkennt auch die endgültigen Abweisungen der Finanzwege', () => {
    for (const meldung of [
      'finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht',
      'finance_license_expired: Lizenz ist abgelaufen',
      'finance_account_blocked: Konto ist gesperrt',
    ]) {
      expect(isRoleDenialFailure({ message: meldung, retryable: false })).toBe(true);
      expect(isRoleDenialFailure({ message: meldung, retryable: true })).toBe(false);
      expect(isRoleDeniedOutboxEntry(auftrag({ lastErrorMessage: meldung }))).toBe(true);
    }
    expect(isRoleDenialFailure({ message: 'finance_irgendwas', retryable: false })).toBe(false);
  });

  it('holt nur Grabsteine zurück, deren Cloud-Zeile lebt', () => {
    const lokal = [
      { id: 'paper-1', sync: META },
      { id: 'paper-2', sync: META },
      { id: 'paper-3', sync: { ...META, deleted: false } },
    ];
    const outbox = [
      auftrag(),
      auftrag({ id: 'out-2', entityId: 'paper-2' }),
      auftrag({ id: 'out-3', entityId: 'paper-3' }),
      auftrag({ id: 'out-4', entityId: 'paper-1', entityType: 'document' }),
      auftrag({ id: 'out-5', entityId: 'paper-1', lastErrorMessage: 'Failed to fetch' }),
    ];
    const plan = planRoleDeniedTombstoneRestore(outbox, 'paper_register_entry', lokal, new Set(['paper-1', 'paper-3']));
    // paper-2 lebt in der Cloud nicht, paper-3 ist lokal kein Grabstein; andere Typen und Fehler zählen nicht.
    expect([...plan.entityIds]).toEqual(['paper-1']);
    expect(plan.outboxIds).toEqual(['out-1']);
  });
});

function bericht(errors: SyncSimulationReport['errors'] = []): SyncSimulationReport {
  return {
    startedAt: '2026-10-09T18:00:00.000Z',
    finishedAt: '2026-10-09T18:00:01.000Z',
    durationMs: 0,
    pushCount: 1,
    pullCount: 0,
    mergedEntityCount: 0,
    conflictCount: 0,
    errorCount: errors.length,
    completedOutboxCount: 0,
    syncedEntities: [],
    conflicts: [],
    errors,
  };
}

function zustand(): AppPersistedState {
  const client = { ...createSyncClient(), deviceId: 'device-1', workspaceId: 'ws-1', syncPolicy: 'cloud_ready' as const };
  return {
    ...applySyncMetadataToState(
      {
        version: STORAGE_VERSION,
        syncClient: client,
        syncOutbox: [],
        setup: { ...DEFAULT_SETUP },
        inboxItems: [],
        vorgaenge: [],
        tasks: [],
        documents: [],
        expenses: [],
        savedAt: '2026-10-09T18:00:00.000Z',
      },
      client,
    ),
    syncOutbox: [auftrag({ status: 'pending', lastErrorMessage: undefined })],
  } as AppPersistedState;
}

function adapter(meldung: string, retryable: boolean) {
  const pullChanges = vi.fn<SyncAdapter['pullChanges']>(async (input) => ({
    success: true,
    state: input.state,
    report: { ...bericht(), pushCount: 0, pullCount: 1 },
  }));
  const stub = {
    providerKind: 'local' as const,
    pushChanges: vi.fn<SyncAdapter['pushChanges']>(async (input) => ({
      success: false,
      state: input.state,
      completedOutboxIds: [],
      failedOutbox: [{ outboxId: 'out-1', message: meldung, retryable }],
      report: bericht([{ outboxId: 'out-1', message: meldung }]),
    })),
    pullChanges,
    acknowledgeChanges: vi.fn<SyncAdapter['acknowledgeChanges']>(async () => undefined),
    reserveInvoiceNumber: vi.fn<SyncAdapter['reserveInvoiceNumber']>(),
    uploadBlob: vi.fn<SyncAdapter['uploadBlob']>(),
    downloadBlob: vi.fn<SyncAdapter['downloadBlob']>(),
    getSyncStatus: vi.fn<SyncAdapter['getSyncStatus']>(() => ({ syncState: 'idle', pendingChanges: 0 })),
  };
  return stub as unknown as SyncAdapter & { pullChanges: typeof pullChanges };
}

describe('GLS01 Sync — der Koordinator', () => {
  it('K1: nach einer Rollenabweisung läuft der Abgleich trotzdem', async () => {
    const stub = adapter('Keine Schreibberechtigung', false);
    await new SyncCoordinator(stub).runSync(zustand());
    expect(stub.pullChanges).toHaveBeenCalledTimes(1);
  });

  it('K1b: nach einer Finanzabweisung (veraltete Rolle) läuft der Abgleich ebenfalls', async () => {
    const stub = adapter('finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht', false);
    await new SyncCoordinator(stub).runSync(zustand());
    expect(stub.pullChanges).toHaveBeenCalledTimes(1);
  });

  it('K2: jeder andere Sendefehler hält den Abgleich weiterhin an', async () => {
    const stub = adapter('Failed to fetch', true);
    const result = await new SyncCoordinator(stub).runSync(zustand());
    expect(stub.pullChanges).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('K3: der Nur-Senden-Lauf bleibt ein Fehler, verlangt aber den vollständigen Abgleich', async () => {
    const rolle = await new SyncCoordinator(adapter('Keine Schreibberechtigung', false)).runPushOnly(zustand());
    expect(rolle.success).toBe(false);
    expect(rolle.needsFullSync).toBe(true);

    const netz = await new SyncCoordinator(adapter('Failed to fetch', true)).runPushOnly(zustand());
    expect(netz.needsFullSync).toBe(false);
  });
});
