/**
 * REFERENCE-LS-01 — Lieferschein (UI Visibility)
 */
import { describe, expect, it } from 'vitest';
import { assertDeliveryJourney } from '../_lib/assertDeliveryJourney';
import { assertDeliveryUiVisibility } from '../_lib/assertDeliveryUiVisibility';
import { getReferenceCase } from '../_lib/loadReferenceCase';
import { runDeliveryJourney } from '../_lib/runDeliveryJourney';
import { isDeliveryNoteReference } from '../_lib/types';

const CASE_ID = 'LS-01';

describe(`REFERENCE ${CASE_ID} — UI Visibility`, () => {

  it('Auftrag, Lieferschein, Datum, Status und Verknüpfung sind sichtbar', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isDeliveryNoteReference(reference)).toBe(true);
    if (!isDeliveryNoteReference(reference)) return;
    expect(reference.layers).toContain('ui-visibility');

    const observation = runDeliveryJourney(reference);
    assertDeliveryJourney(observation);
    assertDeliveryUiVisibility(observation);

    expect(reference.damagePrevented.some((d) => /Auftrag/i.test(d))).toBe(true);
    expect(reference.damagePrevented.some((d) => /Mengen/i.test(d))).toBe(true);
    expect(reference.damagePrevented.some((d) => /UI/i.test(d))).toBe(true);
  });
});
