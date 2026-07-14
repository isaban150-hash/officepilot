import { afterEach, describe, expect, it } from 'vitest';
import {
  DI_AUTHORITY_SCORING_REASON_KEY,
  DI_CERTIFICATE_SCORING_REASON_KEY,
  DI_INVOICE_SCORING_REASON_KEY,
  DI_PAYMENT_SCORING_REASON_KEY,
  DI_RECEIPT_SCORING_REASON_KEY,
  setAuthorityScoringCutoverEnabledForTests,
  setCertificateScoringCutoverEnabledForTests,
  setInvoiceScoringCutoverEnabledForTests,
  setPaymentScoringCutoverEnabledForTests,
  setReceiptScoringCutoverEnabledForTests,
} from '../config/documentIntelligenceConfig';
import { classifyDocument, detectClassifiedKindWithReason } from './documentClassificationService';
import { resolveClassificationDetection } from './documentClassificationHybridService';
import { runReceiptAnalysisPipeline } from './documentReceiptAnalysisPipelineService';
import { evaluateCertificateCutoverEligibility } from './documentCertificateCutoverService';

const FREISTELLUNG_TEXT = [
  'Finanzamt München',
  'Freistellungsbescheinigung §48b',
  'Betreff: Freistellungsbescheinigung nach §48b EStG',
  'Aussteller: Finanzamt München',
  'Datum: 15.03.2026',
  'gültig bis 31.12.2027',
].join('\n');

const UNBEDENKLICHKEIT_TEXT = [
  'BG BAU',
  'Unbedenklichkeitsbescheinigung',
  'Mustermann Sanitär GmbH',
  'Betreff: Unbedenklichkeit Beiträge',
  'Aussteller: BG BAU',
  'Datum: 01.04.2026',
  'gültig bis 30.06.2027',
].join('\n');

const STEUERBESCHEID_TEXT = [
  'Finanzamt Frankfurt',
  'Steuerbescheid 2025',
  'Aktenzeichen: 123/456/78901',
  'Betreff: Festsetzung Einkommensteuer',
  'Frist: 15.06.2026',
].join('\n');

const CONTRACT_WITH_CERT_MENTION = [
  'Bau-Subunternehmervertrag',
  'Werkvertrag',
  'Auftraggeber: Müller Bau GmbH',
  'Freistellungsbescheinigung, BG BAU Unbedenklichkeitsbescheinigung',
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

const AMBIGUOUS_CERTIFICATE = ['Freistellung', '31.12.2027', 'Danke'].join('\n');

describe('documentCertificateCutoverService', () => {
  afterEach(() => {
    setCertificateScoringCutoverEnabledForTests(null);
  });

  it('accepts a clear freistellungsbescheinigung when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: FREISTELLUNG_TEXT });
    const decision = evaluateCertificateCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('freistellungsbescheinigung');
    expect(decision.detection?.reasonKey).toBe(DI_CERTIFICATE_SCORING_REASON_KEY);
  });

  it('accepts a clear unbedenklichkeitsbescheinigung when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: UNBEDENKLICHKEIT_TEXT });
    const decision = evaluateCertificateCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('unbedenklichkeitsbescheinigung');
  });

  it('rejects cutover when the feature flag is disabled', () => {
    setCertificateScoringCutoverEnabledForTests(false);
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: FREISTELLUNG_TEXT });
    expect(evaluateCertificateCutoverEligibility(pipeline).eligible).toBe(false);
  });

  it('rejects cutover for contract texts via contract exclusion guard', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: CONTRACT_WITH_CERT_MENTION });
    const decision = evaluateCertificateCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:contract_excluded');
  });

  it('rejects cutover for mahnung texts via payment exclusion guard', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: MAHNUNG_TEXT });
    const decision = evaluateCertificateCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:payment_excluded');
  });

  it('rejects cutover when margin is too low', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: AMBIGUOUS_CERTIFICATE });
    const decision = evaluateCertificateCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBeTruthy();
  });

  it('rejects cutover when OCR text is missing', () => {
    expect(evaluateCertificateCutoverEligibility(null).rejectionReason).toBe('cutover:no_text');
  });
});

describe('documentCertificateCutoverHybridService', () => {
  afterEach(() => {
    setCertificateScoringCutoverEnabledForTests(null);
    setReceiptScoringCutoverEnabledForTests(null);
    setInvoiceScoringCutoverEnabledForTests(null);
    setPaymentScoringCutoverEnabledForTests(null);
    setAuthorityScoringCutoverEnabledForTests(null);
  });

  it('productively applies freistellungsbescheinigung cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: FREISTELLUNG_TEXT });

    expect(result.classifiedKind).toBe('freistellungsbescheinigung');
    expect(result.detectionReasonKey).toBe(DI_CERTIFICATE_SCORING_REASON_KEY);
    expect(result.recognizedData.Betreff).toBe('Freistellungsbescheinigung nach §48b EStG');
    expect(result.recognizedData.Aussteller).toBe('Finanzamt München');
    expect(result.recognizedData.Gültig_bis).toBe('31.12.2027');
    expect(result.recognizedData.Gültig_bis).not.toBe('31.12.2026');
    expect(result.recognizedData.Datum).toBe('15.03.2026');
    expect(result.processType).toBe('send_to_client');
  });

  it('productively applies unbedenklichkeitsbescheinigung cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: UNBEDENKLICHKEIT_TEXT });

    expect(result.classifiedKind).toBe('unbedenklichkeitsbescheinigung');
    expect(result.detectionReasonKey).toBe(DI_CERTIFICATE_SCORING_REASON_KEY);
    expect(result.recognizedData.Aussteller).toBe('BG BAU');
    expect(result.recognizedData.Gültig_bis).toBe('30.06.2027');
    expect(result.recognizedData.Gültig_bis).not.toBe('31.12.2026');
    expect(result.recognizedData.Datum).toBe('01.04.2026');
  });

  it('keeps steuerbescheid on authority cutover, not certificate', () => {
    const result = classifyDocument({ recognizedText: STEUERBESCHEID_TEXT });

    expect(result.classifiedKind).toBe('steuerbescheid');
    expect(result.detectionReasonKey).toBe(DI_AUTHORITY_SCORING_REASON_KEY);
    expect(result.detectionReasonKey).not.toBe(DI_CERTIFICATE_SCORING_REASON_KEY);
  });

  it('keeps freistellung distinct from unbedenklichkeit', () => {
    const freistellung = classifyDocument({ recognizedText: FREISTELLUNG_TEXT });
    const unbedenklichkeit = classifyDocument({ recognizedText: UNBEDENKLICHKEIT_TEXT });

    expect(freistellung.classifiedKind).toBe('freistellungsbescheinigung');
    expect(unbedenklichkeit.classifiedKind).toBe('unbedenklichkeitsbescheinigung');
  });

  it('keeps contract documents on legacy, not certificate cutover', () => {
    const result = classifyDocument({ recognizedText: CONTRACT_WITH_CERT_MENTION });

    expect(result.detectionReasonKey).not.toBe(DI_CERTIFICATE_SCORING_REASON_KEY);
    expect(['werkvertrag', 'subunternehmervertrag']).toContain(result.classifiedKind);
  });

  it('keeps invoice on invoice cutover, not certificate', () => {
    const result = classifyDocument({ recognizedText: INVOICE_TEXT });

    expect(result.classifiedKind).toBe('eingangsrechnung');
    expect(result.detectionReasonKey).toBe(DI_INVOICE_SCORING_REASON_KEY);
  });

  it('keeps mahnung on payment cutover, not certificate', () => {
    const result = classifyDocument({ recognizedText: MAHNUNG_TEXT });

    expect(result.classifiedKind).toBe('mahnung');
    expect(result.detectionReasonKey).toBe(DI_PAYMENT_SCORING_REASON_KEY);
  });

  it('keeps receipt cutover unchanged for tankbeleg', () => {
    const result = classifyDocument({ recognizedText: TANK_RECEIPT });

    expect(result.classifiedKind).toBe('tankbeleg');
    expect(result.detectionReasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });

  it('falls back to legacy when certificate cutover is disabled', () => {
    setCertificateScoringCutoverEnabledForTests(false);
    const legacy = detectClassifiedKindWithReason({ recognizedText: FREISTELLUNG_TEXT });
    const result = classifyDocument({ recognizedText: FREISTELLUNG_TEXT });

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).toBe(legacy.reasonKey);
    expect(result.detectionReasonKey).not.toBe(DI_CERTIFICATE_SCORING_REASON_KEY);
  });

  it('falls back to legacy when an upload kind hint is present', () => {
    const legacy = detectClassifiedKindWithReason({
      recognizedText: FREISTELLUNG_TEXT,
      kindHint: 'freistellungsbescheinigung',
    });
    const resolution = resolveClassificationDetection(
      { recognizedText: FREISTELLUNG_TEXT, kindHint: 'freistellungsbescheinigung' },
      legacy,
    );

    expect(resolution.cutoverApplied).toBe(false);
    expect(resolution.detection).toEqual(legacy);
  });

  it('falls back to legacy when OCR text is missing', () => {
    const legacy = detectClassifiedKindWithReason({});
    const result = classifyDocument({});

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).not.toBe(DI_CERTIFICATE_SCORING_REASON_KEY);
  });
});
