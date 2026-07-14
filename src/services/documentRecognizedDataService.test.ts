import { afterEach, describe, expect, it } from 'vitest';
import { setOcrOnlyRecognizedDataEnabledForTests } from '../config/documentIntelligenceConfig';
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

describe('documentRecognizedDataService', () => {
  afterEach(() => {
    setOcrOnlyRecognizedDataEnabledForTests(null);
  });

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

  it('returns only Dokumentart when OCR text is missing', () => {
    const recognizedData = buildEvidenceBasedRecognizedData({
      classifiedKind: 'tankbeleg',
    });

    expect(recognizedData).toEqual({ Dokumentart: 'tankbeleg' });
    expect(recognizedData.Betrag).toBeUndefined();
    expect(recognizedData.Tankstelle).toBeUndefined();
  });

  it('does not inject sender hints as merchant name', () => {
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

  it('feeds OCR amount into the expense flow for ec_beleg', () => {
    const classification = classifyDocument({ recognizedText: EC_RECEIPT });
    const inboxItem = {
      id: 'inbox-ec-ocr',
      title: 'EC-Beleg',
      sender: classification.recognizedData.Lieferant ?? '',
      recognizedData: classification.recognizedData,
      classifiedKind: classification.classifiedKind,
    } as InboxItem;

    const expenseInput = buildExpenseInputFromInbox(inboxItem, 'ec_beleg');

    expect(classification.classifiedKind).toBe('ec_beleg');
    expect(expenseInput.grossAmount).toBe(18.42);
  });

  it('feeds OCR amount into the expense flow for kassenbeleg', () => {
    const classification = classifyDocument({ recognizedText: KASSEN_RECEIPT });
    const inboxItem = {
      id: 'inbox-kassen-ocr',
      title: 'Kassenbeleg',
      sender: classification.recognizedData.Lieferant ?? '',
      recognizedData: classification.recognizedData,
      classifiedKind: classification.classifiedKind,
    } as InboxItem;

    const expenseInput = buildExpenseInputFromInbox(inboxItem, 'kassenbeleg');

    expect(classification.classifiedKind).toBe('kassenbeleg');
    expect(expenseInput.grossAmount).toBe(8.9);
  });

  it('leaves other document kinds on legacy recognizedData profiles', () => {
    const result = classifyDocument({
      recognizedText: 'Eingangsrechnung Lieferant Mustermann GmbH',
      kindHint: 'eingangsrechnung',
    });

    expect(shouldUseEvidenceBasedRecognizedData(result.classifiedKind)).toBe(false);
    expect(result.recognizedData.Betrag).toBe('342,16 €');
  });

  it('can be disabled via feature flag for rollback', () => {
    setOcrOnlyRecognizedDataEnabledForTests(false);

    const result = classifyDocument({ recognizedText: 'Tankstelle Diesel Beleg' });

    expect(result.classifiedKind).toBe('tankbeleg');
    expect(result.recognizedData.Betrag).toBe('85,40 €');
  });
});
