import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { getAllDocuments, hydrateDocumentStore } from '../documentService';
import {
  buildDocumentAiContextFromDocument,
  buildDocumentAiContextFromInbox,
} from './documentAiContextService';
import { buildDocumentAiPrompt } from './documentAiPromptBuilder';
import { askDocumentAi } from './documentAiService';
import { setAiGenerateTextForTests } from '../ai/aiRequestRunner';
import { AI_QA_SYSTEM_RULES } from '../ai/aiGuardrails';
import type { CompanyDocument, InboxItem } from '../../types/models';

const sampleDocument: CompanyDocument = {
  id: 'doc-ai-1',
  title: 'Freistellungsbescheinigung 2026',
  category: 'steuer',
  issuer: 'Finanzamt Berlin',
  recognizedText: 'Freistellungsbescheinigung für Test GmbH bis 2026-12-31',
  issueDate: '2026-01-01',
  validUntil: '2026-12-31',
  digitalFolder: { id: 'd', name: 'Steuer', path: '/Steuer/' },
  paperFolder: { folderId: 'f', register: 'A', label: 'Steuer' },
  tags: ['Freistellung'],
  linkedCompany: 'Test GmbH',
  linkedVorgang: { vorgangId: 'v-1', vorgangTitle: 'Sanierung Bad' },
  archived: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const sampleInbox: InboxItem = {
  id: 'inbox-ai-1',
  title: 'Finanzamt Schreiben',
  sender: 'Finanzamt München',
  documentType: 'behoerde',
  priority: 'hoch',
  deadline: '2026-07-15',
  digitalFolder: { id: 'd', name: 'Behörden', path: '/Behörden/' },
  paperFiling: { folderId: 'f', register: 'A', label: 'Behörden' },
  status: 'neu',
  receivedAt: '2026-06-01',
  officePilotSuggestion: 'Steuerbescheid prüfen',
  nextTaskLabel: 'Prüfen',
  securityHint: 'Original aufbewahren',
  recommendedAction: 'archivieren',
  recognizedData: { Frist: '2026-07-15', Betreff: 'Steuerbescheid' },
  markedAsCompanyDocument: true,
};

describe('documentAiService prompt/context', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    setAiGenerateTextForTests(null);
    hydrateCompanyProfileStore({
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Test GmbH',
      iban: 'DE89370400440532013000',
      taxNumber: '27/123/45678',
      vatId: 'DE123456789',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setAiGenerateTextForTests(null);
    vi.restoreAllMocks();
  });

  it('Prompt enthält scoped Kontext und Guardrails', () => {
    const context = buildDocumentAiContextFromDocument(sampleDocument);
    const prompt = buildDocumentAiPrompt('Welche Frist gibt es?', context);

    expect(prompt).toContain(AI_QA_SYSTEM_RULES);
    expect(prompt).toContain('Freistellungsbescheinigung 2026');
    expect(prompt).toContain('Sanierung Bad');
    expect(prompt).toContain('Welche Frist gibt es?');
  });

  it('Prompt enthält keine sensiblen Bank-/Steuerdaten', () => {
    const context = buildDocumentAiContextFromInbox(sampleInbox);
    const prompt = buildDocumentAiPrompt('Was steht hier?', context);

    expect(prompt).not.toContain('DE89370400440532013000');
    expect(prompt).not.toContain('27/123/45678');
    expect(prompt).not.toContain('DE123456789');
    expect(prompt).toContain('Finanzamt München');
  });

  it('Prompt enthält keinen globalen BrainSnapshot', () => {
    const context = buildDocumentAiContextFromDocument(sampleDocument);
    const prompt = buildDocumentAiPrompt('Was muss ich tun?', context);

    expect(prompt).not.toContain('Kommunikationshistorie');
    expect(prompt).not.toContain('Rechnungen gesamt');
  });

  it('liefert Mock-Antwort ohne Store-Mutation', async () => {
    hydrateDocumentStore([sampleDocument]);
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: 'Die Frist endet am 2026-12-31.',
      }),
    );

    const before = JSON.stringify(getAllDocuments());
    const answer = await askDocumentAi({
      source: { type: 'document', document: sampleDocument },
      question: 'Welche Frist gibt es?',
    });
    const after = JSON.stringify(getAllDocuments());

    expect(answer.source).toBe('ai');
    expect(answer.text).toContain('2026-12-31');
    expect(after).toBe(before);
  });
});
