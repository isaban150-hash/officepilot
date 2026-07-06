import { beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_WERKVERTRAG_TEXT } from '../contractAnalysisService';
import { hydrateDocumentStore, importInboxDocument } from '../documentService';
import { withInboxExtractedDocumentText } from '../inboxDocumentText';
import {
  recordArchivedDocumentMemory,
  resetMemory,
  syncContractProofRequirementsFromInbox,
} from '../officePilotMemoryService';
import { answerQuestion } from '../officeAssistantService';
import { createAuftragInboxItem } from '../../test/fixtures';
import type { CompanyDocument } from '../../types/models';
import {
  buildDocumentExplanation,
  containsForbiddenExplanationPhrase,
  EXPLANATION_DISCLAIMER,
  EXPLANATION_NO_DATA_MESSAGE,
  findDocumentForExplanationQuestion,
} from './documentExplanationService';
import { detectMemoryQueryIntent, tryMemoryQueryAnswer } from './memoryQueryService';

function createBgBauDocument(): CompanyDocument {
  return {
    id: 'doc-bg-bau',
    title: 'Unbedenklichkeitsbescheinigung BG BAU',
    category: 'behoerde',
    issuer: 'BG BAU',
    recognizedText: 'Unbedenklichkeitsbescheinigung der Berufsgenossenschaft der Bauwirtschaft',
    issueDate: '2026-01-01',
    validUntil: '2026-12-31',
    digitalFolder: { id: 'd', name: 'BG BAU', path: '/Firma/Behoerden/BG-BAU/' },
    paperFolder: { folderId: 'paper-behoerden', register: 'BG BAU', label: 'Behörden' },
    tags: [],
    linkedCompany: 'Test GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function createFinanzamtDocument(): CompanyDocument {
  return {
    id: 'doc-finanzamt',
    title: 'Schreiben Finanzamt München',
    category: 'steuer',
    issuer: 'Finanzamt München',
    recognizedText: 'Bitte reichen Sie Unterlagen bis 15.08.2026 ein.',
    issueDate: '2026-06-01',
    validUntil: '2026-08-15',
    digitalFolder: { id: 'd', name: 'Finanzamt', path: '/Firma/Behoerden/Finanzamt/' },
    paperFolder: { folderId: 'paper-behoerden', register: 'Finanzamt', label: 'Behörden' },
    tags: [],
    linkedCompany: 'Test GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

function createFreistellungDocument(): CompanyDocument {
  return {
    id: 'doc-freistellung',
    title: 'Freistellungsbescheinigung §48b',
    category: 'steuer',
    issuer: 'Finanzamt München',
    recognizedText: 'Freistellungsbescheinigung nach §48b EStG',
    issueDate: '2026-01-01',
    validUntil: '2026-12-31',
    digitalFolder: {
      id: 'd',
      name: 'Freistellung',
      path: '/Steuerberater/2026/Freistellungsbescheinigungen/',
    },
    paperFolder: { folderId: 'folder-4', register: 'Freistellungsbescheinigungen', label: 'Steuerberater' },
    tags: [],
    linkedCompany: 'Test GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function createWerbungDocument(): CompanyDocument {
  return {
    id: 'doc-werbung',
    title: 'Sommer-Sale Prospekt',
    category: 'sonstiges',
    issuer: 'Werbung GmbH Newsletter',
    recognizedText: 'Jetzt 20% Rabatt auf Werkzeuge – Newsletter Werbung',
    issueDate: '2026-06-01',
    validUntil: null,
    digitalFolder: { id: 'd', name: 'Eingang', path: '/Eingang/' },
    paperFolder: { folderId: 'folder-1', register: 'A', label: 'Test' },
    tags: [],
    linkedCompany: 'Test GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

describe('documentExplanationService', () => {
  beforeEach(() => {
    resetMemory();
    hydrateDocumentStore([]);
  });

  it('BG BAU Erklärung enthält Anlass, Handlung, Ordner/Register', () => {
    const document = createBgBauDocument();
    hydrateDocumentStore([document]);
    recordArchivedDocumentMemory(document, {
      inboxItem: createAuftragInboxItem({ classifiedKind: 'bg_bau', sender: 'BG BAU' }),
      todayIso: '2026-06-01',
    });

    const explanation = buildDocumentExplanation({ documentId: document.id });
    expect(explanation).not.toBeNull();
    expect(explanation!.shortAnswer.toLowerCase()).toMatch(/bg|unbedenklichkeit/);
    expect(explanation!.whyImportant.toLowerCase()).toContain('nachweis');
    expect(explanation!.paperLocation).toMatch(/Behörden|BG BAU/);
    expect(explanation!.register).toBe('BG BAU');
    expect(explanation!.nextSteps.length).toBeGreaterThan(0);
    expect(containsForbiddenExplanationPhrase(explanation!.shortAnswer)).toBe(false);
  });

  it('Finanzamt Erklärung enthält Frist/Risiko ohne Steuerberatung', () => {
    const document = createFinanzamtDocument();
    hydrateDocumentStore([document]);
    recordArchivedDocumentMemory(document, {
      inboxItem: createAuftragInboxItem({ classifiedKind: 'finanzamt', sender: 'Finanzamt München' }),
      todayIso: '2026-06-01',
    });

    const explanation = buildDocumentExplanation({ documentId: document.id });
    expect(explanation).not.toBeNull();
    expect(explanation!.deadline).toContain('2026');
    expect(explanation!.risk.length).toBeGreaterThan(3);
    expect(explanation!.disclaimer).toContain('keine Rechts- oder Steuerberatung');
    expect(explanation!.shortAnswer.toLowerCase()).not.toContain('steuerlich sicher');
  });

  it('Freistellung erklärt Gültigkeit + Ablage + Originalstatus', () => {
    const document = createFreistellungDocument();
    hydrateDocumentStore([document]);
    recordArchivedDocumentMemory(document, {
      inboxItem: createAuftragInboxItem({ classifiedKind: 'freistellungsbescheinigung' }),
      todayIso: '2026-06-01',
    });

    const explanation = buildDocumentExplanation({ documentId: document.id });
    expect(explanation).not.toBeNull();
    expect(explanation!.deadline).toContain('2026');
    expect(explanation!.register).toBe('Freistellungsbescheinigungen');
    expect(explanation!.originalFiledStatus.toLowerCase()).toMatch(/original/);
    expect(explanation!.digitalLocation).toContain('Freistellung');
  });

  it('Werkvertrag erklärt fehlende Nachweise', () => {
    const werkvertrag = createAuftragInboxItem({
      id: 'inbox-wv',
      classifiedKind: 'werkvertrag',
      vorgangId: 'v-500',
      vorgangTitle: 'Projekt Test',
      recognizedData: withInboxExtractedDocumentText({}, SAMPLE_WERKVERTRAG_TEXT),
    });
    syncContractProofRequirementsFromInbox(werkvertrag);
    const result = importInboxDocument(werkvertrag, 'Test GmbH');
    if (!result.success) throw new Error('import failed');

    const explanation = buildDocumentExplanation({ documentId: result.document.id });
    expect(explanation).not.toBeNull();
    expect(explanation!.requiredDocuments.join(' ').toLowerCase()).toMatch(/freistellung|bg|nachweis/);
    expect(explanation!.nextSteps.some((step) => /nachweis/i.test(step))).toBe(true);
  });

  it('Werbung sagt entsorgen / nicht speichern', () => {
    const document = createWerbungDocument();
    hydrateDocumentStore([document]);

    const explanation = buildDocumentExplanation({ documentId: document.id });
    expect(explanation).not.toBeNull();
    expect(explanation!.shortAnswer.toLowerCase()).toMatch(/werbung/);
    expect(explanation!.actionRequired.toLowerCase()).toMatch(/entsorg/);
    expect(explanation!.paperLocation.toLowerCase()).toMatch(/entsorg|kein papierordner/);
    expect(explanation!.nextSteps[0]?.toLowerCase()).toContain('entsorg');
  });

  it('enthält keine verbotenen Aussagen', () => {
    const docs = [createBgBauDocument(), createFinanzamtDocument(), createFreistellungDocument()];
    hydrateDocumentStore(docs);
    for (const document of docs) {
      recordArchivedDocumentMemory(document, { todayIso: '2026-06-01' });
      const explanation = buildDocumentExplanation({ documentId: document.id });
      const combined = JSON.stringify(explanation);
      expect(containsForbiddenExplanationPhrase(combined)).toBe(false);
      expect(combined.toLowerCase()).not.toContain('rechtlich verbindlich');
    }
    expect(EXPLANATION_DISCLAIMER).toContain('keine Rechts- oder Steuerberatung');
  });
});

describe('documentExplanationService – memory query integration', () => {
  beforeEach(() => {
    resetMemory();
    hydrateDocumentStore([]);
  });

  it('Memory Query nutzt Erklärung', () => {
    const document = createBgBauDocument();
    hydrateDocumentStore([document]);
    recordArchivedDocumentMemory(document, {
      inboxItem: createAuftragInboxItem({ classifiedKind: 'bg_bau' }),
      todayIso: '2026-06-01',
    });

    expect(detectMemoryQueryIntent('Was wollte die BG BAU?')).toBe('bg_bau_content');
    const answer = tryMemoryQueryAnswer('Was wollte die BG BAU?', '2026-06-01');
    expect(answer).not.toBeNull();
    expect(answer!.shortAnswer.length).toBeGreaterThan(10);
    expect(answer!.register).toBe('BG BAU');
  });

  it('officeAssistantService delegiert korrekt', () => {
    const document = createFreistellungDocument();
    hydrateDocumentStore([document]);
    recordArchivedDocumentMemory(document, {
      inboxItem: createAuftragInboxItem({ classifiedKind: 'freistellungsbescheinigung' }),
      todayIso: '2026-06-01',
    });

    const assistantAnswer = answerQuestion('Was ist mit meiner Freistellung?', '2026-06-01');
    expect(assistantAnswer.summary.toLowerCase()).toMatch(/freistellung/);
    expect(assistantAnswer.bullets.some((line) => line.startsWith('Register:'))).toBe(true);
  });

  it('Fallback bei fehlenden Daten', () => {
    const assistantAnswer = answerQuestion('Was bedeutet der Brief?', '2026-06-01');
    expect(assistantAnswer.summary).toBe(EXPLANATION_NO_DATA_MESSAGE);
    expect(findDocumentForExplanationQuestion('Was bedeutet der Brief?')).toBeNull();
  });
});
