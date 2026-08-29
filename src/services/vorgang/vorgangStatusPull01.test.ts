/**
 * VORGANG-STATUS-CLOUD-PULL-01 — der Cloud-Status muss über Geräte reisen.
 *
 * Realbefund: Client A setzt „In Prüfung", der Push schreibt
 * `payload.status = 'in_pruefung'` und hebt `row_version` auf 2. Ein frischer
 * Client zieht dieselbe Zeile, löst `customerId` korrekt auf — und zeigt
 * trotzdem wieder „Eingegangen".
 *
 * Ursache: Die Statusauflösung des Cloud-Merges kannte den Cloud-Status nicht.
 * Ohne Chain-Facts und ohne lokalen Vorgang blieb nur `eingegangen`. Betroffen
 * sind alle Status, die sich **nicht** aus Facts rekonstruieren lassen:
 * `in_pruefung` und `in_verhandlung`.
 *
 * Die bestehenden Schutzregeln bleiben unangetastet und werden hier
 * mitgeprüft: Facts und ein terminaler lokaler Zustand behalten Vorrang, und
 * die Konfliktentscheidung aus SYNC-VERSION-CONTRACT-02 fällt weiterhin vor
 * jeder Statusübernahme.
 *
 * Neutrale Beispieldaten.
 */
import { describe, expect, it } from 'vitest';
import type { ContractConfirmationSnapshot, Vorgang } from '../../types/models';
import {
  createVorgangFromCloudRow,
  mergeCloudVorgangIntoLocal,
  mergeVorgaengeFromPull,
  stripVorgangForCloud,
  type VorgangCloudPayload,
  type WorkspaceVorgangRow,
} from './vorgangCloudService';

const DEVICE = 'device-status-pull-01';
const WORKSPACE = 'ws-status-pull-01';
const UPDATED_AT = '2026-08-29T10:00:00.000Z';

const CONFIRMATION: ContractConfirmationSnapshot = {
  id: 'snap-status-pull-1',
  confirmedAt: '2026-08-20T09:00:00.000Z',
  customer: 'Beispiel Industriebau GmbH',
  auftraggeber: 'Beispiel Industriebau GmbH',
  baustelle: 'Beispielstraße 5',
  title: 'Beispielauftrag',
  positions: [
    {
      id: 'op-1',
      description: 'Beispielposition',
      plannedQuantity: 4,
      unit: 'Stk',
      unitPrice: 100,
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

function localVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return {
    id: 'v-status-pull-01',
    title: 'Beispielauftrag',
    customer: 'Beispiel Industriebau GmbH',
    baustelle: 'Beispielstraße 5',
    status: 'eingegangen',
    materialSource: 'unclear',
    orderPositions: [],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
    ...overrides,
  } as Vorgang;
}

/** Der Cloud-Payload entsteht über den produktiven Schreibpfad. */
function cloudPayloadFrom(overrides: Partial<Vorgang> = {}): VorgangCloudPayload {
  return stripVorgangForCloud(localVorgang(overrides));
}

function remoteRow(payload: VorgangCloudPayload, rowVersion: number): WorkspaceVorgangRow {
  return {
    workspace_id: WORKSPACE,
    vorgang_id: payload.id,
    payload: payload as unknown as Record<string, unknown>,
    row_version: rowVersion,
    deleted: false,
    deleted_at: null,
    updated_at: UPDATED_AT,
    updated_by: DEVICE,
  };
}

describe('VORGANG-STATUS-CLOUD-PULL-01', () => {
  it('T1 — Remote-only: in_pruefung, Version und customerId kommen an', () => {
    const payload = cloudPayloadFrom({ status: 'in_pruefung', customerId: 'cust-test' });
    // Vorbedingung: Der Schreibpfad transportiert den Status überhaupt.
    expect(payload.status).toBe('in_pruefung');

    const created = createVorgangFromCloudRow(payload, 2, UPDATED_AT, false, DEVICE, WORKSPACE);

    expect({
      status: created.status,
      version: created.sync?.version,
      customerId: created.customerId,
    }).toEqual({ status: 'in_pruefung', version: 2, customerId: 'cust-test' });
  });

  it('T2 — sauberer lokaler v1 + neuerer Remote v2 übernimmt in_pruefung', () => {
    const local = localVorgang({
      status: 'eingegangen',
      sync: { updatedAt: UPDATED_AT, version: 1, deviceId: DEVICE, workspaceId: WORKSPACE },
    });
    const payload = cloudPayloadFrom({ status: 'in_pruefung' });

    const merged = mergeCloudVorgangIntoLocal(
      local,
      payload,
      2,
      UPDATED_AT,
      false,
      DEVICE,
      WORKSPACE,
      { dirty: false },
    );

    expect({
      status: merged.vorgang.status,
      version: merged.vorgang.sync?.version,
      conflict: merged.conflict,
    }).toEqual({ status: 'in_pruefung', version: 2, conflict: false });
  });

  it('T3 — in_verhandlung reist ebenso (Remote-only und clean merge)', () => {
    const payload = cloudPayloadFrom({ status: 'in_verhandlung' });

    const created = createVorgangFromCloudRow(payload, 2, UPDATED_AT, false, DEVICE, WORKSPACE);
    expect(created.status).toBe('in_verhandlung');

    const local = localVorgang({
      status: 'eingegangen',
      sync: { updatedAt: UPDATED_AT, version: 1, deviceId: DEVICE, workspaceId: WORKSPACE },
    });
    const merged = mergeCloudVorgangIntoLocal(
      local,
      payload,
      2,
      UPDATED_AT,
      false,
      DEVICE,
      WORKSPACE,
      { dirty: false },
    );
    expect(merged.vorgang.status).toBe('in_verhandlung');
    expect(merged.conflict).toBe(false);
  });

  it('T4 — terminaler lokaler Zustand wird von schwächerem Cloud-Status nicht zurückgestuft', () => {
    /*
     * Der bestehende Schutz hängt an den Facts, nicht am Statuswort allein:
     * `abgeschlossen` bleibt erhalten, solange Bestätigung und
     * Ausführungsbeginn vorliegen. Genau diese Regel darf der Statusfix nicht
     * aufweichen.
     */
    const local = localVorgang({
      status: 'abgeschlossen',
      contractConfirmation: CONFIRMATION,
      executionStartedAt: '2026-08-21T08:00:00.000Z',
      sync: { updatedAt: UPDATED_AT, version: 1, deviceId: DEVICE, workspaceId: WORKSPACE },
    });

    for (const weak of ['eingegangen', 'in_pruefung'] as const) {
      const payload = cloudPayloadFrom({
        status: weak,
        contractConfirmation: CONFIRMATION,
        executionStartedAt: '2026-08-21T08:00:00.000Z',
      });
      const merged = mergeCloudVorgangIntoLocal(
        local,
        payload,
        2,
        UPDATED_AT,
        false,
        DEVICE,
        WORKSPACE,
        { dirty: false },
      );
      expect(merged.vorgang.status).toBe('abgeschlossen');
    }
  });

  it('T5 — Ausführungs-Facts setzen den Zustand, ein früherer Cloud-Status nicht zurück', () => {
    const local = localVorgang({
      status: 'in_bearbeitung',
      contractConfirmation: CONFIRMATION,
      executionStartedAt: '2026-08-21T08:00:00.000Z',
      sync: { updatedAt: UPDATED_AT, version: 1, deviceId: DEVICE, workspaceId: WORKSPACE },
    });
    const payload = cloudPayloadFrom({
      status: 'in_pruefung',
      contractConfirmation: CONFIRMATION,
      executionStartedAt: '2026-08-21T08:00:00.000Z',
    });

    const merged = mergeCloudVorgangIntoLocal(
      local,
      payload,
      2,
      UPDATED_AT,
      false,
      DEVICE,
      WORKSPACE,
      { dirty: false },
    );

    expect(merged.vorgang.status).toBe('in_bearbeitung');
    expect(merged.vorgang.executionStartedAt).toBe('2026-08-21T08:00:00.000Z');
  });

  it('T5b — auch ein Remote-only-Create folgt den Facts, nicht dem Cloud-Statuswort', () => {
    const payload = cloudPayloadFrom({
      status: 'in_pruefung',
      contractConfirmation: CONFIRMATION,
      executionStartedAt: '2026-08-21T08:00:00.000Z',
    });

    const created = createVorgangFromCloudRow(payload, 2, UPDATED_AT, false, DEVICE, WORKSPACE);

    // Facts bestimmen den Zustand — das Statuswort im Payload ist nachrangig.
    expect(created.status).toBe('in_bearbeitung');
  });

  it('T6 — dirty gegen neueren Remote bleibt Konflikt, der Status wird nicht übernommen', () => {
    const local = localVorgang({
      status: 'eingegangen',
      title: 'Lokal geändert',
      sync: { updatedAt: UPDATED_AT, version: 1, deviceId: DEVICE, workspaceId: WORKSPACE },
    });
    const payload = cloudPayloadFrom({ status: 'in_pruefung', title: 'Remote' });

    const merged = mergeCloudVorgangIntoLocal(
      local,
      payload,
      2,
      UPDATED_AT,
      false,
      DEVICE,
      WORKSPACE,
      { dirty: true },
    );

    expect({
      conflict: merged.conflict,
      status: merged.vorgang.status,
      title: merged.vorgang.title,
      version: merged.vorgang.sync?.version,
    }).toEqual({ conflict: true, status: 'eingegangen', title: 'Lokal geändert', version: 1 });
  });

  it('T7 — 03B: die Relation bleibt beim Create unverändert erhalten', () => {
    const payload = cloudPayloadFrom({ status: 'in_pruefung', customerId: 'cust-test' });
    const created = createVorgangFromCloudRow(payload, 2, UPDATED_AT, false, DEVICE, WORKSPACE);
    expect(created.customerId).toBe('cust-test');

    // Und eine vorhandene lokale Relation gewinnt weiterhin.
    const local = localVorgang({
      customerId: 'cust-lokal',
      sync: { updatedAt: UPDATED_AT, version: 1, deviceId: DEVICE, workspaceId: WORKSPACE },
    });
    const merged = mergeCloudVorgangIntoLocal(
      local,
      payload,
      2,
      UPDATED_AT,
      false,
      DEVICE,
      WORKSPACE,
      { dirty: false },
    );
    expect(merged.vorgang.customerId).toBe('cust-lokal');
  });

  it('T8 — die Remote-Version wird unverändert übernommen', () => {
    const payload = cloudPayloadFrom({ status: 'in_pruefung' });
    expect(
      createVorgangFromCloudRow(payload, 2, UPDATED_AT, false, DEVICE, WORKSPACE).sync?.version,
    ).toBe(2);
  });

  it('T9 — der reale Pull-Pfad eines frischen Clients liefert den Status', () => {
    /*
     * Der Weg, den Client B tatsächlich nimmt: leerer lokaler Bestand, eine
     * Remote-Zeile, keine dirty-Einträge.
     */
    const payload = cloudPayloadFrom({ status: 'in_pruefung', customerId: 'cust-test' });
    const result = mergeVorgaengeFromPull([], [remoteRow(payload, 2)], DEVICE, WORKSPACE, {
      dirtyVorgangIds: new Set<string>(),
    });

    expect(result.conflicts).toEqual([]);
    expect(result.vorgaenge).toHaveLength(1);
    expect({
      status: result.vorgaenge[0].status,
      version: result.vorgaenge[0].sync?.version,
      customerId: result.vorgaenge[0].customerId,
    }).toEqual({ status: 'in_pruefung', version: 2, customerId: 'cust-test' });
  });
});
