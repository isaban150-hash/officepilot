/**
 * REFERENCE-ER-01 — Eingangsrechnung Goldpfad (Journey)
 */
import { describe, expect, it } from 'vitest';
import { assertInvoiceJourney } from '../_lib/assertInvoiceJourney';
import { getReferenceCase } from '../_lib/loadReferenceCase';
import { runInvoiceJourney } from '../_lib/runInvoiceJourney';
import { isIncomingInvoiceReference } from '../_lib/types';

const CASE_ID = 'ER-01';

describe(`REFERENCE ${CASE_ID} — Invoice Journey`, () => {

  it('dokumentiert damagePrevented (Goldstandard-Eingangsrechnung)', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isIncomingInvoiceReference(reference)).toBe(true);
    if (!isIncomingInvoiceReference(reference)) return;
    expect(reference.damagePrevented.length).toBeGreaterThanOrEqual(5);
    for (const entry of reference.damagePrevented) {
      expect(entry.trim().length).toBeGreaterThan(8);
    }
    expect(reference.layers).toEqual(
      expect.arrayContaining(['stable-pipeline', 'invoice-journey', 'ui-visibility']),
    );
    expect(reference.documentCaseId).toBe('ER-01');
  });

  it('Happy Path: erkennen → archivieren → Ausgabe mit Feldern und Links', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isIncomingInvoiceReference(reference)).toBe(true);
    if (!isIncomingInvoiceReference(reference)) return;

    const observation = runInvoiceJourney(reference);
    assertInvoiceJourney(observation);

    expect(observation.expense.invoiceNumber).toBe('RE-2026-9912');
    expect(observation.expense.supplierName).toMatch(/Nordhandel/i);
    expect(observation.expense.paymentStatus).toBe('offen');
    expect(observation.archiveDocumentId).toBeTruthy();
  });
});
