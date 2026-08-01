/**
 * REFERENCE-ER-01 — Eingangsrechnung Goldpfad (UI Visibility)
 */
import { describe, expect, it } from 'vitest';
import { assertInvoiceJourney } from '../_lib/assertInvoiceJourney';
import { assertInvoiceUiVisibility } from '../_lib/assertInvoiceUiVisibility';
import { getReferenceCase } from '../_lib/loadReferenceCase';
import { runInvoiceJourney } from '../_lib/runInvoiceJourney';
import { isIncomingInvoiceReference } from '../_lib/types';

const CASE_ID = 'ER-01';

describe(`REFERENCE ${CASE_ID} — UI Visibility`, () => {

  it('Lieferant, Nummer, Datum, Betrag, Status und Archiv sind sichtbar', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isIncomingInvoiceReference(reference)).toBe(true);
    if (!isIncomingInvoiceReference(reference)) return;
    expect(reference.layers).toContain('ui-visibility');

    const observation = runInvoiceJourney(reference);
    assertInvoiceJourney(observation);
    assertInvoiceUiVisibility(observation);

    expect(reference.damagePrevented.some((d) => /Lieferant/i.test(d))).toBe(true);
    expect(reference.damagePrevented.some((d) => /Archiv/i.test(d))).toBe(true);
    expect(reference.damagePrevented.some((d) => /Zahlungsstatus/i.test(d))).toBe(true);
  });
});
