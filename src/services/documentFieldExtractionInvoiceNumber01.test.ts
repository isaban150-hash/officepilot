/**
 * EXPENSE-IDENTIFIER-COMPLETENESS-01 — Teil B.
 *
 * `INVOICE_NUMBER_PATTERN` verlangte den Stamm unmittelbar vor `nr`/`nummer`.
 * Die im Deutschen üblichen getrennten Schreibweisen (`Rechnungs-Nr.`,
 * `Beleg Nr.`) blieben dadurch unerkannt, obwohl `RECEIPT_NUMBER_PATTERN` die
 * Konvention `beleg[\s-]*nr\.?` im selben Repository bereits verwendet.
 */
import { describe, expect, it } from 'vitest';
import { extractFieldsWithConfidence } from './documentFieldExtractionService';

function invoiceNumberOf(text: string): string | undefined {
  return extractFieldsWithConfidence(text).Rechnungsnummer?.value;
}

describe('EXPENSE-IDENTIFIER-COMPLETENESS-01 — getrennte Nummernschreibweisen', () => {
  it('D: Rechnungs-Nr. R-100', () => {
    expect(invoiceNumberOf('Rechnungs-Nr. R-100')).toBe('R-100');
  });

  it('E: Rechnungs Nr. R-100', () => {
    expect(invoiceNumberOf('Rechnungs Nr. R-100')).toBe('R-100');
  });

  it('F: Beleg-Nr. TEST-000184', () => {
    expect(invoiceNumberOf('Beleg-Nr. TEST-000184')).toBe('TEST-000184');
  });

  it('G: Beleg Nr. TEST-000184', () => {
    expect(invoiceNumberOf('Beleg Nr. TEST-000184')).toBe('TEST-000184');
  });

  it('H: die bereits erkannten kompakten Formen bleiben unverändert', () => {
    expect(invoiceNumberOf('Rechnungsnummer: R-100')).toBe('R-100');
    expect(invoiceNumberOf('Rechnungsnr. R-100')).toBe('R-100');
    expect(invoiceNumberOf('Belegnummer: TEST-000184')).toBe('TEST-000184');
    expect(invoiceNumberOf('BelegNr TEST-000184')).toBe('TEST-000184');
    expect(invoiceNumberOf('Invoice No. INV-2026-77')).toBe('INV-2026-77');
    expect(invoiceNumberOf('Invoice INV-2026-77')).toBe('INV-2026-77');
  });

  it('I: Bon-Nr. bleibt ausdrücklich außerhalb des Scopes', () => {
    expect(invoiceNumberOf('Bon-Nr. 4711')).toBeUndefined();
  });

  it('J: ohne jede Nummer wird keine erfunden', () => {
    const text = [
      'ARAL Tankstelle München',
      'Musterweg 1',
      '80331 München',
      'Betrag: 70,51 EUR',
      'Vielen Dank für Ihren Einkauf',
    ].join('\n');

    expect(invoiceNumberOf(text)).toBeUndefined();
    expect(invoiceNumberOf('')).toBeUndefined();
    expect(invoiceNumberOf('Rechnungs-Nr.')).toBeUndefined();
  });

  it('K: der getrennte Treffer verhält sich wie ein kompakter — Wert ohne Label', () => {
    const text = [
      'Baustoff Müller GmbH',
      'Rechnungs-Nr. R-2026-77',
      'Datum: 12.03.2026',
      'Gesamtbetrag 1.247,80 EUR',
    ].join('\n');

    expect(invoiceNumberOf(text)).toBe('R-2026-77');
    expect(extractFieldsWithConfidence(text).Rechnungsnummer?.confidence).toBe('high');
  });
});
