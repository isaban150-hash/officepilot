/**
 * REAL-DOCUMENT-TEST-FOUNDATION-01A
 * Stable-Pipeline: kontrollierter OCR-Text → processUploadedDocument → fachliche Soll-Prüfung.
 * Schaden je Case: siehe scenario.damagePrevented / expected.damagePrevented.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { hydrateVorgangStore } from '../../services/vorgangService';
import { listDocumentCases } from './_lib/loadCases';
import { assertDocumentCase } from './_lib/assertCase';
import { runStablePipeline } from './_lib/runStablePipeline';

describe('REAL-DOCUMENT-TEST-FOUNDATION-01A — Stable-Pipeline Document Cases', () => {
  beforeEach(() => {
    hydrateVorgangStore([]);
  });

  const cases = listDocumentCases().filter((c) =>
    c.scenario.layers.includes('stable-pipeline'),
  );

  it('registriert die erwarteten Referenzfälle', () => {
    const ids = cases.map((c) => c.caseId).sort();
    expect(ids).toEqual(
      [
        'BANK-RLS-01',
        'BG-SOKA-01',
        'ER-01',
        'FA-FRIST-01',
        'HOTEL-01',
        'MAIL-TERMIN-01',
        'UNSURE-01',
        'VS-BEITRAG-01',
        'WV-LV-01',
      ].sort(),
    );
  });

  for (const docCase of cases) {
    it(`schützt: ${docCase.caseId} — ${docCase.scenario.damagePrevented}`, () => {
      const observation = runStablePipeline(docCase);
      expect(observation.workflow.businessInterpretation).not.toBeNull();
      assertDocumentCase(docCase.expected, observation);

      // Bekannte Lücken müssen explizit stehen, nicht durch leere Erwartungen versteckt werden.
      for (const gap of docCase.expected.knownGaps) {
        expect(gap.trim().length).toBeGreaterThan(10);
      }
    });
  }
});
