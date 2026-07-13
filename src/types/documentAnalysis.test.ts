import { describe, expect, it } from 'vitest';
import {
  clampAnalysisConfidence,
  hasEvidenceForFact,
  isValidEvidenceRef,
  validateDocumentAnalysisResult,
  type DocumentAnalysisResult,
  type EvidenceBackedFact,
  type EvidenceRef,
} from './documentAnalysis';

const EVIDENCE_ID = 'ev-1';

function createEvidenceRef(overrides: Partial<EvidenceRef> = {}): EvidenceRef {
  return {
    id: EVIDENCE_ID,
    zone: 'header',
    snippet: 'Acme GmbH',
    ...overrides,
  };
}

function createMinimalValidResult(
  overrides: Partial<DocumentAnalysisResult> = {},
): DocumentAnalysisResult {
  return {
    version: 'v1',
    classification: {
      family: 'invoice',
      kind: 'rechnung',
      candidates: [
        {
          kind: 'rechnung',
          family: 'invoice',
          score: 0.9,
          confidence: 0.85,
          positiveEvidenceRefs: [EVIDENCE_ID],
          negativeEvidenceRefs: [],
          structuralEvidenceRefs: [],
          missingRequiredFeatures: [],
          conflicts: [],
        },
      ],
      confidence: 0.85,
      margin: 0.2,
      needsReview: false,
      source: 'rules',
      reviewStatus: 'auto_accepted',
    },
    facts: {
      sender: {
        value: 'Acme GmbH',
        confidence: 0.9,
        source: 'ocr',
        evidenceRefs: [EVIDENCE_ID],
        reviewStatus: 'auto_accepted',
      },
    },
    recommendations: {
      requestedActions: [
        {
          value: 'archive',
          source: 'rules',
          confidence: 0.7,
          evidenceRefs: [EVIDENCE_ID],
        },
      ],
    },
    evidenceIndex: {
      [EVIDENCE_ID]: createEvidenceRef(),
    },
    conflicts: [],
    warnings: [],
    ocrQuality: {
      score: 0.8,
      readable: true,
      partialRecognition: false,
    },
    ...overrides,
  };
}

function createFact(
  source: EvidenceBackedFact<string>['source'],
  evidenceRefs: string[] = [EVIDENCE_ID],
): EvidenceBackedFact<string> {
  return {
    value: 'Test',
    confidence: 0.8,
    source,
    evidenceRefs,
    reviewStatus: 'auto_accepted',
  };
}

describe('documentAnalysis validation helpers', () => {
  it('accepts a valid minimal DocumentAnalysisResult', () => {
    const result = validateDocumentAnalysisResult(createMinimalValidResult());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('clamps confidence below 0 to 0', () => {
    expect(clampAnalysisConfidence(-0.25)).toBe(0);
  });

  it('clamps confidence above 1 to 1', () => {
    expect(clampAnalysisConfidence(1.4)).toBe(1);
  });

  it('detects a missing evidence reference in the evidenceIndex', () => {
    const result = validateDocumentAnalysisResult(
      createMinimalValidResult({
        facts: {
          sender: createFact('ocr', ['missing-evidence']),
        },
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('missing evidence id "missing-evidence"'))).toBe(
      true,
    );
  });

  it('rejects an OCR fact without evidence', () => {
    const result = validateDocumentAnalysisResult(
      createMinimalValidResult({
        facts: {
          sender: createFact('ocr', []),
        },
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('ocr fact requires valid evidence'))).toBe(true);
  });

  it('rejects a rules fact without evidence', () => {
    const result = validateDocumentAnalysisResult(
      createMinimalValidResult({
        facts: {
          sender: createFact('rules', []),
        },
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('rules fact requires valid evidence'))).toBe(true);
  });

  it('rejects an AI fact without evidence', () => {
    const result = validateDocumentAnalysisResult(
      createMinimalValidResult({
        facts: {
          sender: createFact('ai', []),
        },
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('ai fact requires valid evidence'))).toBe(true);
  });

  it('allows a user fact without OCR evidence', () => {
    const userFact = createFact('user', []);
    const evidenceIndex = { [EVIDENCE_ID]: createEvidenceRef() };

    expect(hasEvidenceForFact(userFact, evidenceIndex)).toBe(true);

    const result = validateDocumentAnalysisResult(
      createMinimalValidResult({
        facts: {
          sender: userFact,
        },
      }),
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('requires needsReview when a critical conflict is present', () => {
    const result = validateDocumentAnalysisResult(
      createMinimalValidResult({
        classification: {
          ...createMinimalValidResult().classification,
          needsReview: false,
        },
        conflicts: [
          {
            type: 'amount_mismatch',
            severity: 'critical',
            evidenceRefs: [EVIDENCE_ID],
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('critical conflict requires classification.needsReview'))).toBe(
      true,
    );
  });

  it('requires the winner kind to be present in candidates when candidates exist', () => {
    const result = validateDocumentAnalysisResult(
      createMinimalValidResult({
        classification: {
          ...createMinimalValidResult().classification,
          kind: 'mahnung',
          candidates: [
            {
              kind: 'rechnung',
              family: 'invoice',
              score: 0.9,
              confidence: 0.85,
              positiveEvidenceRefs: [EVIDENCE_ID],
              negativeEvidenceRefs: [],
              structuralEvidenceRefs: [],
              missingRequiredFeatures: [],
              conflicts: [],
            },
          ],
        },
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('winner kind must be present in candidates'))).toBe(
      true,
    );
  });

  it('detects empty or invalid evidence refs', () => {
    expect(isValidEvidenceRef(undefined)).toBe(false);
    expect(isValidEvidenceRef({ id: '', zone: 'header', snippet: 'x' })).toBe(false);
    expect(isValidEvidenceRef({ id: 'ev-1', zone: 'header', snippet: '' })).toBe(false);

    const result = validateDocumentAnalysisResult(
      createMinimalValidResult({
        evidenceIndex: {
          'bad-evidence': {
            id: 'bad-evidence',
            zone: 'header',
            snippet: '   ',
          },
        },
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('invalid or empty evidence ref'))).toBe(true);
  });

  it('keeps facts and recommendations structurally separate', () => {
    const analysis = createMinimalValidResult();

    expect(analysis.facts).toEqual(
      expect.objectContaining({
        sender: expect.objectContaining({ value: 'Acme GmbH' }),
      }),
    );
    expect(analysis.recommendations).toEqual(
      expect.objectContaining({
        requestedActions: expect.arrayContaining([
          expect.objectContaining({ value: 'archive' }),
        ]),
      }),
    );
    expect(analysis.facts).not.toHaveProperty('requestedActions');
    expect(analysis.recommendations).not.toHaveProperty('sender');
    expect(validateDocumentAnalysisResult(analysis).valid).toBe(true);
  });
});
