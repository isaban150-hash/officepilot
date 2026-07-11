import type { VorgangNote } from '../../types/communication';
import type { CommunicationEvent } from '../../types/communicationHistory';
import type { Expense } from '../../types/expense';
import type { KnowledgeFact } from '../../types/knowledge';
import type { MailImport } from '../../types/mailImport';
import type {
  DocumentMemory,
  MemoryRelation,
  OfficePilotMemoryState,
  PaperRegisterEntry,
  ProofMemory,
} from '../../types/memory';
import type {
  AppPersistedState,
  CompanyDocument,
  InboxItem,
  Task,
  Vorgang,
} from '../../types/models';
import type { SyncClientConfig, SyncMeta } from '../../types/sync';
import { createSyncClient, ensureSyncClientFromState } from './syncClientService';
import { createDefaultSyncMeta } from './syncMetaService';

export const LEGACY_STORAGE_VERSION = 1;
export const STORAGE_VERSION = 4;
export const STORAGE_VERSION_V2 = 2;
export const STORAGE_VERSION_V3 = 3;

type PersistedStateV1 = Omit<AppPersistedState, 'syncClient' | 'syncOutbox'> & {
  version: typeof LEGACY_STORAGE_VERSION;
  syncClient?: undefined;
  syncOutbox?: undefined;
};

function backfillMeta<T extends { sync?: SyncMeta }>(
  entity: T,
  fallbackUpdatedAt: string,
  client: SyncClientConfig,
): T & { sync: SyncMeta } {
  if (entity.sync?.deviceId && entity.sync?.workspaceId) {
    return entity as T & { sync: SyncMeta };
  }
  return {
    ...entity,
    sync: entity.sync
      ? {
          ...entity.sync,
          deviceId: entity.sync.deviceId ?? client.deviceId,
          workspaceId: entity.sync.workspaceId ?? client.workspaceId,
          version: entity.sync.version ?? 1,
          deleted: entity.sync.deleted ?? false,
          updatedAt: entity.sync.updatedAt ?? fallbackUpdatedAt,
        }
      : createDefaultSyncMeta(fallbackUpdatedAt, client),
  };
}

function inboxFallbackUpdatedAt(item: InboxItem): string {
  return item.modifiedAt ?? item.receivedAt;
}

function taskFallbackUpdatedAt(task: Task): string {
  return task.completedAt ?? task.createdAt;
}

function vorgangFallbackUpdatedAt(vorgang: Vorgang, savedAt: string): string {
  const invoiceDates = (vorgang.invoices ?? []).map((inv) => inv.createdAt);
  const candidates = invoiceDates.filter(Boolean);
  if (candidates.length === 0) return savedAt;
  return candidates.sort().at(-1) ?? savedAt;
}

function applySyncToMemoryState(
  memory: OfficePilotMemoryState,
  client: SyncClientConfig,
): OfficePilotMemoryState {
  return {
    documentMemories: (memory.documentMemories ?? []).map((item: DocumentMemory) =>
      backfillMeta(item, item.updatedAt ?? item.createdAt, client),
    ),
    proofMemories: (memory.proofMemories ?? []).map((item: ProofMemory) =>
      backfillMeta(item, item.updatedAt, client),
    ),
    relations: (memory.relations ?? []).map((item: MemoryRelation) =>
      backfillMeta(item, item.createdAt, client),
    ),
    paperRegisterEntries: (memory.paperRegisterEntries ?? []).map((item: PaperRegisterEntry) =>
      backfillMeta(item, item.updatedAt ?? item.createdAt, client),
    ),
  };
}

export function applySyncMetadataToState(
  state: AppPersistedState,
  client: SyncClientConfig,
): AppPersistedState {
  const savedAt = state.savedAt ?? new Date().toISOString();

  return {
    ...state,
    version: STORAGE_VERSION,
    syncClient: client,
    syncOutbox: state.syncOutbox ?? [],
    inboxItems: state.inboxItems.map((item) =>
      backfillMeta(item, inboxFallbackUpdatedAt(item), client),
    ),
    documents: (state.documents ?? []).map((doc: CompanyDocument) =>
      backfillMeta(doc, doc.createdAt, client),
    ),
    tasks: state.tasks.map((task) => backfillMeta(task, taskFallbackUpdatedAt(task), client)),
    vorgaenge: state.vorgaenge.map((vorgang) =>
      backfillMeta(vorgang, vorgangFallbackUpdatedAt(vorgang, savedAt), client),
    ),
    expenses: (state.expenses ?? []).map((expense: Expense) =>
      backfillMeta(expense, expense.updatedAt ?? expense.createdAt, client),
    ),
    vorgangNotes: (state.vorgangNotes ?? []).map((note: VorgangNote) =>
      backfillMeta(note, note.updatedAt ?? note.createdAt, client),
    ),
    communicationHistory: (state.communicationHistory ?? []).map((event: CommunicationEvent) =>
      backfillMeta(event, event.timestamp, client),
    ),
    knowledgeFacts: (state.knowledgeFacts ?? []).map((fact: KnowledgeFact) =>
      backfillMeta(fact, fact.updatedAt ?? fact.confirmedAt ?? fact.createdAt, client),
    ),
    mailImports: (state.mailImports ?? []).map((item: MailImport) =>
      backfillMeta(item, item.updatedAt ?? item.createdAt, client),
    ),
    officePilotMemory: applySyncToMemoryState(
      state.officePilotMemory ?? {
        documentMemories: [],
        proofMemories: [],
        relations: [],
        paperRegisterEntries: [],
      },
      client,
    ),
  };
}

type PersistedStateV2 = Omit<
  AppPersistedState,
  'workspace' | 'workspaceMembers' | 'workspaceSettings' | 'setupSync' | 'companyProfileSync'
> & {
  version: typeof STORAGE_VERSION_V2;
  workspace?: undefined;
  workspaceMembers?: undefined;
  workspaceSettings?: undefined;
  setupSync?: undefined;
  companyProfileSync?: undefined;
};

export function migratePersistedStateV3ToV4(state: AppPersistedState): AppPersistedState {
  const documentFileRefs = [...(state.documentFileRefs ?? [])];
  const documentFileBlobs = { ...(state.documentFileBlobs ?? {}) };

  for (const upl of state.uploadedDocuments ?? []) {
    if (!upl.originalFileDataUrl) continue;
    const refId = `legacy-upl-${upl.id}`;
    if (documentFileRefs.some((entry) => entry.id === refId)) continue;
    const localDataKey = `legacy-blob-${upl.id}`;
    documentFileBlobs[localDataKey] = upl.originalFileDataUrl;
    documentFileRefs.push({
      id: refId,
      originalFileName: upl.fileName,
      mimeType: upl.fileType,
      fileSize: upl.fileSize,
      contentHash: '',
      storageType: 'local_data_url',
      localDataKey,
      createdAt: upl.uploadedAt,
    });
  }

  return {
    ...state,
    version: STORAGE_VERSION,
    documentFileRefs,
    documentFileBlobs,
  };
}

export function migratePersistedStateV2ToV3(state: PersistedStateV2): AppPersistedState {
  const client = ensureSyncClientFromState(state.syncClient);
  const workspaceId = client.serverWorkspaceId ?? client.workspaceId;
  const now = new Date().toISOString();

  return {
    ...state,
    version: STORAGE_VERSION_V3,
    syncClient: client,
    workspace: state.workspace,
    workspaceMembers: state.workspaceMembers ?? [],
    workspaceSettings: state.workspaceSettings,
    setupSync:
      state.setupSync ??
      createDefaultSyncMeta(now, { deviceId: client.deviceId, workspaceId }),
    companyProfileSync:
      state.companyProfileSync ??
      createDefaultSyncMeta(now, { deviceId: client.deviceId, workspaceId }),
  };
}

export function migratePersistedStateV1ToV2(state: PersistedStateV1): AppPersistedState {
  const migratedAt = new Date().toISOString();
  const client = createSyncClient(migratedAt);
  const base: AppPersistedState = {
    ...state,
    version: STORAGE_VERSION_V2,
    syncClient: client,
    syncOutbox: [],
  };
  return migratePersistedStateV3ToV4(migratePersistedStateV2ToV3(applySyncMetadataToState(base, client) as PersistedStateV2));
}

export function isValidPersistedStateV1(value: unknown): value is PersistedStateV1 {
  if (!value || typeof value !== 'object') return false;
  const state = value as PersistedStateV1;
  return (
    state.version === LEGACY_STORAGE_VERSION &&
    Array.isArray(state.inboxItems) &&
    Array.isArray(state.vorgaenge) &&
    Array.isArray(state.tasks) &&
    (Array.isArray(state.documents) || state.documents === undefined) &&
    (Array.isArray(state.expenses) || state.expenses === undefined) &&
    (Array.isArray(state.vorgangNotes) || state.vorgangNotes === undefined) &&
    (Array.isArray(state.communicationHistory) || state.communicationHistory === undefined) &&
    (Array.isArray(state.knowledgeFacts) || state.knowledgeFacts === undefined) &&
    (state.officePilotMemory === undefined ||
      (Array.isArray(state.officePilotMemory.documentMemories) &&
        Array.isArray(state.officePilotMemory.proofMemories) &&
        Array.isArray(state.officePilotMemory.relations) &&
        (state.officePilotMemory.paperRegisterEntries === undefined ||
          Array.isArray(state.officePilotMemory.paperRegisterEntries)))) &&
    typeof state.setup === 'object' &&
    state.setup !== null
  );
}

export function isValidPersistedStateV2(value: unknown): value is PersistedStateV2 {
  if (!value || typeof value !== 'object') return false;
  const state = value as PersistedStateV2;
  return (
    state.version === STORAGE_VERSION_V2 &&
    typeof state.syncClient === 'object' &&
    state.syncClient !== null &&
    typeof state.syncClient.deviceId === 'string' &&
    typeof state.syncClient.workspaceId === 'string' &&
    Array.isArray(state.syncOutbox) &&
    Array.isArray(state.inboxItems) &&
    Array.isArray(state.vorgaenge) &&
    Array.isArray(state.tasks) &&
    (Array.isArray(state.documents) || state.documents === undefined) &&
    typeof state.setup === 'object' &&
    state.setup !== null
  );
}

export function isValidPersistedStateV4(value: unknown): value is AppPersistedState {
  if (!value || typeof value !== 'object') return false;
  const state = value as AppPersistedState;
  return (
    state.version === STORAGE_VERSION &&
    typeof state.syncClient === 'object' &&
    state.syncClient !== null &&
    typeof state.syncClient.deviceId === 'string' &&
    typeof state.syncClient.workspaceId === 'string' &&
    Array.isArray(state.syncOutbox) &&
    Array.isArray(state.inboxItems) &&
    Array.isArray(state.vorgaenge) &&
    Array.isArray(state.tasks) &&
    (Array.isArray(state.documents) || state.documents === undefined) &&
    typeof state.setup === 'object' &&
    state.setup !== null
  );
}

export function isValidPersistedStateV3(value: unknown): value is AppPersistedState {
  if (!value || typeof value !== 'object') return false;
  const state = value as AppPersistedState;
  return (
    state.version === STORAGE_VERSION_V3 &&
    typeof state.syncClient === 'object' &&
    state.syncClient !== null &&
    typeof state.syncClient.deviceId === 'string' &&
    typeof state.syncClient.workspaceId === 'string' &&
    Array.isArray(state.syncOutbox) &&
    Array.isArray(state.inboxItems) &&
    Array.isArray(state.vorgaenge) &&
    Array.isArray(state.tasks) &&
    (Array.isArray(state.documents) || state.documents === undefined) &&
    typeof state.setup === 'object' &&
    state.setup !== null
  );
}
