import { describe, expect, it, beforeEach } from 'vitest';
import type { CompanyDocument, Task } from '../../types/models';
import type { CommunicationEvent } from '../../types/communicationHistory';
import type { DocumentMemory, ProofMemory } from '../../types/memory';
import type { KnowledgeFact } from '../../types/knowledge';
import type { SyncMeta, VirtualSyncDevice } from '../../types/sync';
import { mergeAppendOnlyCollections, mergeSyncEntities } from './syncMergeEngine';
import {
  cloneAppPersistedState,
  findEntityInState,
  upsertEntityInState,
} from './syncEntityRegistry';
import {
  createVirtualDevice,
  createVirtualDevicePair,
  enqueueDeviceOutboxEntry,
  getLastSyncSimulationReport,
  getLocalSyncHubSnapshot,
  resetLocalSyncHubForTests,
  retryFailedOutboxEntries,
  simulateBidirectionalSync,
  simulatePull,
  simulatePush,
  simulateSyncCycle,
} from './syncSimulatorService';
import { STORAGE_VERSION } from './syncMigrationService';

function syncMeta(
  deviceId: string,
  workspaceId: string,
  version: number,
  overrides: Partial<SyncMeta> = {},
): SyncMeta {
  return {
    updatedAt: `2026-03-01T10:0${version}:00.000Z`,
    version,
    deleted: false,
    deviceId,
    workspaceId,
    ...overrides,
  };
}

function withDocument(
  device: VirtualSyncDevice,
  doc: {
    id: string;
    title: string;
    version: number;
    deleted?: boolean;
  },
): VirtualSyncDevice {
  const state = upsertEntityInState(device.state, 'document', {
    id: doc.id,
    title: doc.title,
    category: 'steuer',
    issuer: 'FA',
    recognizedText: '',
    issueDate: null,
    validUntil: null,
    digitalFolder: { id: 'dig-1', name: 'Steuer', path: '/Steuer/' },
    paperFolder: { folderId: 'f1', register: 'A', label: 'Steuer' },
    tags: [],
    linkedCompany: 'Test GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-03-01T10:00:00.000Z',
    sync: syncMeta(device.deviceId, device.workspaceId, doc.version, {
      deleted: doc.deleted ?? false,
      deletedAt: doc.deleted ? '2026-03-01T12:00:00.000Z' : undefined,
    }),
  } as CompanyDocument);
  return { ...device, state };
}

function queueEntity(
  device: VirtualSyncDevice,
  entityType: 'document' | 'task' | 'document_memory' | 'proof_memory' | 'communication_event' | 'knowledge_fact',
  entityId: string,
  operation: 'create' | 'update' | 'delete' = 'update',
  version = 1,
): VirtualSyncDevice {
  return enqueueDeviceOutboxEntry(device, {
    entityType,
    entityId,
    operation,
    version,
  });
}

describe('syncMergeEngine', () => {
  it('gleiche Version → noop', () => {
    const entity = {
      id: 'doc-1',
      sync: syncMeta('a', 'w', 2),
    };
    const result = mergeSyncEntities(entity, { ...entity }, 'document');
    expect(result.resolution).toBe('noop');
    expect(result.conflict).toBe(false);
  });

  it('höhere Version gewinnt', () => {
    const local = { id: 'doc-1', sync: syncMeta('a', 'w', 2) };
    const remote = { id: 'doc-1', sync: syncMeta('b', 'w', 3) };
    const result = mergeSyncEntities(local, remote, 'document');
    expect(result.resolution).toBe('remote_wins');
    expect(result.entity?.sync.version).toBe(3);
  });

  it('Tombstone gewinnt gegen alte Daten', () => {
    const local = { id: 'doc-1', sync: syncMeta('a', 'w', 2) };
    const remote = {
      id: 'doc-1',
      sync: syncMeta('b', 'w', 3, { deleted: true, deletedAt: '2026-03-01T12:00:00.000Z' }),
    };
    const result = mergeSyncEntities(local, remote, 'document');
    expect(result.resolution).toBe('remote_wins');
    expect(result.entity?.sync.deleted).toBe(true);
    expect(result.conflict).toBe(true);
  });

  it('CommunicationHistory ist append-only Union', () => {
    const local = [
      { id: 'evt-1', sync: syncMeta('a', 'w', 1) },
      { id: 'evt-2', sync: syncMeta('a', 'w', 1) },
    ];
    const remote = [{ id: 'evt-3', sync: syncMeta('b', 'w', 1) }];
    const union = mergeAppendOnlyCollections(local as never[], remote as never[]);
    expect(union.items).toHaveLength(3);
    expect(union.mergedCount).toBeGreaterThan(0);
  });
});

describe('syncSimulatorService', () => {
  beforeEach(() => {
    resetLocalSyncHubForTests();
  });

  it('erzeugt virtuelle Geräte mit deviceId und workspaceId', () => {
    const { deviceA, deviceB } = createVirtualDevicePair();
    expect(deviceA.deviceId).not.toBe(deviceB.deviceId);
    expect(deviceA.workspaceId).toBe(deviceB.workspaceId);
    expect(deviceA.syncState).toBe('idle');
  });

  it('Push → Pull synchronisiert Dokument von A nach B', () => {
    let { deviceA, deviceB } = createVirtualDevicePair();
    deviceA = withDocument(deviceA, { id: 'doc-sync-1', title: 'Steuerbescheid', version: 1 });
    deviceA = queueEntity(deviceA, 'document', 'doc-sync-1', 'create', 1);

    const result = simulateSyncCycle(deviceA, deviceB);
    const docB = findEntityInState(result.targetDevice.state, 'document', 'doc-sync-1') as CompanyDocument | null;

    expect(docB?.title).toBe('Steuerbescheid');
    expect(result.report.completedOutboxCount).toBe(1);
    expect(getLocalSyncHubSnapshot()).toHaveLength(1);
  });

  it('Tombstone auf A und Änderung auf B → Tombstone gewinnt nach Zyklus', () => {
    let { deviceA, deviceB } = createVirtualDevicePair();
    deviceA = withDocument(deviceA, { id: 'doc-del', title: 'Original', version: 1 });
    deviceB = withDocument(deviceB, { id: 'doc-del', title: 'Original', version: 1 });

    const pushSeed = simulateSyncCycle(deviceA, deviceB);
    deviceA = pushSeed.sourceDevice;
    deviceB = pushSeed.targetDevice;

    deviceA = withDocument(deviceA, { id: 'doc-del', title: 'Original', version: 2, deleted: true });
    deviceA = queueEntity(deviceA, 'document', 'doc-del', 'delete', 2);

    deviceB = withDocument(deviceB, { id: 'doc-del', title: 'Geändert auf B', version: 2 });
    deviceB = queueEntity(deviceB, 'document', 'doc-del', 'update', 2);

    const merged = simulateBidirectionalSync(deviceA, deviceB);
    const docA = findEntityInState(merged.deviceA.state, 'document', 'doc-del');
    const docB = findEntityInState(merged.deviceB.state, 'document', 'doc-del');

    expect(docA?.sync?.deleted || docB?.sync?.deleted).toBe(true);
    expect(merged.report.conflictCount).toBeGreaterThan(0);
  });

  it('Task erledigt auf A und bearbeitet auf B erzeugt Merge-Konflikt', () => {
    let { deviceA, deviceB } = createVirtualDevicePair();
    const task = {
      id: 'task-1',
      title: 'Prüfen',
      description: 'Dokument prüfen',
      status: 'open' as const,
      priority: 'mittel' as const,
      category: 'dokumente' as const,
      sourceType: 'manual' as const,
      sourceId: 'task-1',
      taskKind: 'manual',
      dedupeKey: 'manual:task-1:manual',
      autoCreated: false,
      createdAt: '2026-03-01T10:00:00.000Z',
      type: 'dokument_pruefen' as const,
    };

    let stateA = upsertEntityInState(deviceA.state, 'task', {
      ...task,
      sync: syncMeta(deviceA.deviceId, deviceA.workspaceId, 1),
    } as Task);
    deviceA = { ...deviceA, state: stateA };
    deviceB = { ...deviceB, state: cloneAppPersistedState(stateA) };

    stateA = upsertEntityInState(deviceA.state, 'task', {
      ...task,
      status: 'done',
      completedAt: '2026-03-01T11:00:00.000Z',
      sync: syncMeta(deviceA.deviceId, deviceA.workspaceId, 2),
    } as Task);
    deviceA = queueEntity({ ...deviceA, state: stateA }, 'task', 'task-1', 'update', 2);

    const stateB = upsertEntityInState(deviceB.state, 'task', {
      ...task,
      title: 'Prüfen und abheften',
      autoCreated: true,
      sync: syncMeta(deviceB.deviceId, deviceB.workspaceId, 2),
    } as Task);
    deviceB = queueEntity({ ...deviceB, state: stateB }, 'task', 'task-1', 'update', 2);

    const result = simulateBidirectionalSync(deviceA, deviceB);
    expect(result.report.mergedEntityCount).toBeGreaterThan(0);
  });

  it('DocumentMemory und ProofMemory werden synchronisiert', () => {
    let { deviceA, deviceB } = createVirtualDevicePair();

    let stateA = upsertEntityInState(deviceA.state, 'document_memory', {
      id: 'mem-1',
      documentId: 'doc-1',
      title: 'Versicherung',
      issuer: 'Allianz',
      digitalFolder: { id: 'd1', name: 'Vers', path: '/v/' },
      paperFolder: { folderId: 'f1', register: 'A', label: 'V' },
      validUntil: null,
      createdAt: '2026-03-01T10:00:00.000Z',
      updatedAt: '2026-03-01T10:00:00.000Z',
      sync: syncMeta(deviceA.deviceId, deviceA.workspaceId, 1),
    } as DocumentMemory);
    stateA = upsertEntityInState(stateA, 'proof_memory', {
      id: 'proof-1',
      proofType: 'bg_bau',
      status: 'valid',
      requiredByVorgangIds: ['v-1'],
      lastCheckedAt: '2026-03-01T10:00:00.000Z',
      updatedAt: '2026-03-01T10:00:00.000Z',
      sync: syncMeta(deviceA.deviceId, deviceA.workspaceId, 1),
    } as ProofMemory);
    deviceA = queueEntity({ ...deviceA, state: stateA }, 'document_memory', 'mem-1', 'create', 1);
    deviceA = queueEntity(deviceA, 'proof_memory', 'proof-1', 'create', 1);

    const result = simulateSyncCycle(deviceA, deviceB);
    expect(findEntityInState(result.targetDevice.state, 'document_memory', 'mem-1')).not.toBeNull();
    expect(findEntityInState(result.targetDevice.state, 'proof_memory', 'proof-1')).not.toBeNull();
  });

  it('CommunicationHistory wird append-only zusammengeführt', () => {
    let { deviceA, deviceB } = createVirtualDevicePair();

    const eventA = {
      id: 'evt-a',
      timestamp: '2026-03-01T10:00:00.000Z',
      type: 'document_question' as const,
      contextRef: { type: 'document' as const, id: 'doc-1' },
      status: 'complete' as const,
      disclaimerShown: true,
      sync: syncMeta(deviceA.deviceId, deviceA.workspaceId, 1),
    };
    const eventB = {
      id: 'evt-b',
      timestamp: '2026-03-02T10:00:00.000Z',
      type: 'document_answer' as const,
      contextRef: { type: 'document' as const, id: 'doc-1' },
      status: 'complete' as const,
      disclaimerShown: true,
      sync: syncMeta(deviceB.deviceId, deviceB.workspaceId, 1),
    };

    deviceA = {
      ...deviceA,
      state: upsertEntityInState(deviceA.state, 'communication_event', eventA as CommunicationEvent),
    };
    deviceB = {
      ...deviceB,
      state: upsertEntityInState(deviceB.state, 'communication_event', eventB as CommunicationEvent),
    };
    deviceA = queueEntity(deviceA, 'communication_event', 'evt-a', 'create', 1);
    deviceB = queueEntity(deviceB, 'communication_event', 'evt-b', 'create', 1);

    simulatePush(deviceA);
    simulatePush(deviceB);
    const pullA = simulatePull(deviceA);
    const pullB = simulatePull(deviceB);

    const eventsA = pullA.device.state.communicationHistory ?? [];
    const eventsB = pullB.device.state.communicationHistory ?? [];
    expect(eventsA).toHaveLength(2);
    expect(eventsB).toHaveLength(2);
  });

  it('Knowledge-Facts werden synchronisiert', () => {
    let { deviceA, deviceB } = createVirtualDevicePair();
    deviceA = {
      ...deviceA,
      state: upsertEntityInState(deviceA.state, 'knowledge_fact', {
        id: 'know-1',
        scope: 'company',
        category: 'communication_preference',
        key: 'email',
        value: 'morning',
        displayText: 'E-Mail morgens',
        sourceType: 'user',
        confirmedAt: '2026-03-01T10:00:00.000Z',
        createdAt: '2026-03-01T10:00:00.000Z',
        active: true,
        sync: syncMeta(deviceA.deviceId, deviceA.workspaceId, 1),
      } as KnowledgeFact),
    };
    deviceA = queueEntity(deviceA, 'knowledge_fact', 'know-1', 'create', 1);

    const result = simulateSyncCycle(deviceA, deviceB);
    expect(findEntityInState(result.targetDevice.state, 'knowledge_fact', 'know-1')).not.toBeNull();
  });

  it('Outbox wird auf completed gesetzt und Retry bei error vorbereitet', () => {
    let device = createVirtualDevice('A');
    device = queueEntity(device, 'document', 'missing-doc', 'update', 1);

    const push = simulatePush(device);
    expect(push.device.state.syncOutbox?.[0].status).toBe('error');

    const retried = retryFailedOutboxEntries(push.device);
    expect(retried.state.syncOutbox?.[0].status).toBe('pending');
    expect(retried.state.syncOutbox?.[0].retryCount).toBe(1);
  });

  it('SyncSimulationReport zeigt Statistiken', () => {
    let { deviceA, deviceB } = createVirtualDevicePair();
    deviceA = withDocument(deviceA, { id: 'doc-report', title: 'Report', version: 1 });
    deviceA = queueEntity(deviceA, 'document', 'doc-report', 'create', 1);

    simulateSyncCycle(deviceA, deviceB);
    const report = getLastSyncSimulationReport();
    expect(report).not.toBeNull();
    expect(report!.mergedEntityCount).toBeGreaterThan(0);
    expect(report!.durationMs).toBeGreaterThanOrEqual(0);
    expect(report!.syncedEntities.length).toBeGreaterThan(0);
  });

  it('drei Geräte teilen workspace und Hub', () => {
    const { deviceA, deviceB, deviceC } = createVirtualDevicePair();
    let a = withDocument(deviceA, { id: 'doc-3', title: 'Drei Geräte', version: 1 });
    a = queueEntity(a, 'document', 'doc-3', 'create', 1);
    simulatePush(a);
    const pullB = simulatePull(deviceB);
    const pullC = simulatePull(deviceC);

    expect(findEntityInState(pullB.device.state, 'document', 'doc-3')).not.toBeNull();
    expect(findEntityInState(pullC.device.state, 'document', 'doc-3')).not.toBeNull();
  });

  it('roundtrip state bleibt version 2', () => {
    const { deviceA, deviceB } = createVirtualDevicePair();
    expect(deviceA.state.version).toBe(STORAGE_VERSION);
    expect(deviceB.state.version).toBe(STORAGE_VERSION);
  });
});
