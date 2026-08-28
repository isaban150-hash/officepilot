/**
 * OFFICEPILOT-ZERO-VALUE-GUARD-01 — keine Rechnung ohne Leistungswert.
 *
 * `no_positions` fängt den häufigsten Fall: keine abrechenbare Position mit
 * Menge > 0. Es fängt aber **nicht** den Fall, dass es sie gibt und ihr Wert
 * trotzdem 0 € beträgt — Menge 1, Einzelpreis 0. Eine solche Rechnung war bis
 * hierher freigabefähig.
 *
 * Der neue Guard rechnet ausschliesslich über **abrechenbare** Positionen.
 * Damit hängt er nicht an der impliziten Invariante
 * `billable === false ⟹ quantity === 0`, die bei einem wiederhergestellten
 * Entwurf nicht zugesichert ist.
 *
 * **Ausdrücklich nicht betroffen:** eine echte Schlussrechnung, deren
 * Restzahlbetrag nach vollen Abschlagsabzügen 0,00 € ist. Sie hat eine
 * Leistung > 0 und bleibt gültig — der Guard sieht den Restbetrag gar nicht an.
 *
 * Neutrale Beispieldaten.
 */
import { describe, expect, it } from 'vitest';
import { validateInvoiceDraftForApproval } from './invoiceValidationService';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import type { InvoiceDraft, InvoiceDraftPosition, Vorgang } from '../types/models';

const VORGANG_ID = 'v-zero-value';

function vorgang(): Vorgang {
  return createTestVorgang({
    id: VORGANG_ID,
    orderPositions: [
      createOrderPosition({ id: 'op-1', unit: 'Stunden', plannedQuantity: 10, unitPrice: 65 }),
    ],
  });
}

function position(overrides: Partial<InvoiceDraftPosition> = {}): InvoiceDraftPosition {
  return {
    id: 'draft-pos-1',
    orderPositionId: 'op-1',
    description: 'Montage',
    plannedQuantity: 10,
    billedQuantity: 0,
    openQuantity: 10,
    quantity: 1,
    unit: 'Stunden',
    unitPrice: 65,
    billable: true,
    ...overrides,
  };
}

function draft(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  return {
    id: 'draft-zero-1',
    vorgangId: VORGANG_ID,
    vorgangTitle: 'Testvorgang',
    customer: 'Beispiel Projektbau GmbH',
    baustelle: 'Beispielweg 1',
    type: 'rechnung',
    taxStatus: 'standard_19',
    materialSource: 'betrieb',
    positions: [position()],
    issueDate: '2026-08-28',
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-28',
    paymentDueDate: '2099-12-31',
    paymentTermsText: 'Zahlbar innerhalb 14 Tagen',
    skontoText: '',
    customerBilling: {
      name: 'Beispiel Projektbau GmbH',
      contactPerson: '',
      street: 'Beispielstraße 2',
      zip: '20000',
      city: 'Beispielstadt',
      email: '',
      phone: '',
    },
    companySnapshot: {
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Muster GmbH',
      street: 'Musterallee 5',
      zip: '30000',
      city: 'Musterstadt',
    },
    legalNotices: [],
    previousAbschlagDeductions: [],
    invoiceNumberPreview: 'Entwurf',
    introText: '',
    closingText: '',
    ...overrides,
  } as InvoiceDraft;
}

function codes(input: InvoiceDraft): string[] {
  return validateInvoiceDraftForApproval(
    input,
    input.companySnapshot,
    vorgang(),
    { reverseCharge13bConfirmed: true },
  ).blockingErrors.map((issue) => issue.code);
}

describe('OFFICEPILOT-ZERO-VALUE-GUARD-01', () => {
  /* ---------------------------------------------------------------------- */
  /* Der neue Fall                                                           */
  /* ---------------------------------------------------------------------- */

  it('C: abrechenbare Menge 1 zum Preis 0 wird abgewiesen', () => {
    const result = codes(draft({ positions: [position({ unitPrice: 0 })] }));
    expect(result).toContain('zero_billable_value');
    // Es gibt sehr wohl eine aktive Position — der andere Fehler wäre falsch.
    expect(result).not.toContain('no_positions');
  });

  it('D: mehrere abrechenbare Positionen mit Gesamtwert 0 werden abgewiesen', () => {
    const result = codes(
      draft({
        positions: [
          position({ id: 'draft-pos-1', unitPrice: 0 }),
          position({ id: 'draft-pos-2', quantity: 5, unitPrice: 0 }),
        ],
      }),
    );
    expect(result).toContain('zero_billable_value');
  });

  it('E: ein inkonsistenter Entwurf wird sicher abgewiesen', () => {
    /*
     * Der entscheidende Fall: Die nicht abrechenbare Position trägt 500 € und
     * würde das gewöhnliche `subtotal` fälschlich positiv machen. Der Guard
     * rechnet nur über abrechenbare Positionen und kommt auf 0.
     */
    const result = codes(
      draft({
        positions: [
          position({ id: 'draft-pos-1', quantity: 1, unitPrice: 0, billable: true }),
          position({ id: 'draft-pos-2', quantity: 1, unitPrice: 500, billable: false }),
        ],
      }),
    );
    expect(result).toContain('zero_billable_value');
  });

  /* ---------------------------------------------------------------------- */
  /* Bestehende Fehler bleiben unverändert                                   */
  /* ---------------------------------------------------------------------- */

  it('A: ohne Positionen bleibt es bei no_positions', () => {
    const result = codes(draft({ positions: [] }));
    expect(result).toContain('no_positions');
    expect(result).not.toContain('zero_billable_value');
  });

  it('B: bei ausschliesslich Menge 0 bleibt es bei no_positions', () => {
    const result = codes(draft({ positions: [position({ quantity: 0 })] }));
    expect(result).toContain('no_positions');
    expect(result).not.toContain('zero_billable_value');
  });

  it('J: ein pauschaler Abschlag über 0 € bleibt fixed_amount_net', () => {
    const result = codes(
      draft({
        type: 'abschlag',
        abschlagNumber: 1,
        calculationMode: 'fixed_amount',
        fixedAmountNet: 0,
        positions: [position({ quantity: 0 })],
      }),
    );
    expect(result).toContain('fixed_amount_net');
    expect(result).not.toContain('zero_billable_value');
  });

  /* ---------------------------------------------------------------------- */
  /* Legitime Rechnungen bleiben zulässig                                    */
  /* ---------------------------------------------------------------------- */

  it('F/G/H: positive mengenbasierte Rechnungen bleiben zulässig', () => {
    for (const type of ['rechnung', 'teilrechnung', 'abschlag'] as InvoiceDraft['type'][]) {
      const result = codes(
        draft({
          type,
          ...(type === 'abschlag' ? { abschlagNumber: 1, calculationMode: 'quantity_based' } : {}),
        }),
      );
      expect(result, type).not.toContain('zero_billable_value');
      expect(result, type).not.toContain('no_positions');
    }
  });

  it('I: ein pauschaler Abschlag über 0 € bleibt zulässig', () => {
    const result = codes(
      draft({
        type: 'abschlag',
        abschlagNumber: 1,
        calculationMode: 'fixed_amount',
        fixedAmountNet: 2500,
        positions: [position({ quantity: 0 })],
      }),
    );
    expect(result).not.toContain('zero_billable_value');
    expect(result).not.toContain('fixed_amount_net');
  });

  it('K: eine Schlussrechnung mit Leistung > 0 und Restzahlung 0 bleibt zulässig', () => {
    /*
     * Der Pflichtfall: Die Abschläge decken die gesamte Forderung, der
     * Restzahlbetrag ist exakt 0,00 €. Der Beleg ist gültig — der Guard darf
     * den Restbetrag nicht zur Entscheidung heranziehen.
     */
    const gross = 65 * 10 * 1.19;
    const result = codes(
      draft({
        type: 'schluss',
        positions: [position({ quantity: 10 })],
        previousAbschlagDeductions: [
          {
            invoiceId: 'inv-abschlag-1',
            invoiceNumber: '2026-0001',
            abschlagNumber: 1,
            date: '2026-08-01',
            subtotal: 650,
            amount: gross,
          },
        ],
      }),
    );
    expect(result).not.toContain('zero_billable_value');
    expect(result).not.toContain('no_positions');
    expect(result).not.toContain('totals_negative');
  });

  it('L: eine überzahlte Schlussrechnung verhält sich unverändert', () => {
    const result = codes(
      draft({
        type: 'schluss',
        positions: [position({ quantity: 10 })],
        previousAbschlagDeductions: [
          {
            invoiceId: 'inv-abschlag-1',
            invoiceNumber: '2026-0001',
            abschlagNumber: 1,
            date: '2026-08-01',
            subtotal: 650,
            amount: 99999,
          },
        ],
      }),
    );
    // Bestehendes Verhalten: `totals_negative` gilt nur für `rechnung`.
    expect(result).not.toContain('totals_negative');
    expect(result).not.toContain('zero_billable_value');
  });
});
