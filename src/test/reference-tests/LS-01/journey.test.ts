/**
 * REFERENCE-LS-01 — Lieferschein (Journey)
 */
import { describe, expect, it } from 'vitest';
import { assertDeliveryJourney } from '../_lib/assertDeliveryJourney';
import { getReferenceCase } from '../_lib/loadReferenceCase';
import { runDeliveryJourney } from '../_lib/runDeliveryJourney';
import { isDeliveryNoteReference } from '../_lib/types';

const CASE_ID = 'LS-01';

describe(`REFERENCE ${CASE_ID} — Delivery Journey`, () => {

  it('dokumentiert damagePrevented (Goldstandard-Lieferschein)', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isDeliveryNoteReference(reference)).toBe(true);
    if (!isDeliveryNoteReference(reference)) return;
    expect(reference.damagePrevented.length).toBeGreaterThanOrEqual(6);
    for (const entry of reference.damagePrevented) {
      expect(entry.trim().length).toBeGreaterThan(8);
    }
    expect(reference.layers).toEqual(
      expect.arrayContaining(['stable-pipeline', 'delivery-journey', 'ui-visibility']),
    );
    expect(reference.documentCaseId).toBe('LS-01');
  });

  it('Happy Path: erkennen → archivieren → Auftrag zuordnen → Plan unverändert', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isDeliveryNoteReference(reference)).toBe(true);
    if (!isDeliveryNoteReference(reference)) return;

    const observation = runDeliveryJourney(reference);
    assertDeliveryJourney(observation);

    expect(observation.inbox.vorgangId).toBe(reference.deliveryJourney.vorgangId);
    expect(observation.archiveDocumentId).toBeTruthy();
    expect(observation.positionsAfter[0]?.plannedQuantity).toBe(
      reference.deliveryJourney.originalPlannedQuantity,
    );
    expect(observation.amendmentDraftCount).toBe(0);
    expect(observation.expenseCount).toBe(0);
  });
});
