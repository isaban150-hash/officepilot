import { describe, expect, it, beforeEach, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState, CompanyDocument } from '../../types/models';
import type { SyncAdapter } from './syncAdapter';
import { LocalSyncAdapter, resetLocalSyncAdapterStoresForTests } from './localSyncAdapter';
import { createSyncAdapter, isSyncProviderAvailable } from './syncAdapterFactory';
import { SyncCoordinator, resetSyncCoordinatorForTests } from './syncCoordinator';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import { generateUuid } from './syncMetaService';
import { applySyncMetadataToState, STORAGE_VERSION } from './syncMigrationService';
import { upsertEntityInState } from './syncEntityRegistry';
import { resetLocalSyncHubForTests } from './syncSimulatorService';

function buildTestState(deviceId: string, workspaceId: string): AppPersistedState {
  const client = { ...createSyncClient(), deviceId, workspaceId, syncPolicy: 'local_only' as const };
  return applySyncMetadataToState(
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
      savedAt: new Date().toISOString(),
    },
    client,
  );
}

function withDocumentState(
  state: AppPersistedState,
  doc: CompanyDocument,
  outboxVersion = 1,
): AppPersistedState {
  const withDoc = upsertEntityInState(state, 'document', doc);
  return {
    ...withDoc,
    syncOutbox: [
      {
        id: generateUuid(),
        entityType: 'document',
        entityId: doc.id,
        operation: 'update',
        version: outboxVersion,
        queuedAt: new Date().toISOString(),
        retryCount: 0,
        status: 'pending',
      },
    ],
  };
}

class StubSyncAdapter implements SyncAdapter {
  readonly providerKind = 'local' as const;
  pushChanges = vi.fn<SyncAdapter['pushChanges']>();
  pullChanges = vi.fn<SyncAdapter['pullChanges']>();
  acknowledgeChanges = vi.fn<SyncAdapter['acknowledgeChanges']>();
  reserveInvoiceNumber = vi.fn<SyncAdapter['reserveInvoiceNumber']>();
  uploadBlob = vi.fn<SyncAdapter['uploadBlob']>();
  downloadBlob = vi.fn<SyncAdapter['downloadBlob']>();
  getSyncStatus = vi.fn<SyncAdapter['getSyncStatus']>(() => ({
    syncState: 'idle',
    pendingChanges: 0,
  }));

  constructor() {
    this.pushChanges.mockImplementation(async (input) => ({
      success: true,
      state: input.state,
      completedOutboxIds: [],
      failedOutbox: [],
      report: {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        pushCount: 1,
        pullCount: 0,
        mergedEntityCount: 0,
        conflictCount: 0,
        errorCount: 0,
        completedOutboxCount: 0,
        syncedEntities: [],
        conflicts: [],
        errors: [],
      },
    }));
    this.pullChanges.mockImplementation(async (input) => ({
      success: true,
      state: input.state,
      report: {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        pushCount: 0,
        pullCount: 1,
        mergedEntityCount: 0,
        conflictCount: 0,
        errorCount: 0,
        completedOutboxCount: 0,
        syncedEntities: [],
        conflicts: [],
        errors: [],
      },
    }));
    this.acknowledgeChanges.mockResolvedValue(undefined);
    this.reserveInvoiceNumber.mockResolvedValue({ year: 2026, sequenceNumber: 1, formatted: '2026-0001' });
    this.uploadBlob.mockResolvedValue({ blobId: 'blob-1' });
    this.downloadBlob.mockResolvedValue(null);
  }
}

describe('syncAdapterFactory', () => {
  it('erstellt LocalSyncAdapter als Default', () => {
    const adapter = createSyncAdapter();
    expect(adapter.providerKind).toBe('local');
    expect(adapter.pushChanges).toBeTypeOf('function');
    expect(adapter.pullChanges).toBeTypeOf('function');
  });

  it('markiert nur local als verfügbar', () => {
    expect(isSyncProviderAvailable('local')).toBe(true);
    expect(isSyncProviderAvailable('supabase')).toBe(false);
  });

  it('wirft für nicht implementierte Provider', () => {
    expect(() => createSyncAdapter({ provider: 'supabase' })).toThrow(/nicht implementiert/);
  });
});

describe('LocalSyncAdapter', () => {
  beforeEach(() => {
    resetLocalSyncHubForTests();
    resetLocalSyncAdapterStoresForTests();
    resetSyncClientForTests();
  });

  it('erfüllt SyncAdapter Interface', async () => {
    const adapter = new LocalSyncAdapter();
    const workspaceId = generateUuid();
    const reservation = await adapter.reserveInvoiceNumber(workspaceId);
    expect(reservation.formatted).toMatch(/^2026-\d{4}$/);

    const blob = new Blob(['test'], { type: 'text/plain' });
    const uploaded = await adapter.uploadBlob(workspaceId, blob);
    const downloaded = await adapter.downloadBlob(uploaded.blobId);
    expect(downloaded).not.toBeNull();

    expect(adapter.getSyncStatus().syncState).toBeDefined();
  });

  it('pushChanges verarbeitet Outbox über Simulator', async () => {
    const workspaceId = generateUuid();
    const deviceId = generateUuid();
    let state = buildTestState(deviceId, workspaceId);
    const doc: CompanyDocument = {
      id: 'doc-adapter-1',
      title: 'Adapter Test',
      category: 'steuer',
      issuer: 'FA',
      recognizedText: '',
      issueDate: null,
      validUntil: null,
      digitalFolder: { id: 'd1', name: 'Steuer', path: '/s/' },
      paperFolder: { folderId: 'f1', register: 'A', label: 'S' },
      tags: [],
      linkedCompany: 'Test',
      linkedVorgang: null,
      archived: true,
      createdAt: '2026-03-01T10:00:00.000Z',
      sync: {
        updatedAt: '2026-03-01T10:00:00.000Z',
        version: 1,
        deleted: false,
        deviceId,
        workspaceId,
      },
    };
    state = withDocumentState(state, doc);

    const adapter = new LocalSyncAdapter();
    const result = await adapter.pushChanges({
      deviceId,
      workspaceId,
      state,
      outbox: state.syncOutbox ?? [],
    });

    expect(result.success).toBe(true);
    expect(result.completedOutboxIds.length).toBe(1);
    expect(result.state.syncOutbox?.[0].status).toBe('completed');
  });
});

describe('SyncCoordinator', () => {
  beforeEach(() => {
    resetLocalSyncHubForTests();
    resetLocalSyncAdapterStoresForTests();
    resetSyncCoordinatorForTests();
    resetSyncClientForTests();
  });

  it('nutzt Adapter für Push und Pull', async () => {
    const stub = new StubSyncAdapter();
    const coordinator = new SyncCoordinator(stub);
    const state = buildTestState(generateUuid(), generateUuid());

    await coordinator.runSync(state);

    expect(stub.pushChanges).not.toHaveBeenCalled();
    expect(stub.pullChanges).toHaveBeenCalledTimes(1);
    expect(coordinator.getStatus().syncState).toBe('synced');
  });

  it('ruft Push und Pull bei pending Outbox auf', async () => {
    const stub = new StubSyncAdapter();
    const coordinator = new SyncCoordinator(stub);
    const workspaceId = generateUuid();
    const deviceId = generateUuid();
    const doc: CompanyDocument = {
      id: 'doc-coord-1',
      title: 'Coordinator',
      category: 'steuer',
      issuer: 'FA',
      recognizedText: '',
      issueDate: null,
      validUntil: null,
      digitalFolder: { id: 'd1', name: 'Steuer', path: '/s/' },
      paperFolder: { folderId: 'f1', register: 'A', label: 'S' },
      tags: [],
      linkedCompany: 'Test',
      linkedVorgang: null,
      archived: true,
      createdAt: '2026-03-01T10:00:00.000Z',
      sync: {
        updatedAt: '2026-03-01T10:00:00.000Z',
        version: 1,
        deleted: false,
        deviceId,
        workspaceId,
      },
    };
    const state = withDocumentState(buildTestState(deviceId, workspaceId), doc);

    await coordinator.runSync(state);

    expect(stub.pushChanges).toHaveBeenCalledTimes(1);
    expect(stub.pullChanges).toHaveBeenCalledTimes(1);
    expect(stub.acknowledgeChanges).toHaveBeenCalledTimes(1);
  });

  it('Adapter ist austauschbar', async () => {
    const stub = new StubSyncAdapter();
    const coordinator = new SyncCoordinator(createSyncAdapter());
    coordinator.setAdapter(stub);

    await coordinator.runSync(buildTestState(generateUuid(), generateUuid()));
    expect(stub.pullChanges).toHaveBeenCalled();
  });

  it('Retry wird zentral vom Coordinator gesteuert', async () => {
    const coordinator = new SyncCoordinator(new LocalSyncAdapter());
    const workspaceId = generateUuid();
    const deviceId = generateUuid();
    let state = buildTestState(deviceId, workspaceId);
    state = {
      ...state,
      syncOutbox: [
        {
          id: generateUuid(),
          entityType: 'document',
          entityId: 'missing',
          operation: 'update',
          version: 1,
          queuedAt: new Date().toISOString(),
          retryCount: 0,
          status: 'error',
        },
      ],
    };

    const retried = coordinator.prepareRetry(state);
    expect(retried.syncOutbox?.[0].status).toBe('pending');

    const result = await coordinator.retrySync(retried);
    expect(result.report.retryAttempts).toBeGreaterThan(0);
  });

  it('synchronisiert zwischen zwei Geräten über LocalAdapter', async () => {
    const workspaceId = generateUuid();
    const deviceAId = generateUuid();
    const deviceBId = generateUuid();

    const doc: CompanyDocument = {
      id: 'doc-multi',
      title: 'Multi Device',
      category: 'steuer',
      issuer: 'FA',
      recognizedText: '',
      issueDate: null,
      validUntil: null,
      digitalFolder: { id: 'd1', name: 'Steuer', path: '/s/' },
      paperFolder: { folderId: 'f1', register: 'A', label: 'S' },
      tags: [],
      linkedCompany: 'Test',
      linkedVorgang: null,
      archived: true,
      createdAt: '2026-03-01T10:00:00.000Z',
      sync: {
        updatedAt: '2026-03-01T10:00:00.000Z',
        version: 1,
        deleted: false,
        deviceId: deviceAId,
        workspaceId,
      },
    };

    const stateA = withDocumentState(buildTestState(deviceAId, workspaceId), doc);
    const stateB = buildTestState(deviceBId, workspaceId);

    const coordinatorA = new SyncCoordinator(new LocalSyncAdapter());
    const coordinatorB = new SyncCoordinator(new LocalSyncAdapter());

    await coordinatorA.runSync(stateA);
    const resultB = await coordinatorB.runSync(stateB);

    const syncedDoc = resultB.state.documents?.find((item) => item.id === 'doc-multi');
    expect(syncedDoc?.title).toBe('Multi Device');
    expect(coordinatorB.getLastReport()?.downloadCount).toBeGreaterThanOrEqual(0);
  });

  it('setzt Status offline bei disabled syncPolicy', async () => {
    const coordinator = new SyncCoordinator(new LocalSyncAdapter());
    const client = { ...createSyncClient(), syncPolicy: 'disabled' as const };
    const state = applySyncMetadataToState(
      {
        version: STORAGE_VERSION,
        syncClient: client,
        syncOutbox: [],
        setup: { ...DEFAULT_SETUP },
        inboxItems: [],
        vorgaenge: [],
        tasks: [],
        documents: [],
        savedAt: new Date().toISOString(),
      },
      client,
    );

    const result = await coordinator.runSync(state);
    expect(coordinator.getStatus().syncState).toBe('offline');
    expect(result.state).toEqual(state);
  });

  it('liefert Telemetrie im Report', async () => {
    const coordinator = new SyncCoordinator(new LocalSyncAdapter());
    const workspaceId = generateUuid();
    const deviceId = generateUuid();
    const doc: CompanyDocument = {
      id: 'doc-telemetry',
      title: 'Telemetry',
      category: 'steuer',
      issuer: 'FA',
      recognizedText: '',
      issueDate: null,
      validUntil: null,
      digitalFolder: { id: 'd1', name: 'Steuer', path: '/s/' },
      paperFolder: { folderId: 'f1', register: 'A', label: 'S' },
      tags: [],
      linkedCompany: 'Test',
      linkedVorgang: null,
      archived: true,
      createdAt: '2026-03-01T10:00:00.000Z',
      sync: {
        updatedAt: '2026-03-01T10:00:00.000Z',
        version: 1,
        deleted: false,
        deviceId,
        workspaceId,
      },
    };
    const state = withDocumentState(buildTestState(deviceId, workspaceId), doc);

    await coordinator.runSync(state);
    const report = coordinator.getLastReport();
    expect(report).not.toBeNull();
    expect(report!.durationMs).toBeGreaterThanOrEqual(0);
    expect(report!.uploadCount).toBeGreaterThanOrEqual(0);
    expect(typeof report!.retryAttempts).toBe('number');
  });
});

describe('createSyncAdapter via Factory', () => {
  it('liefert austauschbare Instanzen', () => {
    const a = createSyncAdapter();
    const b = createSyncAdapter();
    expect(a).not.toBe(b);
    expect(a.providerKind).toBe(b.providerKind);
  });
});
