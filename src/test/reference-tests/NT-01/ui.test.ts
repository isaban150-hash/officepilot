/**
 * REFERENCE-NT-01 — Nachtrag Goldpfad (UI Visibility)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOrderAmendmentConfirmIntentsForTests } from '../../../services/orderAmendment/orderAmendmentConfirmIntentService';
import { assertAmendmentJourney } from '../_lib/assertAmendmentJourney';
import { assertAmendmentUiVisibility } from '../_lib/assertAmendmentUiVisibility';
import { getReferenceCase } from '../_lib/loadReferenceCase';
import { runAmendmentJourney } from '../_lib/runAmendmentJourney';
import { isOrderAmendmentReference } from '../_lib/types';

const CASE_ID = 'NT-01';

describe(`REFERENCE ${CASE_ID} — UI Visibility`, () => {
  beforeEach(() => {
    resetOrderAmendmentConfirmIntentsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetOrderAmendmentConfirmIntentsForTests();
  });

  it('Nachtrag, Status, Positionen und Auftrag-Verknüpfung sind sichtbar', async () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isOrderAmendmentReference(reference)).toBe(true);
    if (!isOrderAmendmentReference(reference)) return;
    expect(reference.layers).toContain('ui-visibility');

    const observation = await runAmendmentJourney(reference);
    assertAmendmentJourney(observation);
    await assertAmendmentUiVisibility(observation);

    expect(reference.damagePrevented.some((d) => /UI|sichtbar/i.test(d))).toBe(true);
    expect(reference.damagePrevented.some((d) => /Confirm|still/i.test(d))).toBe(true);
  });
});
