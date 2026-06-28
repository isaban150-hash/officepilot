import { describe, expect, it } from 'vitest';
import { buildInvoicePrintModel } from './invoicePrintModel';
import { updateInvoiceDraftMetadata } from './invoiceService';
import {
  createNormalPrintSetup,
  createSchlussPrintSetup,
} from '../test/invoicePrintFixtures';

describe('buildInvoicePrintModel', () => {
  it('maps draft fields into print model', () => {
    const { draft, setup } = createNormalPrintSetup();
    const model = buildInvoicePrintModel(draft, setup);

    expect(model.documentTitle).toBe('Abschlagsrechnung 1');
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
