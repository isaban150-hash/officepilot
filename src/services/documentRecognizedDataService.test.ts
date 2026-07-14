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

const TANK_RECEIPT_WITH_REGISTER_FOOTER = TANK_RECEIPT_WITH_AMOUNT;

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

  it('returns only Dokumentart when OCR text is missing', () => {
    const recognizedData = buildEvidenceBasedRecognizedData({
      classifiedKind: 'tankbeleg',
    });

    expect(recognizedData).toEqual({ Dokumentart: 'tankbeleg' });
    expect(recognizedData.Betrag).toBeUndefined();
    expect(recognizedData.Tankstelle).toBeUndefined();
  });

  it('does not inject sender hints as tank station', () => {
    const result = classifyDocument({
      recognizedText: TANK_RECEIPT_WITH_REGISTER_FOOTER,
      senderHint: 'Shell Autobahn',
    });

    expect(result.classifiedKind).toBe('tankbeleg');
    expect(result.recognizedData.Tankstelle).toBe('ARAL Tankstelle München');
    expect(result.recognizedData.Tankstelle).not.toBe('Shell Autobahn');
  });

  it('feeds OCR amount into the expense flow', () => {
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
