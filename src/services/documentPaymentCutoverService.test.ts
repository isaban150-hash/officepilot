import { afterEach, describe, expect, it } from 'vitest';
import {
  DI_INVOICE_SCORING_REASON_KEY,
  DI_PAYMENT_SCORING_REASON_KEY,
  DI_RECEIPT_SCORING_REASON_KEY,
  setInvoiceScoringCutoverEnabledForTests,
  setPaymentScoringCutoverEnabledForTests,
  setReceiptScoringCutoverEnabledForTests,
} from '../config/documentIntelligenceConfig';
import { classifyDocument, detectClassifiedKindWithReason } from './documentClassificationService';
import { resolveClassificationDetection } from './documentClassificationHybridService';
import { runReceiptAnalysisPipeline } from './documentReceiptAnalysisPipelineService';
import { evaluatePaymentCutoverEligibility } from './documentPaymentCutoverService';

const MAHNUNG_TEXT = [
  'Müller Bau GmbH',
  'Musterstraße 1',
  '12345 Musterstadt',
  '2. Mahnung',
  'Rechnungsnummer: INV-2026-77',
  'Datum: 12.03.2026',
  'Offener Betrag: 1.247,80 EUR',
  'Zahlungsaufforderung',
  'Zahlbar bis 31.03.2026',
].join('\n');

const ZAHLUNGSERINNERUNG_TEXT = [
  'Müller Bau GmbH',
  'Musterstraße 1',
  'Zahlungserinnerung',
  'Rechnungsnummer: INV-2026-55',
  'Datum: 08.03.2026',
  'Offener Betrag: 842,50 EUR',
  'Zahlbar bis 22.03.2026',
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

const TANK_RECEIPT = [
  'ARAL Tankstelle München',
  'Diesel 52,18 EUR',
  'Kartenzahlung Girocard',
  'Vielen Dank für Ihren Einkauf',
].join('\n');

const AMBIGUOUS_PAYMENT = ['Mahnung', '842,50 EUR', 'Danke'].join('\n');

describe('documentPaymentCutoverService', () => {
  afterEach(() => {
    setPaymentScoringCutoverEnabledForTests(null);
    setReceiptScoringCutoverEnabledForTests(null);
    setInvoiceScoringCutoverEnabledForTests(null);
  });

  it('accepts a clear mahnung when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: MAHNUNG_TEXT });
    const decision = evaluatePaymentCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('mahnung');
    expect(decision.detection?.reasonKey).toBe(DI_PAYMENT_SCORING_REASON_KEY);
  });

  it('accepts a clear zahlungserinnerung when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: ZAHLUNGSERINNERUNG_TEXT });
    const decision = evaluatePaymentCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('zahlungserinnerung');
    expect(decision.detection?.reasonKey).toBe(DI_PAYMENT_SCORING_REASON_KEY);
  });

  it('rejects cutover when the feature flag is disabled', () => {
    setPaymentScoringCutoverEnabledForTests(false);
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: MAHNUNG_TEXT });
    expect(evaluatePaymentCutoverEligibility(pipeline).eligible).toBe(false);
  });

  it('rejects cutover when margin is too low', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: AMBIGUOUS_PAYMENT });
    const decision = evaluatePaymentCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBeTruthy();
  });

  it('rejects cutover when OCR text is missing', () => {
    expect(evaluatePaymentCutoverEligibility(null).rejectionReason).toBe('cutover:no_text');
  });
});

describe('documentPaymentCutoverHybridService', () => {
  afterEach(() => {
    setPaymentScoringCutoverEnabledForTests(null);
    setReceiptScoringCutoverEnabledForTests(null);
    setInvoiceScoringCutoverEnabledForTests(null);
  });

  it('productively applies mahnung cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: MAHNUNG_TEXT });

    expect(result.classifiedKind).toBe('mahnung');
    expect(result.detectionReasonKey).toBe(DI_PAYMENT_SCORING_REASON_KEY);
    expect(result.recognizedData.Rechnungsnummer).toBe('INV-2026-77');
    expect(result.recognizedData.Betrag).toContain('1.247,80');
    expect(result.recognizedData.Betrag).not.toBe('342,16 €');
    expect(result.recognizedData.Fälligkeit).toBe('31.03.2026');
    expect(result.recognizedData.Fälligkeit).not.toBe('30.03.2026');
    expect(result.recognizedData.Lieferant).toBe('Müller Bau GmbH');
    expect(result.recognizedData.Hinweis).toMatch(/mahnung/i);
    expect(result.deadline).toBe('31.03.2026');
    expect(result.deadline).not.toBe('2026-03-30');
    expect(result.processType).toBe('reminder_required');
  });

  it('productively applies zahlungserinnerung cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: ZAHLUNGSERINNERUNG_TEXT });

    expect(result.classifiedKind).toBe('zahlungserinnerung');
    expect(result.detectionReasonKey).toBe(DI_PAYMENT_SCORING_REASON_KEY);
    expect(result.recognizedData.Rechnungsnummer).toBe('INV-2026-55');
    expect(result.recognizedData.Betrag).toContain('842,50');
    expect(result.recognizedData.Fälligkeit).toBe('22.03.2026');
    expect(result.recognizedData.Hinweis).toMatch(/zahlungserinnerung/i);
    expect(result.processType).toBe('reminder_required');
  });

  it('keeps eingangsrechnung cutover for invoice-shaped documents without payment markers', () => {
    const result = classifyDocument({ recognizedText: INVOICE_TEXT });

    expect(result.classifiedKind).toBe('eingangsrechnung');
    expect(result.detectionReasonKey).toBe(DI_INVOICE_SCORING_REASON_KEY);
    expect(result.detectionReasonKey).not.toBe(DI_PAYMENT_SCORING_REASON_KEY);
  });

  it('keeps receipt cutover unchanged for tankbeleg', () => {
    const result = classifyDocument({ recognizedText: TANK_RECEIPT });

    expect(result.classifiedKind).toBe('tankbeleg');
    expect(result.detectionReasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });

  it('falls back to legacy when payment cutover is disabled', () => {
    setPaymentScoringCutoverEnabledForTests(false);
    const legacy = detectClassifiedKindWithReason({ recognizedText: MAHNUNG_TEXT });
    const result = classifyDocument({ recognizedText: MAHNUNG_TEXT });

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).toBe(legacy.reasonKey);
    expect(result.detectionReasonKey).not.toBe(DI_PAYMENT_SCORING_REASON_KEY);
    expect(result.classifiedKind).toBe('mahnung');
  });

  it('falls back to legacy when an upload kind hint is present', () => {
    const legacy = detectClassifiedKindWithReason({
      recognizedText: MAHNUNG_TEXT,
      kindHint: 'mahnung',
    });
    const resolution = resolveClassificationDetection(
      { recognizedText: MAHNUNG_TEXT, kindHint: 'mahnung' },
      legacy,
    );

    expect(resolution.cutoverApplied).toBe(false);
    expect(resolution.detection).toEqual(legacy);
  });

  it('rebuilds classification fields from the final kind after payment cutover', () => {
    const result = classifyDocument({
      recognizedText: MAHNUNG_TEXT,
      senderHint: 'Müller Bau GmbH',
    });

    expect(result.classifiedKind).toBe('mahnung');
    expect(result.digitalFolder.path).toContain('Mahnungen');
    expect(result.priority).toBe('kritisch');
  });

  it('falls back to legacy when OCR text is missing', () => {
    const legacy = detectClassifiedKindWithReason({});
    const result = classifyDocument({});

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).not.toBe(DI_PAYMENT_SCORING_REASON_KEY);
    expect(result.deadline).toBeNull();
  });
});
