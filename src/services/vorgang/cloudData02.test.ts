import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState, Vorgang } from '../../types/models';
import { isSupabaseSyncAllowed, LOCAL_ONLY_SYNC_ENTITY_TYPES } from '../sync/cloudSyncAllowlist';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { resetSyncOutboxForTests, getSyncOutboxSnapshot, enqueueSyncOutbox } from '../sync/syncOutboxService';
import {
  resetSyncChangeTrackerForTests,
  resetSyncChangeTrackerFromState,
  trackPersistedChanges,
} from '../sync/syncChangeTrackerService';
import { STORAGE_VERSION } from '../sync/syncMigrationService';
import { SupabaseSyncAdapter } from '../sync/supabaseSyncAdapter';
import { generateUuid } from '../sync/syncMetaService';
import {
  buildVorgangCloudContentKey,
  buildVorgangCloudPushPayload,
  mergeCloudVorgangIntoLocal,
  mergeVorgaengeFromPull,
  stripVorgangForCloud,
} from './vorgangCloudService';
import { deleteVorgang, hydrateVorgangStore } from '../vorgangService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';

function sampleVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return {
    id: 'v-test-001',
    title: 'Badrenovierung',
    customer: 'Müller GmbH',
    baustelle: 'Hauptstr. 1',
    status: 'neu',
    materialSource: 'unclear',
    orderPositions: [
      {
        id: 'op-1',
        description: 'Fliesen',
        plannedQuantity: 10,
        unit: 'm²',
        unitPrice: 45,
      },
    ],
    documents: [{ id: 'd1', name: 'Vertrag', type: 'vertrag', date: '2026-07-01' }],
    tasks: [],
    photos: [],
    invoices: [
      {
        id: 'inv-1',
        number: '2026-0001',
        type: 'abschlag',
        positions: [],
        subtotal: 1000,
        taxStatus: 'standard_19',
        amount: 1190,
        status: 'vorbereitet',
        date: '2026-07-01',
        createdAt: '2026-07-01T10:00:00.000Z',
      },
    ],
    sync: {
      updatedAt: '2026-07-01T10:00:00.000Z',
      version: 1,
      deleted: false,
      deviceId: 'dev-1',
      workspaceId: 'ws-1',
    },
    ...overrides,
  };
}

function buildState(vorgaenge: Vorgang[]): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, serverWorkspaceId: 'ws-1', workspaceId: 'ws-1' },
    syncOutbox: [],
    setup: DEFAULT_SETUP,
    vorgaenge,
    inboxItems: [],
    tasks: [],
    documents: [],
    savedAt: '2026-07-01T10:00:00.000Z',
  };
}

describe('CLOUD-DATA-02 allowlist', () => {
  it('erlaubt vorgang und blockiert Rechnungen/Dokumente/Inbox', () => {
    expect(isSupabaseSyncAllowed('vorgang')).toBe(true);
    expect(isSupabaseSyncAllowed('document')).toBe(false);
    expect(isSupabaseSyncAllowed('inbox_item')).toBe(false);
    expect(isSupabaseSyncAllowed('expense')).toBe(false);
    expect(LOCAL_ONLY_SYNC_ENTITY_TYPES.has('vorgang')).toBe(false);
    expect(LOCAL_ONLY_SYNC_ENTITY_TYPES.has('document')).toBe(true);
  });
});

describe('CLOUD-DATA-02 vorgang cloud payload', () => {
  it('strippt Rechnungen, Dokumente, Aufgaben und Fotos', () => {
    const stripped = stripVorgangForCloud(sampleVorgang());
    expect(stripped.invoices).toBeUndefined();
    expect(stripped.orderPositions).toHaveLength(1);
    expect(stripped.title).toBe('Badrenovierung');
  });

  it('Rechnungsänderung ändert Cloud-ContentKey nicht', () => {
    const base = sampleVorgang();
    const withInvoice = sampleVorgang({
      invoices: [
        ...sampleVorgang().invoices,
        {
          id: 'inv-2',
          number: '2026-0002',
          type: 'abschlag',
          positions: [],
          subtotal: 500,
          taxStatus: 'standard_19',
          amount: 595,
          status: 'vorbereitet',
          date: '2026-07-02',
          createdAt: '2026-07-02T10:00:00.000Z',
        },
      ],
    });
    expect(buildVorgangCloudContentKey(base)).toBe(buildVorgangCloudContentKey(withInvoice));
  });

  it('Positionsänderung ändert Cloud-ContentKey', () => {
    const base = sampleVorgang();
    const changed = sampleVorgang({
      orderPositions: [{ ...base.orderPositions[0], plannedQuantity: 20 }],
    });
    expect(buildVorgangCloudContentKey(base)).not.toBe(buildVorgangCloudContentKey(changed));
  });

  it('Push-Payload markiert Delete/Tombstone', () => {
    const payload = buildVorgangCloudPushPayload(sampleVorgang(), true);
    expect(payload.deleted).toBe(true);
    expect(payload.vorgang_id).toBe('v-test-001');
  });
});

describe('CLOUD-DATA-02 merge / conflicts', () => {
  it('behält lokale Rechnungen beim Remote-Merge', () => {
    const local = sampleVorgang({ sync: { ...sampleVorgang().sync!, version: 0 } });
    const { vorgang, conflict } = mergeCloudVorgangIntoLocal(
      local,
      stripVorgangForCloud({ ...local, title: 'Remote Titel' }),
      2,
      '2026-07-02T10:00:00.000Z',
      false,
      'dev-1',
      'ws-1',
    );
    expect(conflict).toBe(false);
    expect(vorgang?.title).toBe('Remote Titel');
    expect(vorgang?.invoices).toHaveLength(1);
  });

  it('meldet Konflikt bei Versionsabweichung', () => {
    const local = sampleVorgang({ sync: { ...sampleVorgang().sync!, version: 5 } });
    const { conflict } = mergeCloudVorgangIntoLocal(
      local,
      stripVorgangForCloud({ ...local, title: 'Remote' }),
      99,
      '2026-07-02T10:00:00.000Z',
      false,
      'dev-2',
      'ws-1',
    );
    expect(conflict).toBe(true);
  });

  it('pull merge übernimmt Remote-Vorgänge wenn lokal leer', () => {
    const { vorgaenge } = mergeVorgaengeFromPull(
      [],
      [
        {
          workspace_id: 'ws-1',
          vorgang_id: 'v-remote',
          payload: stripVorgangForCloud(sampleVorgang({ id: 'v-remote' })),
          row_version: 1,
          deleted: false,
          deleted_at: null,
          updated_at: '2026-07-02T10:00:00.000Z',
          updated_by: null,
        },
      ],
      'dev-1',
      'ws-1',
    );
    expect(vorgaenge).toHaveLength(1);
    expect(vorgaenge[0].id).toBe('v-remote');
    expect(vorgaenge[0].invoices).toEqual([]);
  });
});

describe('CLOUD-DATA-02 change tracker / offline', () => {
  beforeEach(() => {
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests();
    hydrateVorgangStore([]);
  });

  it('trackt Positionsänderungen in Outbox', () => {
    const state = buildState([sampleVorgang()]);
    hydrateVorgangStore(state.vorgaenge);
    resetSyncChangeTrackerFromState(state);

    trackPersistedChanges({
      ...state,
      vorgaenge: [
        sampleVorgang({
          orderPositions: [{ ...sampleVorgang().orderPositions[0], plannedQuantity: 15 }],
          sync: { ...sampleVorgang().sync!, version: 2 },
        }),
      ],
    });

    expect(getSyncOutboxSnapshot().some((e) => e.entityType === 'vorgang')).toBe(true);
  });

  it('Rechnungsänderung erzeugt keinen Cloud-Outbox-Eintrag', () => {
    const state = buildState([sampleVorgang()]);
    hydrateVorgangStore(state.vorgaenge);
    resetSyncChangeTrackerFromState(state);

    trackPersistedChanges({
      ...state,
      vorgaenge: [
        sampleVorgang({
          invoices: [
            {
              ...sampleVorgang().invoices[0],
              amount: 1500,
            },
          ],
          sync: { ...sampleVorgang().sync!, version: 2 },
        }),
      ],
    });

    expect(getSyncOutboxSnapshot().some((e) => e.entityType === 'vorgang')).toBe(false);
  });
});

describe('CLOUD-DATA-02 tombstone / delete', () => {
  beforeEach(() => {
    resetSyncClientForTests();
    hydrateVorgangStore([sampleVorgang()]);
  });

  it('deleteVorgang setzt Tombstone', () => {
    const result = deleteVorgang('v-test-001');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.vorgang.sync?.deleted).toBe(true);
    }
  });
});

describe('CLOUD-DATA-02 SupabaseSyncAdapter', () => {
  it('bestätigt vorgang nicht wenn nicht in Allowlist-Extraktion fehlt', async () => {
    const adapter = new SupabaseSyncAdapter(null);
    const state = buildState([]);
    const result = await adapter.pushChanges({
      deviceId: 'dev',
      workspaceId: 'ws-1',
      state,
      outbox: [
        {
          id: generateUuid(),
          entityType: 'vorgang',
          entityId: 'missing',
          operation: 'create',
          version: 1,
          queuedAt: new Date().toISOString(),
          retryCount: 0,
          status: 'pending',
        },
      ],
    });
    expect(result.completedOutboxIds).toHaveLength(0);
  });

  it('lässt document-Outbox pending', async () => {
    const adapter = new SupabaseSyncAdapter(null);
    const outboxId = generateUuid();
    const state = buildState([sampleVorgang()]);
    const result = await adapter.pushChanges({
      deviceId: 'dev',
      workspaceId: 'ws-1',
      state,
      outbox: [
        {
          id: outboxId,
          entityType: 'document',
          entityId: 'doc-1',
          operation: 'create',
          version: 1,
          queuedAt: new Date().toISOString(),
          retryCount: 0,
          status: 'pending',
        },
      ],
    });
    expect(result.completedOutboxIds).not.toContain(outboxId);
  });
});

describe('CLOUD-DATA-02 bootstrap initial migration', () => {
  it('enqueued lokale Vorgänge wenn Cloud leer', () => {
    resetSyncOutboxForTests([]);
    const state = buildState([sampleVorgang()]);
    const { state: merged } = mergeRemoteWorkspacePullIntoState(state, {
      workspace: null,
      members: [],
      settings: null,
      setupPayload: null,
      setupRowVersion: 0,
      setupUpdatedAt: null,
      companyProfilePayload: null,
      companyProfileRowVersion: 0,
      companyProfileUpdatedAt: null,
      vorgaenge: [],
    });
    expect(merged.vorgaenge).toHaveLength(1);
    expect(getSyncOutboxSnapshot().some((e) => e.entityType === 'vorgang')).toBe(true);
  });
});

describe('CLOUD-DATA-02 entity extraction', () => {
  it('extrahiert vorgang aus State', () => {
    const state = buildState([sampleVorgang()]);
    const extracted = extractCloudSyncEntity(state, 'vorgang', 'v-test-001');
    expect(extracted?.entityType).toBe('vorgang');
    expect(extracted && 'entity' in extracted && extracted.entity.title).toBe('Badrenovierung');
  });
});

describe('CLOUD-DATA-02 outbox dedup', () => {
  it('dedupliziert vorgang outbox', () => {
    resetSyncOutboxForTests([]);
    enqueueSyncOutbox({ entityType: 'vorgang', entityId: 'v-1', operation: 'update', version: 1 });
    enqueueSyncOutbox({ entityType: 'vorgang', entityId: 'v-1', operation: 'update', version: 2 });
    expect(getSyncOutboxSnapshot().filter((e) => e.entityId === 'v-1')).toHaveLength(1);
  });
});
