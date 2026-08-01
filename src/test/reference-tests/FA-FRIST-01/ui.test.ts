/**
 * REFERENCE-FA-FRIST-01 — Behördenpost mit Frist (UI Visibility)
 */
import { describe, expect, it } from 'vitest';
import { assertAuthorityJourney } from '../_lib/assertAuthorityJourney';
import { assertAuthorityUiVisibility } from '../_lib/assertAuthorityUiVisibility';
import { getReferenceCase } from '../_lib/loadReferenceCase';
import { runAuthorityJourney } from '../_lib/runAuthorityJourney';
import { isAuthorityLetterReference } from '../_lib/types';

const CASE_ID = 'FA-FRIST-01';

describe(`REFERENCE ${CASE_ID} — UI Visibility`, () => {

  it('Behörde, Frist, Pflicht und Dokumentstatus sind sichtbar', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isAuthorityLetterReference(reference)).toBe(true);
    if (!isAuthorityLetterReference(reference)) return;
    expect(reference.layers).toContain('ui-visibility');

    const observation = runAuthorityJourney(reference);
    assertAuthorityJourney(observation);
    assertAuthorityUiVisibility(observation);

    expect(reference.damagePrevented.some((d) => /Frist/i.test(d))).toBe(true);
    expect(reference.damagePrevented.some((d) => /Auftrag/i.test(d))).toBe(true);
    expect(reference.damagePrevented.some((d) => /Ausgabe/i.test(d))).toBe(true);
  });
});
