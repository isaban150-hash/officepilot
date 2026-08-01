/**
 * TEST-ARCHITECTURE-01 — WV-LV-01 Referenz
 * Ebene 1 (Document Case) + Ebene 2 (Accept Journey)
 *
 * Keine doppelte Pipeline-Logik: Document-Case OCR/Asserts + Accept-Orchestrator.
 */
import { describe, expect, it } from 'vitest';
import { assertAcceptJourney } from '../_lib/assertAcceptJourney';
import { getReferenceCase } from '../_lib/loadReferenceCase';
import { runAcceptJourney } from '../_lib/runAcceptJourney';
import { isContractAcceptReference } from '../_lib/types';

const CASE_ID = 'WV-LV-01';

describe(`REFERENCE ${CASE_ID} — Accept Journey (Ebene 1+2)`, () => {

  it('dokumentiert damagePrevented (Goldstandard-Vertrag)', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isContractAcceptReference(reference)).toBe(true);
    if (!isContractAcceptReference(reference)) return;
    expect(reference.damagePrevented.length).toBeGreaterThanOrEqual(5);
    for (const entry of reference.damagePrevented) {
      expect(entry.trim().length).toBeGreaterThan(10);
    }
    expect(reference.layers).toEqual(
      expect.arrayContaining(['stable-pipeline', 'accept-journey', 'ui-visibility']),
    );
    expect(reference.documentCaseId).toBe('WV-LV-01');
  });

  it('Ebene 1+2: Analyse → Auftrag annehmen → Vorgang/Archiv/Fakten (Soll-Ist)', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isContractAcceptReference(reference)).toBe(true);
    if (!isContractAcceptReference(reference)) return;
    const observation = runAcceptJourney(reference);

    // Ebene 1 läuft innerhalb von runAcceptJourney via assertDocumentCase.
    expect(observation.pipeline.bi).not.toBeNull();
    expect(observation.proposal.positions.length).toBeGreaterThanOrEqual(
      reference.acceptJourney.minPositions,
    );

    assertAcceptJourney(observation);

    expect(observation.vorgang.id).toBeTruthy();
    expect(observation.archiveDocumentId).toBeTruthy();
    expect(observation.vorgang.customer).toContain('Isobautec');
  });
});
