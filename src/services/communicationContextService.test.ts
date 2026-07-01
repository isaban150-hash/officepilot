import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { createTestVorgang } from '../test/fixtures';
import { buildCommunicationContext } from './communicationContextService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateInboxStore } from './inboxService';
import { addVorgangNote, hydrateVorgangNotes } from './vorgangNoteService';
import { addKnowledgeFact, resetKnowledgeFacts } from './knowledgeService';
import { hydrateVorgangStore } from './vorgangService';
import type { InboxItem } from '../types/models';

function createBriefInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-brief-test',
    title: 'Finanzamt Schreiben',
    sender: 'Finanzamt München',
    documentType: 'behoerde',
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
    ...overrides,
  };
}

describe('buildCommunicationContext', () => {
  beforeEach(() => {
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Test GmbH' });
    hydrateVorgangStore([createTestVorgang()]);
    hydrateVorgangNotes([]);
    hydrateInboxStore([]);
    resetKnowledgeFacts();
  });

  it('builds inbox context with letter explanation', () => {
    hydrateInboxStore([createBriefInboxItem()]);
    const context = buildCommunicationContext({ type: 'inbox', id: 'inbox-brief-test' });
    expect(context.relevanceAllowed).toBe(true);
    expect(context.letterExplanation?.kind).toBe('finanzamt');
    expect(context.recognizedData?.Frist).toBe('2026-07-15');
  });

  it('blocks non-relevant inbox without override', () => {
    hydrateInboxStore([
      createBriefInboxItem({
        id: 'inbox-private',
        markedAsCompanyDocument: false,
        title: 'Privater Brief',
        sender: 'Unbekannt',
        recognizedData: {},
        officePilotSuggestion: '',
      }),
    ]);
    const context = buildCommunicationContext({ type: 'inbox', id: 'inbox-private' });
    expect(context.relevanceAllowed).toBe(false);
  });

  it('includes vorgang notes as facts', () => {
    addVorgangNote('v-test-1', { body: 'Kunde möchte graue Fliesen' });
    const context = buildCommunicationContext({ type: 'vorgang', id: 'v-test-1' });
    expect(context.facts.some((fact) => fact.value.includes('graue Fliesen'))).toBe(true);
    expect(context.facts.some((fact) => fact.source === 'note')).toBe(true);
  });

  it('includes active knowledge facts with source knowledge', () => {
    addKnowledgeFact({
      scope: 'vorgang',
      scopeId: 'v-test-1',
      category: 'material_preference',
      key: 'fliesen',
      value: 'grau',
      displayText: 'Kunde wünscht graue Fliesen',
      sourceType: 'user',
    });
    const context = buildCommunicationContext({ type: 'vorgang', id: 'v-test-1' });
    expect(context.facts.some((fact) => fact.source === 'knowledge')).toBe(true);
    expect(context.facts.some((fact) => fact.value.includes('graue Fliesen'))).toBe(true);
  });
});
