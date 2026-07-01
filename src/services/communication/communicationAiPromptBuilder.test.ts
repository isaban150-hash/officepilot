import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import {
  buildCommunicationAiAllowedSourceText,
  buildCommunicationAiPrompt,
} from './communicationAiPromptBuilder';
import { COMMUNICATION_AI_SYSTEM_RULES } from '../ai/aiGuardrails';
import type { CommunicationAiEnhanceInput } from '../../types/communicationAi';
import type { CommunicationContext, CommunicationDraft } from '../../types/communication';

const sampleDraft: CommunicationDraft = {
  intent: 'price_adjustment',
  channel: 'email',
  subject: 'Preisanpassung',
  greeting: 'Sehr geehrte Damen und Herren,',
  body: 'Der Preis für Fliesenarbeiten wird auf 120,00 € angepasst. Grund: Materialengpass.',
  closing: 'Mit freundlichen Grüßen\nTest GmbH',
  tone: 'formal',
  basedOnFacts: ['Position: Fliesenarbeiten', 'Neuer Preis: 120', 'Grund (vom Nutzer): Materialengpass'],
  notIncluded: ['Keine automatisch ergänzten Marktdaten'],
};

const sampleContext: CommunicationContext = {
  ref: { type: 'vorgang', id: 'v-1' },
  companyName: 'Test GmbH',
  recipient: { name: 'Müller GmbH' },
  subject: 'Sanierung Bad',
  facts: [
    { key: 'note:1', value: 'Kunde wünscht schnelle Rückmeldung', source: 'note' },
    { key: 'iban', value: 'DE89370400440532013000', source: 'system' },
    { key: 'steuer', value: 'Steuernummer: 27/123/45678', source: 'system' },
  ],
  relevanceAllowed: true,
  disclaimer: 'Disclaimer',
  vorgangSummary: {
    id: 'v-1',
    title: 'Sanierung Bad',
    customer: 'Müller GmbH',
    baustelle: 'Berlin',
  },
};

function buildInput(overrides: Partial<CommunicationAiEnhanceInput> = {}): CommunicationAiEnhanceInput {
  return {
    context: sampleContext,
    draft: sampleDraft,
    channel: 'email',
    style: 'professional',
    ...overrides,
  };
}

describe('communicationAiPromptBuilder', () => {
  beforeEach(() => {
    hydrateCompanyProfileStore({
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Test GmbH',
      iban: 'DE89370400440532013000',
      taxNumber: '27/123/45678',
      vatId: 'DE123456789',
    });
  });

  it('enthält Guardrails, Original-Draft und basedOnFacts', () => {
    const prompt = buildCommunicationAiPrompt(buildInput());

    expect(prompt).toContain(COMMUNICATION_AI_SYSTEM_RULES);
    expect(prompt).toContain('Keine Rechtsberatung');
    expect(prompt).toContain(sampleDraft.body);
    expect(prompt).toContain('Position: Fliesenarbeiten');
    expect(prompt).toContain('Nicht enthalten');
  });

  it('enthält keine IBAN, Steuernummer oder USt-ID', () => {
    const prompt = buildCommunicationAiPrompt(buildInput());

    expect(prompt).not.toContain('DE89370400440532013000');
    expect(prompt).not.toContain('27/123/45678');
    expect(prompt).not.toContain('DE123456789');
    expect(prompt).not.toContain('Steuernummer');
  });

  it('stellt erlaubte Quelltexte für die Guard-Validierung bereit', () => {
    const allowed = buildCommunicationAiAllowedSourceText(buildInput());

    expect(allowed).toContain('120,00 €');
    expect(allowed).toContain('DE89370400440532013000');
  });
});
