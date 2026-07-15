import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { parseDocumentAiAnswer } from './documentAiAnswerParser';
import {
  detectDocumentQuestionIntents,
  filterUncertaintyNotesForQuestion,
} from './documentAiQuestionIntent';

describe('documentAiAnswerParser', () => {
  it('parst JSON in directAnswer und explanation', () => {
    const parsed = parseDocumentAiAnswer(
      '{"directAnswer":"Nein.","explanation":"Laut dem Hinweis im Dokument ist es eine Testrechnung."}',
    );
    expect(parsed.directAnswer).toBe('Nein.');
    expect(parsed.explanation).toContain('Testrechnung');
    expect(parsed.text.startsWith('Nein.')).toBe(true);
  });

  it('parst beschriftetes Format', () => {
    const parsed = parseDocumentAiAnswer(
      'KERN: Die Frist ist 2026-12-31.\nERKLÄRUNG: Im Dokument steht die Gültigkeit bis 2026-12-31.',
    );
    expect(parsed.directAnswer).toContain('Frist');
    expect(parsed.explanation).toContain('Gültigkeit');
  });

  it('fällt auf ersten Satz zurück', () => {
    const parsed = parseDocumentAiAnswer(
      'Nein. Laut dem Hinweis im Dokument handelt es sich um eine Testrechnung.',
    );
    expect(parsed.directAnswer).toBe('Nein.');
    expect(parsed.explanation).toContain('Testrechnung');
  });
});

describe('documentAiQuestionIntent', () => {
  const customerDe = t('document.freeQuestion.note.customerUncertain', 'de');
  const amountDe = t('document.freeQuestion.note.amountNeedsReview', 'de');
  const deadlineDe = t('document.freeQuestion.note.noDeadline', 'de');
  const senderDe = t('document.freeQuestion.note.noSender', 'de');
  const noTextDe = t('document.freeQuestion.note.noRecognizedText', 'de');
  const customerTr = t('document.freeQuestion.note.customerUncertain', 'tr');
  const deadlineBg = t('document.freeQuestion.note.noDeadline', 'bg');

  it('erkennt Intents in DE/TR/BG', () => {
    expect(detectDocumentQuestionIntents('Muss ich das bezahlen?').has('payment')).toBe(true);
    expect(detectDocumentQuestionIntents('Bu faturayı ödemeli miyim?').has('payment')).toBe(true);
    expect(detectDocumentQuestionIntents('Трябва ли да платя?').has('payment')).toBe(true);
    expect(detectDocumentQuestionIntents('Welche Frist gibt es?').has('deadline')).toBe(true);
    expect(detectDocumentQuestionIntents('Son tarih nedir?').has('deadline')).toBe(true);
    expect(detectDocumentQuestionIntents('Какъв е срокът?').has('deadline')).toBe(true);
    expect(detectDocumentQuestionIntents('Wer ist der Absender?').has('sender')).toBe(true);
    expect(detectDocumentQuestionIntents('Welcher Kunde ist das?').has('customer_or_order')).toBe(
      true,
    );
    expect(detectDocumentQuestionIntents('Was steht im Dokument?').has('general')).toBe(true);
  });

  it('blendet Kundenunsicherheit bei Zahlungsfrage aus', () => {
    const filtered = filterUncertaintyNotesForQuestion(
      'Muss ich das bezahlen?',
      [customerDe, amountDe, noTextDe],
      'de',
    );
    expect(filtered).not.toContain(customerDe);
    expect(filtered).toContain(amountDe);
    expect(filtered).toContain(noTextDe);
  });

  it('behält Frist bei Fristfrage und Absender bei Absenderfrage', () => {
    expect(
      filterUncertaintyNotesForQuestion('Welche Frist gibt es?', [deadlineDe, customerDe], 'de'),
    ).toEqual([deadlineDe]);
    expect(
      filterUncertaintyNotesForQuestion('Wer ist der Absender?', [senderDe, customerDe], 'de'),
    ).toEqual([senderDe]);
  });

  it('behält Kundenunsicherheit bei Kundenfrage', () => {
    expect(
      filterUncertaintyNotesForQuestion('Welcher Auftrag ist verknüpft?', [customerDe, amountDe], 'de'),
    ).toEqual([customerDe]);
  });

  it('behält fehlenden Text bei jeder Frage', () => {
    expect(
      filterUncertaintyNotesForQuestion('Muss ich zahlen?', [noTextDe, customerDe], 'de'),
    ).toContain(noTextDe);
    expect(
      filterUncertaintyNotesForQuestion('Was steht hier?', [noTextDe, customerDe], 'de'),
    ).toEqual([noTextDe]);
  });

  it('filtert Notes unabhängig von der Note-Sprache', () => {
    expect(
      filterUncertaintyNotesForQuestion('Muss ich bezahlen?', [customerTr, amountDe], 'de'),
    ).toEqual([amountDe]);
    expect(
      filterUncertaintyNotesForQuestion('Какъв е срокът?', [deadlineBg, customerDe], 'bg'),
    ).toEqual([deadlineBg]);
  });
});
