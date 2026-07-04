import { beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_WERKVERTRAG_TEXT } from '../contractAnalysisService';
import { hydrateDocumentStore } from '../documentService';
import { withInboxExtractedDocumentText } from '../inboxDocumentText';
import {
  getDocumentMemoryByDocumentId,
  recordArchivedDocumentMemory,
  resetMemory,
} from '../officePilotMemoryService';
import { createAuftragInboxItem } from '../../test/fixtures';
import type { CompanyDocument } from '../../types/models';
import { buildDocumentSummary } from './documentSummaryService';
import { applyDocumentSummaryEnhancement } from '../officePilotMemoryService';

function createFreistellungDocument(validUntil = '2026-12-31'): CompanyDocument {
  return {
    id: 'doc-freistellung-summary',
    title: 'Freistellungsbescheinigung §48b',
    category: 'steuer',
    issuer: 'Finanzamt München',
    recognizedText: 'Freistellungsbescheinigung nach §48b EStG',
    issueDate: '2026-01-01',
    validUntil,
    digitalFolder: {
      id: 'dig-f',
      name: 'Freistellungsbescheinigungen',
      path: '/Steuerberater/2026/Freistellungsbescheinigungen/',
    },
    paperFolder: { folderId: 'folder-4', register: 'Monat 01', label: 'Steuerberater 2026' },
    tags: ['Freistellung'],
    linkedCompany: 'Test GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-03-01T10:00:00.000Z',
  };
}

describe('documentSummaryService', () => {
  beforeEach(() => {
    resetMemory();
  });

  it('erzeugt eine strukturierte Document Summary', () => {
    const document = createFreistellungDocument();
    const summary = buildDocumentSummary({
      document,
      classifiedKind: 'freistellungsbescheinigung',
      recognizedData: { Dokument: 'Freistellungsbescheinigung nach §48b EStG' },
      todayIso: '2026-06-01',
    });

    expect(summary.documentKindLabel).toBe('Freistellungsbescheinigung §48b');
    expect(summary.issuer).toBe('Finanzamt München');
    expect(summary.topic).toContain('Freistellungsbescheinigung');
    expect(summary.shortSummary.length).toBeGreaterThan(20);
    expect(summary.deadline).toBe('2026-12-31');
    expect(summary.nextAction.length).toBeGreaterThan(5);
    expect(summary.riskLevel).toBe('medium');
    expect(summary.sourceConfidence).not.toBe('low');
    expect(summary.origin).toBe('rules');
    expect(summary.generatedAt).toBeTruthy();
  });

  it('Freistellungsbescheinigung bekommt Summary, Ordner und Status', () => {
    hydrateDocumentStore([]);
    const document = createFreistellungDocument();
    recordArchivedDocumentMemory(document, {
      inboxItem: createAuftragInboxItem({
        classifiedKind: 'freistellungsbescheinigung',
        sender: 'Finanzamt München',
      }),
      todayIso: '2026-06-01',
    });

    const memory = getDocumentMemoryByDocumentId(document.id);
    expect(memory?.summary?.documentKindLabel).toBe('Freistellungsbescheinigung §48b');
    expect(memory?.digitalFolder.path).toContain('Freistellungsbescheinigungen');
    expect(memory?.paperFolder.label).toBe('Steuerberater 2026');
    expect(memory?.memoryStatus).toMatch(/understood|partial/);
    expect(memory?.letterExplanation?.digitalStorage).toContain('Freistellungsbescheinigungen');
    expect(memory?.letterExplanation?.paperStorage).toContain('Steuerberater 2026');
  });

  it('BG BAU-Brief bekommt Behördenbezug', () => {
    hydrateDocumentStore([]);
    const document: CompanyDocument = {
      ...createFreistellungDocument(),
      id: 'doc-bg-bau',
      title: 'Unbedenklichkeitsbescheinigung BG BAU',
      issuer: 'BG BAU',
      recognizedText: 'Berufsgenossenschaft der Bauwirtschaft – Unbedenklichkeitsbescheinigung',
      category: 'behoerde',
      validUntil: '2026-09-30',
    };

    recordArchivedDocumentMemory(document, {
      inboxItem: createAuftragInboxItem({ classifiedKind: 'bg_bau', sender: 'BG BAU' }),
      todayIso: '2026-06-01',
    });

    const memory = getDocumentMemoryByDocumentId(document.id);
    expect(memory?.relatedAuthorities).toContain('bg_bau');
    expect(memory?.summary?.documentKindLabel).toBe('BG BAU Schreiben');
  });

  it('Werkvertrag nutzt ContractAnalysis-Daten für requiredDocuments', () => {
    const document: CompanyDocument = {
      ...createFreistellungDocument(),
      id: 'doc-werkvertrag',
      title: 'Werkvertrag Müller Bau',
      issuer: 'Müller Bau GmbH',
      recognizedText: SAMPLE_WERKVERTRAG_TEXT,
      category: 'vertrag',
      validUntil: null,
    };
    const inboxItem = createAuftragInboxItem({
      classifiedKind: 'werkvertrag',
      recognizedData: withInboxExtractedDocumentText({}, SAMPLE_WERKVERTRAG_TEXT),
    });

    const summary = buildDocumentSummary({
      document,
      classifiedKind: 'werkvertrag',
      recognizedData: inboxItem.recognizedData,
    });

    expect(summary.requiredDocuments.length).toBeGreaterThan(0);
    expect(summary.documentKindLabel).toBe('Werkvertrag');
  });

  it('AI-01 kann dieselben Summary-Felder verbessern ohne zweite Struktur', () => {
    hydrateDocumentStore([]);
    const document = createFreistellungDocument();
    recordArchivedDocumentMemory(document, {
      inboxItem: createAuftragInboxItem({ classifiedKind: 'freistellungsbescheinigung' }),
      todayIso: '2026-06-01',
    });

    const enhanced = applyDocumentSummaryEnhancement(document.id, {
      shortSummary: 'Präzisere KI-Kurzfassung der Freistellung.',
      sourceConfidence: 'high',
    });

    expect(enhanced?.summary?.shortSummary).toBe('Präzisere KI-Kurzfassung der Freistellung.');
    expect(enhanced?.summary?.origin).toBe('ai');
    expect(enhanced?.summary?.documentKindLabel).toBe('Freistellungsbescheinigung §48b');
  });
});
