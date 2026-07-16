import { afterEach, describe, expect, it } from 'vitest';
import {
  DI_AUTHORITY_SCORING_REASON_KEY,
  DI_PAYMENT_SCORING_REASON_KEY,
  setAuthorityScoringCutoverEnabledForTests,
  setPaymentScoringCutoverEnabledForTests,
} from '../config/documentIntelligenceConfig';
import { UNKNOWN_SENDER_CANONICAL } from '../i18n/resolveStoredText';
import { classifyDocument, detectClassifiedKind } from './documentClassificationService';
import { evaluatePaymentCutoverEligibility } from './documentPaymentCutoverService';
import { runReceiptAnalysisPipeline } from './documentReceiptAnalysisPipelineService';

const ARBEITSBESCHEINIGUNG_TEXT = [
  'Bundesagentur für Arbeit',
  'Agentur für Arbeit München',
  'Arbeitsbescheinigung',
  'nach § 312 SGB III',
  'Arbeitgeber: Muster Bau GmbH',
  'Arbeitnehmer: Max Mustermann',
  'Versicherungsnummer: 12 345678 A 123',
  'Beschäftigungsverhältnis vom 01.01.2020 bis 30.06.2026',
  'Bruttoarbeitsentgelt: 3.200,00 EUR',
  'Frist: 15.08.2026',
  'Seite 3 von 9 Arbeitsbescheinigung Bitte vollständig ausfüllen',
].join('\n');

const ARBEITSBESCHEINIGUNG_WITH_SPURIOUS_MAHNUNG = [
  ARBEITSBESCHEINIGUNG_TEXT,
  'Mahnung',
].join('\n');

const BA_MAHNUNG_TEXT = [
  'Bundesagentur für Arbeit',
  'Agentur für Arbeit München',
  '1. Mahnung',
  'Zahlungsaufforderung',
  'Rechnungsnummer: BA-2026-441',
  'Offener Betrag: 480,00 EUR',
  'Bitte überweisen Sie den Betrag bis 31.08.2026',
].join('\n');

const KUENDIGUNG_TEXT = [
  'Kündigung des Arbeitsverhältnisses',
  'Arbeitgeber: Muster Bau GmbH',
  'Arbeitnehmer: Max Mustermann',
  'Das Arbeitsverhältnis endet am 31.07.2026.',
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

const ZAHLUNGSERINNERUNG_TEXT = [
  'Müller Bau GmbH',
  'Musterstraße 1',
  'Zahlungserinnerung',
  'Rechnungsnummer: INV-2026-55',
  'Datum: 08.03.2026',
  'Offener Betrag: 842,50 EUR',
  'Zahlbar bis 22.03.2026',
].join('\n');

describe('DI-EMPLOYMENT-DOCUMENT-MISCLASSIFICATION-01', () => {
  afterEach(() => {
    setPaymentScoringCutoverEnabledForTests(null);
    setAuthorityScoringCutoverEnabledForTests(null);
  });

  it('classifies Arbeitsbescheinigung as agentur_fuer_arbeit, not mahnung', () => {
    const result = classifyDocument({ recognizedText: ARBEITSBESCHEINIGUNG_TEXT });

    expect(result.classifiedKind).toBe('agentur_fuer_arbeit');
    expect(result.classifiedKind).not.toBe('mahnung');
    expect(result.detectionReasonKey).not.toBe(DI_PAYMENT_SCORING_REASON_KEY);
    expect(result.detectionReasonKey).toBe(DI_AUTHORITY_SCORING_REASON_KEY);
    expect(result.priority).not.toBe('kritisch');
    expect(result.recommendedAction).not.toBe('zahlung_pruefen');
    expect(result.digitalFolder.path).toMatch(/Behörden|agentur/i);
    expect(result.digitalFolder.path).not.toMatch(/Mahnungen/i);
    expect(result.paperFiling.register).toMatch(/Agentur/i);
    expect(result.paperFiling.folderId).toBe('paper-behoerden');
    expect(result.sender).toBe('Bundesagentur für Arbeit');
    expect(result.sender).not.toMatch(/Seite\s+3/i);
    expect(result.explanation).toMatch(/Bundesagentur|Agentur/i);
    expect(result.explanation).not.toMatch(/Zahlung prüfen/i);
  });

  it('does not classify Arbeitsbescheinigung with wage amounts as mahnung', () => {
    const result = classifyDocument({ recognizedText: ARBEITSBESCHEINIGUNG_TEXT });
    expect(result.classifiedKind).toBe('agentur_fuer_arbeit');
    expect(result.classifiedKind).not.toBe('mahnung');
  });

  it('does not classify Arbeitsbescheinigung with Frist as mahnung without demand', () => {
    const result = classifyDocument({ recognizedText: ARBEITSBESCHEINIGUNG_TEXT });
    expect(result.classifiedKind).not.toBe('mahnung');
    expect(result.detectionReasonKey).not.toBe(DI_PAYMENT_SCORING_REASON_KEY);
  });

  it('rejects payment cutover for Arbeitsbescheinigung even with stray Mahnung token', () => {
    const pipeline = runReceiptAnalysisPipeline({
      recognizedText: ARBEITSBESCHEINIGUNG_WITH_SPURIOUS_MAHNUNG,
    });
    const decision = evaluatePaymentCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:employment_excluded');

    const result = classifyDocument({
      recognizedText: ARBEITSBESCHEINIGUNG_WITH_SPURIOUS_MAHNUNG,
    });
    expect(result.classifiedKind).toBe('agentur_fuer_arbeit');
    expect(result.classifiedKind).not.toBe('mahnung');
  });

  it('keeps clear commercial mahnung on payment cutover', () => {
    const result = classifyDocument({ recognizedText: MAHNUNG_TEXT });
    expect(result.classifiedKind).toBe('mahnung');
    expect(result.detectionReasonKey).toBe(DI_PAYMENT_SCORING_REASON_KEY);
  });

  it('keeps clear BA mahnung with real demand as mahnung', () => {
    const result = classifyDocument({ recognizedText: BA_MAHNUNG_TEXT });
    expect(result.classifiedKind).toBe('mahnung');
    expect(result.detectionReasonKey).toBe(DI_PAYMENT_SCORING_REASON_KEY);
  });

  it('keeps zahlungserinnerung cutover', () => {
    const result = classifyDocument({ recognizedText: ZAHLUNGSERINNERUNG_TEXT });
    expect(result.classifiedKind).toBe('zahlungserinnerung');
    expect(result.detectionReasonKey).toBe(DI_PAYMENT_SCORING_REASON_KEY);
  });

  it('does not classify Kündigung without demand as mahnung', () => {
    const kind = detectClassifiedKind({ recognizedText: KUENDIGUNG_TEXT });
    expect(kind).not.toBe('mahnung');
    expect(kind).not.toBe('zahlungserinnerung');
  });

  it('uses uncertain sender label when BA name is missing', () => {
    const result = classifyDocument({
      recognizedText: [
        'Arbeitsbescheinigung',
        'nach § 312 SGB III',
        'Arbeitgeber: Muster Bau GmbH',
        'Arbeitnehmer: Max Mustermann',
        'Beschäftigungsverhältnis vom 01.01.2020 bis 30.06.2026',
        'Seite 3 von 9 Arbeitsbescheinigung Bitte vollständig ausfüllen',
      ].join('\n'),
    });

    expect(result.classifiedKind).toBe('agentur_fuer_arbeit');
    expect(result.sender).toBe(UNKNOWN_SENDER_CANONICAL);
    expect(result.sender).not.toMatch(/Seite\s+3/i);
    expect(result.recognizedData.Absender).toBeUndefined();
    expect(result.recognizedData.Lieferant).toBeUndefined();
  });

  it('uses the same classification path for scan-like input without kindHint', () => {
    const uploadLike = classifyDocument({
      recognizedText: ARBEITSBESCHEINIGUNG_TEXT,
      sourceFileName: 'scan-arbeitsbescheinigung.pdf',
    });
    const scanLike = classifyDocument({
      recognizedText: ARBEITSBESCHEINIGUNG_TEXT,
    });

    expect(uploadLike.classifiedKind).toBe(scanLike.classifiedKind);
    expect(uploadLike.detectionReasonKey).toBe(scanLike.detectionReasonKey);
  });

  it('keeps related employment kinds stable', () => {
    expect(
      detectClassifiedKind({ recognizedText: 'Arbeitsvertrag zwischen Arbeitgeber und Arbeitnehmer' }),
    ).toBe('arbeitsvertrag');
    expect(
      detectClassifiedKind({
        recognizedText: 'Arbeitsunfähigkeitsbescheinigung AU-Bescheinigung Krankenschein',
      }),
    ).toBe('arbeitsunfaehigkeitsbescheinigung');
    expect(
      detectClassifiedKind({ recognizedText: 'Lohnabrechnung Gehaltsabrechnung Entgeltabrechnung' }),
    ).toBe('lohnabrechnung');
    expect(
      detectClassifiedKind({ recognizedText: 'Freistellungsbescheinigung §48b Finanzamt' }),
    ).toBe('freistellungsbescheinigung');
  });
});
