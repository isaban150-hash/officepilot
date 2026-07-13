import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import {
  LEGACY_STORAGE_VERSION,
  getActiveStorageKey,
  STORAGE_VERSION,
  clearPersistedState,
  loadPersistedState,
  savePersistedState,
} from '../persistenceService';
import { resetSyncClientForTests, createSyncClient, hydrateSyncClient } from './syncClientService';
import { resetSyncOutboxForTests, getSyncOutboxSnapshot } from './syncOutboxService';
import type { AppPersistedState } from '../../types/models';

function minimalV1State(): AppPersistedState {
  return {
    version: LEGACY_STORAGE_VERSION,
    setup: { ...DEFAULT_SETUP, companyName: 'Migration GmbH' },
    inboxItems: [
      {
        id: 'inbox-1',
        title: 'Test Brief',
        documentType: 'brief',
        sender: 'Finanzamt',
        priority: 'mittel',
        deadline: null,
        recommendedAction: 'abheften',
        digitalFolder: { id: 'dig-1', name: 'Post', path: '/Post/' },
        paperFiling: { folderId: 'f1', register: 'A', label: 'Post' },
        status: 'neu',
        receivedAt: '2026-03-01T10:00:00.000Z',
        recognizedData: {},
        officePilotSuggestion: '',
        nextTaskLabel: '',
        securityHint: '',
      },
    ],
    vorgaenge: [],
    tasks: [],
    documents: [
      {
        id: 'doc-legacy-1',
        title: 'Legacy Doc',
        category: 'steuer',
        issuer: 'FA',
        recognizedText: '',
        issueDate: null,
        validUntil: null,
        digitalFolder: { id: 'dig-2', name: 'Steuer', path: '/Steuer/' },
        paperFolder: { folderId: 'f2', register: 'B', label: 'Steuer' },
        tags: [],
        linkedCompany: 'Migration GmbH',
        linkedVorgang: null,
        archived: true,
        createdAt: '2026-03-01T10:00:00.000Z',
      },
    ],
    savedAt: '2026-03-27T12:00:00.000Z',
  };
}

describe('CLOUD-01B migration v1 → v2', () => {
  beforeEach(() => {
    clearPersistedState();
    resetSyncOutboxForTests([]);
    resetSyncClientForTests();
  });

  it('migriert v1 automatisch zu v2 und persistiert', () => {
    savePersistedState(minimalV1State());

    const loaded = loadPersistedState();
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(STORAGE_VERSION);
    expect(loaded!.syncClient).toBeDefined();
    expect(loaded!.syncOutbox).toEqual([]);

    const raw = JSON.parse(localStorage.getItem(getActiveStorageKey())!);
    expect(raw.version).toBe(STORAGE_VERSION);
  });

  it('ergänzt SyncMeta auf migrierten Entities', () => {
    savePersistedState(minimalV1State());
    const loaded = loadPersistedState();

    expect(loaded!.inboxItems[0].sync).toMatchObject({
      version: 1,
      deleted: false,
    });
    expect(loaded!.documents![0].sync?.updatedAt).toBe('2026-03-01T10:00:00.000Z');
    expect(loaded!.inboxItems[0].sync?.deviceId).toBe(loaded!.syncClient!.deviceId);
    expect(loaded!.inboxItems[0].sync?.workspaceId).toBe(loaded!.syncClient!.workspaceId);
  });

  it('hält deviceId und workspaceId über Reloads stabil', () => {
    savePersistedState(minimalV1State());
    const first = loadPersistedState();
    const deviceId = first!.syncClient!.deviceId;
    const workspaceId = first!.syncClient!.workspaceId;

    const second = loadPersistedState();
    expect(second!.syncClient!.deviceId).toBe(deviceId);
    expect(second!.syncClient!.workspaceId).toBe(workspaceId);
  });

  it('behandelt unbekannte Version sauber', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(
      getActiveStorageKey(),
      JSON.stringify({
        version: 99,
        setup: DEFAULT_SETUP,
        inboxItems: [],
        vorgaenge: [],
        tasks: [],
        savedAt: '2026-01-01',
      }),
    );

    expect(loadPersistedState()).toBeNull();
    warn.mockRestore();
  });
});

describe('CLOUD-01B tombstones and outbox', () => {
  beforeEach(() => {
    clearPersistedState();
    resetSyncOutboxForTests([]);
    resetSyncClientForTests();
  });

  it('legt Tombstone statt Hard-Delete für Dokumente an', async () => {
    const { hydrateDocumentStore, deleteDocument, getDocumentStoreSnapshot } = await import(
      '../documentService'
    );
    const { hydrateMemory, getOfficePilotMemorySnapshot } = await import(
      '../officePilotMemoryService'
    );

    hydrateSyncClient(createSyncClient());
    hydrateDocumentStore([
      {
        id: 'doc-del-1',
        title: 'Löschtest',
        category: 'sonstiges',
        issuer: 'X',
        recognizedText: '',
        issueDate: null,
        validUntil: null,
        digitalFolder: { id: 'd1', name: 'X', path: '/x/' },
        paperFolder: { folderId: 'f1', register: 'A', label: 'X' },
        tags: [],
        linkedCompany: 'Test',
        linkedVorgang: null,
        archived: true,
        createdAt: '2026-03-01T10:00:00.000Z',
      },
    ]);
    hydrateMemory({
      documentMemories: [
        {
          id: 'mem-1',
          documentId: 'doc-del-1',
          title: 'Löschtest',
          issuer: 'X',
          digitalFolder: { id: 'd1', name: 'X', path: '/x/' },
          paperFolder: { folderId: 'f1', register: 'A', label: 'X' },
          validUntil: null,
          createdAt: '2026-03-01T10:00:00.000Z',
          updatedAt: '2026-03-01T10:00:00.000Z',
        },
      ],
      proofMemories: [],
      relations: [],
      paperRegisterEntries: [
        {
          id: 'paper-reg-doc-del-1',
          documentId: 'doc-del-1',
          documentTitle: 'Löschtest',
          folderId: 'f1',
          register: 'A',
          physicalFiled: false,
          createdAt: '2026-03-01T10:00:00.000Z',
          updatedAt: '2026-03-01T10:00:00.000Z',
        },
      ],
    });

    deleteDocument('doc-del-1');

    const snapshot = getDocumentStoreSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].sync?.deleted).toBe(true);

    const memory = getOfficePilotMemorySnapshot();
    expect(memory.documentMemories[0].sync?.deleted).toBe(true);
    expect(memory.paperRegisterEntries[0].sync?.deleted).toBe(true);
  });

  it('erzeugt Outbox-Einträge bei Mutationen', async () => {
    const { hydrateDocumentStore, addDocument } = await import('../documentService');

    hydrateSyncClient(createSyncClient());
    hydrateDocumentStore([]);
    const { seedSyncChangeTrackerFromCurrentStores } = await import('../persistenceService');
    seedSyncChangeTrackerFromCurrentStores();

    addDocument({ title: 'Outbox Test', category: 'vertrag' });

    const outbox = getSyncOutboxSnapshot();
    expect(outbox.length).toBeGreaterThan(0);
    const documentEntry = outbox.find((entry) => entry.entityType === 'document' && entry.operation === 'create');
    expect(documentEntry).toBeDefined();
  });
});

describe('CLOUD-01B beta guard', () => {
  it('setzt syncPolicy auf disabled im Beta-Modus', () => {
    vi.stubEnv('VITE_BETA_TEST_MODE', 'true');
    resetSyncClientForTests();
    const client = createSyncClient();
    expect(client.syncPolicy).toBe('disabled');
    vi.unstubAllEnvs();
  });
});
