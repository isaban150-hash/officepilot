import { describe, expect, it } from 'vitest';
import { answerDocumentQuestion } from './communicationDocumentQaService';
import type { CommunicationContext } from '../types/communication';

describe('answerDocumentQuestion', () => {
  const relevantContext: CommunicationContext = {
    ref: { type: 'inbox', id: 'inbox-1' },
    companyName: 'Test GmbH',
    facts: [],
    relevanceAllowed: true,
    disclaimer: 'Disclaimer',
    subject: 'Steuerbescheid 2025',
    letterExplanation: {
      kind: 'finanzamt',
      about: 'Es könnte ein Finanzamt-Schreiben sein.',
      importance: 'Wahrscheinlich wichtig',
      deadline: 'Im Text erkannte Frist: 2026-07-15',
      nextSteps: 'Frist prüfen und Original abheften.',
    },
    recognizedData: { Frist: '2026-07-15' },
  };

  it('answers what_wanted from letter explanation', () => {
    const result = answerDocumentQuestion(
      { userText: 'Was wollen die von mir?' },
      relevantContext,
    );
    expect(result.questionType).toBe('what_wanted');
    expect(result.answer).toContain('Finanzamt');
    expect(result.sources).toContain('letterExplanation.about');
  });

  it('answers deadline question', () => {
    const result = answerDocumentQuestion(
      { userText: 'Bis wann muss ich antworten?' },
      relevantContext,
    );
    expect(result.questionType).toBe('deadline');
    expect(result.answer).toMatch(/2026-07-15|Frist/);
  });

  it('blocks when not company relevant', () => {
    const blocked: CommunicationContext = {
      ...relevantContext,
      relevanceAllowed: false,
    };
    const result = answerDocumentQuestion(
      { userText: 'Was wollen die von mir?' },
      blocked,
    );
    expect(result.uncertain).toBe(true);
    expect(result.answer).toContain('nicht firmenrelevant');
  });
});
