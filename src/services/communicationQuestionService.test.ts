import { describe, expect, it } from 'vitest';
import { getMissingCommunicationInfo } from './communicationQuestionService';
import type { CommunicationContext, CommunicationRequest } from '../types/communication';

const baseContext: CommunicationContext = {
  ref: { type: 'none' },
  companyName: 'Test GmbH',
  facts: [],
  relevanceAllowed: true,
  disclaimer: 'Disclaimer',
};

describe('getMissingCommunicationInfo', () => {
  it('requires position, newPrice and reason for price_adjustment', () => {
    const request: CommunicationRequest = { userText: 'Preis erhöhen' };
    const missing = getMissingCommunicationInfo('price_adjustment', request, baseContext);
    expect(missing.map((field) => field.fieldId).sort()).toEqual(['newPrice', 'position', 'reason']);
  });

  it('returns empty when all price_adjustment fields provided', () => {
    const request: CommunicationRequest = {
      userText: 'Preis erhöhen',
      userAnswers: {
        position: 'Fliesenarbeit',
        newPrice: '120 €/m²',
        reason: 'Materialkosten gestiegen',
      },
    };
    const missing = getMissingCommunicationInfo('price_adjustment', request, baseContext);
    expect(missing).toHaveLength(0);
  });

  it('prefills invoice reference from context', () => {
    const context: CommunicationContext = {
      ...baseContext,
      invoiceSummary: {
        id: 'inv-1',
        number: '2026-0100',
        amount: 1000,
        openAmount: 500,
      },
    };
    const request: CommunicationRequest = { userText: 'Zahlungserinnerung senden' };
    const missing = getMissingCommunicationInfo('payment_reminder', request, context);
    expect(missing).toHaveLength(0);
  });
});
