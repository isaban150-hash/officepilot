import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as supabaseLib from '../../lib/supabase';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { getAllVorgaenge, hydrateVorgangStore } from '../vorgangService';
import { createTestVorgang } from '../../test/fixtures';
import {
  enhanceCommunicationDraft,
  setCommunicationAiGenerateTextForTests,
} from './communicationAiService';
import { buildCommunicationAiPrompt } from './communicationAiPromptBuilder';
import { COMMUNICATION_AI_SYSTEM_RULES } from '../ai/aiGuardrails';
import type { CommunicationAiEnhanceInput } from '../../types/communicationAi';
import type { CommunicationContext, CommunicationDraft } from '../../types/communication';

const sampleDraft: CommunicationDraft = {
  intent: 'delay_notice',
  channel: 'email',
  subject: 'Verzögerung',
  body: 'Es verzögert sich wegen Material. Wir melden uns am 15.07.2026.',
  tone: 'neutral',
  basedOnFacts: ['Material verzögert', 'Termin: 15.07.2026'],
  notIncluded: ['Keine neuen Gründe'],
};

const sampleContext: CommunicationContext = {
  ref: { type: 'vorgang', id: 'v-ai-1' },
  companyName: 'Test GmbH',
  facts: [],
  relevanceAllowed: true,
  disclaimer: 'Disclaimer',
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

describe('communicationAiService', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    setCommunicationAiGenerateTextForTests(null);
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Test GmbH' });
    hydrateVorgangStore([createTestVorgang({ id: 'v-ai-1' })]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setCommunicationAiGenerateTextForTests(null);
    vi.restoreAllMocks();
  });

  it('ruft ohne eingerichtete Cloud-Verbindung keinen Provider auf', async () => {
    /*
     * SECURITY-GEMINI-KEY-01B: Der Browser kennt keinen Gemini-Schlüssel mehr.
     * Die Zusicherung bleibt — ohne Verbindung wird nichts gesendet.
     */
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    const generateMock = vi.fn().mockResolvedValue({ success: true, text: 'KI-Text' });
    setCommunicationAiGenerateTextForTests(generateMock);

    const result = await enhanceCommunicationDraft(buildInput());

    expect(result.source).toBe('unavailable');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('liefert KI-Entwurf bei gültiger Mock-Antwort', async () => {
    setCommunicationAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: 'Aufgrund von Materialverzug verschiebt sich der Termin am 15.07.2026.',
      }),
    );

    const result = await enhanceCommunicationDraft(buildInput());

    expect(result.success).toBe(true);
    expect(result.source).toBe('ai');
    expect(result.enhancedDraft?.body).toContain('15.07.2026');
  });

  it('fällt bei Guard-Verstoß auf Original zurück', async () => {
    setCommunicationAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: 'Der neue Preis beträgt 999,00 €.',
      }),
    );

    const result = await enhanceCommunicationDraft(buildInput());

    expect(result.source).toBe('rule_fallback');
    expect(result.enhancedDraft?.body).toBe(sampleDraft.body);
    expect(result.warnings?.some((warning) => warning.includes('Geldbetrag'))).toBe(true);
  });

  it('fällt bei API-Fehler auf Original zurück', async () => {
    setCommunicationAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: false,
        errorCode: 'api_error',
        message: 'API nicht erreichbar',
      }),
    );

    const result = await enhanceCommunicationDraft(buildInput());

    expect(result.source).toBe('rule_fallback');
    expect(result.enhancedDraft?.body).toBe(sampleDraft.body);
    expect(result.message).toContain('API nicht erreichbar');
  });

  it('mutiert keine Stores', async () => {
    setCommunicationAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: 'Aufgrund von Materialverzug verschiebt sich der Termin am 15.07.2026.',
      }),
    );

    const before = JSON.stringify(getAllVorgaenge());
    await enhanceCommunicationDraft(buildInput());
    const after = JSON.stringify(getAllVorgaenge());

    expect(after).toBe(before);
  });

  it('baut Prompt mit Guardrails und Original-Draft', () => {
    const prompt = buildCommunicationAiPrompt(buildInput());

    expect(prompt).toContain(COMMUNICATION_AI_SYSTEM_RULES);
    expect(prompt).toContain(sampleDraft.body);
    expect(prompt).toContain('Material verzögert');
  });
});
