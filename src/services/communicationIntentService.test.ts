import { describe, expect, it } from 'vitest';
import { detectCommunicationIntent, detectRewriteStyle } from './communicationIntentService';
import type { CommunicationContext } from '../types/communication';

describe('detectCommunicationIntent', () => {
  it('detects price_adjustment', () => {
    expect(detectCommunicationIntent('Ich möchte den Preis erhöhen')).toBe('price_adjustment');
  });

  it('detects delay_notice', () => {
    expect(detectCommunicationIntent('Wir haben eine Verzögerung auf der Baustelle')).toBe('delay_notice');
  });

  it('detects document_question', () => {
    expect(detectCommunicationIntent('Was wollen die von mir?')).toBe('document_question');
  });

  it('detects rewrite_message from style keywords', () => {
    expect(detectCommunicationIntent('Bitte höflicher formulieren')).toBe('rewrite_message');
    expect(detectRewriteStyle('höflicher formulieren')).toBe('polite');
  });
});

describe('detectCommunicationIntent with context', () => {
  const letterContext: CommunicationContext = {
    ref: { type: 'inbox', id: 'x' },
    companyName: 'Test GmbH',
    facts: [],
    relevanceAllowed: true,
    disclaimer: 'Disclaimer',
    letterExplanation: {
      kind: 'finanzamt',
      about: 'Finanzamt Schreiben',
      importance: 'Wichtig',
      deadline: 'Frist 2026-07-01',
      nextSteps: 'Prüfen',
    },
  };

  it('detects deadline question with letter context', () => {
    expect(detectCommunicationIntent('Bis wann muss ich antworten?', letterContext)).toBe(
      'document_question',
    );
  });
});
