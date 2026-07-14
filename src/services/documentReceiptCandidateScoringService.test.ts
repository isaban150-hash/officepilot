import { describe, expect, it, vi } from 'vitest';
import { classifyDocument } from './documentClassificationService';
import {
  buildShadowScoredDocumentAnalysis,
  resetLegacyAnalysisShadowInvocationCountForTests,
} from './documentAnalysisShadowService';
import { extractDocumentFeatures } from './documentFeatureExtractionService';
import { scoreReceiptCandidates } from './documentReceiptCandidateScoringService';
import { zoneText } from './documentZoningService';
import { validateDocumentAnalysisResult } from '../types/documentAnalysis';

const TANK_RECEIPT_WITH_REGISTER_FOOTER = [
  'ARAL Tankstelle München',
  'Diesel 52,18 EUR',
  'Kartenzahlung Girocard',
  'Vielen Dank für Ihren Einkauf',
  'ARAL AG',
  'HRB 12345 Amtsgericht München',
  'Geschäftsführer: Max Mustermann',
].join('\n');

const PURE_HANDELSREGISTER = [
  'Muster GmbH',
  'Handelsregisterauszug',
  'HRB 98765',
  'Amtsgericht Frankfurt',
  'Geschäftsführer: Anna Beispiel',
  'Gesellschaftsvertrag',
  'Stammkapital 25.000 EUR',
].join('\n');

const EC_RECEIPT = [
  'REWE Markt',
  'EC-Beleg',
  'Summe',
  '18,42 EUR',
  'Kartenzahlung Girocard',
  'Terminal 04',
  'Danke',
].join('\n');

const INVOICE_TEXT = [
  'Müller Bau GmbH',
  'Musterstraße 1',
  '12345 Musterstadt',
  'Rechnungsnummer: INV-2026-77',
  'Datum: 12.03.2026',
  'Leistung: Sanierung Dach',
  'Gesamtbetrag 1.247,80 EUR',
  'IBAN: DE89 3704 0044 0532 0130 00',
  'zahlbar bis 31.03.2026',
].join('\n');

function scoreText(text: string) {
  const zoned = zoneText(text);
  const features = extractDocumentFeatures(zoned);
  return scoreReceiptCandidates(features.features);
}

describe('documentReceiptCandidateScoringService', () => {
  it('prefers tankbeleg over handelsregister when body receipt evidence dominates footer register markers', () => {
    const result = scoreText(TANK_RECEIPT_WITH_REGISTER_FOOTER);

    expect(result.winnerKind).toBe('tankbeleg');
    expect(result.candidates[0]?.kind).toBe('tankbeleg');

    const tankCandidate = result.candidates.find((candidate) => candidate.kind === 'tankbeleg');
    const registerCandidate = result.candidates.find((candidate) => candidate.kind === 'handelsregister');

    expect(tankCandidate?.score).toBeGreaterThan(registerCandidate?.score ?? 0);
    expect(tankCandidate?.structuralEvidenceRefs.length).toBeGreaterThan(0);
    expect(tankCandidate?.positiveEvidenceRefs.length).toBeGreaterThan(0);
    expect(result.margin).toBeGreaterThan(0.12);
  });

  it('ranks handelsregister highest on a register-focused document', () => {
    const result = scoreText(PURE_HANDELSREGISTER);

    expect(result.winnerKind).toBe('handelsregister');
    expect(result.candidates[0]?.kind).toBe('handelsregister');
    expect(result.candidates[0]?.positiveEvidenceRefs.length).toBeGreaterThan(0);
  });

  it('prefers ec_beleg when card payment evidence is present', () => {
    const result = scoreText(EC_RECEIPT);

    expect(result.winnerKind).toBe('ec_beleg');
    expect(result.candidates[0]?.kind).toBe('ec_beleg');
    expect(result.candidates[0]?.positiveEvidenceRefs.length).toBeGreaterThan(0);
  });

  it('prefers eingangsrechnung over receipt kinds for invoice-shaped documents', () => {
    const result = scoreText(INVOICE_TEXT);

    expect(result.winnerKind).toBe('eingangsrechnung');
    expect(result.candidates[0]?.kind).toBe('eingangsrechnung');
    expect(result.candidates[0]?.positiveEvidenceRefs.length).toBeGreaterThan(0);
  });

  it('emits footer_dominates_body only when footer register outweighs body receipt evidence', () => {
    const tankResult = scoreText(TANK_RECEIPT_WITH_REGISTER_FOOTER);
    expect(tankResult.conflicts.some((conflict) => conflict.type === 'footer_dominates_body')).toBe(
      false,
    );

    const registerOnlyBody = [
      'Firma GmbH',
      'Produkte und Dienstleistungen',
      'HRB 11111 Amtsgericht Köln',
      'Geschäftsführer: Test Person',
    ].join('\n');
    const registerResult = scoreText(registerOnlyBody);
    expect(registerResult.winnerKind).toBe('handelsregister');
  });

  it('marks close decisions for review via candidates_too_close when scores are near', () => {
    const ambiguous = ['Beleg', '52,18 EUR', 'Danke'].join('\n');
    const result = scoreText(ambiguous);

    expect(result.candidates.length).toBeGreaterThan(1);
    if (result.margin < 0.12) {
      expect(result.needsReview).toBe(true);
      expect(result.conflicts.some((conflict) => conflict.type === 'candidates_too_close')).toBe(true);
    }
  });

  it('builds a valid shadow analysis result with scored candidates and merged evidence', () => {
    const zoned = zoneText(TANK_RECEIPT_WITH_REGISTER_FOOTER);
    const featureResult = extractDocumentFeatures(zoned);
    const scoringResult = scoreReceiptCandidates(featureResult.features);
    const classification = classifyDocument({ recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER });

    const analysis = buildShadowScoredDocumentAnalysis({
      classification,
      recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER,
      zonedText: zoned,
      featureResult,
      mergedEvidenceIndex: featureResult.evidenceIndex,
      scoringResult,
      ocrQuality: { score: 0.9, readable: true, partialRecognition: false },
    });

    expect(validateDocumentAnalysisResult(analysis).valid).toBe(true);
    expect(analysis.classification.kind).toBe('tankbeleg');
    expect(analysis.classification.candidates.length).toBeGreaterThan(1);
    expect(analysis.classification.source).toBe('rules');
    expect(analysis.warnings).not.toContain('legacy:no_weighted_candidate_scoring');
    expect(analysis.classification.candidates[0]?.positiveEvidenceRefs.length).toBeGreaterThan(0);
  });

  it('adds a mismatch warning when shadow winner differs from legacy classification', () => {
    const zoned = zoneText(TANK_RECEIPT_WITH_REGISTER_FOOTER);
    const featureResult = extractDocumentFeatures(zoned);
    const scoringResult = scoreReceiptCandidates(featureResult.features);
    const classification = classifyDocument({ recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER });

    const analysis = buildShadowScoredDocumentAnalysis({
      classification,
      recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER,
      zonedText: zoned,
      featureResult,
      mergedEvidenceIndex: featureResult.evidenceIndex,
      scoringResult,
      ocrQuality: { score: 0.9, readable: true, partialRecognition: false },
    });

    if (classification.classifiedKind !== scoringResult.winnerKind) {
      expect(analysis.warnings).toContain('shadow:classification_mismatch');
    }
  });

  it('does not change productive classification when shadow scoring runs', () => {
    resetLegacyAnalysisShadowInvocationCountForTests();
    const result = classifyDocument({ recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER });

    expect(['tankbeleg', 'handelsregister']).toContain(result.classifiedKind);
    expect(result.detectionReasonKey).toBeTruthy();
  });

  it('does not log document contents during shadow scoring', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    classifyDocument({ recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER });

    const logged = [...logSpy.mock.calls, ...debugSpy.mock.calls].flat().join(' ');
    expect(logged).not.toContain('HRB 12345');
    expect(logged).not.toContain('Kartenzahlung');

    logSpy.mockRestore();
    debugSpy.mockRestore();
  });
});
