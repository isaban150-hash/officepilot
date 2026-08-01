/**
 * REFERENCE-BG-SOKA-01 — Nachweispflichten (Authority Journey)
 * Wiederverwendet kind=authority-letter + runAuthorityJourney.
 */
import { describe, expect, it } from 'vitest';
import { assertAuthorityJourney } from '../_lib/assertAuthorityJourney';
import { getReferenceCase } from '../_lib/loadReferenceCase';
import { runAuthorityJourney } from '../_lib/runAuthorityJourney';
import { isAuthorityLetterReference } from '../_lib/types';

const CASE_ID = 'BG-SOKA-01';

describe(`REFERENCE ${CASE_ID} — Authority Journey (Nachweispflichten)`, () => {

  it('dokumentiert damagePrevented (Goldstandard-Nachweispflichten)', () => {
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
    expect(reference.documentCaseId).toBe('BG-SOKA-01');
    expect(reference.kind).toBe('authority-letter');
  });

  it('Happy Path: Organisation/Nachweis erkennen → archivieren → keine Auftrag/Expense/Vertragswirkung', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isAuthorityLetterReference(reference)).toBe(true);
    if (!isAuthorityLetterReference(reference)) return;

    const observation = runAuthorityJourney(reference);
    assertAuthorityJourney(observation);

    expect(observation.vorgangCount).toBe(0);
    expect(observation.expenseCount).toBe(0);
    expect(observation.archiveDocumentId).toBeTruthy();
    expect(observation.inbox.archiveDocumentId).toBe(observation.archiveDocumentId);
    expect(observation.inbox.sender).toMatch(/BG BAU/i);
    expect(observation.pipeline.bi?.operational?.meanings).toEqual(
      expect.arrayContaining(['obligation', 'evidence']),
    );
  });
});
