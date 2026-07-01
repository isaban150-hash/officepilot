import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { createTestVorgang } from '../test/fixtures';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateInboxStore } from './inboxService';
import { processCommunicationRequest } from './communicationOrchestrator';
import { hydrateVorgangStore } from './vorgangService';
import { getDraftBodyLength } from './communicationChannelService';
import type { InboxItem } from '../types/models';

function createBriefInboxItem(): InboxItem {
  return {
    id: 'inbox-brief-orch',
    title: 'Finanzamt Schreiben',
    sender: 'Finanzamt München',
    documentType: 'brief',
    priority: 'hoch',
    deadline: '2026-07-15',
    digitalFolder: { id: 'dig-1', name: 'Behörden', path: '/Behörden/' },
    paperFiling: { folderId: 'folder-1', register: 'A', label: 'Behörden' },
    status: 'neu',
    receivedAt: '2026-06-01',
    officePilotSuggestion: 'Steuerbescheid',
    nextTaskLabel: 'Prüfen',
    securityHint: 'Original aufbewahren',
    recommendedAction: 'archivieren',
    recognizedData: { Frist: '2026-07-15', Betreff: 'Steuerbescheid' },
    markedAsCompanyDocument: true,
  };
}

describe('processCommunicationRequest', () => {
  beforeEach(() => {
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Test GmbH' });
    hydrateVorgangStore([createTestVorgang()]);
    hydrateInboxStore([createBriefInboxItem()]);
  });

  it('returns needs_info for price_adjustment without details', () => {
    const result = processCommunicationRequest({
      userText: 'Ich möchte den Preis erhöhen',
      contextRef: { type: 'vorgang', id: 'v-test-1' },
    });
    expect(result.status).toBe('needs_info');
    expect(result.intent).toBe('price_adjustment');
    expect(result.missingInfo?.length).toBeGreaterThan(0);
  });

  it('returns complete draft with user reason', () => {
    const result = processCommunicationRequest({
      userText: 'Preis erhöhen',
      contextRef: { type: 'vorgang', id: 'v-test-1' },
      userAnswers: {
        position: 'Fliesen',
        newPrice: '95 €',
        reason: 'Teureres Material',
      },
    });
    expect(result.status).toBe('complete');
    expect(result.drafts?.email?.body).toContain('Teureres Material');
    expect(result.drafts?.whatsapp).toBeDefined();
    expect(result.drafts?.letter).toBeDefined();
  });

  it('answers document question for inbox context', () => {
    const result = processCommunicationRequest({
      userText: 'Was wollen die von mir?',
      contextRef: { type: 'inbox', id: 'inbox-brief-orch' },
    });
    expect(result.status).toBe('complete');
    expect(result.intent).toBe('document_question');
    expect(result.documentQa?.questionType).toBe('what_wanted');
  });

  it('blocks non-relevant inbox', () => {
    hydrateInboxStore([
      {
        ...createBriefInboxItem(),
        id: 'inbox-blocked',
        markedAsCompanyDocument: false,
        title: 'Privat',
        sender: 'Unbekannt',
        recognizedData: {},
        officePilotSuggestion: '',
      },
    ]);
    const result = processCommunicationRequest({
      userText: 'Was wollen die von mir?',
      contextRef: { type: 'inbox', id: 'inbox-blocked' },
    });
    expect(result.status).toBe('blocked');
  });

  it('whatsapp draft is shorter than email for delay_notice', () => {
    const result = processCommunicationRequest({
      userText: 'Verzögerung melden',
      contextRef: { type: 'vorgang', id: 'v-test-1' },
      userAnswers: { delayReason: 'Material verzögert' },
    });
    expect(result.status).toBe('complete');
    const emailLen = getDraftBodyLength(result.drafts!.email!);
    const waLen = getDraftBodyLength(result.drafts!.whatsapp!);
    expect(waLen).toBeLessThan(emailLen);
  });
});
