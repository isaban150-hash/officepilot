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

const KASSEN_RECEIPT = [
  'Bäckerei Schmidt',
  'Kassenbeleg',
  'Beleg-Nr. 4421',
  'Datum: 14.07.2026',
  'Brötchen    2,40 EUR',
  'Kaffee      2,50 EUR',
  'Croissant   3,00 EUR',
  'Summe       8,90 EUR',
  'Bar gezahlt',
  'Vielen Dank',
].join('\n');

const KREDITKARTEN_RECEIPT = [
  'REWE Markt München',
  'Kreditkartenbeleg',
  'Visa contactless',
  'Summe 42,80 EUR',
  'Terminal-ID 04',
  'Datum: 14.07.2026',
  'Beleg-Nr. KC-8821',
  'Danke für Ihren Einkauf',
].join('\n');

const QUITTUNG_RECEIPT = [
  'Handwerker Müller',
  'Quittung',
  'Bar erhalten',
  'Betrag: 150,00 EUR',
  'Datum: 14.07.2026',
].join('\n');

const INVOICE_TEXT = [
  'Müller Bau GmbH',
  'Rechnungsnummer: INV-2026-77',
  'Gesamtbetrag 1.247,80 EUR',
  'IBAN: DE89 3704 0044 0532 0130 00',
  'zahlbar bis 31.03.2026',
].join('\n');

const MAHNUNG_TEXT = [
  'Müller Bau GmbH',
  '2. Mahnung',
  'Rechnungsnummer: INV-2026-77',
  'Offener Betrag: 1.247,80 EUR',
  'Zahlungsaufforderung',
  'Zahlbar bis 31.03.2026',
].join('\n');

const AMBIGUOUS_RECEIPT = ['Quittung', '42,80 EUR', 'Danke'].join('\n');

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

  it('accepts a clear ec_beleg when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: EC_RECEIPT });
    const decision = evaluateReceiptCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('ec_beleg');
  });

  it('accepts a clear kassenbeleg when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: KASSEN_RECEIPT });
    const decision = evaluateReceiptCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('kassenbeleg');
  });

  it('accepts a clear kreditkartenbeleg when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: KREDITKARTEN_RECEIPT });
    const decision = evaluateReceiptCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('kreditkartenbeleg');
    expect(decision.detection?.reasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });

  it('accepts a clear quittung when all cutover gates pass', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: QUITTUNG_RECEIPT });
    const decision = evaluateReceiptCutoverEligibility(pipeline);

    expect(pipeline?.valid).toBe(true);
    expect(decision.eligible).toBe(true);
    expect(decision.detection?.kind).toBe('quittung');
  });

  it('rejects cutover for invoice texts via invoice exclusion guard', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: INVOICE_TEXT });
    const decision = evaluateReceiptCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:invoice_excluded');
  });

  it('rejects cutover for mahnung texts via payment exclusion guard', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: MAHNUNG_TEXT });
    const decision = evaluateReceiptCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:payment_excluded');
  });

  it('rejects cutover when margin is too low', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: AMBIGUOUS_RECEIPT });
    const decision = evaluateReceiptCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBeTruthy();
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

  it('rejects kassenbeleg cutover without a kassenbeleg marker in the text', () => {
    const pipeline = runReceiptAnalysisPipeline({
      recognizedText: 'AOK Nordwest Beitragsbescheid 250,00 EUR Frist 30.04.2026',
    });
    const decision = evaluateReceiptCutoverEligibility(pipeline);

    expect(decision.eligible).toBe(false);
    expect(decision.rejectionReason).toBe('cutover:missing_kind_marker');
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

  it('productively applies ec_beleg cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: EC_RECEIPT });

    expect(result.classifiedKind).toBe('ec_beleg');
    expect(result.detectionReasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
    expect(result.recognizedData.Betrag).toContain('18,42');
    expect(result.recognizedData.Lieferant).toBe('REWE Markt München');
    expect(result.processType).toBe('record_expense');
  });

  it('productively applies kassenbeleg cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: KASSEN_RECEIPT });

    expect(result.classifiedKind).toBe('kassenbeleg');
    expect(result.detectionReasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
    expect(result.recognizedData.Betrag).toContain('8,90');
    expect(result.recognizedData.Lieferant).toBe('Bäckerei Schmidt');
    expect(result.recognizedData.Belegnummer).toBe('4421');
    expect(result.processType).toBe('record_expense');
  });

  it('productively applies kreditkartenbeleg cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: KREDITKARTEN_RECEIPT });

    expect(result.classifiedKind).toBe('kreditkartenbeleg');
    expect(result.detectionReasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
    expect(result.recognizedData.Betrag).toContain('42,80');
    expect(result.recognizedData.Betrag).not.toBe('85,40 €');
    expect(result.recognizedData.Lieferant).toBe('REWE Markt München');
    expect(result.recognizedData.Datum).toBe('14.07.2026');
    expect(result.recognizedData.Belegnummer).toBe('KC-8821');
  });

  it('productively applies quittung cutover with OCR-only recognizedData', () => {
    const result = classifyDocument({ recognizedText: QUITTUNG_RECEIPT });

    expect(result.classifiedKind).toBe('quittung');
    expect(result.detectionReasonKey).toBe(DI_RECEIPT_SCORING_REASON_KEY);
    expect(result.recognizedData.Betrag).toContain('150,00');
    expect(result.recognizedData.Lieferant).toBe('Handwerker Müller');
    expect(result.recognizedData.Datum).toBe('14.07.2026');
  });

  it('keeps ec_beleg for girocard receipts, not kreditkartenbeleg', () => {
    const result = classifyDocument({ recognizedText: EC_RECEIPT });

    expect(result.classifiedKind).toBe('ec_beleg');
    expect(result.classifiedKind).not.toBe('kreditkartenbeleg');
  });

  it('keeps kassenbeleg distinct from quittung', () => {
    const kassen = classifyDocument({ recognizedText: KASSEN_RECEIPT });
    const quittung = classifyDocument({ recognizedText: QUITTUNG_RECEIPT });

    expect(kassen.classifiedKind).toBe('kassenbeleg');
    expect(quittung.classifiedKind).toBe('quittung');
  });

  it('keeps invoice on invoice cutover, not receipt', () => {
    const result = classifyDocument({ recognizedText: INVOICE_TEXT });

    expect(result.classifiedKind).toBe('eingangsrechnung');
    expect(result.detectionReasonKey).not.toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });

  it('keeps mahnung on payment cutover, not receipt', () => {
    const result = classifyDocument({ recognizedText: MAHNUNG_TEXT });

    expect(result.classifiedKind).toBe('mahnung');
    expect(result.detectionReasonKey).not.toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });

  it('keeps kartenzahlung with fuel markers on tankbeleg', () => {
    const result = classifyDocument({ recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER });

    expect(result.classifiedKind).toBe('tankbeleg');
    expect(result.classifiedKind).not.toBe('ec_beleg');
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

  /*
   * OFFICEPILOT-RECEIPT-PRIMARY-DOCUMENT-TYPE-FIX-01D — Zahlungsevidenz belegt,
   * WIE bezahlt wurde; Kraftstoffevidenz belegt, WAS gekauft wurde. Das reine
   * Standortwort „Tankstelle" im Händlerkopf gehört zu keinem von beidem und
   * darf einen eigenständigen Terminalbeleg nicht zum Tankbeleg machen.
   * Geprüft wird die finale Dokumentart inklusive Cutover und Legacy-Fallback.
   */
  describe('OFFICEPILOT-RECEIPT-PRIMARY-DOCUMENT-TYPE-FIX-01D — Standortwort ist keine Kraftstoffevidenz', () => {
    const STATION_HEAD = ['Musterstadt Tankstelle', 'Musterstrasse 10', '32108 Musterstadt'];

    const LONG_TERMINAL = [
      'Terminal-ID 12345678',
      'Trace-Nr. 004821',
      'Genehmigungs-Nr. 999999',
      'AID A0000000041010',
      'TVR 0000008000',
      'TSI E800',
      'Zahlung erfolgt',
      'APPROVED',
    ];

    const of = (lines: string[]): string => lines.join('\n');

    it('S1: kurzer eigenständiger EC-Terminalbeleg einer Tankstelle bleibt ec_beleg', () => {
      const result = classifyDocument({
        recognizedText: of([
          ...STATION_HEAD,
          'EC-Beleg',
          'Kartenzahlung Girocard',
          'Betrag 70,51 EUR',
          'APPROVED',
        ]),
      });
      expect(result.classifiedKind).toBe('ec_beleg');
    });

    it('S2: langer eigenständiger EC-Terminalbeleg einer Tankstelle bleibt ec_beleg', () => {
      const result = classifyDocument({
        recognizedText: of([
          ...STATION_HEAD,
          'EC-Beleg',
          'Kartenzahlung Girocard',
          ...LONG_TERMINAL,
          'Betrag 70,51 EUR',
        ]),
      });
      expect(result.classifiedKind).toBe('ec_beleg');
    });

    it('S3: kurzer eigenständiger Kreditkartenbeleg einer Tankstelle bleibt kreditkartenbeleg', () => {
      const result = classifyDocument({
        recognizedText: of([
          ...STATION_HEAD,
          'Kreditkarte Mastercard',
          'Betrag 70,51 EUR',
          'APPROVED',
        ]),
      });
      expect(result.classifiedKind).toBe('kreditkartenbeleg');
    });

    it('S4: langer eigenständiger Kreditkartenbeleg einer Tankstelle bleibt kreditkartenbeleg', () => {
      const result = classifyDocument({
        recognizedText: of([
          ...STATION_HEAD,
          'Kreditkarte Mastercard',
          ...LONG_TERMINAL,
          'Betrag 70,51 EUR',
        ]),
      });
      expect(result.classifiedKind).toBe('kreditkartenbeleg');
    });

    it('S5: vollständiger Kraftstoffbeleg mit langem EC-Terminalblock bleibt tankbeleg', () => {
      const result = classifyDocument({
        recognizedText: of([
          ...STATION_HEAD,
          'Datum: 23.08.2026',
          'Diesel B7',
          '39,32 Liter',
          '1,789 EUR/L',
          'Gesamtbetrag 70,51 EUR',
          'EC-Beleg',
          'Kartenzahlung Girocard',
          ...LONG_TERMINAL,
        ]),
      });
      expect(result.classifiedKind).toBe('tankbeleg');
    });

    it('S6: vollständiger Kraftstoffbeleg mit langem Kreditkartenblock bleibt tankbeleg', () => {
      const result = classifyDocument({
        recognizedText: of([
          ...STATION_HEAD,
          'Datum: 23.08.2026',
          'Super E10',
          '41,10 Liter',
          '1,859 EUR/L',
          'Gesamtbetrag 76,40 EUR',
          'Kreditkarte Mastercard',
          ...LONG_TERMINAL,
        ]),
      });
      expect(result.classifiedKind).toBe('tankbeleg');
    });

    it('S7: Kraftstoffbeleg ohne jeden Zahlungsblock bleibt tankbeleg', () => {
      const result = classifyDocument({
        recognizedText: of([
          ...STATION_HEAD,
          'Datum: 23.08.2026',
          'Diesel B7',
          '39,32 Liter',
          '1,789 EUR/L',
          'Gesamtbetrag 70,51 EUR',
        ]),
      });
      expect(result.classifiedKind).toBe('tankbeleg');
    });

    it('S8: nur Standortwort und Betrag — bestehendes Verhalten wird festgeschrieben', () => {
      // Weder Zahlungs- noch Kraftstoffevidenz: die Legacy-Katalogregel greift
      // weiterhin über das Standortwort. Bewusst keine neue Produktentscheidung.
      const result = classifyDocument({
        recognizedText: of([...STATION_HEAD, 'Gesamtbetrag 70,51 EUR']),
      });
      expect(result.classifiedKind).toBe('tankbeleg');
    });
  });

  it('falls back to legacy when OCR text is missing', () => {
    const legacy = detectClassifiedKindWithReason({});
    const result = classifyDocument({});

    expect(result.classifiedKind).toBe(legacy.kind);
    expect(result.detectionReasonKey).not.toBe(DI_RECEIPT_SCORING_REASON_KEY);
  });
});
