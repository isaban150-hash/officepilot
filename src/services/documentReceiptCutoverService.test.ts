import { afterEach, describe, expect, it } from 'vitest';
import {
  DI_RECEIPT_SCORING_REASON_KEY,
  setReceiptScoringCutoverEnabledForTests,
} from '../config/documentIntelligenceConfig';
import { classifyDocument, detectClassifiedKindWithReason } from './documentClassificationService';
import { resolveClassificationDetection } from './documentClassificationHybridService';
import { runReceiptAnalysisPipeline } from './documentReceiptAnalysisPipelineService';
import { evaluateReceiptCutoverEligibility } from './documentReceiptCutoverService';
import { mapClassifiedKindToExpenseCategory } from './expenseCategoryMapping';

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

describe('documentReceiptCutoverService', () => {
  afterEach(() => {
    setReceiptScoringCutoverEnabledForTests(null);
  });

  it('accepts a clear tankbeleg with register footer when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER });
    const decision = evaluateReceiptCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('tankbeleg');
    expect(decision.detection?.reasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });

  it('rejects cutover when the feature flag is disabled', () => {
    setReceiptScoringCutoverEnabledForTests(false);
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER });
    expect(evaluateReceiptCutoverEligibility(pipeline).eligible).toBe(false);
  });

  it('rejects cutover for register-only documents', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: PURE_HANDELSREGISTER });
    const decision = evaluateReceiptCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBeTruthy();
  });

  it('rejects cutover when OCR text is missing', () => {
    expect(evaluateReceiptCutoverEligibility(null).rejectionReason).toBe('cutover:no_text');
  });
});

describe('documentClassificationHybridService', () => {
  afterEach(() => {
    setReceiptScoringCutoverEnabledForTests(null);
  });

  it('productively applies tankbeleg cutover for HRB footer receipts', () => {
    const result = classifyDocument({ recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER });

    expect(result.classifiedKind).toBe('tankbeleg');
    expect(result.detectionReasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
    expect(result.recognizedData.Dokumentart).toBe('tankbeleg');
    expect(result.recognizedData.Betrag).toContain('52,18');
    expect(result.recognizedData.Betrag).not.toBe('85,40 €');
    expect(mapClassifiedKindToExpenseCategory(result.classifiedKind)).toBe('fahrzeug');
  });

  it('falls back to legacy when cutover is disabled', () => {
    setReceiptScoringCutoverEnabledForTests(false);
    const legacy = detectClassifiedKindWithReason({ recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER });
    const result = classifyDocument({ recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER });

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).toBe(legacy.reasonKey);
  });

  it('falls back to legacy when an upload kind hint is present', () => {
    const legacy = detectClassifiedKindWithReason({
      recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER,
      kindHint: 'handelsregister',
    });
    const resolution = resolveClassificationDetection(
      { recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER, kindHint: 'handelsregister' },
      legacy,
    );

    expect(resolution.cutoverApplied).toBe(false);
    expect(resolution.detection).toEqual(legacy);
  });

  it('keeps legacy classification for pure handelsregister documents', () => {
    const result = classifyDocument({ recognizedText: PURE_HANDELSREGISTER });
    expect(result.classifiedKind).toBe('handelsregisterauszug');
    expect(result.detectionReasonKey).not.toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });

  it('rebuilds classification fields from the final kind after cutover', () => {
    const result = classifyDocument({
      recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER,
      senderHint: 'ARAL Tankstelle',
    });

    expect(result.classifiedKind).toBe('tankbeleg');
    expect(result.digitalFolder.path).toContain('Tankbelege');
    expect(result.processType).toBe('record_expense');
  });
});
