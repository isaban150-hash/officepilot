/**
 * FINANZ-CORE-01A (AUS-01) — die Schlussrechnung setzt die Abschläge mit
 * ihrer Umsatzsteuer ab (§ 14 Abs. 5 S. 2 UStG).
 *
 * Geprüft werden das Druckmodell und der tatsächlich gezeichnete PDF-Text.
 * Die HTML-Ansicht bleibt unverändert (ihr Snapshot ist geschützt); ihre
 * Darstellung ist im Abschlussbericht als Entscheidungspunkt benannt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFPage } from 'pdf-lib';
import type { VorgangInvoice } from '../../types/models';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgang } from '../../test/fixtures';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateDocumentStore } from '../documentService';
import { hydrateVorgangStore } from '../vorgangService';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import { generateApprovedInvoicePdf } from '../invoicePdfService';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Beispiel Betrieb GmbH',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Beispielstadt',
  iban: 'DE00 0000 0000 0000 0000 00',
};

function schlussrechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-schluss-fc01a',
    number: '2026-0043',
    type: 'schluss',
    positions: [
      { id: 'line-1', orderPositionId: 'op-test-1', description: 'Fliesenarbeiten', quantity: 10, unit: 'Stunden', unitPrice: 65, lineTotal: 650 },
    ],
    subtotal: 650,
    taxStatus: 'standard_19',
    // 773,50 brutto − 309,40 − 154,70 = 309,40
    amount: 309.4,
    status: 'vorbereitet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    servicePeriodFrom: '2026-05-01',
    servicePeriodTo: '2026-05-31',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-06-15',
    paymentTermsText: 'Zahlbar in 14 Tagen',
    skontoText: '',
    customerSnapshot: { name: 'Beispiel Kundschaft GmbH', contactPerson: '', street: 'Musterweg 1', zip: '12345', city: 'Beispielstadt', email: '', phone: '' },
    companySnapshot,
    legalNotices: [],
    previousAbschlagDeductions: [
      { invoiceId: 'inv-ab-1', invoiceNumber: '2026-0001', abschlagNumber: 1, date: '2026-04-01', subtotal: 260, amount: 309.4 },
      { invoiceId: 'inv-ab-2', invoiceNumber: '2026-0002', abschlagNumber: 2, date: '2026-05-01', subtotal: 130, amount: 154.7 },
    ],
    introText: 'Einleitung',
    closingText: 'Schluss',
    baustelle: 'Teststraße 1',
    vorgangTitle: 'Testvorgang',
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  };
}

beforeEach(() => {
  hydrateDocumentStore([]);
  hydrateCompanyProfileStore(companySnapshot);
  hydrateVorgangStore([createTestVorgang()]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AUS-01 — Netto und Umsatzsteuer der abgezogenen Abschläge', () => {
  it('M1: das Druckmodell trägt je Abschlag Netto und Steuer aus dessen eigenem Beleg', () => {
    const summary = buildInvoicePrintModelFromInvoice(schlussrechnung()).summary;
    expect(summary.deductionLines.map(({ netAmount, taxAmount, amount }) => ({ netAmount, taxAmount, amount }))).toEqual([
      { netAmount: 260, taxAmount: 49.4, amount: 309.4 },
      { netAmount: 130, taxAmount: 24.7, amount: 154.7 },
    ]);
    expect(summary.deductionsNetTotal).toBe(390);
    expect(summary.deductionsTaxTotal).toBe(74.1);
    expect(summary.deductionsTotal).toBe(464.1);
    expect(summary.amountDue).toBe(309.4);
  });

  it('M2: Altbestand ohne Netto bekommt keine erfundene Aufteilung', () => {
    const invoice = schlussrechnung({
      previousAbschlagDeductions: [
        { invoiceId: 'inv-ab-1', invoiceNumber: '2026-0001', abschlagNumber: 1, date: '2026-04-01', subtotal: undefined as never, amount: 309.4 },
      ],
      amount: 464.1,
    });
    const summary = buildInvoicePrintModelFromInvoice(invoice).summary;
    expect(summary.deductionLines[0]!.netAmount).toBeUndefined();
    expect(summary.deductionsNetTotal).toBeUndefined();
    expect(summary.deductionsTaxTotal).toBeUndefined();
  });

  it('P1: das PDF setzt jeden Abschlag mit Netto und Umsatzsteuer ab', async () => {
    const gezeichnet: string[] = [];
    const original = PDFPage.prototype.drawText;
    vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, text, options) {
      gezeichnet.push(String(text));
      return original.call(this, text, options);
    });

    const result = await generateApprovedInvoicePdf(schlussrechnung());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const text = gezeichnet.join('\n');
    expect(text).toContain('Abschlag 1 (2026-0001): -309,40 € (netto 260,00 €, USt 49,40 €)');
    expect(text).toContain('Abschlag 2 (2026-0002): -154,70 € (netto 130,00 €, USt 24,70 €)');
    expect(text).toContain('Bereits berechnet: 464,10 € (netto 390,00 €, USt 74,10 €)');
  });
});
