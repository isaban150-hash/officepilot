import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyDocument, detectClassifiedKindWithReason } from './documentClassificationService';
import { resolveHybridClassification } from './documentClassificationHybridService';
import {
  buildDocumentAnalysisFromLegacy,
  buildDocumentAnalysisFromLegacyClassification,
  isValidLegacyAdapterInput,
} from './documentAnalysisLegacyAdapter';
import { zoneDocumentText } from './documentZoningService';
import {
  getLegacyAnalysisShadowInvocationCountForTests,
  resetLegacyAnalysisShadowInvocationCountForTests,
  runLegacyDocumentAnalysisShadow,
} from './documentAnalysisShadowService';
import { validateDocumentAnalysisResult } from '../types/documentAnalysis';
import * as legacyAdapterModule from './documentAnalysisLegacyAdapter';

function buildClassification(overrides: Parameters<typeof classifyDocument>[0] = {}) {
  return classifyDocument(overrides);
}

describe('documentAnalysisLegacyAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetLegacyAnalysisShadowInvocationCountForTests();
  });

  it('accepts a valid minimal legacy mapping and passes validation', () => {
    const classification = buildClassification({ kindHint: 'bg_bau', senderHint: 'BG BAU' });
    const analysis = buildDocumentAnalysisFromLegacy({
      classification,
      recognizedText: 'BG BAU Beitragsbescheid',
      ocrQuality: { score: 0.82, readable: true, partialRecognition: false },
    });

    expect(validateDocumentAnalysisResult(analysis).valid).toBe(true);
    expect(analysis.classification.source).toBe('legacy');
    expect(analysis.classification.kind).toBe('bg_bau');
  });

  it('includes an OCR-backed amount when the amount appears in recognized text', () => {
    const ocrText = 'Rechnung Gesamtbetrag 1.247,80 EUR';
    const analysis = buildDocumentAnalysisFromLegacy({
      classification: buildClassification({ recognizedText: ocrText }),
      recognizedText: ocrText,
      ocrQuality: { score: 0.9, readable: true, partialRecognition: false },
    });

    expect(analysis.facts.grossAmount?.value).toBe(1247.8);
    expect(analysis.evidenceIndex['legacy:grossAmount']?.snippet).toContain('1.247,80');
    expect(analysis.evidenceIndex['legacy:grossAmount']?.startOffset).toBeGreaterThanOrEqual(0);
  });

  it('includes an OCR-backed date when the date appears in recognized text', () => {
    const ocrText = 'Rechnungsdatum: 12.03.2026';
    const analysis = buildDocumentAnalysisFromLegacy({
      classification: buildClassification({ recognizedText: ocrText }),
      recognizedText: ocrText,
      ocrQuality: { score: 0.9, readable: true, partialRecognition: false },
    });

    expect(analysis.facts.documentDate?.value).toBe('12.03.2026');
    expect(analysis.evidenceIndex['legacy:documentDate']?.snippet).toContain('12.03.2026');
  });

  it('includes an OCR-backed reference number when it appears in recognized text', () => {
    const ocrText = 'Rechnungsnummer: INV-2026-77';
    const analysis = buildDocumentAnalysisFromLegacy({
      classification: buildClassification({ recognizedText: ocrText }),
      recognizedText: ocrText,
      ocrQuality: { score: 0.9, readable: true, partialRecognition: false },
    });

    expect(analysis.facts.referenceNumbers?.[0]?.value).toBe('INV-2026-77');
    expect(analysis.evidenceIndex['legacy:reference:0']?.snippet).toContain('INV-2026-77');
  });

  it('omits legacy facts without OCR evidence and adds legacy_fact_without_evidence', () => {
    const analysis = buildDocumentAnalysisFromLegacy({
      classification: buildClassification({ kindHint: 'materialrechnung' }),
    });

    expect(analysis.facts.sender).toBeUndefined();
    expect(analysis.facts.grossAmount).toBeUndefined();
    expect(analysis.facts.referenceNumbers).toBeUndefined();
  });

  it('omits pseudo amounts from profile defaults when they are not present in OCR text', () => {
    const analysis = buildDocumentAnalysisFromLegacy({
      classification: buildClassification({ kindHint: 'materialrechnung' }),
      recognizedText: 'Materialrechnung ohne Betrag',
      ocrQuality: { score: 0.8, readable: true, partialRecognition: false },
    });

    expect(analysis.facts.grossAmount).toBeUndefined();
  });

  it('omits pseudo dates from profile defaults when they are not present in OCR text', () => {
    const analysis = buildDocumentAnalysisFromLegacy({
      classification: buildClassification({ recognizedText: '2. Mahnung offener Betrag' }),
      recognizedText: '2. Mahnung offener Betrag',
      ocrQuality: { score: 0.8, readable: true, partialRecognition: false },
    });

    expect(analysis.facts.dueDate).toBeUndefined();
    expect(analysis.warnings).toContain('legacy_fact_without_evidence');
  });

  it('omits default sender without OCR evidence', () => {
    const analysis = buildDocumentAnalysisFromLegacy({
      classification: buildClassification({ recognizedText: 'unbekanntes Schreiben ohne Signale' }),
      recognizedText: 'unbekanntes Schreiben ohne Signale',
      ocrQuality: { score: 0.7, readable: true, partialRecognition: false },
    });

    expect(analysis.facts.sender).toBeUndefined();
    expect(analysis.warnings).toContain('legacy_fact_without_evidence');
  });

  it('keeps recommendations separate from facts', () => {
    const classification = buildClassification({ kindHint: 'materialrechnung' });
    const analysis = buildDocumentAnalysisFromLegacy({ classification });

    expect(analysis.recommendations.requestedActions.length).toBeGreaterThan(0);
    expect(analysis.recommendations.filingCategory?.value).toContain('Steuerberater');
    expect(analysis.facts).not.toHaveProperty('requestedActions');
    expect(analysis.recommendations).not.toHaveProperty('sender');
  });

  it('sets needsReview for unreadable OCR', () => {
    const analysis = buildDocumentAnalysisFromLegacy({
      classification: buildClassification({ recognizedText: 'Werkvertrag Sanierung' }),
      recognizedText: 'Werkvertrag Sanierung',
      ocrQuality: { score: 0.1, readable: false, partialRecognition: false },
    });

    expect(analysis.classification.needsReview).toBe(true);
    expect(analysis.classification.reviewStatus).toBe('needs_review');
  });

  it('sets needsReview for partial OCR recognition', () => {
    const analysis = buildDocumentAnalysisFromLegacy({
      classification: buildClassification({ recognizedText: 'Werkvertrag Sanierung' }),
      recognizedText: 'Werkvertrag Sanierung',
      ocrQuality: { score: 0.4, readable: false, partialRecognition: true },
    });

    expect(analysis.classification.needsReview).toBe(true);
  });

  it('handles invalid adapter input in a controlled way', () => {
    expect(isValidLegacyAdapterInput(null)).toBe(false);
    expect(() =>
      buildDocumentAnalysisFromLegacy({
        classification: { classifiedKind: 'rechnung' } as never,
      }),
    ).toThrow('invalid_legacy_adapter_input');
  });

  it('keeps detection reason evidence separate from OCR-backed fact evidence', () => {
    const ocrText = 'Rechnung von Müller Bau GmbH Betrag 342,16 EUR';
    const classification = buildClassification({
      recognizedText: ocrText,
      senderHint: 'Müller Bau GmbH',
    });
    const analysis = buildDocumentAnalysisFromLegacy({
      classification,
      recognizedText: ocrText,
      ocrQuality: { score: 0.9, readable: true, partialRecognition: false },
    });

    expect(analysis.evidenceIndex['legacy:detection']?.snippet).toBe(classification.detectionReasonKey);
    expect(analysis.facts.sender?.evidenceRefs).toEqual(['legacy:sender']);
    expect(analysis.facts.sender?.evidenceRefs).not.toContain('legacy:detection');
  });

  it('uses zoned evidence zones when zonedText is provided', () => {
    const ocrText = [
      'ARAL Tankstelle',
      'Diesel 52,18 EUR',
      'HRB 99999 Amtsgericht Beispielstadt',
    ].join('\n');
    const zonedText = zoneDocumentText(ocrText);
    const classification = buildClassification({ recognizedText: ocrText });
    const analysis = buildDocumentAnalysisFromLegacy({
      classification,
      recognizedText: ocrText,
      zonedText,
      ocrQuality: { score: 0.9, readable: true, partialRecognition: false },
    });

    expect(analysis.warnings).not.toContain('legacy:no_document_zone_segmentation');
    expect(analysis.facts.grossAmount?.evidenceRefs[0]).toBe('legacy:grossAmount');
    expect(analysis.evidenceIndex['legacy:grossAmount']?.zone).toBe('body');
  });

  it('exposes the masterplan alias buildDocumentAnalysisFromLegacyClassification', () => {
    const classification = buildClassification({ recognizedText: 'Werkvertrag Sanierung' });
    expect(buildDocumentAnalysisFromLegacyClassification(classification)).toEqual(
      buildDocumentAnalysisFromLegacy({ classification }),
    );
  });
});

describe('documentAnalysisShadowService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetLegacyAnalysisShadowInvocationCountForTests();
  });

  it('invokes the adapter from classifyDocument without changing the productive legacy result', () => {
    const input = { kindHint: 'bg_bau' as const, senderHint: 'BG BAU', recognizedText: 'BG BAU Beitrag' };
    const before = getLegacyAnalysisShadowInvocationCountForTests();

    const result = classifyDocument(input);

    expect(getLegacyAnalysisShadowInvocationCountForTests()).toBe(before + 1);
    expect(result.classifiedKind).toBe('bg_bau');
    expect(result.sender).toBe('BG BAU');
    expect(result.detectionReasonKey).toBe('classification.detect.uploadHint');
  });

  it('does not log document contents during shadow execution', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const input = {
      recognizedText: 'Rechnung INV-SECRET-77 an geheime@firma.de',
      senderHint: 'Geheime Firma GmbH',
    };
    const classification = buildClassification(input);
    const legacyDetection = detectClassifiedKindWithReason(input);
    const hybridContext = resolveHybridClassification(input, legacyDetection);

    runLegacyDocumentAnalysisShadow(classification, input, {
      legacyDetection,
      hybridContext,
    });

    const logged = [...logSpy.mock.calls, ...debugSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .join(' ');
    expect(logged).not.toContain('INV-SECRET-77');
    expect(logged).not.toContain('geheime@firma.de');
    expect(logged).not.toContain('Geheime Firma GmbH');
  });

  it('does not block the productive workflow when the adapter throws', () => {
    vi.spyOn(legacyAdapterModule, 'buildDocumentAnalysisFromLegacy').mockImplementation(() => {
      throw new Error('shadow adapter failed');
    });

    const input = { recognizedText: 'Werkvertrag Sanierung', senderHint: 'Familie Müller' };
    const result = classifyDocument(input);

    expect(result.classifiedKind).toBe('werkvertrag');
    expect(result.sender).toBe('Familie Müller');
  });

  it('swallows adapter failures inside runLegacyDocumentAnalysisShadow', () => {
    const legacyDetection = detectClassifiedKindWithReason({});
    const hybridContext = resolveHybridClassification({}, legacyDetection);
    expect(() =>
      runLegacyDocumentAnalysisShadow({ classifiedKind: 'rechnung' } as never, {}, {
        legacyDetection,
        hybridContext,
      }),
    ).not.toThrow();
  });
});
