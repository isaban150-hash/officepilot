import { afterEach, describe, expect, it } from 'vitest';
import {
  DI_AUTHORITY_SCORING_REASON_KEY,
  DI_CERTIFICATE_SCORING_REASON_KEY,
  DI_CONTRACT_SCORING_REASON_KEY,
  DI_CUSTOMER_SCORING_REASON_KEY,
  DI_INVOICE_SCORING_REASON_KEY,
  DI_PAYMENT_SCORING_REASON_KEY,
  DI_RECEIPT_SCORING_REASON_KEY,
  setAuthorityScoringCutoverEnabledForTests,
  setCertificateScoringCutoverEnabledForTests,
  setContractScoringCutoverEnabledForTests,
  setCustomerScoringCutoverEnabledForTests,
  setInvoiceScoringCutoverEnabledForTests,
  setPaymentScoringCutoverEnabledForTests,
  setReceiptScoringCutoverEnabledForTests,
} from '../config/documentIntelligenceConfig';
import {
  SAMPLE_SUBUNTERNEHMERVERTRAG_TEXT,
  SAMPLE_WERKVERTRAG_TEXT,
} from './contractAnalysisService';
import { classifyDocument, detectClassifiedKindWithReason } from './documentClassificationService';
import { resolveClassificationDetection } from './documentClassificationHybridService';
import { runReceiptAnalysisPipeline } from './documentReceiptAnalysisPipelineService';
import {
  computeCustomerCutoverConfidence,
  evaluateCustomerCutoverEligibility,
} from './documentCustomerCutoverService';

const KUNDENAUFTRAG_TEXT = [
  'Müller Bau GmbH',
  'Kundenauftrag',
  'Betreff: Sanierung Fassade',
  'Auftraggeber: Stadt München',
  'Baustelle: Hauptstr. 12, 80331 München',
  'Auftragsnummer: KA-2026-0042',
  'Auftragssumme: 45.000,00 EUR',
  'Datum: 15.03.2026',
].join('\n');

const ANGEBOT_TEXT = [
  'Weber Elektro GmbH',
  'Angebot',
  'Betreff: Elektroinstallation Neubau',
  'Kunde: Weber GmbH',
  'Baustelle: Schulweg 5, 80331 München',
  'Angebotsnummer: AN-2026-118',
  'Angebotssumme: 12.500,00 EUR',
  'Datum: 20.02.2026',
].join('\n');

const KOSTENVORANSCHLAG_TEXT = [
  'Sanitär Meier OHG',
  'Angebot',
  'Kostenvoranschlag',
  'Betreff: Badsanierung',
  'Auftraggeber: Familie Schmidt',
  'Baustelle: Gartenweg 2, 80331 München',
  'Angebotsnummer: KV-2026-55',
  'Angebotssumme: 8.500,00 EUR',
  'Datum: 10.01.2026',
].join('\n');

const AUFTRAGSBESTAETIGUNG_TEXT = [
  'Großbau AG',
  'Auftragsbestätigung',
  'Betreff: Bestätigung Ihres Auftrags',
  'Auftraggeber: Großbau AG',
  'Baustelle: Werkstraße 8, 80333 München',
  'Auftragsnummer: AB-2026-77',
  'Datum: 01.04.2026',
  'Sehr geehrte Damen und Herren,',
  'wir bestätigen den Eingang Ihres Auftrages.',
].join('\n');

const CONFIRMATION_VS_AUFTRAG_TEXT = [
  'Müller Bau GmbH',
  'Auftragsbestätigung',
  'Kundenauftrag',
  'Betreff: Bestätigung Auftrag Sanierung',
  'Auftraggeber: Stadt München',
  'Baustelle: Hauptstr. 12, 80331 München',
  'Auftragsnummer: AB-2026-88',
  'Datum: 05.04.2026',
  'wir bestätigen den Eingang Ihres Auftrages.',
].join('\n');

const AUFTRAG_VS_VERTRAG_TEXT = [
  'Werkvertrag',
  'Kundenauftrag',
  'Auftraggeber: Müller Bau GmbH',
  'Subunternehmer: Mustermann Sanitär GmbH',
  'Baustellenadresse: Hauptstr. 12, 10115 Berlin',
  'Vertragsdatum: 15.03.2026',
  'Auftragsnummer: AV-2026-0042',
  'Leistungsverzeichnis',
  'Pos. Beschreibung Einheit Menge',
  '1 Rohrleitungsarbeiten m 120',
].join('\n');

const ANGEBOT_VS_INVOICE_TEXT = [
  'Müller Bau GmbH',
  'Angebot',
  'Rechnungsnummer: INV-2026-77',
  'Datum: 12.03.2026',
  'Leistung: Sanierung Dach',
  'Gesamtbetrag 1.247,80 EUR',
  'IBAN: DE89 3704 0044 0532 0130 00',
  'zahlbar bis 31.03.2026',
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

const FREISTELLUNG_TEXT = [
  'Finanzamt München',
  'Freistellungsbescheinigung §48b',
  'Betreff: Freistellungsbescheinigung nach §48b EStG',
  'Aussteller: Finanzamt München',
  'Datum: 15.03.2026',
  'gültig bis 31.12.2027',
].join('\n');

const FINANZAMT_TEXT = [
  'Finanzamt München',
  'Betreff: Umsatzsteuervoranmeldung',
  'Aktenzeichen: 143/123/45678',
  'Datum: 15.02.2026',
  'Frist: 10.05.2026',
].join('\n');

const TANK_RECEIPT = [
  'ARAL Tankstelle München',
  'Diesel 52,18 EUR',
  'Kartenzahlung Girocard',
].join('\n');

const KUNDENAUFTRAG_WITH_RECEIPT_NOISE = [
  'Müller Bau GmbH',
  'Kundenauftrag',
  'Betreff: Büromaterial',
  'Auftraggeber: Stadt München',
  'Baustelle: Hauptstr. 12, 80331 München',
  'Auftragsnummer: KA-2026-0042',
  'Datum: 15.03.2026',
  'Kassenbeleg Nr. 9982',
  'Summe 12,50 EUR',
].join('\n');

const AMBIGUOUS_CUSTOMER = ['Angebot', 'Auftrag', 'Danke'].join('\n');

const MIXED_CUSTOMER_KINDS = [
  'Angebot',
  'Kundenauftrag',
  'Betreff: Unklar',
  'Datum: 01.01.2026',
].join('\n');

describe('documentCustomerCutoverService', () => {
  afterEach(() => {
    setCustomerScoringCutoverEnabledForTests(null);
  });

  it('accepts a clear auftrag when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: KUNDENAUFTRAG_TEXT });
    const decision = evaluateCustomerCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('auftrag');
    expect(decision.detection?.reasonKey).toBe(DI_CUSTOMER_SCORING_REASON_KEY);
  });

  it('accepts a clear angebot when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: ANGEBOT_TEXT });
    const decision = evaluateCustomerCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('angebot');
    expect(decision.detection?.reasonKey).toBe(DI_CUSTOMER_SCORING_REASON_KEY);
  });

  it('accepts kostenvoranschlag as angebot', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: KOSTENVORANSCHLAG_TEXT });
    const decision = evaluateCustomerCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('angebot');
  });

  it('accepts a clear auftragsbestaetigung when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: AUFTRAGSBESTAETIGUNG_TEXT });
    const decision = evaluateCustomerCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('auftragsbestaetigung');
    expect(decision.detection?.reasonKey).toBe(DI_CUSTOMER_SCORING_REASON_KEY);
  });

  it('prefers auftragsbestaetigung over generic auftrag when confirmation marker is present', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: CONFIRMATION_VS_AUFTRAG_TEXT });
    const decision = evaluateCustomerCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('auftragsbestaetigung');
  });

  it('rejects cutover when the feature flag is disabled', () => {
    setCustomerScoringCutoverEnabledForTests(false);
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: KUNDENAUFTRAG_TEXT });
    expect(evaluateCustomerCutoverEligibility(pipeline).eligible).toBe(false);
  });

  it('rejects cutover for werkvertrag texts via contract exclusion guard', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: AUFTRAG_VS_VERTRAG_TEXT });
    const decision = evaluateCustomerCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:contract_excluded');
  });

  it('rejects cutover for invoice-shaped texts via invoice exclusion guard', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: INVOICE_TEXT });
    const decision = evaluateCustomerCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:invoice_excluded');
  });

  it('rejects cutover for mahnung texts via payment exclusion guard', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: MAHNUNG_TEXT });
    const decision = evaluateCustomerCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:payment_excluded');
  });

  it('rejects cutover for freistellung texts via certificate exclusion guard', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: FREISTELLUNG_TEXT });
    const decision = evaluateCustomerCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:certificate_excluded');
  });

  it('rejects cutover for finanzamt texts via authority exclusion guard', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: FINANZAMT_TEXT });
    const decision = evaluateCustomerCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:authority_excluded');
  });

  it('rejects cutover when customer-only margin is too low', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: AMBIGUOUS_CUSTOMER });
    const decision = evaluateCustomerCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBeTruthy();
  });

  it('rejects cutover when customer kinds are too close in family-internal margin', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: MIXED_CUSTOMER_KINDS });
    const decision = evaluateCustomerCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(['cutover:margin_too_low', 'cutover:candidates_too_close', 'cutover:confidence_too_low', 'cutover:ocr_score_too_low']).toContain(
      decision.rejectionReason,
    );
  });

  it('uses customer-only ranking independent of the global winner', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: KUNDENAUFTRAG_WITH_RECEIPT_NOISE });
    const customerCandidates = pipeline?.scoringResult.candidates.filter(
      (candidate) =>
        ['auftrag', 'angebot', 'auftragsbestaetigung'].includes(candidate.kind) && candidate.score > 0,
    );

    expect(customerCandidates?.[0]?.kind).toBe('auftrag');
    expect(evaluateCustomerCutoverEligibility(pipeline).eligible).toBe(true);
    expect(computeCustomerCutoverConfidence(pipeline!)).toBeGreaterThan(0);
  });

  it('rejects cutover when OCR text is missing', () => {
    expect(evaluateCustomerCutoverEligibility(null).rejectionReason).toBe('cutover:no_text');
  });
});

describe('documentCustomerCutoverHybridService', () => {
  afterEach(() => {
    setCustomerScoringCutoverEnabledForTests(null);
    setReceiptScoringCutoverEnabledForTests(null);
    setInvoiceScoringCutoverEnabledForTests(null);
    setPaymentScoringCutoverEnabledForTests(null);
    setAuthorityScoringCutoverEnabledForTests(null);
    setCertificateScoringCutoverEnabledForTests(null);
    setContractScoringCutoverEnabledForTests(null);
  });

  it('productively applies auftrag cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: KUNDENAUFTRAG_TEXT });

    expect(result.classifiedKind).toBe('auftrag');
    expect(result.detectionReasonKey).toBe(DI_CUSTOMER_SCORING_REASON_KEY);
    expect(result.recognizedData.Auftraggeber).toBe('Stadt München');
    expect(result.recognizedData.Baustelle).toBe('Hauptstr. 12, 80331 München');
    expect(result.recognizedData.Auftragsnummer).toBe('KA-2026-0042');
    expect(result.recognizedData.Auftragssumme).toBe('45.000,00 EUR');
    expect(result.recognizedData.Leistung).toBeUndefined();
    expect(result.recognizedData.Baustelle).not.toBe('Baustelle laut Auftrag');
  });

  it('productively applies angebot cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: ANGEBOT_TEXT });

    expect(result.classifiedKind).toBe('angebot');
    expect(result.detectionReasonKey).toBe(DI_CUSTOMER_SCORING_REASON_KEY);
    expect(result.recognizedData.Kunde).toBe('Weber GmbH');
    expect(result.recognizedData.Angebotsnummer).toBe('AN-2026-118');
    expect(result.recognizedData.Angebotssumme).toBe('12.500,00 EUR');
    expect(result.recognizedData.Angebotssumme).not.toBe('ca. 5.000 €');
  });

  it('productively applies auftragsbestaetigung cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: AUFTRAGSBESTAETIGUNG_TEXT });

    expect(result.classifiedKind).toBe('auftragsbestaetigung');
    expect(result.detectionReasonKey).toBe(DI_CUSTOMER_SCORING_REASON_KEY);
    expect(result.recognizedData.Auftraggeber).toBe('Großbau AG');
    expect(result.recognizedData.Auftragsnummer).toBe('AB-2026-77');
  });

  it('prefers auftragsbestaetigung over auftrag in hybrid classification', () => {
    const result = classifyDocument({ recognizedText: CONFIRMATION_VS_AUFTRAG_TEXT });

    expect(result.classifiedKind).toBe('auftragsbestaetigung');
    expect(result.detectionReasonKey).toBe(DI_CUSTOMER_SCORING_REASON_KEY);
  });

  it('keeps werkvertrag on contract cutover, not customer auftrag', () => {
    const result = classifyDocument({ recognizedText: AUFTRAG_VS_VERTRAG_TEXT });

    expect(result.classifiedKind).toBe('werkvertrag');
    expect(result.detectionReasonKey).toBe(DI_CONTRACT_SCORING_REASON_KEY);
    expect(result.detectionReasonKey).not.toBe(DI_CUSTOMER_SCORING_REASON_KEY);
  });

  it('keeps eingangsrechnung cutover for invoice-shaped documents over angebot', () => {
    const result = classifyDocument({ recognizedText: ANGEBOT_VS_INVOICE_TEXT });

    expect(result.classifiedKind).toBe('eingangsrechnung');
    expect(result.detectionReasonKey).toBe(DI_INVOICE_SCORING_REASON_KEY);
    expect(result.detectionReasonKey).not.toBe(DI_CUSTOMER_SCORING_REASON_KEY);
  });

  it('keeps mahnung on payment cutover, not customer', () => {
    const result = classifyDocument({ recognizedText: MAHNUNG_TEXT });

    expect(result.classifiedKind).toBe('mahnung');
    expect(result.detectionReasonKey).toBe(DI_PAYMENT_SCORING_REASON_KEY);
  });

  it('keeps freistellung on certificate cutover, not customer', () => {
    const result = classifyDocument({ recognizedText: FREISTELLUNG_TEXT });

    expect(result.classifiedKind).toBe('freistellungsbescheinigung');
    expect(result.detectionReasonKey).toBe(DI_CERTIFICATE_SCORING_REASON_KEY);
  });

  it('keeps finanzamt on authority cutover, not customer', () => {
    const result = classifyDocument({ recognizedText: FINANZAMT_TEXT });

    expect(result.classifiedKind).toBe('finanzamt');
    expect(result.detectionReasonKey).toBe(DI_AUTHORITY_SCORING_REASON_KEY);
  });

  it('keeps receipt cutover unchanged for tankbeleg', () => {
    const result = classifyDocument({ recognizedText: TANK_RECEIPT });

    expect(result.classifiedKind).toBe('tankbeleg');
    expect(result.detectionReasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });

  it('keeps contract cutover before customer for werkvertrag sample', () => {
    const result = classifyDocument({ recognizedText: SAMPLE_WERKVERTRAG_TEXT });

    expect(result.classifiedKind).toBe('werkvertrag');
    expect(result.detectionReasonKey).toBe(DI_CONTRACT_SCORING_REASON_KEY);
    expect(result.detectionReasonKey).not.toBe(DI_CUSTOMER_SCORING_REASON_KEY);
  });

  it('keeps subunternehmervertrag on contract cutover', () => {
    const result = classifyDocument({ recognizedText: SAMPLE_SUBUNTERNEHMERVERTRAG_TEXT });

    expect(result.classifiedKind).toBe('subunternehmervertrag');
    expect(result.detectionReasonKey).toBe(DI_CONTRACT_SCORING_REASON_KEY);
  });

  it('falls back to legacy when customer cutover is disabled', () => {
    setCustomerScoringCutoverEnabledForTests(false);
    const legacy = detectClassifiedKindWithReason({ recognizedText: KUNDENAUFTRAG_TEXT });
    const result = classifyDocument({ recognizedText: KUNDENAUFTRAG_TEXT });

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).toBe(legacy.reasonKey);
    expect(result.detectionReasonKey).not.toBe(DI_CUSTOMER_SCORING_REASON_KEY);
  });

  it('falls back to legacy when an upload kind hint is present', () => {
    const legacy = detectClassifiedKindWithReason({
      recognizedText: KUNDENAUFTRAG_TEXT,
      kindHint: 'auftrag',
    });
    const resolution = resolveClassificationDetection(
      { recognizedText: KUNDENAUFTRAG_TEXT, kindHint: 'auftrag' },
      legacy,
    );

    expect(resolution.cutoverApplied).toBe(false);
    expect(resolution.detection).toEqual(legacy);
  });

  it('falls back to legacy when OCR text is missing', () => {
    const legacy = detectClassifiedKindWithReason({});
    const result = classifyDocument({});

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).not.toBe(DI_CUSTOMER_SCORING_REASON_KEY);
  });
});
