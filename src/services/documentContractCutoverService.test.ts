import { afterEach, describe, expect, it } from 'vitest';
import {
  DI_CERTIFICATE_SCORING_REASON_KEY,
  DI_CONTRACT_SCORING_REASON_KEY,
  DI_INVOICE_SCORING_REASON_KEY,
  DI_PAYMENT_SCORING_REASON_KEY,
  DI_RECEIPT_SCORING_REASON_KEY,
  setCertificateScoringCutoverEnabledForTests,
  setContractScoringCutoverEnabledForTests,
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
import { evaluateContractCutoverEligibility } from './documentContractCutoverService';

const NACHUNTERNEHMER_TEXT = [
  'Nachunternehmervertrag',
  'Auftraggeber: Großbau AG',
  'Nachunternehmer: Klempner Meier OHG',
  'Bauvorhaben: Neubau Schule Nord',
  'Baustelle: Schulweg 5, 80331 München',
  'Vertragsdatum: 20.02.2026',
  'Auftragsnummer: NU-2026-118',
  'Leistungsverzeichnis',
  'Pos. Beschreibung Einheit Menge',
  '1 Rohrleitungsarbeiten m 120',
  'Unterschrift Auftraggeber    Unterschrift Auftragnehmer',
].join('\n');

const FREISTELLUNG_TEXT = [
  'Finanzamt München',
  'Freistellungsbescheinigung §48b',
  'Betreff: Freistellungsbescheinigung nach §48b EStG',
  'Aussteller: Finanzamt München',
  'Datum: 15.03.2026',
  'gültig bis 31.12.2027',
].join('\n');

const CONTRACT_WITH_CERT_MENTION = [
  'Werkvertrag',
  'Auftraggeber: Müller Bau GmbH',
  'Subunternehmer: Mustermann Sanitär GmbH',
  'Baustellenadresse: Hauptstr. 12, 10115 Berlin',
  'Vertragsdatum: 15.03.2026',
  'Auftragsnummer: AV-2026-0042',
  'Leistungsverzeichnis',
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

const AMBIGUOUS_CONTRACT = ['Vertrag', 'Baustelle', 'Danke'].join('\n');

const BODY_FILLER = Array.from({ length: 22 }, (_, index) => `Position ${index + 1} Leistungsbeschreibung`);

function buildContractZoneText(options: {
  partyLine?: string;
  dateLine?: string;
}): string {
  return [
    'Werkvertrag',
    'Auftraggeber: Müller Bau GmbH',
    options.partyLine,
    options.dateLine,
    'Auftragsnummer: AV-2026-0042',
    'Leistungsverzeichnis',
    ...BODY_FILLER,
    'Unterschrift Auftraggeber',
    'Ort, Datum: 01.07.2026',
  ]
    .filter(Boolean)
    .join('\n');
}

describe('documentContractCutoverService', () => {
  afterEach(() => {
    setContractScoringCutoverEnabledForTests(null);
  });

  it('accepts a clear werkvertrag when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: SAMPLE_WERKVERTRAG_TEXT });
    const decision = evaluateContractCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('werkvertrag');
    expect(decision.detection?.reasonKey).toBe(DI_CONTRACT_SCORING_REASON_KEY);
  });

  it('accepts a clear subunternehmervertrag when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: SAMPLE_SUBUNTERNEHMERVERTRAG_TEXT });
    const decision = evaluateContractCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('subunternehmervertrag');
  });

  it('accepts a clear nachunternehmervertrag when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: NACHUNTERNEHMER_TEXT });
    const decision = evaluateContractCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('nachunternehmervertrag');
  });

  it('rejects cutover when the feature flag is disabled', () => {
    setContractScoringCutoverEnabledForTests(false);
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: SAMPLE_WERKVERTRAG_TEXT });
    expect(evaluateContractCutoverEligibility(pipeline).eligible).toBe(false);
  });

  it('rejects cutover for freistellung texts via certificate exclusion guard', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: FREISTELLUNG_TEXT });
    const decision = evaluateContractCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:certificate_excluded');
  });

  it('rejects cutover for mahnung texts via payment exclusion guard', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: MAHNUNG_TEXT });
    const decision = evaluateContractCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:payment_excluded');
  });

  it('rejects cutover when margin is too low', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: AMBIGUOUS_CONTRACT });
    const decision = evaluateContractCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBeTruthy();
  });

  it('rejects cutover when OCR text is missing', () => {
    expect(evaluateContractCutoverEligibility(null).rejectionReason).toBe('cutover:no_text');
  });

  it('accepts werkvertrag when party label appears in the header zone', () => {
    const text = buildContractZoneText({
      partyLine: 'Subunternehmer: Mustermann Sanitär GmbH',
      dateLine: 'Vertragsdatum: 15.03.2026',
    });
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: text });
    const decision = evaluateContractCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('werkvertrag');
  });

  it('accepts werkvertrag when party label appears in the body zone', () => {
    const text = [
      'Werkvertrag',
      'Auftraggeber: Müller Bau GmbH',
      'Auftragsnummer: AV-2026-0042',
      'Leistungsverzeichnis',
      ...BODY_FILLER.slice(0, 8),
      'Subunternehmer: Mustermann Sanitär GmbH',
      'Vertragsdatum: 15.03.2026',
      ...BODY_FILLER.slice(8),
      'Unterschrift Auftraggeber',
      'Ort, Datum: 01.07.2026',
    ].join('\n');
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: text });
    const decision = evaluateContractCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('werkvertrag');
  });

  it('accepts werkvertrag when party label appears in the footer zone', () => {
    const text = [
      'Werkvertrag',
      'Auftraggeber: Müller Bau GmbH',
      'Vertragsdatum: 15.03.2026',
      'Auftragsnummer: AV-2026-0042',
      'Leistungsverzeichnis',
      ...BODY_FILLER,
      'Subunternehmer: Mustermann Sanitär GmbH',
      'Unterschrift Auftraggeber',
      'Ort, Datum: 01.07.2026',
    ].join('\n');
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: text });
    const decision = evaluateContractCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('werkvertrag');
  });

  it('does not treat footer signature dates as contract dates in recognizedData', () => {
    const text = [
      'Werkvertrag',
      'Auftraggeber: Müller Bau GmbH',
      'Subunternehmer: Mustermann Sanitär GmbH',
      'Auftragsnummer: AV-2026-0042',
      'Leistungsverzeichnis',
      ...BODY_FILLER,
      'Unterschrift Auftraggeber',
      'Ort, Datum: 01.07.2026',
    ].join('\n');
    const result = classifyDocument({ recognizedText: text });

    expect(result.classifiedKind).toBe('werkvertrag');
    expect(result.recognizedData.Vertragsdatum).toBeUndefined();
  });
});

describe('documentContractCutoverHybridService', () => {
  afterEach(() => {
    setContractScoringCutoverEnabledForTests(null);
    setReceiptScoringCutoverEnabledForTests(null);
    setInvoiceScoringCutoverEnabledForTests(null);
    setPaymentScoringCutoverEnabledForTests(null);
    setCertificateScoringCutoverEnabledForTests(null);
  });

  it('productively applies werkvertrag cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: SAMPLE_WERKVERTRAG_TEXT });

    expect(result.classifiedKind).toBe('werkvertrag');
    expect(result.detectionReasonKey).toBe(DI_CONTRACT_SCORING_REASON_KEY);
    expect(result.recognizedData.Auftraggeber).toBe('Müller Bau GmbH');
    expect(result.recognizedData.Auftragnehmer).toBe('Mustermann Sanitär GmbH');
    expect(result.recognizedData.Baustelle).toBe('Hauptstr. 12, 10115 Berlin');
    expect(result.recognizedData.Baustelle).not.toBe('Baustelle laut Vertrag');
    expect(result.recognizedData.Vertragsdatum).toBe('15.03.2026');
    expect(result.recognizedData.Auftragsnummer).toBe('AV-2026-0042');
  });

  it('productively applies subunternehmervertrag cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: SAMPLE_SUBUNTERNEHMERVERTRAG_TEXT });

    expect(result.classifiedKind).toBe('subunternehmervertrag');
    expect(result.detectionReasonKey).toBe(DI_CONTRACT_SCORING_REASON_KEY);
    expect(result.recognizedData.Auftraggeber).toBe('Großbau AG');
    expect(result.recognizedData.Auftragnehmer).toBe('Klempner Meier OHG');
    expect(result.recognizedData.Baustelle).toBe('Schulweg 5, 80331 München');
    expect(result.recognizedData.Vertragsdatum).toBe('20.02.2026');
    expect(result.recognizedData.Auftragsnummer).toBe('SU-2026-118');
  });

  it('productively applies nachunternehmervertrag cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: NACHUNTERNEHMER_TEXT });

    expect(result.classifiedKind).toBe('nachunternehmervertrag');
    expect(result.detectionReasonKey).toBe(DI_CONTRACT_SCORING_REASON_KEY);
    expect(result.recognizedData.Auftraggeber).toBe('Großbau AG');
    expect(result.recognizedData.Auftragnehmer).toBe('Klempner Meier OHG');
    expect(result.recognizedData.Auftragsnummer).toBe('NU-2026-118');
  });

  it('keeps contract with proof mentions on contract cutover, not certificate', () => {
    const result = classifyDocument({ recognizedText: CONTRACT_WITH_CERT_MENTION });

    expect(result.detectionReasonKey).toBe(DI_CONTRACT_SCORING_REASON_KEY);
    expect(result.detectionReasonKey).not.toBe(DI_CERTIFICATE_SCORING_REASON_KEY);
    expect(result.classifiedKind).toBe('werkvertrag');
    expect(result.recognizedData.Auftraggeber).toBe('Müller Bau GmbH');
    expect(result.recognizedData.Baustelle).not.toBe('Baustelle laut Vertrag');
  });

  it('keeps freistellung on certificate cutover, not contract', () => {
    const result = classifyDocument({ recognizedText: FREISTELLUNG_TEXT });

    expect(result.classifiedKind).toBe('freistellungsbescheinigung');
    expect(result.detectionReasonKey).toBe(DI_CERTIFICATE_SCORING_REASON_KEY);
    expect(result.detectionReasonKey).not.toBe(DI_CONTRACT_SCORING_REASON_KEY);
  });

  it('keeps invoice on invoice cutover, not contract', () => {
    const result = classifyDocument({ recognizedText: INVOICE_TEXT });

    expect(result.classifiedKind).toBe('eingangsrechnung');
    expect(result.detectionReasonKey).toBe(DI_INVOICE_SCORING_REASON_KEY);
  });

  it('keeps mahnung on payment cutover, not contract', () => {
    const result = classifyDocument({ recognizedText: MAHNUNG_TEXT });

    expect(result.classifiedKind).toBe('mahnung');
    expect(result.detectionReasonKey).toBe(DI_PAYMENT_SCORING_REASON_KEY);
  });

  it('keeps receipt cutover unchanged for tankbeleg', () => {
    const result = classifyDocument({ recognizedText: TANK_RECEIPT });

    expect(result.classifiedKind).toBe('tankbeleg');
    expect(result.detectionReasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });

  it('falls back to legacy when contract cutover is disabled', () => {
    setContractScoringCutoverEnabledForTests(false);
    const legacy = detectClassifiedKindWithReason({ recognizedText: SAMPLE_WERKVERTRAG_TEXT });
    const result = classifyDocument({ recognizedText: SAMPLE_WERKVERTRAG_TEXT });

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).toBe(legacy.reasonKey);
    expect(result.detectionReasonKey).not.toBe(DI_CONTRACT_SCORING_REASON_KEY);
  });

  it('falls back to legacy when an upload kind hint is present', () => {
    const legacy = detectClassifiedKindWithReason({
      recognizedText: SAMPLE_WERKVERTRAG_TEXT,
      kindHint: 'werkvertrag',
    });
    const resolution = resolveClassificationDetection(
      { recognizedText: SAMPLE_WERKVERTRAG_TEXT, kindHint: 'werkvertrag' },
      legacy,
    );

    expect(resolution.cutoverApplied).toBe(false);
    expect(resolution.detection).toEqual(legacy);
  });

  it('falls back to legacy when OCR text is missing', () => {
    const legacy = detectClassifiedKindWithReason({});
    const result = classifyDocument({});

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).not.toBe(DI_CONTRACT_SCORING_REASON_KEY);
  });
});
