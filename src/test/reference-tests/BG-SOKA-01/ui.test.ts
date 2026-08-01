/**
 * REFERENCE-BG-SOKA-01 — Nachweispflichten (UI Visibility)
 */
import { describe, expect, it } from 'vitest';
import { assertAuthorityJourney } from '../_lib/assertAuthorityJourney';
import { assertAuthorityUiVisibility } from '../_lib/assertAuthorityUiVisibility';
import { getReferenceCase } from '../_lib/loadReferenceCase';
import { runAuthorityJourney } from '../_lib/runAuthorityJourney';
import { isAuthorityLetterReference } from '../_lib/types';

const CASE_ID = 'BG-SOKA-01';

describe(`REFERENCE ${CASE_ID} — UI Visibility`, () => {

  it('Organisation, Nachweispflicht, Status und Archiv sind sichtbar', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isAuthorityLetterReference(reference)).toBe(true);
    if (!isAuthorityLetterReference(reference)) return;
    expect(reference.layers).toContain('ui-visibility');

    const observation = runAuthorityJourney(reference);
    assertAuthorityJourney(observation);
    assertAuthorityUiVisibility(observation);

    expect(reference.damagePrevented.some((d) => /Nachweis/i.test(d))).toBe(true);
    expect(reference.damagePrevented.some((d) => /Organisation/i.test(d))).toBe(true);
    expect(reference.damagePrevented.some((d) => /UI/i.test(d))).toBe(true);
  });
});
