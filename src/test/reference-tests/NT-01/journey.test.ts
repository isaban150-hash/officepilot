/**
 * REFERENCE-NT-01 — Nachtrag Goldpfad (Journey)
 * Confirm-first + Plan-Konsistenz — keine neue Geschäftslogik.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOrderAmendmentConfirmIntentsForTests } from '../../../services/orderAmendment/orderAmendmentConfirmIntentService';
import { assertAmendmentJourney } from '../_lib/assertAmendmentJourney';
import { getReferenceCase } from '../_lib/loadReferenceCase';
import { runAmendmentJourney } from '../_lib/runAmendmentJourney';
import { isOrderAmendmentReference } from '../_lib/types';

const CASE_ID = 'NT-01';

describe(`REFERENCE ${CASE_ID} — Amendment Journey`, () => {
  beforeEach(() => {
    resetOrderAmendmentConfirmIntentsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetOrderAmendmentConfirmIntentsForTests();
  });

  it('dokumentiert damagePrevented (Goldstandard-Nachtrag)', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isOrderAmendmentReference(reference)).toBe(true);
    if (!isOrderAmendmentReference(reference)) return;
    expect(reference.damagePrevented.length).toBeGreaterThanOrEqual(5);
    for (const entry of reference.damagePrevented) {
      expect(entry.trim().length).toBeGreaterThan(10);
    }
    expect(reference.layers).toEqual(
      expect.arrayContaining(['amendment-journey', 'ui-visibility']),
    );
  });

  it('Happy Path: Auftrag → Nachtrag → Confirm-first → Plan konsistent', async () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isOrderAmendmentReference(reference)).toBe(true);
    if (!isOrderAmendmentReference(reference)) return;

    const observation = await runAmendmentJourney(reference);
    assertAmendmentJourney(observation);

    expect(observation.vorgang.confirmedOrderAmendments).toHaveLength(1);
    expect(observation.vorgang.orderAmendments ?? []).toHaveLength(0);
    expect(
      observation.vorgang.orderPositions?.some((p) =>
        p.description.includes(reference.amendmentJourney.newPositionDescription),
      ),
    ).toBe(true);
  });
});
