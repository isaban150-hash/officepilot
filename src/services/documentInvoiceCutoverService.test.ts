import { afterEach, describe, expect, it } from 'vitest';
import {
  DI_INVOICE_SCORING_REASON_KEY,
  DI_RECEIPT_SCORING_REASON_KEY,
  setInvoiceScoringCutoverEnabledForTests,
  setReceiptScoringCutoverEnabledForTests,
} from '../config/documentIntelligenceConfig';
import { classifyDocument, detectClassifiedKindWithReason } from './documentClassificationService';
import { resolveClassificationDetection } from './documentClassificationHybridService';
import { runReceiptAnalysisPipeline } from './documentReceiptAnalysisPipelineService';
import { evaluateInvoiceCutoverEligibility } from './documentInvoiceCutoverService';

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

const MAHNUNG_TEXT = [
  'Müller Bau GmbH',
  '2. Mahnung',
  'Rechnungsnummer: INV-2026-77',
  'Offener Betrag: 1.247,80 EUR',
  'Zahlbar bis 31.03.2026',
  'IBAN: DE89 3704 0044 0532 0130 00',
].join('\n');

const TANK_RECEIPT_WITH_REGISTER_FOOTER = [
  'ARAL Tankstelle München',
  'Diesel 52,18 EUR',
  'Kartenzahlung Girocard',
  'Vielen Dank für Ihren Einkauf',
  'ARAL AG',
  'HRB 12345 Amtsgericht München',
  'Geschäftsführer: Max Mustermann',
].join('\n');

const EC_RECEIPT = [
  'REWE Markt München',
  'EC-Beleg',
  'Datum 14.07.2026',
  'Kartenzahlung Girocard',
  'Summe 18,42 EUR',
  'Terminal-ID 04',
  'Beleg-Nr. EC-4421',
  'Danke für Ihren Einkauf',
].join('\n');

const AMBIGUOUS_INVOICE = ['Rechnung', '1.247,80 EUR', 'Danke'].join('\n');

describe('documentInvoiceCutoverService', () => {
  afterEach(() => {
    setInvoiceScoringCutoverEnabledForTests(null);
    setReceiptScoringCutoverEnabledForTests(null);
  });

  it('accepts a clear eingangsrechnung when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: INVOICE_TEXT });
    const decision = evaluateInvoiceCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('eingangsrechnung');
    expect(decision.detection?.reasonKey).toBe(DI_INVOICE_SCORING_REASON_KEY);
  });

  it('rejects cutover when the feature flag is disabled', () => {
    setInvoiceScoringCutoverEnabledForTests(false);
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: INVOICE_TEXT });
    expect(evaluateInvoiceCutoverEligibility(pipeline).eligible).toBe(false);
  });

  it('rejects cutover for mahnung texts via exclusion guard', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: MAHNUNG_TEXT });
    const decision = evaluateInvoiceCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:mahnung_excluded');
  });

  it('rejects cutover when margin is too low', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: AMBIGUOUS_INVOICE });
    const decision = evaluateInvoiceCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBeTruthy();
  });

  it('rejects cutover when OCR text is missing', () => {
    expect(evaluateInvoiceCutoverEligibility(null).rejectionReason).toBe('cutover:no_text');
  });
});

describe('documentInvoiceCutoverHybridService', () => {
  afterEach(() => {
    setInvoiceScoringCutoverEnabledForTests(null);
    setReceiptScoringCutoverEnabledForTests(null);
  });

  it('productively applies eingangsrechnung cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: INVOICE_TEXT });

    expect(result.classifiedKind).toBe('eingangsrechnung');
    expect(result.detectionReasonKey).toBe(DI_INVOICE_SCORING_REASON_KEY);
    expect(result.recognizedData.Rechnungsnummer).toBe('INV-2026-77');
    expect(result.recognizedData.Betrag).toContain('1.247,80');
    expect(result.recognizedData.Lieferant).toBe('Müller Bau GmbH');
    expect(result.processType).toBe('record_expense');
  });

  it('keeps legacy classification for mahnung documents', () => {
    const legacy = detectClassifiedKindWithReason({ recognizedText: MAHNUNG_TEXT });
    const result = classifyDocument({ recognizedText: MAHNUNG_TEXT });

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.classifiedKind).toBe('mahnung');
    expect(result.detectionReasonKey).toBe(legacy.reasonKey);
    expect(result.detectionReasonKey).not.toBe(DI_INVOICE_SCORING_REASON_KEY);
  });

  it('keeps receipt cutover unchanged for tankbeleg', () => {
    const result = classifyDocument({ recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER });

    expect(result.classifiedKind).toBe('tankbeleg');
    expect(result.detectionReasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });

  it('keeps receipt cutover unchanged for ec_beleg', () => {
    const result = classifyDocument({ recognizedText: EC_RECEIPT });

    expect(result.classifiedKind).toBe('ec_beleg');
    expect(result.detectionReasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });

  it('falls back to legacy when invoice cutover is disabled', () => {
    setInvoiceScoringCutoverEnabledForTests(false);
    const legacy = detectClassifiedKindWithReason({ recognizedText: INVOICE_TEXT });
    const result = classifyDocument({ recognizedText: INVOICE_TEXT });

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).toBe(legacy.reasonKey);
    expect(result.detectionReasonKey).not.toBe(DI_INVOICE_SCORING_REASON_KEY);
  });

  it('falls back to legacy when an upload kind hint is present', () => {
    const legacy = detectClassifiedKindWithReason({
      recognizedText: INVOICE_TEXT,
      kindHint: 'eingangsrechnung',
    });
    const resolution = resolveClassificationDetection(
      { recognizedText: INVOICE_TEXT, kindHint: 'eingangsrechnung' },
      legacy,
    );

    expect(resolution.cutoverApplied).toBe(false);
    expect(resolution.detection).toEqual(legacy);
  });

  it('rebuilds classification fields from the final kind after invoice cutover', () => {
    const result = classifyDocument({
      recognizedText: INVOICE_TEXT,
      senderHint: 'Müller Bau GmbH',
    });

    expect(result.classifiedKind).toBe('eingangsrechnung');
    expect(result.digitalFolder.path).toContain('Eingangsrechnungen');
    expect(result.processType).toBe('record_expense');
  });

  it('falls back to legacy when OCR text is missing', () => {
    const legacy = detectClassifiedKindWithReason({});
    const result = classifyDocument({});

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).not.toBe(DI_INVOICE_SCORING_REASON_KEY);
  });
});
