import type { AppPersistedState } from '../../types/models';
import { DEFAULT_SETUP } from '../../data/mockData';
import type {
  SyncEntityType,
  SyncHubEntity,
  SyncOutboxEntry,
  SyncSimulationReport,
  SyncState,
  VirtualSyncDevice,
} from '../../types/sync';
import { createSyncClient } from './syncClientService';
import { generateUuid } from './syncMetaService';
import { applySyncMetadataToState, STORAGE_VERSION } from './syncMigrationService';
import {
  cloneAppPersistedState,
  findEntityInState,
  listEntitiesByType,
  upsertEntityInState,
} from './syncEntityRegistry';
import {
  isAppendOnlyEntityType,
  mergeAppendOnlyCollections,
  mergeEntityWithAppendOnlyFields,
  mergeProofMemoryEntities,
  mergeSyncEntities,
} from './syncMergeEngine';
import {
  createEmptySyncSimulationReport,
  finalizeSyncSimulationReport,
  getLastSyncSimulationReport,
  recordOutboxError,
  recordSyncedEntity,
  resetSyncSimulationReportForTests,
} from './syncSimulationReportService';

const hub = new Map<string, SyncHubEntity>();

function hubKey(entityType: SyncEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function setDeviceSyncState(device: VirtualSyncDevice, syncState: SyncState): VirtualSyncDevice {
  return { ...device, syncState };
}

function updateDeviceState(device: VirtualSyncDevice, state: AppPersistedState): VirtualSyncDevice {
  return { ...device, state: cloneAppPersistedState(state) };
}

function updateDeviceOutbox(
  device: VirtualSyncDevice,
  outbox: SyncOutboxEntry[],
): VirtualSyncDevice {
  return {
    ...device,
    state: {
      ...device.state,
      syncOutbox: outbox.map((entry) => ({ ...entry })),
    },
  };
}

function pendingOutboxEntries(device: VirtualSyncDevice): SyncOutboxEntry[] {
  return (device.state.syncOutbox ?? []).filter((entry) => entry.status === 'pending');
}

function markOutboxEntry(
  device: VirtualSyncDevice,
  outboxId: string,
  status: SyncOutboxEntry['status'],
  retryIncrement = false,
): VirtualSyncDevice {
  const outbox = (device.state.syncOutbox ?? []).map((entry) => {
    if (entry.id !== outboxId) return entry;
    return {
      ...entry,
      status,
      retryCount: retryIncrement ? entry.retryCount + 1 : entry.retryCount,
    };
  });
  return updateDeviceOutbox(device, outbox);
}

function mergeIntoHub(
  entityType: SyncEntityType,
  entity: unknown,
  report: SyncSimulationReport,
): void {
  if (!entity || typeof entity !== 'object' || !('id' in entity)) return;
  const syncEntity = entity as { id: string; sync?: SyncHubEntity['sync'] };
  if (!syncEntity.sync) return;

  const key = hubKey(entityType, syncEntity.id);
  const existing = hub.get(key)?.payload ?? null;
  const mergeFn =
    entityType === 'proof_memory'
      ? mergeProofMemoryEntities
      : entityType === 'expense' || entityType === 'communication_event'
        ? mergeEntityWithAppendOnlyFields
        : mergeSyncEntities;

  const result =
    entityType === 'proof_memory'
      ? mergeProofMemoryEntities(existing as never, syncEntity as never)
      : mergeFn(existing as never, syncEntity as never, entityType);

  if (result.entity && result.entity.sync) {
    hub.set(key, {
      entityType,
      entityId: syncEntity.id,
      payload: result.entity,
      sync: result.entity.sync,
    });
    recordSyncedEntity(report, entityType, syncEntity.id, result.resolution, result.conflict);
  }
}

export function wrapStateAsVirtualDevice(
  state: AppPersistedState,
  name = 'client',
): VirtualSyncDevice {
  const client = state.syncClient;
  if (!client) {
    throw new Error('[Sync] syncClient fehlt im AppPersistedState');
  }
  return {
    name,
    deviceId: client.deviceId,
    workspaceId: client.workspaceId,
    state: cloneAppPersistedState(state),
    syncState: 'idle',
  };
}

export function getStateFromVirtualDevice(device: VirtualSyncDevice): AppPersistedState {
  return cloneAppPersistedState(device.state);
}

export function resetLocalSyncHubForTests(): void {
  hub.clear();
  resetSyncSimulationReportForTests();
}

export function getLocalSyncHubSnapshot(): SyncHubEntity[] {
  return [...hub.values()].map((entry) => ({
    ...entry,
    payload: JSON.parse(JSON.stringify(entry.payload)),
    sync: { ...entry.sync },
  }));
}

export function createVirtualDevice(
  name: string,
  initialState?: AppPersistedState,
  workspaceId?: string,
): VirtualSyncDevice {
  const client = createSyncClient();
  const resolvedWorkspaceId = workspaceId ?? client.workspaceId;
  const baseState = initialState
    ? cloneAppPersistedState(initialState)
    : {
        version: STORAGE_VERSION,
        setup: { ...DEFAULT_SETUP },
        inboxItems: [],
        vorgaenge: [],
        tasks: [],
        documents: [],
        expenses: [],
        vorgangNotes: [],
        communicationHistory: [],
        knowledgeFacts: [],
        mailImports: [],
        officePilotMemory: {
          documentMemories: [],
          proofMemories: [],
          relations: [],
          paperRegisterEntries: [],
        },
        savedAt: new Date().toISOString(),
      };

  const syncClient = {
    ...client,
    deviceId: generateUuid(),
    workspaceId: resolvedWorkspaceId,
    syncPolicy: 'local_only' as const,
  };

  const hydrated = applySyncMetadataToState(
    {
      ...baseState,
      version: STORAGE_VERSION,
      syncClient,
      syncOutbox: baseState.syncOutbox ?? [],
    },
    syncClient,
  );

  return {
    name,
    deviceId: syncClient.deviceId,
    workspaceId: resolvedWorkspaceId,
    state: hydrated,
    syncState: 'idle',
  };
}

export function createVirtualDevicePair(
  initialState?: AppPersistedState,
): { deviceA: VirtualSyncDevice; deviceB: VirtualSyncDevice; deviceC: VirtualSyncDevice } {
  const workspaceId = generateUuid();
  const seed = initialState ? cloneAppPersistedState(initialState) : undefined;
  return {
    deviceA: createVirtualDevice('Device A', seed, workspaceId),
    deviceB: createVirtualDevice('Device B', seed ? cloneAppPersistedState(seed) : undefined, workspaceId),
    deviceC: createVirtualDevice('Device C', seed ? cloneAppPersistedState(seed) : undefined, workspaceId),
  };
}

export function enqueueDeviceOutboxEntry(
  device: VirtualSyncDevice,
  entry: Omit<SyncOutboxEntry, 'id' | 'queuedAt' | 'retryCount' | 'status'>,
): VirtualSyncDevice {
  const nextEntry: SyncOutboxEntry = {
    ...entry,
    id: generateUuid(),
    queuedAt: new Date().toISOString(),
    retryCount: 0,
    status: 'pending',
  };
  const outbox = [nextEntry, ...(device.state.syncOutbox ?? [])];
  return updateDeviceOutbox(device, outbox);
}

export function simulatePush(
  sourceDevice: VirtualSyncDevice,
  report: SyncSimulationReport = createEmptySyncSimulationReport(new Date().toISOString()),
): { device: VirtualSyncDevice; report: SyncSimulationReport } {
  let device = setDeviceSyncState(sourceDevice, 'uploading');
  report.pushCount += 1;

  for (const entry of pendingOutboxEntries(device)) {
    const entity = findEntityInState(device.state, entry.entityType, entry.entityId);
    if (!entity) {
      if (entry.operation === 'delete') {
        const tombstone = hub.get(hubKey(entry.entityType, entry.entityId));
        if (tombstone) {
          mergeIntoHub(entry.entityType, tombstone.payload, report);
        }
        device = markOutboxEntry(device, entry.id, 'completed');
        report.completedOutboxCount += 1;
        continue;
      }
      recordOutboxError(report, entry.id, `Entity ${entry.entityType}:${entry.entityId} not found`);
      device = markOutboxEntry(device, entry.id, 'error', true);
      continue;
    }

    try {
      mergeIntoHub(entry.entityType, entity, report);
      device = markOutboxEntry(device, entry.id, 'completed');
      report.completedOutboxCount += 1;
    } catch (error) {
      recordOutboxError(
        report,
        entry.id,
        error instanceof Error ? error.message : 'Unknown push error',
      );
      device = markOutboxEntry(device, entry.id, 'error', true);
    }
  }

  return { device: setDeviceSyncState(device, 'synced'), report };
}

export function simulatePull(
  targetDevice: VirtualSyncDevice,
  report: SyncSimulationReport = createEmptySyncSimulationReport(new Date().toISOString()),
): { device: VirtualSyncDevice; report: SyncSimulationReport } {
  let device = setDeviceSyncState(targetDevice, 'downloading');
  report.pullCount += 1;

  let nextState = cloneAppPersistedState(device.state);

  for (const hubEntity of hub.values()) {
    if (hubEntity.sync.workspaceId !== device.workspaceId) continue;

    if (isAppendOnlyEntityType(hubEntity.entityType)) {
      const localItems = listEntitiesByType(nextState, hubEntity.entityType);
      const remoteItems = [hubEntity.payload as ReturnType<typeof listEntitiesByType>[number]];
      const union = mergeAppendOnlyCollections(localItems as never[], remoteItems as never[]);
      for (const item of union.items) {
        nextState = upsertEntityInState(nextState, hubEntity.entityType, item);
      }
      report.mergedEntityCount += union.mergedCount;
      report.conflictCount += union.conflictCount;
      recordSyncedEntity(
        report,
        hubEntity.entityType,
        hubEntity.entityId,
        union.mergedCount > 0 ? 'union' : 'noop',
        union.conflictCount > 0,
      );
      continue;
    }

    const localEntity = findEntityInState(nextState, hubEntity.entityType, hubEntity.entityId);
    const mergeFn =
      hubEntity.entityType === 'proof_memory'
        ? mergeProofMemoryEntities
        : hubEntity.entityType === 'expense'
          ? mergeEntityWithAppendOnlyFields
          : mergeSyncEntities;

    const result =
      hubEntity.entityType === 'proof_memory'
        ? mergeProofMemoryEntities(localEntity as never, hubEntity.payload as never)
        : mergeFn(localEntity as never, hubEntity.payload as never, hubEntity.entityType);

    if (result.entity) {
      nextState = upsertEntityInState(nextState, hubEntity.entityType, result.entity);
      recordSyncedEntity(
        report,
        hubEntity.entityType,
        hubEntity.entityId,
        result.resolution,
        result.conflict,
      );
    }
  }

  device = setDeviceSyncState(updateDeviceState(device, nextState), 'merging');
  return { device: setDeviceSyncState(device, 'synced'), report };
}

export function simulateSyncCycle(
  sourceDevice: VirtualSyncDevice,
  targetDevice: VirtualSyncDevice,
): {
  sourceDevice: VirtualSyncDevice;
  targetDevice: VirtualSyncDevice;
  report: SyncSimulationReport;
} {
  const startedAt = new Date().toISOString();
  const report = createEmptySyncSimulationReport(startedAt);

  const pushResult = simulatePush(sourceDevice, report);
  const pullResult = simulatePull(targetDevice, pushResult.report);

  return {
    sourceDevice: pushResult.device,
    targetDevice: pullResult.device,
    report: finalizeSyncSimulationReport(pullResult.report, new Date().toISOString()),
  };
}

export function simulateBidirectionalSync(
  deviceA: VirtualSyncDevice,
  deviceB: VirtualSyncDevice,
): {
  deviceA: VirtualSyncDevice;
  deviceB: VirtualSyncDevice;
  report: SyncSimulationReport;
} {
  const startedAt = new Date().toISOString();
  let report = createEmptySyncSimulationReport(startedAt);

  const aToHub = simulatePush(deviceA, report);
  let currentA = aToHub.device;
  report = aToHub.report;

  const pullB = simulatePull(deviceB, report);
  let currentB = pullB.device;
  report = pullB.report;

  const bToHub = simulatePush(currentB, report);
  currentB = bToHub.device;
  report = bToHub.report;

  const pullA = simulatePull(currentA, report);
  currentA = pullA.device;
  report = pullA.report;

  return {
    deviceA: currentA,
    deviceB: currentB,
    report: finalizeSyncSimulationReport(report, new Date().toISOString()),
  };
}

export function retryFailedOutboxEntries(device: VirtualSyncDevice): VirtualSyncDevice {
  const outbox = (device.state.syncOutbox ?? []).map((entry) =>
    entry.status === 'error' ? { ...entry, status: 'pending' as const } : entry,
  );
  return updateDeviceOutbox(device, outbox);
}

export { getLastSyncSimulationReport, resetSyncSimulationReportForTests };
