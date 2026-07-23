import { describe, expect, it } from 'vitest';
import type { ContractConfirmationSnapshot, Vorgang } from '../../types/models';
import {
  applyOrderChainCloudInvariants,
  buildVorgangCloudContentKey,
  mergeCloudVorgangIntoLocal,
  parseVorgangCloudPayload,
  resolveVorgangStatusForCloudMerge,
  stripVorgangForCloud,
} from './vorgangCloudService';

const snapshot: ContractConfirmationSnapshot = {
  id: 'snap-02',
  confirmedAt: '2026-07-23T12:00:00.000Z',
  customer: 'Müller GmbH',
  auftraggeber: 'Müller GmbH',
  baustelle: 'Hauptstr. 1',
  title: 'Badrenovierung',
  positions: [
    {
      id: 'op-1',
      description: 'Fliesen',
      plannedQuantity: 10,
      unit: 'm²',
      unitPrice: 45,
      category: 'arbeit',
      billable: true,
    },
  ],
  negotiation: {
    notes: [],
    generalHints: [],
    priceProposals: [],
    positionProposals: [],
    drafts: [],
  },
  immutable: true,
};

function baseVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return {
    id: 'v-chain-02',
    title: 'Badrenovierung',
    customer: 'Müller GmbH',
    baustelle: 'Hauptstr. 1',
    status: 'eingegangen',
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
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
    sync: {
      updatedAt: '2026-07-01T10:00:00.000Z',
      version: 0,
      deleted: false,
      deviceId: 'dev-1',
      workspaceId: 'ws-1',
    },
    ...overrides,
  };
}

describe('CLOUD-ORDER-CHAIN-02', () => {
  it('gültiger Merge übernimmt Shell und leitet Status aus Fakten ab', () => {
    const local = baseVorgang({
      status: 'in_verhandlung',
      sync: { ...baseVorgang().sync!, version: 0 },
    });
    const cloud = stripVorgangForCloud(
      baseVorgang({
        title: 'Remote Titel',
        status: 'abgeschlossen',
        contractConfirmation: snapshot,
        executionStartedAt: '2026-07-23T14:00:00.000Z',
      }),
    );

    const { vorgang, conflict } = mergeCloudVorgangIntoLocal(
      local,
      cloud,
      2,
      '2026-07-24T10:00:00.000Z',
      false,
      'dev-1',
      'ws-1',
    );

    expect(conflict).toBe(false);
    expect(vorgang?.title).toBe('Remote Titel');
    expect(vorgang?.contractConfirmation?.id).toBe('snap-02');
    expect(vorgang?.executionStartedAt).toBe('2026-07-23T14:00:00.000Z');
    expect(vorgang?.status).toBe('in_bearbeitung');
  });

  it('ungültiger Cloud-Status wird ignoriert', () => {
    const status = resolveVorgangStatusForCloudMerge({
      localStatus: 'in_pruefung',
      contractConfirmation: undefined,
      executionStartedAt: undefined,
    });
    expect(status).toBe('in_pruefung');

    const { vorgang } = mergeCloudVorgangIntoLocal(
      baseVorgang({
        status: 'in_pruefung',
        sync: { ...baseVorgang().sync!, version: 0 },
      }),
      {
        ...stripVorgangForCloud(baseVorgang({ status: 'in_pruefung' })),
        status: 'abgeschlossen',
      },
      2,
      '2026-07-24T10:00:00.000Z',
      false,
      'dev-1',
      'ws-1',
    );

    expect(vorgang?.status).toBe('in_pruefung');
  });

  it('Snapshot hebt Status mindestens auf beauftragt', () => {
    expect(
      resolveVorgangStatusForCloudMerge({
        localStatus: 'in_verhandlung',
        contractConfirmation: snapshot,
        executionStartedAt: undefined,
      }),
    ).toBe('beauftragt');

    const { vorgang } = mergeCloudVorgangIntoLocal(
      baseVorgang({
        status: 'eingegangen',
        sync: { ...baseVorgang().sync!, version: 0 },
      }),
      stripVorgangForCloud(
        baseVorgang({
          status: 'eingegangen',
          contractConfirmation: snapshot,
        }),
      ),
      2,
      '2026-07-24T10:00:00.000Z',
      false,
      'dev-1',
      'ws-1',
    );

    expect(vorgang?.status).toBe('beauftragt');
  });

  it('executionStartedAt hebt Status mindestens auf in_bearbeitung', () => {
    expect(
      resolveVorgangStatusForCloudMerge({
        localStatus: 'beauftragt',
        contractConfirmation: snapshot,
        executionStartedAt: '2026-07-23T14:00:00.000Z',
      }),
    ).toBe('in_bearbeitung');
  });

  it('executionStartedAt ohne Snapshot wird verworfen', () => {
    const repaired = applyOrderChainCloudInvariants(
      baseVorgang({
        status: 'in_bearbeitung',
        executionStartedAt: '2026-07-23T14:00:00.000Z',
      }),
    );
    expect(repaired.executionStartedAt).toBeUndefined();
    expect(repaired.status).toBe('eingegangen');

    const { vorgang } = mergeCloudVorgangIntoLocal(
      baseVorgang({
        status: 'in_verhandlung',
        sync: { ...baseVorgang().sync!, version: 0 },
      }),
      {
        ...stripVorgangForCloud(baseVorgang({ status: 'in_bearbeitung' })),
        status: 'in_bearbeitung',
        executionStartedAt: '2026-07-23T14:00:00.000Z',
      },
      2,
      '2026-07-24T10:00:00.000Z',
      false,
      'dev-1',
      'ws-1',
    );

    expect(vorgang?.executionStartedAt).toBeUndefined();
    expect(vorgang?.status).toBe('in_verhandlung');
  });

  it('lokales abgeschlossen bleibt erhalten', () => {
    const local = baseVorgang({
      status: 'abgeschlossen',
      contractConfirmation: snapshot,
      executionStartedAt: '2026-07-20T10:00:00.000Z',
      sync: { ...baseVorgang().sync!, version: 0 },
    });
    const cloud = stripVorgangForCloud(
      baseVorgang({
        status: 'in_bearbeitung',
        contractConfirmation: snapshot,
        executionStartedAt: '2026-07-23T14:00:00.000Z',
        title: 'Cloud Titel',
      }),
    );

    const { vorgang } = mergeCloudVorgangIntoLocal(
      local,
      cloud,
      2,
      '2026-07-24T10:00:00.000Z',
      false,
      'dev-1',
      'ws-1',
    );

    expect(vorgang?.status).toBe('abgeschlossen');
    expect(vorgang?.title).toBe('Cloud Titel');
    expect(vorgang?.executionStartedAt).toBe('2026-07-20T10:00:00.000Z');
  });

  it('Legacy-Payload ohne Chain-Felder bleibt gültig', () => {
    const parsed = parseVorgangCloudPayload({
      id: 'v-legacy-02',
      title: 'Alt',
      customer: 'Kunde',
      baustelle: 'Ort',
      status: 'abgeschlossen',
      materialSource: 'unclear',
      orderPositions: [],
    });

    const { vorgang } = mergeCloudVorgangIntoLocal(
      null,
      parsed!,
      1,
      '2026-07-01T10:00:00.000Z',
      false,
      'dev-1',
      'ws-1',
    );

    expect(vorgang?.id).toBe('v-legacy-02');
    expect(vorgang?.contractConfirmation).toBeUndefined();
    expect(vorgang?.executionStartedAt).toBeUndefined();
    // Cloud status abgeschlossen ignored without facts.
    expect(vorgang?.status).toBe('eingegangen');
  });

  it('keine Regression zu CLOUD-ORDER-CHAIN-01 write-once / Content-Key', () => {
    const withSnap = baseVorgang({
      status: 'beauftragt',
      contractConfirmation: snapshot,
    });
    const withStart = baseVorgang({
      status: 'in_bearbeitung',
      contractConfirmation: snapshot,
      executionStartedAt: '2026-07-23T14:00:00.000Z',
    });
    expect(buildVorgangCloudContentKey(withSnap)).not.toBe(
      buildVorgangCloudContentKey(withStart),
    );

    const local = baseVorgang({
      status: 'beauftragt',
      contractConfirmation: snapshot,
      sync: { ...baseVorgang().sync!, version: 0 },
    });
    const cloud = stripVorgangForCloud(
      baseVorgang({
        status: 'beauftragt',
        contractConfirmation: { ...snapshot, id: 'snap-other', title: 'Other' },
      }),
    );
    const { vorgang } = mergeCloudVorgangIntoLocal(
      local,
      cloud,
      2,
      '2026-07-24T10:00:00.000Z',
      false,
      'dev-1',
      'ws-1',
    );
    expect(vorgang?.contractConfirmation?.id).toBe('snap-02');
  });
});
