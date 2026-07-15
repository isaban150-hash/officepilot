import { describe, expect, it } from 'vitest';
import { formatMessage } from './i18n/formatMessage';
import {
  assertCoreTranslations,
  de,
  t,
  tr,
  bg,
} from './i18n';
import { buildAiLanguageInstruction } from './services/ai/aiLanguageRules';
import { getLetterExplanation } from './services/letterExplanationService';
import type { InboxItem } from './types/models';
import { getLoginErrorMessage, getRegisterErrorMessage } from './services/auth/authService';
import { OFFICEPILOT_TERMINOLOGY, getTerminologyLabel } from './i18n/terminology';
import { buildBrainPrompt } from './services/brain/brainPromptBuilder';
import { buildDocumentAiPrompt } from './services/document/documentAiPromptBuilder';
import { buildCommunicationAiPrompt } from './services/communication/communicationAiPromptBuilder';
import { buildBrainSnapshot } from './services/brain/brainSnapshotService';

function createInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-i18n',
    title: 'Testschreiben',
    documentType: 'brief',
    sender: 'BG BAU',
    priority: 'mittel',
    deadline: '2026-04-10',
    recommendedAction: 'abheften',
    digitalFolder: { id: 'dig-1', name: 'Briefe', path: '/Firma/Briefe/' },
    paperFiling: { folderId: 'folder-5', register: 'A', label: 'Behörden & Versicherungen' },
    status: 'neu',
    receivedAt: '2026-03-27',
    recognizedData: { Betreff: 'Beitragsbescheid Q1' },
    officePilotSuggestion: 'Mock',
    nextTaskLabel: 'Prüfen',
    securityHint: 'Mock',
    ...overrides,
  };
}

describe('I18N-CORE-01', () => {
  it('core paths have DE/TR/BG translations without empty values', () => {
    const missing = assertCoreTranslations({
      de: de as Record<string, string>,
      tr,
      bg,
      ro: {},
      ru: {},
    });
    expect(missing).toEqual([]);
  });

  it('DE mobile greeting uses Sie-form', () => {
    expect(t('mobile.home.greeting', 'de')).toContain('Sie');
    expect(t('mobile.home.greeting', 'de')).not.toMatch(/möchtest du/i);
  });

  it('login/register/error messages are localized for TR and BG', () => {
    expect(getLoginErrorMessage('invalid_credentials', 'tr')).toContain('E-posta');
    expect(getLoginErrorMessage('invalid_credentials', 'bg')).toMatch(/имейл|Грешен/i);
    expect(getRegisterErrorMessage('password_too_short', 'tr')).toContain('8');
    expect(getRegisterErrorMessage('password_too_short', 'bg')).toContain('8');
  });

  it('letter explanation renders BG BAU in all product languages without foreign institutions', () => {
    const explanation = getLetterExplanation(
      createInboxItem({ documentType: 'behoerde', sender: 'BG BAU' }),
    );
    expect(explanation).not.toBeNull();
    const render = (lang: 'de' | 'tr' | 'bg') =>
      formatMessage((key) => t(key as keyof typeof de, lang), explanation!.about);
    expect(render('de')).toContain('BG BAU');
    expect(render('tr')).toContain('BG BAU');
    expect(render('bg')).toContain('BG BAU');
    expect(render('tr')).not.toMatch(/Türkiye.*Sosyal Güvenlik/i);
  });

  it('terminology preserves German institution names', () => {
    const finanzamt = OFFICEPILOT_TERMINOLOGY.find((e) => e.id === 'finanzamt');
    expect(finanzamt?.preserveGermanName).toBe(true);
    expect(getTerminologyLabel('finanzamt', 'tr')).toContain('Finanzamt');
    expect(getTerminologyLabel('finanzamt', 'bg')).toContain('Finanzamt');
  });

  it('LLM prompts include active response language', () => {
    expect(buildAiLanguageInstruction('tr')).toContain('Türkçe');
    expect(buildAiLanguageInstruction('bg')).toContain('български');
    const brainPrompt = buildBrainPrompt('Test?', buildBrainSnapshot(), undefined, 'tr');
    expect(brainPrompt).toContain('Türkçe');
    const docPrompt = buildDocumentAiPrompt('Test?', {
      sourceType: 'inbox',
      title: 'Brief',
      issuerOrSender: 'AOK',
      category: 'brief',
      recognizedDataLines: [],
      missingDocuments: [],
      tags: [],
      uncertainFieldNotes: [],
      missingFieldNotes: [],
    }, 'bg');
    expect(docPrompt).toContain('български');
    const commPrompt = buildCommunicationAiPrompt({
      context: { ref: { type: 'vorgang', id: 'v-1' }, facts: [], relevanceAllowed: true, disclaimer: '' },
      draft: { intent: 'general', channel: 'email', body: 'Test', tone: 'formal', basedOnFacts: [], notIncluded: [] },
      channel: 'email',
      style: 'professional',
    }, 'tr');
    expect(commPrompt).toContain('Türkçe');
  });

  it('bulgarian navigation uses cyrillic', () => {
    expect(t('nav.dokumente', 'bg')).toMatch(/[А-Яа-яЁё]/);
    expect(t('auth.login.title', 'bg')).toMatch(/[А-Яа-яЁё]/);
  });
});
