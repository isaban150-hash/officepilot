import { describe, expect, it } from 'vitest';
import type { ContractConfirmationSnapshot, Vorgang } from '../../types/models';
import {
  applyOrderChainCloudInvariants,
  buildVorgangCloudContentKey,
  mergeCloudVorgangIntoLocal,
  parseVorgangCloudPayload,
  stripVorgangForCloud,
} from './vorgangCloudService';

const snapshot: ContractConfirmationSnapshot = {
  id: 'snap-cloud-1',
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
    notes: ['ok'],
    generalHints: [],
    priceProposals: [],
    positionProposals: [],
    drafts: [],
  },
  immutable: true,
};

const otherSnapshot: ContractConfirmationSnapshot = {
  ...snapshot,
  id: 'snap-cloud-2',
  confirmedAt: '2026-07-24T12:00:00.000Z',
  title: 'Anderer Stand',
};

function baseVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return {
    id: 'v-chain-1',
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

describe('CLOUD-ORDER-CHAIN-01', () => {
  it('Snapshot wird in CloudPayload synchronisiert', () => {
    const stripped = stripVorgangForCloud(
      baseVorgang({
        status: 'beauftragt',
        contractConfirmation: snapshot,
      }),
    );
    expect(stripped.contractConfirmation?.id).toBe('snap-cloud-1');
    expect(stripped.contractConfirmation?.positions).toHaveLength(1);
    expect('negotiation' in stripped).toBe(false);
    expect('invoices' in stripped).toBe(false);
  });

  it('executionStartedAt wird in CloudPayload synchronisiert', () => {
    const stripped = stripVorgangForCloud(
      baseVorgang({
        status: 'in_bearbeitung',
        contractConfirmation: snapshot,
        executionStartedAt: '2026-07-23T14:00:00.000Z',
      }),
    );
    expect(stripped.executionStartedAt).toBe('2026-07-23T14:00:00.000Z');
  });

  it('Content-Key reagiert auf Snapshot und executionStartedAt', () => {
    const base = baseVorgang({ status: 'beauftragt' });
    const withSnap = baseVorgang({
      status: 'beauftragt',
      contractConfirmation: snapshot,
    });
    const withStart = baseVorgang({
      status: 'in_bearbeitung',
      contractConfirmation: snapshot,
      executionStartedAt: '2026-07-23T14:00:00.000Z',
    });

    expect(buildVorgangCloudContentKey(base)).not.toBe(buildVorgangCloudContentKey(withSnap));
    expect(buildVorgangCloudContentKey(withSnap)).not.toBe(buildVorgangCloudContentKey(withStart));
  });

  it('Snapshot write-once: lokal vorhandenes Snapshot wird nicht überschrieben', () => {
    const local = baseVorgang({
      status: 'beauftragt',
      contractConfirmation: snapshot,
      sync: { ...baseVorgang().sync!, version: 0 },
    });
    const cloud = stripVorgangForCloud(
      baseVorgang({
        status: 'beauftragt',
        contractConfirmation: otherSnapshot,
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
    expect(vorgang?.contractConfirmation?.id).toBe('snap-cloud-1');
    expect(vorgang?.contractConfirmation?.title).toBe('Badrenovierung');
  });

  it('Snapshot: Cloud wird übernommen wenn lokal fehlt', () => {
    const local = baseVorgang({
      status: 'in_verhandlung',
      sync: { ...baseVorgang().sync!, version: 0 },
    });
    const cloud = stripVorgangForCloud(
      baseVorgang({
        status: 'beauftragt',
        contractConfirmation: snapshot,
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

    expect(vorgang?.contractConfirmation?.id).toBe('snap-cloud-1');
    expect(vorgang?.status).toBe('beauftragt');
  });

  it('executionStartedAt write-once: lokal vorhanden bleibt', () => {
    const local = baseVorgang({
      status: 'in_bearbeitung',
      contractConfirmation: snapshot,
      executionStartedAt: '2026-07-23T14:00:00.000Z',
      sync: { ...baseVorgang().sync!, version: 0 },
    });
    const cloud = stripVorgangForCloud(
      baseVorgang({
        status: 'in_bearbeitung',
        contractConfirmation: snapshot,
        executionStartedAt: '2026-07-25T09:00:00.000Z',
      }),
    );

    const { vorgang } = mergeCloudVorgangIntoLocal(
      local,
      cloud,
      2,
      '2026-07-25T10:00:00.000Z',
      false,
      'dev-1',
      'ws-1',
    );

    expect(vorgang?.executionStartedAt).toBe('2026-07-23T14:00:00.000Z');
  });

  it('executionStartedAt: Cloud wird übernommen wenn lokal fehlt', () => {
    const local = baseVorgang({
      status: 'beauftragt',
      contractConfirmation: snapshot,
      sync: { ...baseVorgang().sync!, version: 0 },
    });
    const cloud = stripVorgangForCloud(
      baseVorgang({
        status: 'in_bearbeitung',
        contractConfirmation: snapshot,
        executionStartedAt: '2026-07-23T14:00:00.000Z',
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

    expect(vorgang?.executionStartedAt).toBe('2026-07-23T14:00:00.000Z');
    expect(vorgang?.status).toBe('in_bearbeitung');
  });

  it('Invarianten: Confirmation ohne beauftragt wird angehoben', () => {
    const repaired = applyOrderChainCloudInvariants(
      baseVorgang({
        status: 'in_verhandlung',
        contractConfirmation: snapshot,
      }),
    );
    expect(repaired.status).toBe('beauftragt');
  });

  it('Invarianten: Execution-Status ohne Start wird zurückgesetzt', () => {
    const repaired = applyOrderChainCloudInvariants(
      baseVorgang({
        status: 'in_bearbeitung',
        contractConfirmation: snapshot,
      }),
    );
    expect(repaired.executionStartedAt).toBeUndefined();
    expect(repaired.status).toBe('beauftragt');
  });

  it('Alte Payloads ohne Chain-Felder funktionieren weiterhin', () => {
    const legacy = {
      id: 'v-legacy',
      title: 'Alt',
      customer: 'Kunde',
      baustelle: 'Ort',
      status: 'eingegangen' as const,
      materialSource: 'unclear' as const,
      orderPositions: [],
    };

    const parsed = parseVorgangCloudPayload(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed?.contractConfirmation).toBeUndefined();
    expect(parsed?.executionStartedAt).toBeUndefined();

    const { vorgang, conflict } = mergeCloudVorgangIntoLocal(
      null,
      parsed!,
      1,
      '2026-07-01T10:00:00.000Z',
      false,
      'dev-1',
      'ws-1',
    );

    expect(conflict).toBe(false);
    expect(vorgang?.id).toBe('v-legacy');
    expect(vorgang?.contractConfirmation).toBeUndefined();
    expect(vorgang?.invoices).toEqual([]);
  });

  it('Negotiation und Invoices bleiben lokal und unsynced', () => {
    const local = baseVorgang({
      status: 'beauftragt',
      contractConfirmation: snapshot,
      negotiation: {
        notes: ['lokal'],
        generalHints: [],
        priceProposals: [],
        positionProposals: [],
        closed: true,
      },
      invoices: [
        {
          id: 'inv-1',
          number: '2026-0001',
          type: 'rechnung',
          positions: [],
          subtotal: 100,
          taxStatus: 'standard_19',
          amount: 119,
          status: 'vorbereitet',
          date: '2026-07-01',
          createdAt: '2026-07-01T10:00:00.000Z',
        },
      ],
      sync: { ...baseVorgang().sync!, version: 0 },
    });

    const stripped = stripVorgangForCloud(local);
    expect('negotiation' in stripped).toBe(false);
    expect('invoices' in stripped).toBe(false);

    const { vorgang } = mergeCloudVorgangIntoLocal(
      local,
      stripVorgangForCloud({
        ...local,
        title: 'Remote Titel',
      }),
      2,
      '2026-07-24T10:00:00.000Z',
      false,
      'dev-1',
      'ws-1',
    );

    expect(vorgang?.title).toBe('Remote Titel');
    expect(vorgang?.negotiation?.notes).toEqual(['lokal']);
    expect(vorgang?.invoices).toHaveLength(1);
  });
});
