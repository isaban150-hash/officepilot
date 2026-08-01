/**
 * REFERENCE-FA-FRIST-01 — Behördenpost mit Frist (Journey)
 */
import { describe, expect, it } from 'vitest';
import { assertAuthorityJourney } from '../_lib/assertAuthorityJourney';
import { getReferenceCase } from '../_lib/loadReferenceCase';
import { runAuthorityJourney } from '../_lib/runAuthorityJourney';
import { isAuthorityLetterReference } from '../_lib/types';

const CASE_ID = 'FA-FRIST-01';

describe(`REFERENCE ${CASE_ID} — Authority Journey`, () => {

  it('dokumentiert damagePrevented (Goldstandard-Behördenpost)', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isAuthorityLetterReference(reference)).toBe(true);
    if (!isAuthorityLetterReference(reference)) return;
    expect(reference.damagePrevented.length).toBeGreaterThanOrEqual(6);
    for (const entry of reference.damagePrevented) {
      expect(entry.trim().length).toBeGreaterThan(8);
    }
    expect(reference.layers).toEqual(
      expect.arrayContaining(['stable-pipeline', 'authority-journey', 'ui-visibility']),
    );
    expect(reference.documentCaseId).toBe('FA-FRIST-01');
  });

  it('Happy Path: Behörde/Frist erkennen → archivieren → keine Auftrag/Ausgabe/Vertragswirkung', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isAuthorityLetterReference(reference)).toBe(true);
    if (!isAuthorityLetterReference(reference)) return;

    const observation = runAuthorityJourney(reference);
    assertAuthorityJourney(observation);

    expect(observation.vorgangCount).toBe(0);
    expect(observation.expenseCount).toBe(0);
    expect(observation.archiveDocumentId).toBeTruthy();
    expect(observation.inbox.sender).toMatch(/Finanzamt/i);
  });
});
