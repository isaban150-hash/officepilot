import { afterEach, describe, expect, it } from 'vitest';
import { setOcrOnlyRecognizedDataEnabledForTests, setPaymentScoringCutoverEnabledForTests } from '../config/documentIntelligenceConfig';
import { classifyDocument } from './documentClassificationService';
import {
  buildEvidenceBasedRecognizedData,
  shouldUseEvidenceBasedRecognizedData,
} from './documentRecognizedDataService';
import { buildExpenseInputFromInbox } from './officeActionService';
import type { InboxItem } from '../types/models';

const TANK_RECEIPT_WITH_AMOUNT = [
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

const INCOMING_INVOICE = [
  'Müller Bau GmbH',
  'Musterstraße 1',
  '12345 Musterstadt',
  'Rechnungsnummer: INV-2026-77',
  'Datum: 12.03.2026',
  'Leistung: Sanierung Dach',
  'Position 1    450,00 EUR',
  'Position 2    320,00 EUR',
  'Gesamtbetrag 1.247,80 EUR',
  'IBAN: DE89 3704 0044 0532 0130 00',
  'zahlbar bis 31.03.2026',
].join('\n');

describe('documentRecognizedDataService', () => {
  afterEach(() => {
    setOcrOnlyRecognizedDataEnabledForTests(null);
    setPaymentScoringCutoverEnabledForTests(null);
  });

  describe('receipt family', () => {
    it('uses OCR amount and station instead of demo values for tankbeleg', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'tankbeleg',
        recognizedText: TANK_RECEIPT_WITH_AMOUNT,
      });

      expect(recognizedData.Dokumentart).toBe('tankbeleg');
      expect(recognizedData.Betrag).toContain('52,18');
      expect(recognizedData.Betrag).not.toBe('85,40 €');
      expect(recognizedData.Tankstelle).toBe('ARAL Tankstelle München');
      expect(recognizedData.Tankstelle).not.toBe('Tankstelle');
    });

    it('uses OCR-only fields for ec_beleg', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'ec_beleg',
        recognizedText: EC_RECEIPT,
      });

      expect(recognizedData.Dokumentart).toBe('ec_beleg');
      expect(recognizedData.Betrag).toContain('18,42');
      expect(recognizedData.Lieferant).toBe('REWE Markt München');
      expect(recognizedData.Belegnummer).toBe('EC-4421');
    });

    it('uses OCR-only fields for kassenbeleg including receipt number', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'kassenbeleg',
        recognizedText: KASSEN_RECEIPT,
      });

      expect(recognizedData.Dokumentart).toBe('kassenbeleg');
      expect(recognizedData.Betrag).toContain('8,90');
      expect(recognizedData.Datum).toBe('14.07.2026');
      expect(recognizedData.Lieferant).toBe('Bäckerei Schmidt');
      expect(recognizedData.Belegnummer).toBe('4421');
    });

    it('does not inject sender hints as merchant name for tankbeleg', () => {
      const result = classifyDocument({
        recognizedText: TANK_RECEIPT_WITH_AMOUNT,
        senderHint: 'Shell Autobahn',
      });

      expect(result.classifiedKind).toBe('tankbeleg');
      expect(result.recognizedData.Tankstelle).toBe('ARAL Tankstelle München');
      expect(result.recognizedData.Tankstelle).not.toBe('Shell Autobahn');
    });

    it('feeds OCR amount into the expense flow for tankbeleg', () => {
      const classification = classifyDocument({ recognizedText: TANK_RECEIPT_WITH_AMOUNT });
      const inboxItem = {
        id: 'inbox-tank-ocr',
        title: 'Tankbeleg',
        sender: classification.recognizedData.Tankstelle ?? '',
        recognizedData: classification.recognizedData,
        classifiedKind: classification.classifiedKind,
      } as InboxItem;

      const expenseInput = buildExpenseInputFromInbox(inboxItem, 'tankbeleg');

      expect(expenseInput.grossAmount).toBe(52.18);
      expect(expenseInput.category).toBe('fahrzeug');
    });
  });

  describe('eingangsrechnung', () => {
    it('uses OCR-only invoice fields instead of demo values', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'eingangsrechnung',
        recognizedText: INCOMING_INVOICE,
      });

      expect(recognizedData.Dokumentart).toBe('eingangsrechnung');
      expect(recognizedData.Rechnungsnummer).toBe('INV-2026-77');
      expect(recognizedData.Rechnungsnummer).not.toBe('RE-2026-0001');
      expect(recognizedData.Betrag).toContain('1.247,80');
      expect(recognizedData.Betrag).not.toBe('342,16 €');
      expect(recognizedData.Lieferant).toBe('Müller Bau GmbH');
      expect(recognizedData.Datum).toBe('12.03.2026');
      expect(recognizedData.Frist).toBe('31.03.2026');
    });

    it('prefers invoice total over line item amounts', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'eingangsrechnung',
        recognizedText: INCOMING_INVOICE,
      });

      expect(recognizedData.Betrag).toContain('1.247,80');
      expect(recognizedData.Betrag).not.toContain('450,00');
      expect(recognizedData.Betrag).not.toContain('320,00');
    });

    it('returns only Dokumentart when OCR text is missing', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'eingangsrechnung',
      });

      expect(recognizedData).toEqual({ Dokumentart: 'eingangsrechnung' });
      expect(recognizedData.Betrag).toBeUndefined();
      expect(recognizedData.Rechnungsnummer).toBeUndefined();
      expect(recognizedData.Frist).toBeUndefined();
    });

    it('does not inject sender hints as Lieferant', () => {
      const result = classifyDocument({
        recognizedText: INCOMING_INVOICE,
        senderHint: 'Falscher Lieferant AG',
      });

      expect(result.classifiedKind).toBe('eingangsrechnung');
      expect(result.recognizedData.Lieferant).toBe('Müller Bau GmbH');
      expect(result.recognizedData.Lieferant).not.toBe('Falscher Lieferant AG');
    });

    it('feeds OCR amount and invoice number into the expense flow', () => {
      const classification = classifyDocument({ recognizedText: INCOMING_INVOICE });
      const inboxItem = {
        id: 'inbox-invoice-ocr',
        title: 'Eingangsrechnung',
        sender: classification.recognizedData.Lieferant ?? '',
        recognizedData: classification.recognizedData,
        classifiedKind: classification.classifiedKind,
      } as InboxItem;

      const expenseInput = buildExpenseInputFromInbox(inboxItem, 'eingangsrechnung');

      expect(classification.classifiedKind).toBe('eingangsrechnung');
      expect(expenseInput.grossAmount).toBe(1247.8);
      expect(expenseInput.invoiceNumber).toBe('INV-2026-77');
    });

    it('enables evidence-based recognizedData for eingangsrechnung', () => {
      const result = classifyDocument({ recognizedText: INCOMING_INVOICE });

      expect(shouldUseEvidenceBasedRecognizedData(result.classifiedKind)).toBe(true);
      expect(result.recognizedData.Betrag).not.toBe('342,16 €');
    });
  });

  describe('payment family', () => {
    const MAHNUNG_OCR = [
      'Müller Bau GmbH',
      '2. Mahnung',
      'Rechnungsnummer: INV-2026-77',
      'Datum: 12.03.2026',
      'Offener Betrag: 1.247,80 EUR',
      'Zahlungsaufforderung',
      'Zahlbar bis 31.03.2026',
    ].join('\n');

    it('uses OCR-only payment fields instead of demo values for mahnung', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'mahnung',
        recognizedText: MAHNUNG_OCR,
      });

      expect(recognizedData.Dokumentart).toBe('mahnung');
      expect(recognizedData.Rechnungsnummer).toBe('INV-2026-77');
      expect(recognizedData.Rechnungsnummer).not.toBe('BZ-2026-8842');
      expect(recognizedData.Betrag).toContain('1.247,80');
      expect(recognizedData.Betrag).not.toBe('342,16 €');
      expect(recognizedData.Fälligkeit).toBe('31.03.2026');
      expect(recognizedData.Fälligkeit).not.toBe('30.03.2026');
      expect(recognizedData.Lieferant).toBe('Müller Bau GmbH');
      expect(recognizedData.Hinweis).toMatch(/mahnung/i);
    });

    it('uses OCR-only fields for zahlungserinnerung', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'zahlungserinnerung',
        recognizedText: [
          'Müller Bau GmbH',
          'Zahlungserinnerung',
          'Rechnungsnummer: INV-2026-55',
          'Datum: 08.03.2026',
          'Offener Betrag: 842,50 EUR',
          'Zahlbar bis 22.03.2026',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('zahlungserinnerung');
      expect(recognizedData.Rechnungsnummer).toBe('INV-2026-55');
      expect(recognizedData.Betrag).toContain('842,50');
      expect(recognizedData.Fälligkeit).toBe('22.03.2026');
      expect(recognizedData.Hinweis).toMatch(/zahlungserinnerung/i);
    });

    it('returns only Dokumentart when OCR text is missing for payment kinds', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'mahnung',
      });

      expect(recognizedData).toEqual({ Dokumentart: 'mahnung' });
      expect(recognizedData.Betrag).toBeUndefined();
      expect(recognizedData.Rechnungsnummer).toBeUndefined();
      expect(recognizedData.Fälligkeit).toBeUndefined();
    });
  });

  describe('legacy and rollback', () => {
    it('leaves mahnung without demo values when cutover is disabled', () => {
      setPaymentScoringCutoverEnabledForTests(false);
      const result = classifyDocument({
        recognizedText: 'Mahnung Zahlungsaufforderung',
      });

      expect(shouldUseEvidenceBasedRecognizedData(result.classifiedKind)).toBe(true);
      expect(result.recognizedData.Betrag).toBeUndefined();
      expect(result.recognizedData.Fälligkeit).toBeUndefined();
      expect(result.recognizedData.Rechnungsnummer).toBeUndefined();
    });

    it('leaves mahnung with empty fields on kindHint legacy path', () => {
      const result = classifyDocument({
        recognizedText: 'Mahnung Zahlungsaufforderung',
        kindHint: 'mahnung',
      });

      expect(shouldUseEvidenceBasedRecognizedData(result.classifiedKind)).toBe(true);
      expect(result.recognizedData.Betrag).toBeUndefined();
      expect(result.recognizedData.Fälligkeit).toBeUndefined();
    });

    it('can be disabled via feature flag for rollback', () => {
      setOcrOnlyRecognizedDataEnabledForTests(false);

      const tank = classifyDocument({ recognizedText: 'Tankstelle Diesel Beleg' });
      const invoice = classifyDocument({
        recognizedText: 'Eingangsrechnung ohne erkennbare Details',
        kindHint: 'eingangsrechnung',
      });

      expect(tank.recognizedData.Betrag).toBe('85,40 €');
      expect(invoice.recognizedData.Betrag).toBe('342,16 €');
      expect(invoice.recognizedData.Rechnungsnummer).toBe('RE-2026-0001');
    });
  });
});
