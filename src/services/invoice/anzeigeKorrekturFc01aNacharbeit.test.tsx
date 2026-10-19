/**
 * FC01A-Nacharbeit — Darstellung (aus der Fachprüfung, alle im Client):
 *
 *  A7  Zahlungsübersicht: Ein fristgerecht mit Skonto ausgeglichener Beleg zeigte „Gesamtbetrag
 *      476 / Bezahlt 466,48 / Offen 0" ohne Erklärung der Differenz; bei einer Schlussrechnung hieß
 *      der Restbetrag „Gesamtbetrag". Jetzt: Skontozeile und „Restbetrag nach Abschlägen".
 *  A8  Korrekturbeleg einer Schlussrechnung: Das PDF druckte „Bereits berechnet: -464,10 €" unter
 *      Abzugszeilen mit „+"; Netto und USt der Abzugssumme fielen weg. Jetzt dasselbe „+" und die
 *      Netto/USt-Angabe wie an den Zeilen. Der Originalbeleg bleibt unverändert.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFPage } from 'pdf-lib';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InvoicePayment, VorgangInvoice } from '../../types/models';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgang } from '../../test/fixtures';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateDocumentStore } from '../documentService';
import { hydrateVorgangStore } from '../vorgangService';
import { generateApprovedInvoicePdf, generateInvoiceCorrectionPdf } from '../invoicePdfService';
import { buildInvoiceCorrectionModel } from './invoiceCorrectionModel';
import { InvoicePaymentSummary } from '../../components/invoice/InvoicePaymentSummary';
import { t } from '../../i18n';
import { alsInhaber } from '../../test/workspaceRoleTestUtils';

// SYS-04 (systemische Gesamtnacharbeit): Bei eingerichteter Cloud gibt eine unbekannte Sitzung keine Rechnung mehr aus.
// Diese Tests prüfen Inhalte der Ausgabe und laufen deshalb ausdrücklich als Inhaber (auch nach restoreAllMocks).
beforeEach(() => alsInhaber());

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
    id: 'inv-schluss-nach',
    number: '2026-0043',
    type: 'schluss',
    positions: [
      { id: 'line-1', orderPositionId: 'op-test-1', description: 'Fliesenarbeiten', quantity: 10, unit: 'Stunden', unitPrice: 65, lineTotal: 650 },
    ],
    subtotal: 650,
    taxStatus: 'standard_19',
    // 773,50 brutto − 309,40 − 154,70 = 309,40
    amount: 309.4,
    status: 'versendet',
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

const KORREKTUR = {
  cancellationKind: 'correction' as const,
  cancelledAt: '2026-06-10T09:00:00.000Z',
  cancelReason: 'Leistung falsch berechnet',
};

function gezeichneterText(): { text: () => string } {
  const gezeichnet: string[] = [];
  const original = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, text, options) {
    gezeichnet.push(String(text));
    return original.call(this, text, options);
  });
  return { text: () => gezeichnet.join('\n') };
}

beforeEach(() => {
  hydrateDocumentStore([]);
  hydrateCompanyProfileStore(companySnapshot);
  hydrateVorgangStore([createTestVorgang()]);
});

afterEach(() => {
  (vi.restoreAllMocks(), alsInhaber());
});

describe('FC01A-Nacharbeit A8 — Korrekturbeleg einer Schlussrechnung', () => {
  it('K1: das Korrekturmodell trägt Netto und USt der Abzugssumme wie an den Zeilen', () => {
    const summary = buildInvoiceCorrectionModel(schlussrechnung(KORREKTUR), {
      cancelledAt: KORREKTUR.cancelledAt,
      cancelReason: KORREKTUR.cancelReason,
    }).summary;
    expect(summary.deductionsTotal).toBe(-464.1);
    expect(summary.deductionLines.map(({ amount, netAmount, taxAmount }) => ({ amount, netAmount, taxAmount }))).toEqual([
      { amount: -309.4, netAmount: 260, taxAmount: 49.4 },
      { amount: -154.7, netAmount: 130, taxAmount: 24.7 },
    ]);
    expect(summary.deductionsNetTotal).toBe(390);
    expect(summary.deductionsTaxTotal).toBe(74.1);
  });

  it('K2: das Korrektur-PDF druckt die Summe mit „+" wie die Zeilen; das Original bleibt unverändert', async () => {
    const korrektur = gezeichneterText();
    const result = await generateInvoiceCorrectionPdf(schlussrechnung(KORREKTUR));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(korrektur.text()).toContain('Abschlag 1 (2026-0001): +309,40 € (netto 260,00 €, USt 49,40 €)');
    expect(korrektur.text()).toContain('Bereits berechnet: +464,10 € (netto 390,00 €, USt 74,10 €)');
    expect(korrektur.text()).not.toContain('Bereits berechnet: -464,10 €');
    (vi.restoreAllMocks(), alsInhaber());

    const original = gezeichneterText();
    const originalResult = await generateApprovedInvoicePdf(schlussrechnung());
    expect(originalResult.ok, JSON.stringify(originalResult)).toBe(true);
    expect(original.text()).toContain('Bereits berechnet: 464,10 € (netto 390,00 €, USt 74,10 €)');
  });
});

describe('FC01A-Nacharbeit A7 — Zahlungsübersicht', () => {
  const translate = (key: string) => t(key as never);
  const zahlung = (amount: number, date: string): InvoicePayment => ({ id: `p-${amount}`, amount, date, createdAt: `${date}T10:00:00.000Z` });
  const abschlag = (payments: InvoicePayment[]): VorgangInvoice =>
    schlussrechnung({
      id: 'inv-ab-skonto',
      number: '2026-0017',
      type: 'abschlag',
      calculationMode: 'fixed_amount',
      fixedAmountNet: 400,
      positions: [],
      subtotal: 400,
      amount: 476,
      date: '2026-09-01',
      issueDate: '2026-09-01',
      paymentDueDate: '2026-10-01',
      skontoText: '2 % Skonto bei Zahlung innerhalb von 10 Tagen',
      previousAbschlagDeductions: [],
      payments,
    });

  it('Z1: fristgerecht mit Skonto ausgeglichen — eine eigene Skontozeile erklärt die Differenz', () => {
    const html = renderToStaticMarkup(<InvoicePaymentSummary invoice={abschlag([zahlung(466.48, '2026-09-05')])} translate={translate} />);
    expect(html).toContain('data-testid="payment-summary-skonto"');
    expect(html).toContain(t('payment.skontoGranted'));
    expect(html).toContain('9,52');
  });

  it('Z2: voll bezahlt oder teilbezahlt — keine Skontozeile', () => {
    expect(renderToStaticMarkup(<InvoicePaymentSummary invoice={abschlag([zahlung(476, '2026-09-05')])} translate={translate} />)).not.toContain(
      'payment-summary-skonto',
    );
    expect(renderToStaticMarkup(<InvoicePaymentSummary invoice={abschlag([zahlung(200, '2026-09-05')])} translate={translate} />)).not.toContain(
      'payment-summary-skonto',
    );
  });

  it('Z3: bei einer Schlussrechnung mit Abzügen heißt der Betrag „Restbetrag nach Abschlägen"', () => {
    const schluss = renderToStaticMarkup(<InvoicePaymentSummary invoice={schlussrechnung()} translate={translate} />);
    expect(schluss).toContain(t('payment.totalDueAfterDeductions'));
    expect(schluss).not.toContain(`<dt>${t('payment.totalDue')}</dt>`);
    const normal = renderToStaticMarkup(
      <InvoicePaymentSummary invoice={schlussrechnung({ type: 'rechnung', previousAbschlagDeductions: [], amount: 773.5 })} translate={translate} />,
    );
    expect(normal).toContain(`<dt>${t('payment.totalDue')}</dt>`);
  });
});
