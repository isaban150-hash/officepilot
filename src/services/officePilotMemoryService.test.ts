import { beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEY } from './persistenceService';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import {
  addDocument,
  hydrateDocumentStore,
  importInboxDocument,
} from './documentService';
import {
  computeProofStatus,
  getAllDocumentMemories,
  getDocumentMemoryByDocumentId,
  getMemoryRelations,
  getProofMemories,
  getProofsByStatus,
  getProofsForVorgang,
  hydrateMemory,
  recordArchivedDocumentMemory,
  resetMemory,
  syncContractProofRequirements,
  syncContractProofRequirementsFromInbox,
} from './officePilotMemoryService';
import { withInboxExtractedDocumentText } from './inboxDocumentText';
import { createAuftragInboxItem } from '../test/fixtures';
import type { CompanyDocument, InboxItem } from '../types/models';

function createFreistellungInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return createAuftragInboxItem({
    id: 'inbox-freistellung',
    title: 'Freistellungsbescheinigung §48b',
    documentType: 'behoerde',
    classifiedKind: 'freistellungsbescheinigung',
    sender: 'Finanzamt München',
    deadline: '2026-12-31',
    recognizedData: {
      Dokument: 'Freistellungsbescheinigung nach §48b EStG',
    },
    ...overrides,
  });
}

function createWerkvertragInboxItem(vorgangId: string): InboxItem {
  return createAuftragInboxItem({
    id: 'inbox-werkvertrag',
    title: 'Werkvertrag Müller Bau',
    documentType: 'kundenauftrag',
    classifiedKind: 'werkvertrag',
    vorgangId,
    vorgangTitle: 'Projekt Müller',
    vorgangLinkStatus: 'linked',
    recognizedData: withInboxExtractedDocumentText({}, SAMPLE_WERKVERTRAG_TEXT),
  });
}

function createFreistellungDocument(validUntil: string): CompanyDocument {
  return {
    id: 'doc-freistellung-1',
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

describe('officePilotMemoryService – ProofStatus', () => {
  it('markiert gültige Nachweise als valid', () => {
    expect(computeProofStatus('2026-12-31', '2026-06-01')).toBe('valid');
  });

  it('markiert bald ablaufende Nachweise als expiring', () => {
    expect(computeProofStatus('2026-06-20', '2026-06-01')).toBe('expiring');
  });

  it('markiert abgelaufene Nachweise als expired', () => {
    expect(computeProofStatus('2026-05-01', '2026-06-01')).toBe('expired');
  });

  it('markiert fehlende Gültigkeit als unknown', () => {
    expect(computeProofStatus(null, '2026-06-01')).toBe('unknown');
  });
});

describe('officePilotMemoryService – archive import', () => {
  beforeEach(() => {
    resetMemory();
    hydrateDocumentStore([]);
    localStorage.clear();
  });

  it('erzeugt ProofMemory für Freistellungsbescheinigung beim Import', () => {
    const inboxItem = createFreistellungInboxItem();
    const result = importInboxDocument(inboxItem, 'Test GmbH');
    expect(result.success).toBe(true);

    const proofs = getProofMemories().filter(
      (item) => item.proofType === 'freistellungsbescheinigung',
    );
    expect(proofs).toHaveLength(1);
    expect(proofs[0]?.status).toBe('valid');
    expect(proofs[0]?.documentId).toBeTruthy();
    expect(proofs[0]?.validUntil).toBe('2026-12-31');

    const docMemory = getDocumentMemoryByDocumentId(result.success ? result.document.id : '');
    expect(docMemory?.proofType).toBe('freistellungsbescheinigung');
    expect(docMemory?.digitalFolder.path).toBeTruthy();
    expect(docMemory?.paperFolder.register).toBe('A');
  });

  it('markiert ablaufende Freistellung als expiring', () => {
    recordArchivedDocumentMemory(createFreistellungDocument('2026-07-10'), {
      todayIso: '2026-06-27',
    });

    const proof = getProofMemories().find(
      (item) => item.proofType === 'freistellungsbescheinigung',
    );
    expect(proof?.status).toBe('expiring');
    expect(getProofsByStatus('expiring')).toHaveLength(1);
  });

  it('markiert abgelaufene Freistellung als expired', () => {
    hydrateDocumentStore([]);
    recordArchivedDocumentMemory(createFreistellungDocument('2026-05-01'), {
      todayIso: '2026-06-01',
    });

    const proof = getProofMemories().find(
      (item) => item.proofType === 'freistellungsbescheinigung',
    );
    expect(proof?.status).toBe('expired');
    expect(getProofsByStatus('expired')).toHaveLength(1);
  });
});

describe('officePilotMemoryService – Werkvertrag', () => {
  beforeEach(() => {
    resetMemory();
    hydrateDocumentStore([]);
  });

  it('erzeugt missing Proofs und requires_proof Relationen aus Werkvertrag', () => {
    const result = syncContractProofRequirementsFromInbox(createWerkvertragInboxItem('v-100'));
    expect(result).not.toBeNull();

    const missing = getProofsByStatus('missing');
    expect(missing.length).toBeGreaterThanOrEqual(3);

    const proofTypes = missing.map((item) => item.proofType);
    expect(proofTypes).toContain('freistellungsbescheinigung');
    expect(proofTypes).toContain('bg_bau');
    expect(proofTypes).toContain('soka_bau');
    expect(proofTypes).toContain('betriebshaftpflicht');

    const relations = getMemoryRelations().filter((item) => item.relation === 'requires_proof');
    expect(relations.length).toBeGreaterThanOrEqual(3);
    expect(relations.every((item) => item.fromId === 'v-100')).toBe(true);

    const vorgangProofs = getProofsForVorgang('v-100');
    expect(vorgangProofs.some((item) => item.status === 'missing')).toBe(true);
  });

  it('erfüllt missing Requirement wenn Proof-Dokument vorhanden ist', () => {
    syncContractProofRequirements('v-200', 'inbox-contract', [
      {
        type: 'freistellungsbescheinigung',
        priority: 'hoch',
        reason: 'Im Vertrag gefordert',
      },
    ]);
    expect(getProofsByStatus('missing')).toHaveLength(1);

    hydrateDocumentStore([]);
    addDocument({
      title: 'Freistellungsbescheinigung §48b',
      category: 'steuer',
      issuer: 'Finanzamt',
      recognizedText: 'Freistellungsbescheinigung nach §48b',
      validUntil: '2026-12-31',
    });

    expect(getProofsByStatus('missing')).toHaveLength(0);
    const proof = getProofMemories().find(
      (item) => item.proofType === 'freistellungsbescheinigung',
    );
    expect(proof?.status).toBe('valid');
    expect(proof?.documentId).toBeTruthy();
  });

  it('erfüllt missing Requirement beim Import einer Freistellung nach Vertragsanalyse', () => {
    const werkvertrag = createWerkvertragInboxItem('v-300');
    syncContractProofRequirementsFromInbox(werkvertrag);
    expect(getProofsByStatus('missing').some((item) => item.proofType === 'freistellungsbescheinigung')).toBe(
      true,
    );

    hydrateDocumentStore([]);
    importInboxDocument(createFreistellungInboxItem({ id: 'inbox-f-2' }), 'Test GmbH');

    expect(
      getProofsByStatus('missing').some((item) => item.proofType === 'freistellungsbescheinigung'),
    ).toBe(false);
    expect(getProofsByStatus('missing').length).toBeGreaterThan(0);
    expect(
      getProofMemories().some(
        (item) =>
          item.proofType === 'freistellungsbescheinigung' && item.status === 'valid' && item.documentId,
      ),
    ).toBe(true);
  });
});

describe('officePilotMemoryService – persistence', () => {
  beforeEach(() => {
    resetMemory();
    hydrateDocumentStore([]);
    localStorage.clear();
  });

  it('persistiert und hydratisiert officePilotMemory', () => {
    importInboxDocument(createFreistellungInboxItem(), 'Test GmbH');

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.officePilotMemory.documentMemories.length).toBeGreaterThan(0);
    expect(parsed.officePilotMemory.proofMemories.length).toBeGreaterThan(0);

    resetMemory();
    expect(getAllDocumentMemories()).toHaveLength(0);

    hydrateMemory(parsed.officePilotMemory);
    expect(getAllDocumentMemories().length).toBe(parsed.officePilotMemory.documentMemories.length);
    expect(getProofMemories().length).toBe(parsed.officePilotMemory.proofMemories.length);
  });
});
