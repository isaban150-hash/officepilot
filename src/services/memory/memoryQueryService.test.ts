import { beforeEach, describe, expect, it } from 'vitest';
import { answerQuestion } from '../officeAssistantService';
import { hydrateDocumentStore } from '../documentService';
import {
  getProofMemories,
  recordArchivedDocumentMemory,
  resetMemory,
  syncContractProofRequirements,
} from '../officePilotMemoryService';
import { createAuftragInboxItem } from '../../test/fixtures';
import type { CompanyDocument } from '../../types/models';
import {
  answerMemoryQuestion,
  detectMemoryQueryIntent,
  tryMemoryQueryAnswer,
} from './memoryQueryService';

function createFreistellungDocument(): CompanyDocument {
  return {
    id: 'doc-query-freistellung',
    title: 'Freistellungsbescheinigung §48b',
    category: 'steuer',
    issuer: 'Finanzamt München',
    recognizedText: 'Freistellungsbescheinigung nach §48b EStG',
    issueDate: '2026-01-01',
    validUntil: '2026-12-31',
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

describe('memoryQueryService', () => {
  beforeEach(() => {
    resetMemory();
    hydrateDocumentStore([]);
  });

  it('erkennt Intent für Freistellungs-Ablage', () => {
    expect(detectMemoryQueryIntent('Wo liegt meine Freistellung?')).toBe('freistellung_location');
  });

  it('beantwortet „Wo liegt meine Freistellung?“', () => {
    const document = createFreistellungDocument();
    hydrateDocumentStore([document]);
    recordArchivedDocumentMemory(document, {
      inboxItem: createAuftragInboxItem({ classifiedKind: 'freistellungsbescheinigung' }),
      todayIso: '2026-06-01',
    });

    const answer = tryMemoryQueryAnswer('Wo liegt meine Freistellung?', '2026-06-01');
    expect(answer).not.toBeNull();
    expect(answer!.shortAnswer).toContain('Freistellungsbescheinigung');
    expect(answer!.digitalLocation).toContain('/Steuerberater/2026/Freistellungsbescheinigungen/');
    expect(answer!.paperLocation).toContain('Steuerberater 2026');
    expect(answer!.nextStep.length).toBeGreaterThan(5);
  });

  it('beantwortet „Welche Nachweise fehlen?“', () => {
    syncContractProofRequirements('vorgang-1', 'inbox-1', [
      { type: 'freistellungsbescheinigung', reason: 'Freistellungsbescheinigung §48b', priority: 'hoch' },
      { type: 'bg_bau', reason: 'BG BAU Unbedenklichkeitsbescheinigung', priority: 'hoch' },
    ]);

    const answer = answerMemoryQuestion('missing_proofs', 'Welche Nachweise fehlen?', '2026-06-01');
    expect(answer).not.toBeNull();
    expect(answer!.shortAnswer).toContain('fehlt');
    expect(answer!.digitalLocation.length).toBeGreaterThan(5);
    expect(answer!.paperLocation.length).toBeGreaterThan(5);
    expect(answer!.status).toBe('Fehlend');
  });

  it('Antwortschema enthält digital + Papier', () => {
    const document = createFreistellungDocument();
    hydrateDocumentStore([document]);
    recordArchivedDocumentMemory(document, {
      inboxItem: createAuftragInboxItem({ classifiedKind: 'freistellungsbescheinigung' }),
      todayIso: '2026-06-01',
    });

    const answer = tryMemoryQueryAnswer('Wo liegt meine Freistellung?', '2026-06-01');
    expect(answer?.digitalLocation).toMatch(/Steuerberater|Freistellungsbescheinigungen/);
    expect(answer?.paperLocation).toMatch(/Steuerberater|Register/);
    expect(answer?.source).toContain('Firmen-Gedächtnis');
  });

  it('officeAssistantService nutzt memoryQueryService zuerst', () => {
    const document = createFreistellungDocument();
    hydrateDocumentStore([document]);
    recordArchivedDocumentMemory(document, {
      inboxItem: createAuftragInboxItem({ classifiedKind: 'freistellungsbescheinigung' }),
      todayIso: '2026-06-01',
    });

    const assistantAnswer = answerQuestion('Wo liegt meine Freistellung?', '2026-06-01');
    expect(assistantAnswer.summary).toContain('Freistellungsbescheinigung');
    expect(assistantAnswer.bullets.some((line) => line.startsWith('Digital:'))).toBe(true);
    expect(assistantAnswer.bullets.some((line) => line.startsWith('Papier:'))).toBe(true);
  });

  it('gibt null zurück wenn Gedächtnis leer ist', () => {
    expect(tryMemoryQueryAnswer('Wo liegt meine Freistellung?', '2026-06-01')).toBeNull();
    expect(getProofMemories()).toHaveLength(0);
  });

  it('beantwortet Papierfragen zum Abheftstatus', () => {
    const document = createFreistellungDocument();
    hydrateDocumentStore([document]);
    recordArchivedDocumentMemory(document, {
      inboxItem: createAuftragInboxItem({ classifiedKind: 'freistellungsbescheinigung' }),
      todayIso: '2026-06-01',
    });

    const answer = tryMemoryQueryAnswer('Habe ich das schon abgeheftet?', '2026-06-01');
    expect(answer).not.toBeNull();
    expect(answer!.register).toContain('Freistellungsbescheinigungen');
    expect(answer!.status).toContain('noch abheften');
    expect(answer!.shortAnswer.toLowerCase()).toContain('nein');
  });

  it('beantwortet Register- und Ordnerfragen', () => {
    const document = createFreistellungDocument();
    hydrateDocumentStore([document]);
    recordArchivedDocumentMemory(document, {
      inboxItem: createAuftragInboxItem({ classifiedKind: 'freistellungsbescheinigung' }),
      todayIso: '2026-06-01',
    });

    const registerAnswer = tryMemoryQueryAnswer('In welches Register gehört das?', '2026-06-01');
    expect(registerAnswer?.register).toBe('Freistellungsbescheinigungen');

    const folderAnswer = tryMemoryQueryAnswer('In welchen Ordner muss ich das legen?', '2026-06-01');
    expect(folderAnswer?.paperLocation.length).toBeGreaterThan(5);
    expect(folderAnswer?.register.length).toBeGreaterThan(0);
  });
});
