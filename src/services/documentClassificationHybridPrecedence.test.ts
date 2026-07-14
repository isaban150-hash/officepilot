import { describe, expect, it } from 'vitest';
import {
  DI_AUTHORITY_SCORING_REASON_KEY,
  DI_CERTIFICATE_SCORING_REASON_KEY,
  DI_CONTRACT_SCORING_REASON_KEY,
  DI_CUSTOMER_SCORING_REASON_KEY,
  DI_INVOICE_SCORING_REASON_KEY,
  DI_PAYMENT_SCORING_REASON_KEY,
  DI_RECEIPT_SCORING_REASON_KEY,
} from '../config/documentIntelligenceConfig';
import {
  SAMPLE_SUBUNTERNEHMERVERTRAG_TEXT,
  SAMPLE_WERKVERTRAG_TEXT,
} from './contractAnalysisService';
import {
  classifyDocument,
  detectClassifiedKindWithReason,
} from './documentClassificationService';

const TANK_RECEIPT = [
  'ARAL Tankstelle München',
  'Diesel 52,18 EUR',
  'Kartenzahlung Girocard',
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

const FREISTELLUNG_TEXT = [
  'Finanzamt München',
  'Freistellungsbescheinigung §48b',
  'Betreff: Freistellungsbescheinigung nach §48b EStG',
  'Aussteller: Finanzamt München',
  'Datum: 15.03.2026',
  'gültig bis 31.12.2027',
].join('\n');

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

const AMBIGUOUS_RECEIPT = ['Quittung', '42,80 EUR', 'Danke'].join('\n');

describe('documentClassificationHybridPrecedence', () => {
  it('keeps receipt before invoice for tank receipts', () => {
    const result = classifyDocument({ recognizedText: TANK_RECEIPT });
    expect(result.classifiedKind).toBe('tankbeleg');
    expect(result.detectionReasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });

  it('keeps invoice before payment for invoice-shaped documents', () => {
    const result = classifyDocument({ recognizedText: INVOICE_TEXT });
    expect(result.classifiedKind).toBe('eingangsrechnung');
    expect(result.detectionReasonKey).toBe(DI_INVOICE_SCORING_REASON_KEY);
  });

  it('keeps payment before authority for mahnung documents', () => {
    const result = classifyDocument({ recognizedText: MAHNUNG_TEXT });
    expect(result.classifiedKind).toBe('mahnung');
    expect(result.detectionReasonKey).toBe(DI_PAYMENT_SCORING_REASON_KEY);
  });

  it('keeps authority before certificate for finanzamt documents', () => {
    const result = classifyDocument({ recognizedText: FINANZAMT_TEXT });
    expect(result.classifiedKind).toBe('finanzamt');
    expect(result.detectionReasonKey).toBe(DI_AUTHORITY_SCORING_REASON_KEY);
  });

  it('keeps certificate before contract for freistellung documents', () => {
    const result = classifyDocument({ recognizedText: FREISTELLUNG_TEXT });
    expect(result.classifiedKind).toBe('freistellungsbescheinigung');
    expect(result.detectionReasonKey).toBe(DI_CERTIFICATE_SCORING_REASON_KEY);
  });

  it('keeps contract before customer for werkvertrag documents', () => {
    const result = classifyDocument({ recognizedText: SAMPLE_WERKVERTRAG_TEXT });
    expect(result.classifiedKind).toBe('werkvertrag');
    expect(result.detectionReasonKey).toBe(DI_CONTRACT_SCORING_REASON_KEY);
  });

  it('keeps customer before legacy for kundenauftrag documents', () => {
    const result = classifyDocument({ recognizedText: KUNDENAUFTRAG_TEXT });
    expect(result.classifiedKind).toBe('auftrag');
    expect(result.detectionReasonKey).toBe(DI_CUSTOMER_SCORING_REASON_KEY);
  });

  it('does not let customer cutover win over contract-shaped werkvertrag text', () => {
    const text = [
      'Werkvertrag',
      'Kundenauftrag',
      'Auftraggeber: Müller Bau GmbH',
      'Subunternehmer: Mustermann Sanitär GmbH',
      'Baustellenadresse: Hauptstr. 12, 10115 Berlin',
      'Vertragsdatum: 15.03.2026',
      'Auftragsnummer: AV-2026-0042',
      'Leistungsverzeichnis',
    ].join('\n');
    const result = classifyDocument({ recognizedText: text });
    expect(result.classifiedKind).toBe('werkvertrag');
    expect(result.detectionReasonKey).toBe(DI_CONTRACT_SCORING_REASON_KEY);
    expect(result.detectionReasonKey).not.toBe(DI_CUSTOMER_SCORING_REASON_KEY);
  });

  it('does not let authority cutover win over payment-shaped mahnung text', () => {
    const result = classifyDocument({ recognizedText: MAHNUNG_TEXT });
    expect(result.detectionReasonKey).toBe(DI_PAYMENT_SCORING_REASON_KEY);
    expect(result.detectionReasonKey).not.toBe(DI_AUTHORITY_SCORING_REASON_KEY);
  });

  it('does not let contract cutover win over certificate-shaped freistellung text', () => {
    const result = classifyDocument({ recognizedText: FREISTELLUNG_TEXT });
    expect(result.detectionReasonKey).toBe(DI_CERTIFICATE_SCORING_REASON_KEY);
    expect(result.detectionReasonKey).not.toBe(DI_CONTRACT_SCORING_REASON_KEY);
  });

  it('falls back to legacy for ambiguous receipt-like text', () => {
    const legacy = detectClassifiedKindWithReason({ recognizedText: AMBIGUOUS_RECEIPT });
    const result = classifyDocument({ recognizedText: AMBIGUOUS_RECEIPT });
    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).toBe(legacy.reasonKey);
    expect(result.detectionReasonKey).not.toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });

  it('keeps subunternehmervertrag on contract lane', () => {
    const result = classifyDocument({ recognizedText: SAMPLE_SUBUNTERNEHMERVERTRAG_TEXT });
    expect(result.classifiedKind).toBe('subunternehmervertrag');
    expect(result.detectionReasonKey).toBe(DI_CONTRACT_SCORING_REASON_KEY);
  });
});
