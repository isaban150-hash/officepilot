/**
 * OFFICEPILOT-PREPARED-INVOICE-READER-AMENDMENT-OPTIONAL-01 — der Serververtrag zählt.
 *
 * `expectedAmendmentSequence` ist ein Finalisierungs-Guard, kein Rechnungsfeld.
 * Der Client sendet ihn zwingend, `finalize_workspace_invoice` prüft ihn gegen
 * den aktuellen Nachtragsstand — und `normalize_workspace_invoice_payload_for_idempotency`
 * entfernt ihn danach ausdrücklich aus dem gespeicherten Payload:
 *
 *   -- Strip RPC meta fields that must never become stored invoice content.
 *
 * Eine servergespeicherte Schlussrechnung **ohne** dieses Feld ist damit
 * fachlich gültig. Der Reader hat sie trotzdem verworfen — und genau daran ist
 * die reale Rechnung 2026-0003 auf einer frischen Origin gescheitert.
 *
 * Hier wird nichts normalisiert, nichts repariert und kein Standardwert
 * erfunden: Ein **vorhandener** ungültiger Wert bleibt ungültig.
 *
 * Anonymisierte Beispieldaten, keine Produktionsdaten.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateWorkspaceInvoiceCloudPayload } from './invoice/workspaceInvoiceCloudPayloadValidator';
import {
  inspectWorkspaceInvoicePullRow,
  parseWorkspaceInvoicePullRow,
} from './invoice/workspaceInvoiceCloudService';
import { buildInvoicePayloadV1 } from './invoice/workspaceInvoiceFinalizeRequestValidator';
import { mapPullRowsIsolated } from './invoice/invoiceCloudPullMergeService';
import { createEmptySyncSimulationReport } from './sync/syncSimulationReportService';
import type { InvoiceDocumentType } from '../types/models';

const WORKSPACE = '00000000-0000-4000-8000-0000000000e1';
const CLIENT_INVOICE_ID = 'inv-reader-amendment-1';

const amendmentMigration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20250724150000_workspace_order_amendment_cloud_foundation.sql',
  ),
  'utf8',
);

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

/**
 * Ein Payload in **Serverform**: genau das, was
 * `normalize_workspace_invoice_payload_for_idempotency` übrig lässt —
 * insbesondere **ohne** `expectedAmendmentSequence`.
 */
function serverPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CLIENT_INVOICE_ID,
    number: '2026-0099',
    type: 'schluss',
    status: 'vorbereitet',
    invoiceSequenceNumber: 99,
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Beispielleistung',
        quantity: 10,
        unit: 'm²',
        unitPrice: 100,
        lineTotal: 1000,
      },
    ],
    subtotal: 1000,
    taxStatus: 'reverse_charge_13b',
    amount: 1000,
    date: '2026-08-27',
    createdAt: '2026-08-27T10:00:00.000Z',
    issueDate: '2026-08-27',
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: customerSnapshot(),
    companySnapshot: companySnapshot(),
    ...overrides,
  };
}

function serverRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cloud-row-1',
    workspace_id: WORKSPACE,
    vorgang_id: 'v-reader-amendment-1',
    client_invoice_id: CLIENT_INVOICE_ID,
    invoice_number: '2026-0099',
    invoice_year: 2026,
    invoice_sequence_number: 99,
    invoice_type: 'schluss',
    invoice_status: 'vorbereitet',
    payload: serverPayload(),
    row_version: 1,
    created_at: '2026-08-27T10:00:00.000Z',
    updated_at: '2026-08-27T10:00:00.000Z',
    ...overrides,
  };
}

/** Ein Payload eines anderen Rechnungstyps, sonst identisch aufgebaut. */
function typedPayload(type: InvoiceDocumentType, amendment: unknown): Record<string, unknown> {
  return serverPayload({
    type,
    ...(type === 'abschlag' ? { abschlagNumber: 1 } : {}),
    expectedAmendmentSequence: amendment,
  });
}

describe('OFFICEPILOT-PREPARED-INVOICE-READER-AMENDMENT-OPTIONAL-01', () => {
  /* ---------------------------------------------------------------------- */
  /* Der Serververtrag                                                       */
  /* ---------------------------------------------------------------------- */

  it('A: eine Schlussrechnung ohne das Feld ist gültig', () => {
    const payload = serverPayload();
    // Die Vorbedingung des Falls: Der Schlüssel fehlt wirklich.
    expect(Object.prototype.hasOwnProperty.call(payload, 'expectedAmendmentSequence')).toBe(false);

    expect(validateWorkspaceInvoiceCloudPayload(payload).ok).toBe(true);
  });

  it('K: eine serverförmige Pull-Zeile wird gelesen und in den Merge gegeben', () => {
    const row = serverRow();

    const inspected = inspectWorkspaceInvoicePullRow(row);
    expect(inspected.ok).toBe(true);

    const parsed = parseWorkspaceInvoicePullRow(row);
    expect(parsed).not.toBeNull();
    expect(parsed?.invoice_type).toBe('schluss');
    expect(parsed?.client_invoice_id).toBe(CLIENT_INVOICE_ID);

    const report = createEmptySyncSimulationReport();
    const { mapped, invalidCount } = mapPullRowsIsolated([row], WORKSPACE, report);
    expect(invalidCount).toBe(0);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].clientInvoiceId).toBe(CLIENT_INVOICE_ID);
    // Kein erfundener Standardwert — was der Server nicht führt, bleibt leer.
    expect(mapped[0].invoice.expectedAmendmentSequence).toBeUndefined();
    expect(report.errors.filter((e) => e.outboxId === 'invoice-pull')).toEqual([]);
  });

  /* ---------------------------------------------------------------------- */
  /* Vorhandene Werte bleiben streng geprüft                                 */
  /* ---------------------------------------------------------------------- */

  it('B/C: ein vorhandener gültiger Wert bleibt gültig', () => {
    for (const value of [0, 3, 42]) {
      const result = validateWorkspaceInvoiceCloudPayload(
        serverPayload({ expectedAmendmentSequence: value }),
      );
      expect(result.ok, `Wert ${value}`).toBe(true);
    }
  });

  it('D/E/F/G: ein vorhandener ungültiger Wert wird weiterhin abgewiesen', () => {
    for (const value of [-1, 1.5, '3', null, true, {}, []]) {
      const result = validateWorkspaceInvoiceCloudPayload(
        serverPayload({ expectedAmendmentSequence: value }),
      );
      expect(result.ok, `Wert ${JSON.stringify(value)}`).toBe(false);
      if (result.ok) continue;
      expect(result.detail).toBe('payload.expectedAmendmentSequence:not_sequence');
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Andere Rechnungstypen unverändert                                       */
  /* ---------------------------------------------------------------------- */

  it('H/I/J: bei anderen Rechnungstypen bleibt das Feld unzulässig', () => {
    for (const type of ['rechnung', 'abschlag', 'teilrechnung'] as InvoiceDocumentType[]) {
      // Vorhanden — auch mit an sich gültigem Wert — bleibt ein Fehler.
      const present = validateWorkspaceInvoiceCloudPayload(typedPayload(type, 0));
      expect(present.ok, type).toBe(false);
      if (!present.ok) {
        expect(present.detail).toBe('payload.expectedAmendmentSequence:not_allowed');
      }

      // Und ohne das Feld bleiben sie gültig.
      const absent = serverPayload({
        type,
        ...(type === 'abschlag' ? { abschlagNumber: 1 } : {}),
      });
      expect(validateWorkspaceInvoiceCloudPayload(absent).ok, `${type} ohne Feld`).toBe(true);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Nichts anderes hat sich bewegt                                          */
  /* ---------------------------------------------------------------------- */

  it('L: eine tatsächlich ungültige Zeile behält ihren konkreten Grund', () => {
    const broken = serverRow({
      payload: serverPayload({
        positions: [
          {
            id: 'line-1',
            orderPositionId: 'op-1',
            description: 'Beispielleistung',
            quantity: 10,
            unit: '',
            unitPrice: 100,
            lineTotal: 1000,
          },
        ],
      }),
    });

    const inspected = inspectWorkspaceInvoicePullRow(broken);
    expect(inspected.ok).toBe(false);
    if (inspected.ok) return;
    expect(inspected.detail).toBe('payload.positions[0].unit:not_text');

    const report = createEmptySyncSimulationReport();
    mapPullRowsIsolated([broken], WORKSPACE, report);
    expect(report.errors[0]?.message).toContain('payload.positions[0].unit:not_text');
  });

  it('M: der Writer sendet das Feld für schluss weiterhin immer', () => {
    // Mit Wert: unverändert übernommen.
    const withValue = buildInvoicePayloadV1({ type: 'schluss', expectedAmendmentSequence: 3 });
    expect(withValue?.expectedAmendmentSequence).toBe(3);

    // Ohne Wert: der Writer setzt weiterhin 0 — das ist die Guard-Semantik.
    const withoutValue = buildInvoicePayloadV1({ type: 'schluss' });
    expect(withoutValue?.expectedAmendmentSequence).toBe(0);

    // Für andere Typen sendet er es weiterhin gar nicht.
    const other = buildInvoicePayloadV1({ type: 'rechnung', expectedAmendmentSequence: 3 });
    expect(other).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(other!, 'expectedAmendmentSequence')).toBe(false);
  });

  it('N: der SQL-Amendment-Guard ist unverändert', () => {
    // Der Server prüft weiterhin gegen den tatsächlichen Nachtragsstand.
    expect(amendmentMigration).toContain('select coalesce(max(a.sequence_no), 0)');
    expect(amendmentMigration).toContain(
      'if v_current_amendment_sequence is distinct from v_expected_amendment_sequence then',
    );
    expect(amendmentMigration).toContain("raise exception 'invoice_amendment_state_stale'");

    // Und er entfernt das Feld weiterhin aus dem gespeicherten Payload.
    expect(amendmentMigration).toContain("- 'expectedAmendmentSequence'");
    expect(amendmentMigration).toContain("- 'expected_amendment_sequence'");
  });
});
