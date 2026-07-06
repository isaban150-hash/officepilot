import { describe, expect, it } from 'vitest';
import { buildInvoicePrintModel, buildInvoicePrintModelFromInvoice } from './invoicePrintModel';
import { updateInvoiceDraftMetadata } from './invoiceService';
import {
  createNormalPrintSetup,
  createSchlussPrintSetup,
} from '../test/invoicePrintFixtures';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import type { VorgangInvoice } from '../types/models';

describe('buildInvoicePrintModel', () => {
  it('maps draft fields into print model', () => {
    const { draft, setup } = createNormalPrintSetup();
    const model = buildInvoicePrintModel(draft, setup);

    expect(model.documentTitle).toBe('Rechnung');
    expect(model.invoiceNumber).toBe('ENTWURF');
    expect(model.projectSite).toBe('Teststraße 1');
    expect(model.positions).toHaveLength(1);
    expect(model.positions[0].lineTotal).toBe(520);
    expect(model.summary.grossTotal).toBeCloseTo(618.8, 2);
    expect(model.summary.amountDue).toBeCloseTo(618.8, 2);
  });

  it('calculates schluss restbetrag after deductions', () => {
    const { draft, setup } = createSchlussPrintSetup();
    const model = buildInvoicePrintModel(draft, setup);

    expect(model.type).toBe('schluss');
    expect(model.summary.deductionLines).toHaveLength(3);
    expect(model.summary.deductionsTotal).toBeCloseTo(541.45, 2);
    expect(model.summary.amountDue).toBeCloseTo(232.05, 2);
  });
});

describe('buildInvoicePrintModelFromInvoice', () => {
  it('uses stored snapshots only', () => {
    const invoice: VorgangInvoice = {
      id: 'inv-ro-1',
      number: '2026-0042',
      type: 'abschlag',
      abschlagNumber: 2,
      positions: [
        {
          id: 'line-1',
          orderPositionId: 'op-1',
          description: 'Snapshot-Leistung',
          quantity: 3,
          unit: 'Stunden',
          unitPrice: 80,
          lineTotal: 240,
        },
      ],
      subtotal: 240,
      taxStatus: 'standard_19',
      amount: 285.6,
      status: 'vorbereitet',
      date: '2026-06-10',
      createdAt: '2026-06-10T10:00:00.000Z',
      issueDate: '2026-06-10',
      servicePeriodFrom: '2026-06-01',
      servicePeriodTo: '2026-06-09',
      paymentDueDate: '2026-06-24',
      paymentTermsText: 'Snapshot-Zahlungstext',
      skontoText: 'Snapshot-Skonto',
      customerSnapshot: {
        name: 'Snapshot-Kunde',
        contactPerson: 'Snapshot-Kontakt',
        street: 'Snapshot-Straße 1',
        zip: '12345',
        city: 'Snapshotstadt',
        email: 'kunde@snapshot.de',
        phone: '0123',
      },
      companySnapshot: {
        ...DEFAULT_COMPANY_PROFILE,
        companyName: 'Snapshot-Firma GmbH',
        street: 'Firmenweg 9',
        zip: '99999',
        city: 'Snapshotburg',
        invoiceFooterNotes: 'Snapshot-Fußzeile',
      },
      legalNotices: [],
      previousAbschlagDeductions: [],
      introText: 'Snapshot-Einleitung',
      closingText: 'Snapshot-Schluss',
      baustelle: 'Snapshot-Baustelle',
      vorgangTitle: 'Snapshot-Vorgang',
    };

    const model = buildInvoicePrintModelFromInvoice(invoice);

    expect(model.invoiceNumber).toBe('2026-0042');
    expect(model.company.companyName).toBe('Snapshot-Firma GmbH');
    expect(model.customer.name).toBe('Snapshot-Kunde');
    expect(model.projectTitle).toBe('Snapshot-Vorgang');
    expect(model.projectSite).toBe('Snapshot-Baustelle');
    expect(model.introText).toBe('Snapshot-Einleitung');
    expect(model.paymentTermsText).toBe('Snapshot-Zahlungstext');
    expect(model.footerNotes).toBe('Snapshot-Fußzeile');
    expect(model.positions[0].description).toBe('Snapshot-Leistung');
  });

  it('throws when snapshots are missing', () => {
    expect(() =>
      buildInvoicePrintModelFromInvoice({
        id: 'inv-bad',
        number: 'X',
        type: 'abschlag',
        positions: [],
        subtotal: 0,
        taxStatus: 'standard_19',
        amount: 0,
        status: 'vorbereitet',
        date: '2026-01-01',
        createdAt: '2026-01-01T10:00:00.000Z',
      }),
    ).toThrow(/snapshots missing/i);
  });
});

describe('updateInvoiceDraftMetadata', () => {
  it('merges editable metadata fields', () => {
    const { draft } = createNormalPrintSetup();
    const updated = updateInvoiceDraftMetadata(draft, {
      issueDate: '2026-07-01',
      introText: 'Neuer Einleitungstext',
      customerBilling: { contactPerson: 'Herr Schmidt' },
      projectSite: 'Neue Baustelle 9',
    });

    expect(updated.issueDate).toBe('2026-07-01');
    expect(updated.introText).toBe('Neuer Einleitungstext');
    expect(updated.customerBilling.contactPerson).toBe('Herr Schmidt');
    expect(updated.baustelle).toBe('Neue Baustelle 9');
  });
});
