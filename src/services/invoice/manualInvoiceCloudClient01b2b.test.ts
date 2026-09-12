/**
 * MANUAL-INVOICE-CLOUD-MIGRATION-01B2b — die Clientseite der Rechnung ohne
 * Auftrag.
 *
 * Der Server speichert den fehlenden Auftragsbezug künftig als echtes SQL
 * `NULL`. Diese Tests halten die Gegenseite fest: Parser, Push, Merge, Intent
 * und Sync müssen `null` als **legitime freie Rechnung** lesen — und dürfen
 * `''` weiterhin ablehnen. Die Unterscheidung ist der ganze Punkt: `null`
 * bedeutet „ausdrücklich kein Auftrag", `''` bedeutet „kaputt".
 *
 * Kein Netzwerk, keine Cloud, keine Zugangsdaten. Der Supabase-Client wird als
 * schmale Antwortattrappe hereingereicht.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildWorkspaceInvoiceFinalizeInput,
  inspectWorkspaceInvoicePullRow,
  mapWorkspaceInvoicePullRowToVorgangInvoice,
  parseWorkspaceInvoicePullRow,
  rpcFinalizeWorkspaceInvoice,
  rpcFinalizePreparedWorkspaceInvoice,
  WorkspaceInvoiceCloudError,
  type MappedWorkspaceInvoicePull,
} from './workspaceInvoiceCloudService';
import { mergeCloudInvoicesIntoVorgaenge } from './invoiceCloudPullMergeService';
import {
  buildManualInvoiceFinalizeIntentKey,
  resetInvoiceFinalizeIntentsForTests,
  resolveInvoiceFinalizeIntent,
} from './invoiceFinalizeIntentService';
import { getInvoiceStoreSnapshot, hydrateInvoiceStore, resetInvoiceStore } from './invoiceStore';
import {
  buildInvoiceEntriesAfterPull,
  projectInvoiceEntriesOntoVorgaenge,
} from '../sync/supabaseSyncAdapter';
import { createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { StoredInvoiceEntry, VorgangInvoice } from '../../types/models';

const YEAR = 2026;

function freeInvoicePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'inv-free-c1',
    number: `${YEAR}-0012`,
    invoiceSequenceNumber: 12,
    type: 'rechnung',
    status: 'vorbereitet',
    date: `${YEAR}-05-04`,
    issueDate: `${YEAR}-05-04`,
    createdAt: `${YEAR}-05-04T09:00:00.000Z`,
    subtotal: 45,
    amount: 53.55,
    taxStatus: 'standard_19',
    positions: [
      {
        id: 'line-1',
        description: 'Anfahrt',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 45,
        lineTotal: 45,
      },
    ],
    ...overrides,
  };
}

/** Eine Cloud-Zeile ohne Auftragsbezug: `vorgang_id` ist echtes `null`. */
function freeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cloud-row-free-1',
    workspace_id: 'ws-1',
    vorgang_id: null,
    client_invoice_id: 'inv-free-c1',
    invoice_number: `${YEAR}-0012`,
    invoice_year: YEAR,
    invoice_sequence_number: 12,
    invoice_type: 'rechnung',
    invoice_status: 'vorbereitet',
    payload: freeInvoicePayload(),
    row_version: 1,
    created_at: `${YEAR}-05-04T09:00:00.000Z`,
    updated_at: `${YEAR}-05-04T09:00:00.000Z`,
    ...overrides,
  };
}

function mappedFree(overrides: Partial<MappedWorkspaceInvoicePull> = {}): MappedWorkspaceInvoicePull {
  const row = parseWorkspaceInvoicePullRow(freeRow());
  if (!row) throw new Error('Fixture ungültig: freie Zeile wurde nicht geparst');
  return { ...mapWorkspaceInvoicePullRowToVorgangInvoice(row), ...overrides };
}

const respond = (data: unknown) => ({ rpc: async () => ({ data, error: null }) }) as never;

describe('MANUAL-INVOICE-CLOUD-MIGRATION-01B2b — Pull-Parser', () => {
  it('S10: eine Zeile mit vorgang_id null ist gültig und trägt null weiter', () => {
    const inspected = inspectWorkspaceInvoicePullRow(freeRow());
    expect(
      inspected.ok,
      `Freie Zeile abgewiesen: ${inspected.ok ? '' : inspected.detail}`,
    ).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.row.vorgang_id, 'Der fehlende Auftrag wurde ersetzt').toBeNull();

    const mapped = mapWorkspaceInvoicePullRowToVorgangInvoice(inspected.row);
    expect(mapped.vorgangId).toBeNull();
    expect(mapped.clientInvoiceId).toBe('inv-free-c1');
    expect(mapped.invoice.number).toBe(`${YEAR}-0012`);
  });

  it('S10b: der Leerstring bleibt ungültig — null ist nicht dasselbe wie leer', () => {
    const empty = inspectWorkspaceInvoicePullRow(freeRow({ vorgang_id: '' }));
    expect(empty.ok, 'Ein leerer Vorgangsbezug wurde als freie Rechnung akzeptiert').toBe(false);
    if (!empty.ok) expect(empty.detail).toContain('vorgang_id');
  });

  it('S10c: ein falscher Typ bleibt ungültig', () => {
    for (const wrong of [42, {}, [], true]) {
      const result = inspectWorkspaceInvoicePullRow(freeRow({ vorgang_id: wrong }));
      expect(result.ok, `Typ ${JSON.stringify(wrong)} wurde akzeptiert`).toBe(false);
    }
  });

  it('S10d: der Auftragsbezug bleibt erhalten, wenn es einen gibt', () => {
    const inspected = inspectWorkspaceInvoicePullRow(freeRow({ vorgang_id: 'v-1' }));
    expect(inspected.ok).toBe(true);
    if (inspected.ok) expect(inspected.row.vorgang_id).toBe('v-1');
  });
});

describe('MANUAL-INVOICE-CLOUD-MIGRATION-01B2b — Push', () => {
  it('O: der Finalize-Input trägt den fehlenden Auftrag als null', () => {
    const invoice = { id: 'inv-free-c1', number: `${YEAR}-0012` } as unknown as VorgangInvoice;
    const input = buildWorkspaceInvoiceFinalizeInput('ws-1', null, invoice);
    expect(input.vorgangId).toBeNull();
    expect(input.clientInvoiceId).toBe('inv-free-c1');
  });

  it('P: der Legacy-RPC sendet null und akzeptiert die null-Antwort', async () => {
    const result = await rpcFinalizeWorkspaceInvoice(
      {
        workspaceId: 'ws-1',
        vorgangId: null,
        clientInvoiceId: 'inv-free-c1',
        invoice: freeInvoicePayload() as unknown as VorgangInvoice,
      },
      respond({
        idempotent_replay: false,
        invoice: freeInvoicePayload(),
        row: freeRow(),
      }),
    );
    expect(result.invoice.id).toBe('inv-free-c1');
  });

  it('P2: der Legacy-RPC lehnt den Leerstring weiterhin ab', async () => {
    await expect(
      rpcFinalizeWorkspaceInvoice(
        {
          workspaceId: 'ws-1',
          vorgangId: '   ',
          clientInvoiceId: 'inv-free-c1',
          invoice: freeInvoicePayload() as unknown as VorgangInvoice,
        },
        respond({ idempotent_replay: false, invoice: freeInvoicePayload(), row: freeRow() }),
      ),
    ).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
  });

  it('P3: die Nachbedingung vergleicht NULL-sicher — eine fremde Zuordnung fällt auf', async () => {
    /*
     * Ohne IS-DISTINCT-FROM-Semantik verglich `null !== 'v-9'` zwar richtig,
     * aber `null !== null` wäre bei einem Wechsel auf lose Gleichheit still
     * durchgegangen. Beide Richtungen werden geprüft.
     */
    await expect(
      rpcFinalizePreparedWorkspaceInvoice(
        {
          workspaceId: 'ws-1',
          vorgangId: null,
          clientInvoiceId: 'inv-free-c1',
          invoicePayload: freeInvoicePayload(),
        },
        respond({
          idempotent_replay: false,
          invoice: freeInvoicePayload(),
          row: freeRow({ vorgang_id: 'v-9' }),
        }),
      ),
      'Eine Cloud-Zeile mit fremdem Vorgang wurde als freie Rechnung akzeptiert',
    ).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
  });

  it('P4: der Prepared-RPC akzeptiert die stimmige freie Antwort', async () => {
    const result = await rpcFinalizePreparedWorkspaceInvoice(
      {
        workspaceId: 'ws-1',
        vorgangId: null,
        clientInvoiceId: 'inv-free-c1',
        invoicePayload: freeInvoicePayload(),
      },
      respond({
        idempotent_replay: false,
        invoice: freeInvoicePayload(),
        row: freeRow(),
      }),
    );
    expect(result.rawRow.vorgang_id).toBeNull();
    expect(result.idempotentReplay).toBe(false);
  });
});

describe('MANUAL-INVOICE-CLOUD-MIGRATION-01B2b — Pull-Merge', () => {
  beforeEach(() => {
    resetTestStores();
    resetInvoiceStore();
    resetInvoiceFinalizeIntentsForTests();
  });

  it('S11: eine freie Cloud-Rechnung ist keine Waise', () => {
    const merge = mergeCloudInvoicesIntoVorgaenge(
      [createTestVorgang({ id: 'v-1' })],
      [mappedFree()],
      { workspaceId: 'ws-1', reconcileIntents: false },
    );

    expect(
      merge.conflicts.map((c) => c.reason),
      'Die freie Rechnung wurde als Konflikt gemeldet',
    ).toEqual([]);
    expect(merge.manualInvoices.map((i) => i.id)).toEqual(['inv-free-c1']);
    expect(merge.insertedCount).toBe(1);
    // Kein Vorgang wurde erfunden und keiner verändert.
    expect(merge.vorgaenge).toHaveLength(1);
    expect(merge.vorgaenge[0]!.invoices ?? []).toEqual([]);
  });

  it('S11b: der Wiederholungslauf desselben Pulls erzeugt keinen zweiten Beleg', () => {
    const first = mergeCloudInvoicesIntoVorgaenge([], [mappedFree()], {
      workspaceId: 'ws-1',
      reconcileIntents: false,
    });
    hydrateInvoiceStore(
      first.manualInvoices.map<StoredInvoiceEntry>((invoice) => ({ invoice, vorgangId: null })),
    );

    const second = mergeCloudInvoicesIntoVorgaenge([], [mappedFree()], {
      workspaceId: 'ws-1',
      reconcileIntents: false,
    });
    expect(second.conflicts).toEqual([]);
    expect(second.noopCount).toBe(1);
    expect(second.insertedCount).toBe(0);
  });

  it('S11c: eine lokal auftragsgebundene Kennung wird nicht still gelöst', () => {
    hydrateInvoiceStore([
      {
        invoice: { ...mappedFree().invoice },
        vorgangId: 'v-1',
      },
    ]);

    const merge = mergeCloudInvoicesIntoVorgaenge([createTestVorgang({ id: 'v-1' })], [mappedFree()], {
      workspaceId: 'ws-1',
      reconcileIntents: false,
    });

    expect(merge.manualInvoices).toEqual([]);
    expect(merge.conflicts.map((c) => c.reason)).toEqual(['number_id_conflict']);
  });

  it('S11d: eine auftragsgebundene Cloud-Rechnung ohne lokalen Vorgang bleibt Waise', () => {
    const merge = mergeCloudInvoicesIntoVorgaenge(
      [],
      [{ ...mappedFree(), vorgangId: 'v-fehlt' }],
      { workspaceId: 'ws-1', reconcileIntents: false },
    );
    expect(merge.conflicts.map((c) => c.reason)).toEqual(['orphan']);
    expect(merge.manualInvoices, 'Eine Auftragsrechnung wurde zur freien Rechnung').toEqual([]);
  });

  it('S11e: die Fremd-Workspace-Grenze gilt auch für freie Rechnungen', () => {
    const merge = mergeCloudInvoicesIntoVorgaenge(
      [],
      [{ ...mappedFree(), workspaceId: 'ws-fremd' }],
      { workspaceId: 'ws-1', reconcileIntents: false },
    );
    expect(merge.conflicts.map((c) => c.reason)).toEqual(['orphan']);
    expect(merge.manualInvoices).toEqual([]);
  });
});

describe('MANUAL-INVOICE-CLOUD-MIGRATION-01B2b — Intent', () => {
  beforeEach(() => {
    resetTestStores();
    resetInvoiceFinalizeIntentsForTests();
  });

  it('R: derselbe freie Entwurf bekommt beim Wiederholen denselben Beleg', () => {
    const key = buildManualInvoiceFinalizeIntentKey('draft-1');
    const first = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: key,
      contentFingerprint: 'fp-a',
    });
    const second = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: key,
      contentFingerprint: 'fp-a',
    });
    expect(second.clientInvoiceId).toBe(first.clientInvoiceId);
  });

  it('R2: zwei verschiedene freie Entwürfe bekommen verschiedene Belege', () => {
    const a = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: buildManualInvoiceFinalizeIntentKey('draft-1'),
      contentFingerprint: 'fp-a',
    });
    const b = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: buildManualInvoiceFinalizeIntentKey('draft-2'),
      contentFingerprint: 'fp-b',
    });
    expect(b.clientInvoiceId).not.toBe(a.clientInvoiceId);
  });

  it('R3: ein freier Entwurf kollidiert nicht mit einem gleichnamigen Vorgang', () => {
    const vorgang = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: 'draft-1',
      contentFingerprint: 'fp-a',
    });
    const frei = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: buildManualInvoiceFinalizeIntentKey('draft-1'),
      contentFingerprint: 'fp-a',
    });
    expect(frei.clientInvoiceId).not.toBe(vorgang.clientInvoiceId);
    expect(buildManualInvoiceFinalizeIntentKey('draft-1')).not.toBe('draft-1');
  });
});

describe('MANUAL-INVOICE-CLOUD-MIGRATION-01B2b — Sync-Push', () => {
  beforeEach(() => {
    resetTestStores();
    resetInvoiceStore();
  });

  it('U: die freie Rechnung wird keinem Vorgang untergeschoben', () => {
    /*
     * `projectInvoiceEntriesOntoVorgaenge` spiegelt den lokalen Stand vor dem
     * Pull an die Vorgänge. Eine freie Rechnung hat dort nichts zu suchen —
     * das bleibt so, auch nachdem der Push sie nicht mehr überspringt.
     */
    const entries: StoredInvoiceEntry[] = [
      { invoice: mappedFree().invoice, vorgangId: null },
      { invoice: { ...mappedFree().invoice, id: 'inv-order-1' }, vorgangId: 'v-1' },
    ];
    const projiziert = projectInvoiceEntriesOntoVorgaenge(
      [createTestVorgang({ id: 'v-1' })],
      entries,
    );
    expect(projiziert[0]!.invoices!.map((i) => i.id)).toEqual(['inv-order-1']);
  });

  it('U2: der Rechnungsspeicher behält den freien Eintrag mit null', () => {
    hydrateInvoiceStore([{ invoice: mappedFree().invoice, vorgangId: null }]);
    expect(getInvoiceStoreSnapshot()[0]!.vorgangId).toBeNull();
  });

  it('U3: die gezogene freie Rechnung erreicht den Endzustand des Pulls', () => {
    /*
     * Der Merge persistiert nicht. Ohne diese Übergabe läge die freie Rechnung
     * gemergt im Speicher und fiele beim Schreiben des Endzustands wieder
     * heraus — derselbe Fehler, den INVOICE-CLOUD-PULL-STORE-01B für die
     * auftragsgebundenen Rechnungen korrigiert hat.
     */
    const frei = mappedFree().invoice;
    const eintraege = buildInvoiceEntriesAfterPull([], [], [frei]);
    expect(eintraege).toHaveLength(1);
    expect(eintraege[0]!.vorgangId).toBeNull();
    expect(eintraege[0]!.invoice.id).toBe('inv-free-c1');
  });

  it('U4: ein lokaler Beleg, den der Pull nicht kennt, überlebt', () => {
    const frei = mappedFree().invoice;
    const lokal: StoredInvoiceEntry = {
      invoice: { ...frei, id: 'inv-nur-lokal' },
      vorgangId: null,
    };
    const eintraege = buildInvoiceEntriesAfterPull([], [lokal], [frei]);
    expect(eintraege.map((e) => e.invoice.id).sort()).toEqual(['inv-free-c1', 'inv-nur-lokal']);
  });
});
