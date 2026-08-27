/**
 * OFFICEPILOT-INVOICE-PULL-DIAGNOSTIC-VISIBILITY-01 — der Grund darf nicht verschwinden.
 *
 * `validateWorkspaceInvoiceCloudPayload` berechnet einen exakten Grund wie
 * `payload.positions[7].unit:not_text` — und `parseWorkspaceInvoicePullRow`
 * warf ihn eine Zeile später weg. Übrig blieb im Sync-Report nur „Ungültige
 * Cloud-Rechnungszeile übersprungen." Eine reale Rechnung verschwand damit
 * spurlos zwischen Cloud und frischer Origin.
 *
 * Hier geht es ausschliesslich um **Sichtbarkeit**. Keine Regel wird gelockert,
 * kein Wert repariert, keine Entscheidung verändert: Was vorher gültig war,
 * bleibt gültig; was vorher verworfen wurde, wird weiterhin verworfen — nur
 * jetzt mit Begründung.
 *
 * Neutrale Beispieldaten, keine Produktionsdaten.
 */
import { describe, expect, it } from 'vitest';
import {
  inspectWorkspaceInvoicePullRow,
  parseWorkspaceInvoicePullRow,
} from './invoice/workspaceInvoiceCloudService';
import { mapPullRowsIsolated } from './invoice/invoiceCloudPullMergeService';
import { createEmptySyncSimulationReport } from './sync/syncSimulationReportService';

const WORKSPACE = '00000000-0000-4000-8000-0000000000d1';
const CLIENT_INVOICE_ID = 'inv-diag-1';

function companySnapshot(): Record<string, unknown> {
  return {
    companyName: 'Muster GmbH',
    legalForm: 'GmbH',
    street: 'Beispielweg 1',
    zip: '10000',
    city: 'Beispielstadt',
    country: 'Deutschland',
    contactPerson: 'M. Muster',
    phone: '',
    email: '',
    website: '',
    taxNumber: '',
    vatId: '',
    bankName: '',
    iban: '',
    bic: '',
    defaultPaymentDays: 14,
    defaultPaymentTerms: '',
    defaultSkonto: '',
    invoiceFooterNotes: '',
  };
}

function customerSnapshot(): Record<string, unknown> {
  return {
    name: 'Beispiel Projektbau GmbH',
    contactPerson: '',
    street: 'Beispielstraße 2',
    zip: '20000',
    city: 'Beispielstadt',
    email: '',
    phone: '',
  };
}

function position(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'line-1',
    orderPositionId: 'op-1',
    description: 'Dachsanierung',
    quantity: 100,
    unit: 'm²',
    unitPrice: 100,
    lineTotal: 10000,
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CLIENT_INVOICE_ID,
    number: '2026-0003',
    type: 'schluss',
    status: 'vorbereitet',
    invoiceSequenceNumber: 3,
    positions: [position()],
    subtotal: 10000,
    taxStatus: 'reverse_charge_13b',
    amount: 10000,
    date: '2026-08-27',
    createdAt: '2026-08-27T10:00:00.000Z',
    issueDate: '2026-08-27',
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: customerSnapshot(),
    companySnapshot: companySnapshot(),
    /*
     * Für `schluss` ist dieses Feld die **einzige** typabhängige Pflicht des
     * Validators. Ohne es wäre die Zeile ungültig — und genau das fiel beim
     * Schreiben dieses Tests auf, weil der neue Grund es benannt hat.
     */
    expectedAmendmentSequence: 0,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cloud-row-1',
    workspace_id: WORKSPACE,
    vorgang_id: 'v-diag-1',
    client_invoice_id: CLIENT_INVOICE_ID,
    invoice_number: '2026-0003',
    invoice_year: 2026,
    invoice_sequence_number: 3,
    invoice_type: 'schluss',
    invoice_status: 'vorbereitet',
    payload: payload(),
    row_version: 1,
    created_at: '2026-08-27T10:00:00.000Z',
    updated_at: '2026-08-27T10:00:00.000Z',
    ...overrides,
  };
}

/** Die Gründe aus dem Report — genau das, was ein Mensch später liest. */
function reportMessages(rows: unknown[]): string[] {
  const report = createEmptySyncSimulationReport();
  mapPullRowsIsolated(rows, WORKSPACE, report);
  return report.errors.filter((e) => e.outboxId === 'invoice-pull').map((e) => e.message);
}

describe('OFFICEPILOT-INVOICE-PULL-DIAGNOSTIC-VISIBILITY-01', () => {
  /* ---------------------------------------------------------------------- */
  /* Unveränderte Entscheidungen                                             */
  /* ---------------------------------------------------------------------- */

  it('A: eine gültige Zeile bleibt gültig — Feld für Feld', () => {
    const valid = row();
    const parsed = parseWorkspaceInvoicePullRow(valid);

    expect(parsed).not.toBeNull();
    expect(parsed?.client_invoice_id).toBe(CLIENT_INVOICE_ID);
    expect(parsed?.invoice_number).toBe('2026-0003');
    expect(parsed?.invoice_type).toBe('schluss');
    expect(parsed?.invoice_status).toBe('vorbereitet');
    expect(parsed?.invoice_year).toBe(2026);
    expect(parsed?.invoice_sequence_number).toBe(3);
    expect(parsed?.row_version).toBe(1);

    // Und die Untersuchung sagt dasselbe.
    const inspected = inspectWorkspaceInvoicePullRow(valid);
    expect(inspected.ok).toBe(true);

    // Kein Konflikt, kein Fehlereintrag.
    expect(reportMessages([valid])).toEqual([]);
  });

  it('B: eine ungültige Zeile bleibt ungültig und heisst weiterhin invalid_row', () => {
    const broken = row({ payload: payload({ positions: [position({ unit: '' })] }) });

    expect(parseWorkspaceInvoicePullRow(broken)).toBeNull();

    const report = createEmptySyncSimulationReport();
    const { mapped, invalidCount } = mapPullRowsIsolated([broken], WORKSPACE, report);
    expect(mapped).toHaveLength(0);
    expect(invalidCount).toBe(1);
    expect(report.conflicts[0]?.resolution).toBe('conflict');
  });

  /* ---------------------------------------------------------------------- */
  /* Der Grund überlebt                                                      */
  /* ---------------------------------------------------------------------- */

  it('C: ein falsches Positionsfeld nennt den exakten Pfad', () => {
    // Genau der Verdachtsfall aus dem Realbefund: eine Position ohne Einheit.
    const broken = row({
      payload: payload({ positions: [position(), position({ id: 'line-2', unit: '' })] }),
    });

    const inspected = inspectWorkspaceInvoicePullRow(broken);
    expect(inspected.ok).toBe(false);
    if (inspected.ok) return;
    expect(inspected.detail).toBe('payload.positions[1].unit:not_text');

    expect(reportMessages([broken])[0]).toContain('payload.positions[1].unit:not_text');
  });

  it('D: ein unbekanntes Payload-Feld nennt den exakten Pfad', () => {
    const broken = row({ payload: payload({ preparedFinalizeRequestFormatVersion: 1 }) });

    const inspected = inspectWorkspaceInvoicePullRow(broken);
    expect(inspected.ok).toBe(false);
    if (inspected.ok) return;
    expect(inspected.detail).toBe('payload.preparedFinalizeRequestFormatVersion:unknown_field');
    expect(reportMessages([broken])[0]).toContain(
      'payload.preparedFinalizeRequestFormatVersion:unknown_field',
    );
  });

  it('D2: ein unbekanntes Firmensnapshot-Feld nennt den exakten Pfad', () => {
    const broken = row({
      payload: payload({ companySnapshot: { ...companySnapshot(), xyz: 'etwas' } }),
    });

    const inspected = inspectWorkspaceInvoicePullRow(broken);
    expect(inspected.ok).toBe(false);
    if (inspected.ok) return;
    expect(inspected.detail).toBe('payload.companySnapshot.xyz:unknown_field');
  });

  it('D3: ein JSON-null in einem optionalen Feld nennt das Feld', () => {
    const broken = row({ payload: payload({ sentAt: null }) });

    const inspected = inspectWorkspaceInvoicePullRow(broken);
    expect(inspected.ok).toBe(false);
    if (inspected.ok) return;
    expect(inspected.detail).toBe('payload.sentAt:not_text');
  });

  it('D4: die typabhängige Regel der Schlussrechnung wird benannt', () => {
    /*
     * Die einzige Regel des Validators, die nur einen Rechnungstyp trifft.
     *
     * READER-AMENDMENT-OPTIONAL-01 — hier stand ursprünglich, das Feld sei bei
     * `schluss` Pflicht. Genau diese Annahme war der Fehler: Der Server
     * entfernt den Guard vertragsgemäß aus dem gespeicherten Payload. Ein
     * **fehlendes** Feld ist deshalb gültig; ein **vorhandenes**, unbrauchbares
     * bleibt ein Fehler.
     */
    const missing = row({ payload: payload({ expectedAmendmentSequence: undefined }) });
    expect(inspectWorkspaceInvoicePullRow(missing).ok).toBe(true);
    expect(reportMessages([missing])).toEqual([]);

    // Ein JSON-null ist keine Folge.
    const nulled = row({ payload: payload({ expectedAmendmentSequence: null }) });
    const inspectedNull = inspectWorkspaceInvoicePullRow(nulled);
    expect(inspectedNull.ok).toBe(false);
    if (inspectedNull.ok) return;
    expect(inspectedNull.detail).toBe('payload.expectedAmendmentSequence:not_sequence');

    // Und bei einer normalen Rechnung ist dasselbe Feld unzulässig.
    const wrongType = row({
      invoice_type: 'rechnung',
      payload: payload({ type: 'rechnung', expectedAmendmentSequence: 0 }),
    });
    const inspectedWrong = inspectWorkspaceInvoicePullRow(wrongType);
    expect(inspectedWrong.ok).toBe(false);
    if (inspectedWrong.ok) return;
    expect(inspectedWrong.detail).toBe('payload.expectedAmendmentSequence:not_allowed');
  });

  /* ---------------------------------------------------------------------- */
  /* Stufe 1 und Stufe 3 bekommen ebenfalls einen Grund                      */
  /* ---------------------------------------------------------------------- */

  it('E: ein Spaltenfehler wird konkret benannt', () => {
    for (const [broken, expected] of [
      [row({ invoice_number: ' 2026-0003' }), 'row.invoice_number:not_text'],
      [row({ invoice_year: 1999 }), 'row.invoice_year:out_of_range'],
      [row({ invoice_sequence_number: 0 }), 'row.invoice_sequence_number:not_positive_integer'],
      [row({ row_version: 0 }), 'row.row_version:not_positive_integer'],
      [row({ invoice_type: 'gibtesnicht' }), 'row.invoice_type:unknown_value'],
      [row({ invoice_status: 'gibtesnicht' }), 'row.invoice_status:unknown_value'],
      [row({ payload: 'kein objekt' }), 'row.payload:not_object'],
      [row({ client_invoice_id: '' }), 'row.client_invoice_id:not_text'],
    ] as [Record<string, unknown>, string][]) {
      const inspected = inspectWorkspaceInvoicePullRow(broken);
      expect(inspected.ok).toBe(false);
      if (inspected.ok) continue;
      expect(inspected.detail).toBe(expected);
      // Und derselbe Grund steht im Report.
      expect(reportMessages([broken])[0]).toContain(expected);
    }
  });

  it('F: ein Spalte/Payload-Widerspruch wird konkret benannt', () => {
    for (const [broken, expected] of [
      [row({ payload: payload({ id: 'inv-anders' }) }), 'mismatch.id'],
      [row({ payload: payload({ number: '2026-9999' }) }), 'mismatch.number'],
      // Ohne die Nachtragsfolge — sonst schlägt schon Stufe 2 zu, und zwar zu Recht.
      [
        row({ payload: payload({ type: 'rechnung', expectedAmendmentSequence: undefined }) }),
        'mismatch.type',
      ],
      [row({ payload: payload({ status: 'versendet' }) }), 'mismatch.status'],
      [
        row({ payload: payload({ invoiceSequenceNumber: 7 }) }),
        'mismatch.invoiceSequenceNumber',
      ],
    ] as [Record<string, unknown>, string][]) {
      const inspected = inspectWorkspaceInvoicePullRow(broken);
      expect(inspected.ok).toBe(false);
      if (inspected.ok) continue;
      expect(inspected.detail).toBe(expected);
      expect(reportMessages([broken])[0]).toContain(expected);
    }
  });

  it('F2: eine fremde Workspace-Zeile wird konkret benannt', () => {
    const foreign = row({ workspace_id: '00000000-0000-4000-8000-0000000000ff' });

    // Der Parser selbst hat damit kein Problem — der Workspace-Abgleich sitzt im Mapping.
    expect(parseWorkspaceInvoicePullRow(foreign)).not.toBeNull();
    expect(reportMessages([foreign])[0]).toContain('row.workspace_id:foreign_workspace');
  });

  /* ---------------------------------------------------------------------- */
  /* Keine Semantikänderung                                                  */
  /* ---------------------------------------------------------------------- */

  it('G: Untersuchung und Parser entscheiden über alle Fälle identisch', () => {
    const cases: Record<string, unknown>[] = [
      row(),
      row({ payload: payload({ invoiceSequenceNumber: undefined }) }),
      row({ row_version: undefined }),
      row({ payload: payload({ positions: [position({ unit: '' })] }) }),
      row({ invoice_year: 2101 }),
      row({ payload: payload({ sentAt: null }) }),
      row({ payload: payload({ companySnapshot: undefined }) }),
      row({ payload: payload({ customerSnapshot: undefined }) }),
      'kein objekt' as unknown as Record<string, unknown>,
    ];

    for (const candidate of cases) {
      const parsed = parseWorkspaceInvoicePullRow(candidate);
      const inspected = inspectWorkspaceInvoicePullRow(candidate);
      expect(inspected.ok).toBe(parsed !== null);
    }
  });

  it('G2: bislang gültige Sonderfälle bleiben gültig', () => {
    // Fehlendes `row_version` gilt weiterhin als 1.
    const withoutRowVersion = row({ row_version: undefined });
    expect(parseWorkspaceInvoicePullRow(withoutRowVersion)?.row_version).toBe(1);

    // Fehlende optionale Snapshots bleiben erlaubt.
    expect(
      parseWorkspaceInvoicePullRow(
        row({ payload: payload({ companySnapshot: undefined, customerSnapshot: undefined }) }),
      ),
    ).not.toBeNull();

    // Ein Altbeleg ohne `invoiceSequenceNumber` im Payload bleibt gültig.
    expect(
      parseWorkspaceInvoicePullRow(row({ payload: payload({ invoiceSequenceNumber: undefined }) })),
    ).not.toBeNull();
  });

  it('H: gültige und ungültige Zeilen im selben Pull werden getrennt', () => {
    const good = row();
    const bad = row({
      client_invoice_id: 'inv-diag-2',
      payload: payload({ id: 'inv-diag-2', positions: [position({ unit: '' })] }),
    });

    const report = createEmptySyncSimulationReport();
    const { mapped, invalidCount } = mapPullRowsIsolated([good, bad], WORKSPACE, report);

    expect(mapped).toHaveLength(1);
    expect(mapped[0].clientInvoiceId).toBe(CLIENT_INVOICE_ID);
    expect(invalidCount).toBe(1);

    const messages = report.errors.filter((e) => e.outboxId === 'invoice-pull');
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain('inv-diag-2');
    expect(messages[0].message).toContain('payload.positions[0].unit:not_text');
  });
});
