import { describe, expect, it } from 'vitest';
import { buildCommunicationDraft } from './communicationDraftService';
import { getDraftBodyLength, renderCommunicationDraft } from './communicationChannelService';
import type { CommunicationContext, CommunicationRequest } from '../types/communication';

const baseContext: CommunicationContext = {
  ref: { type: 'vorgang', id: 'v-1' },
  companyName: 'Muster GmbH',
  recipient: { name: 'Kunde Müller' },
  facts: [],
  relevanceAllowed: true,
  disclaimer: 'Disclaimer',
  vorgangSummary: {
    id: 'v-1',
    title: 'Bad Sanierung',
    customer: 'Kunde Müller',
    baustelle: 'Hauptstraße 1',
  },
};

describe('buildCommunicationDraft', () => {
  it('returns null for price_adjustment without reason', () => {
    const request: CommunicationRequest = {
      userText: 'Preis erhöhen',
      userAnswers: { position: 'Fliesen', newPrice: '50 €' },
    };
    expect(buildCommunicationDraft(request, baseContext, 'price_adjustment')).toBeNull();
  });

  it('builds draft with user-provided reason', () => {
    const request: CommunicationRequest = {
      userText: 'Preis erhöhen',
      userAnswers: {
        position: 'Fliesenarbeit',
        newPrice: '120 €/m²',
        reason: 'Materialkosten gestiegen',
      },
    };
    const draft = buildCommunicationDraft(request, baseContext, 'price_adjustment');
    expect(draft).not.toBeNull();
    expect(draft!.body).toContain('Materialkosten gestiegen');
    expect(draft!.basedOnFacts.some((fact) => fact.includes('Grund (vom Nutzer)'))).toBe(true);
    expect(draft!.notIncluded.some((line) => line.includes('automatisch'))).toBe(true);
  });

  it('builds delay_notice with user reason', () => {
    const request: CommunicationRequest = {
      userText: 'Verzögerung',
      userAnswers: { delayReason: 'Lieferengpass Material' },
    };
    const draft = buildCommunicationDraft(request, baseContext, 'delay_notice');
    expect(draft!.body).toContain('Lieferengpass Material');
  });
});

describe('renderCommunicationDraft', () => {
  it('renders WhatsApp shorter than email', () => {
    const request: CommunicationRequest = {
      userText: 'Verzögerung',
      userAnswers: { delayReason: 'Wetter' },
    };
    const core = buildCommunicationDraft(request, baseContext, 'delay_notice')!;
    const email = renderCommunicationDraft(core, 'email', baseContext);
    const whatsapp = renderCommunicationDraft(core, 'whatsapp', baseContext);
    expect(getDraftBodyLength(whatsapp)).toBeLessThan(getDraftBodyLength(email));
  });

  it('renders formal letter with company header', () => {
    const request: CommunicationRequest = {
      userText: 'Verzögerung',
      userAnswers: { delayDuration: '2 Wochen' },
    };
    const core = buildCommunicationDraft(request, baseContext, 'delay_notice')!;
    const letter = renderCommunicationDraft(core, 'letter', baseContext);
    expect(letter.tone).toBe('formal');
    expect(letter.body).toContain('Muster GmbH');
  });
});
