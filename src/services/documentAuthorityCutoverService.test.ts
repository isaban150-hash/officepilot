import { afterEach, describe, expect, it } from 'vitest';
import {
  DI_AUTHORITY_SCORING_REASON_KEY,
  DI_INVOICE_SCORING_REASON_KEY,
  DI_PAYMENT_SCORING_REASON_KEY,
  DI_RECEIPT_SCORING_REASON_KEY,
  setAuthorityScoringCutoverEnabledForTests,
  setInvoiceScoringCutoverEnabledForTests,
  setPaymentScoringCutoverEnabledForTests,
  setReceiptScoringCutoverEnabledForTests,
} from '../config/documentIntelligenceConfig';
import { classifyDocument, detectClassifiedKindWithReason } from './documentClassificationService';
import { resolveClassificationDetection } from './documentClassificationHybridService';
import { runReceiptAnalysisPipeline } from './documentReceiptAnalysisPipelineService';
import { evaluateAuthorityCutoverEligibility } from './documentAuthorityCutoverService';

const FINANZAMT_TEXT = [
  'Finanzamt München',
  'Musterstraße 1',
  '80331 München',
  'Betreff: Umsatzsteuervoranmeldung',
  'Aktenzeichen: 143/123/45678',
  'Datum: 15.02.2026',
  'Frist: 10.05.2026',
  'Lohnsteuer-Anmeldung Q1',
].join('\n');

const BG_BAU_TEXT = [
  'BG BAU',
  'Berufsgenossenschaft der Bauwirtschaft',
  'Region Süd',
  'Beitragsbescheid 2026',
  'Betreff: Beitragsbescheid',
  'Aktenzeichen: BEI-2026-4455',
  'Betrag: 1.250,00 EUR',
  'Frist: 30.04.2026',
].join('\n');

const STEUERBESCHEID_TEXT = [
  'Finanzamt Frankfurt',
  'Steuerbescheid 2025',
  'Aktenzeichen: 123/456/78901',
  'Betreff: Festsetzung Einkommensteuer',
  'Frist: 15.06.2026',
  'Festsetzung Einkommensteuer 2024',
].join('\n');

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
].join('\n');

const CONTRACT_WITH_BG_MENTION = [
  'Bau-Subunternehmervertrag',
  'Werkvertrag',
  'Auftraggeber: Müller Bau GmbH',
  'Freistellungsbescheinigung, BG BAU Unbedenklichkeitsbescheinigung',
].join('\n');

const AMBIGUOUS_AUTHORITY = ['Finanzamt', '1.250,00 EUR', 'Danke'].join('\n');

describe('documentAuthorityCutoverService', () => {
  afterEach(() => {
    setAuthorityScoringCutoverEnabledForTests(null);
    setReceiptScoringCutoverEnabledForTests(null);
    setInvoiceScoringCutoverEnabledForTests(null);
    setPaymentScoringCutoverEnabledForTests(null);
  });

  it('accepts a clear finanzamt document when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: FINANZAMT_TEXT });
    const decision = evaluateAuthorityCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('finanzamt');
    expect(decision.detection?.reasonKey).toBe(DI_AUTHORITY_SCORING_REASON_KEY);
  });

  it('accepts a clear bg_bau document when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: BG_BAU_TEXT });
    const decision = evaluateAuthorityCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('bg_bau');
  });

  it('accepts a clear steuerbescheid document when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: STEUERBESCHEID_TEXT });
    const decision = evaluateAuthorityCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('steuerbescheid');
  });

  it('rejects cutover when the feature flag is disabled', () => {
    setAuthorityScoringCutoverEnabledForTests(false);
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: FINANZAMT_TEXT });
    expect(evaluateAuthorityCutoverEligibility(pipeline).eligible).toBe(false);
  });

  it('rejects cutover for mahnung texts via payment exclusion guard', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: MAHNUNG_TEXT });
    const decision = evaluateAuthorityCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:payment_excluded');
  });

  it('rejects cutover for contract texts via contract exclusion guard', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: CONTRACT_WITH_BG_MENTION });
    const decision = evaluateAuthorityCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:contract_excluded');
  });

  it('rejects cutover when margin is too low', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: AMBIGUOUS_AUTHORITY });
    const decision = evaluateAuthorityCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBeTruthy();
  });

  it('rejects cutover when OCR text is missing', () => {
    expect(evaluateAuthorityCutoverEligibility(null).rejectionReason).toBe('cutover:no_text');
  });
});

describe('documentAuthorityCutoverHybridService', () => {
  afterEach(() => {
    setAuthorityScoringCutoverEnabledForTests(null);
    setReceiptScoringCutoverEnabledForTests(null);
    setInvoiceScoringCutoverEnabledForTests(null);
    setPaymentScoringCutoverEnabledForTests(null);
  });

  it('productively applies finanzamt cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: FINANZAMT_TEXT });

    expect(result.classifiedKind).toBe('finanzamt');
    expect(result.detectionReasonKey).toBe(DI_AUTHORITY_SCORING_REASON_KEY);
    expect(result.recognizedData.Betreff).toBe('Umsatzsteuervoranmeldung');
    expect(result.recognizedData.Aktenzeichen).toBe('143/123/45678');
    expect(result.recognizedData.Frist).toBe('10.05.2026');
    expect(result.recognizedData.Frist).not.toBe('10.04.2026');
    expect(result.recognizedData.Absender).toBe('Finanzamt München');
    expect(result.deadline).toBe('10.05.2026');
    expect(result.documentType).toBe('behoerde');
  });

  it('productively applies bg_bau cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: BG_BAU_TEXT });

    expect(result.classifiedKind).toBe('bg_bau');
    expect(result.detectionReasonKey).toBe(DI_AUTHORITY_SCORING_REASON_KEY);
    expect(result.recognizedData.Aktenzeichen).toBe('BEI-2026-4455');
    expect(result.recognizedData.Frist).toBe('30.04.2026');
    expect(result.recognizedData.Frist).not.toBe('10.04.2026');
    expect(result.recognizedData.Betrag).toContain('1.250,00');
    expect(result.recognizedData.Absender).toMatch(/BG BAU|Berufsgenossenschaft/i);
  });

  it('productively applies steuerbescheid cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: STEUERBESCHEID_TEXT });

    expect(result.classifiedKind).toBe('steuerbescheid');
    expect(result.detectionReasonKey).toBe(DI_AUTHORITY_SCORING_REASON_KEY);
    expect(result.recognizedData.Aktenzeichen).toBe('123/456/78901');
    expect(result.recognizedData.Frist).toBe('15.06.2026');
    expect(result.recognizedData.Betreff).toBe('Festsetzung Einkommensteuer');
  });

  it('keeps mahnung on payment cutover, not authority', () => {
    const result = classifyDocument({ recognizedText: MAHNUNG_TEXT });

    expect(result.classifiedKind).toBe('mahnung');
    expect(result.detectionReasonKey).toBe(DI_PAYMENT_SCORING_REASON_KEY);
    expect(result.detectionReasonKey).not.toBe(DI_AUTHORITY_SCORING_REASON_KEY);
  });

  it('keeps eingangsrechnung cutover for invoice-shaped documents', () => {
    const result = classifyDocument({ recognizedText: INVOICE_TEXT });

    expect(result.classifiedKind).toBe('eingangsrechnung');
    expect(result.detectionReasonKey).toBe(DI_INVOICE_SCORING_REASON_KEY);
  });

  it('keeps receipt cutover unchanged for tankbeleg', () => {
    const result = classifyDocument({ recognizedText: TANK_RECEIPT });

    expect(result.classifiedKind).toBe('tankbeleg');
    expect(result.detectionReasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });

  it('falls back to legacy when authority cutover is disabled', () => {
    setAuthorityScoringCutoverEnabledForTests(false);
    const legacy = detectClassifiedKindWithReason({ recognizedText: FINANZAMT_TEXT });
    const result = classifyDocument({ recognizedText: FINANZAMT_TEXT });

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).toBe(legacy.reasonKey);
    expect(result.detectionReasonKey).not.toBe(DI_AUTHORITY_SCORING_REASON_KEY);
    expect(result.recognizedData.Frist).toBe('10.05.2026');
    expect(result.recognizedData.Frist).not.toBe('10.04.2026');
  });

  it('falls back to legacy when an upload kind hint is present', () => {
    const legacy = detectClassifiedKindWithReason({
      recognizedText: FINANZAMT_TEXT,
      kindHint: 'finanzamt',
    });
    const resolution = resolveClassificationDetection(
      { recognizedText: FINANZAMT_TEXT, kindHint: 'finanzamt' },
      legacy,
    );

    expect(resolution.cutoverApplied).toBe(false);
    expect(resolution.detection).toEqual(legacy);
  });

  it('rebuilds classification fields from the final kind after authority cutover', () => {
    const result = classifyDocument({
      recognizedText: BG_BAU_TEXT,
      senderHint: 'BG BAU',
    });

    expect(result.classifiedKind).toBe('bg_bau');
    expect(result.digitalFolder.path).toContain('BG-BAU');
    expect(result.paperFiling.folderId).toBe('paper-behoerden');
  });

  it('falls back to legacy when OCR text is missing', () => {
    const legacy = detectClassifiedKindWithReason({});
    const result = classifyDocument({});

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).not.toBe(DI_AUTHORITY_SCORING_REASON_KEY);
    expect(result.deadline).toBeNull();
  });
});
