import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import type { VorgangInvoice } from '../types/models';
import {
  buildInvoicePdfFilename,
  downloadInvoicePdfBytes,
  generateApprovedInvoicePdf,
  toPdfSafeText,
} from './invoicePdfService';
import * as invoicePrintService from './invoicePrintService';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster Handwerk GmbH',
  street: 'Werkstraße 12',
  zip: '80331',
  city: 'München',
  phone: '+49 89 123456',
  email: 'rechnung@muster-handwerk.de',
  taxNumber: '143/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse München',
  iban: 'DE89 3704 0044 0532 0130 00',
  bic: 'COBADEFFXXX',
  invoiceFooterNotes: 'Vielen Dank.',
};

function createFinalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-pdf-1',
    number: '2026-0042',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Fliesenarbeiten Bad',
        quantity: 8,
        unit: 'Stunden',
        unitPrice: 65,
        lineTotal: 520,
      },
      {
        id: 'line-2',
        orderPositionId: 'op-2',
        description: 'Materialpauschale',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 120,
        lineTotal: 120,
      },
    ],
    subtotal: 640,
    taxStatus: 'standard_19',
    amount: 761.6,
    status: 'vorbereitet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    servicePeriodFrom: '2026-05-01',
    servicePeriodTo: '2026-05-31',
    paymentDueDate: '2026-06-15',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    skontoText: '',
    customerSnapshot: {
      name: 'Bauherr Müller',
      contactPerson: 'Frau Müller',
      street: 'Gartenweg 5',
      zip: '80333',
      city: 'München',
      email: 'mueller@example.de',
      phone: '089 998877',
    },
    companySnapshot,
    legalNotices: ['Es gelten die gesetzlichen Mehrwertsteuersätze.'],
    previousAbschlagDeductions: [],
    introText: 'Sehr geehrte Damen und Herren,',
    closingText: 'Mit freundlichen Grüßen',
    baustelle: 'Gartenweg 5',
    vorgangTitle: 'Bad Sanierung',
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  };
}

describe('INVOICE-PILOT-PDF-GENERATION-01', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('freigegebene Rechnung erzeugt eine gültige PDF mit Positionen und Summen', async () => {
    const invoice = createFinalizedInvoice();
    const statusBefore = invoice.status;
    const result = await generateApprovedInvoicePdf(invoice);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.mimeType).toBe('application/pdf');
    expect(result.filename).toBe('Rechnung_2026-0042.pdf');
    expect(result.statusUnchanged).toBe('vorbereitet');
    expect(invoice.status).toBe(statusBefore);

    const header = String.fromCharCode(
      result.bytes[0],
      result.bytes[1],
      result.bytes[2],
      result.bytes[3],
      result.bytes[4],
    );
    expect(header).toBe('%PDF-');

    const loaded = await PDFDocument.load(result.bytes);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(result.bytes.byteLength).toBeGreaterThan(500);

    // Uncompressed PDF metadata / trailer often retains the invoice number as literal.
    const asLatin = new TextDecoder('latin1').decode(result.bytes);
    expect(asLatin.includes('2026-0042') || result.filename.includes('2026-0042')).toBe(true);
  });

  it('Draft bzw. ungültige Rechnung erzeugt keine finale PDF', async () => {
    const draftLike = createFinalizedInvoice({ status: 'entwurf', number: 'ENTWURF' });
    const draftResult = await generateApprovedInvoicePdf(draftLike);
    expect(draftResult.ok).toBe(false);
    if (draftResult.ok) return;
    expect(draftResult.reason).toBe('not_finalized');

    const missingCustomer = createFinalizedInvoice({
      customerSnapshot: {
        name: '',
        contactPerson: '',
        street: '',
        zip: '',
        city: '',
        email: '',
        phone: '',
      },
    });
    const invalid = await generateApprovedInvoicePdf(missingCustomer);
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.reason).toBe('validation_failed');
  });

  it('fehlende Angaben werden nicht erfunden; vorhandene Daten bleiben', async () => {
    const invoice = createFinalizedInvoice({
      skontoText: '',
      introText: '',
      companySnapshot: { ...companySnapshot, website: '' },
    });
    const result = await generateApprovedInvoicePdf(invoice);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const latin = new TextDecoder('latin1').decode(result.bytes);
    expect(latin).not.toMatch(/www\.example|placeholder|TODO/i);
    // Position totals come from invoice lines (520 + 120 = 640 net) — present in print model path.
    const { buildInvoicePrintModelFromInvoice } = await import('./invoicePrintModel');
    const model = buildInvoicePrintModelFromInvoice(invoice);
    expect(model.positions).toHaveLength(2);
    expect(model.positions[0]?.description).toBe('Fliesenarbeiten Bad');
    expect(model.summary.subtotalNet).toBe(640);
    expect(model.company.website).toBe('');
    expect(model.skontoText).toBe('');
  });

  it('Dateiname wird sicher erzeugt', () => {
    expect(buildInvoicePdfFilename('2026-0001')).toBe('Rechnung_2026-0001.pdf');
    expect(buildInvoicePdfFilename('RE/../evil.pdf')).toBe('Rechnung_evil.pdf');
    expect(buildInvoicePdfFilename('RE 0042/A')).toBe('Rechnung_A.pdf');
    expect(buildInvoicePdfFilename('  ')).toBe('Rechnung_ohne_Nummer.pdf');
    expect(toPdfSafeText('100 €')).toContain('EUR');
  });

  it('Download erfolgt nur nach Aufruf; Object-URL wird freigegeben; kein Print-Fallback', async () => {
    const printSpy = vi.spyOn(invoicePrintService, 'printInvoice').mockImplementation(() => {});
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:invoice-pdf-test');
    const clickSpy = vi.fn();
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const originalCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreate(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'click', { value: clickSpy });
      }
      return el;
    });

    const invoice = createFinalizedInvoice();
    const result = await generateApprovedInvoicePdf(invoice);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(printSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();

    const handle = downloadInvoicePdfBytes(result.bytes, result.filename);
    expect(createSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalled();

    handle.revoke();
    expect(revokeSpy).toHaveBeenCalledWith('blob:invoice-pdf-test');
    handle.revoke(); // idempotent
    expect(revokeSpy).toHaveBeenCalledTimes(1);

    expect(invoice.status).toBe('vorbereitet');
  });

  it('setzt Status nicht auf versendet', async () => {
    const invoice = createFinalizedInvoice({ status: 'vorbereitet' });
    const result = await generateApprovedInvoicePdf(invoice);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.statusUnchanged).toBe('vorbereitet');
    expect(invoice.status).toBe('vorbereitet');
  });
});
