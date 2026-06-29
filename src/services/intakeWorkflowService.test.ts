import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { createTestVorgang } from '../test/fixtures';
import { classifyInboxItem } from './documentClassificationService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import {
  acceptSuggestedTasks,
  processUploadedDocument,
} from './intakeWorkflowService';
import { hydrateInboxStore } from './inboxService';
import * as pendingEngineService from './pendingEngineService';
import { setTaskStoreForTests } from './taskStore';
import { hydrateVorgangStore } from './vorgangService';
import type { InboxItem } from '../types/models';

const testProfile = {
  companyName: 'Mustermann Sanitär GmbH',
  legalForm: 'GmbH',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  contactPerson: 'Max Mustermann',
  phone: '030',
  email: 'info@mustermann-sanitaer.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

function cloneInbox(item: InboxItem, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    ...item,
    recognizedData: { ...item.recognizedData },
    digitalFolder: { ...item.digitalFolder },
    paperFiling: { ...item.paperFiling },
    taskTemplate: item.taskTemplate ? { ...item.taskTemplate } : undefined,
    ...overrides,
  };
}

function expectCompleteWorkflow(result: NonNullable<ReturnType<typeof processUploadedDocument>>) {
  expect(result.inboxItemId).toBeTruthy();
  expect(result.companyRelevance).toBeTruthy();
  expect(result.classifiedKind).toBeTruthy();
  expect(result.classificationConfidence).toBeTruthy();
  expect(result.suggestedArchiveFolder).toBeTruthy();
  expect(result.pendingSummary).toBeNull();
  expect(Array.isArray(result.warnings)).toBe(true);
  expect(Array.isArray(result.nextActions)).toBe(true);
  expect(Array.isArray(result.suggestedOrderPositions)).toBe(true);
  expect(Array.isArray(result.suggestedTasks)).toBe(true);
  expect(Array.isArray(result.similarVorgaenge)).toBe(true);
  expect(Array.isArray(result.requiredDocuments)).toBe(true);
}

describe('intakeWorkflowService', () => {
  beforeEach(() => {
    localStorage.clear();
    setTaskStoreForTests([]);
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-001',
        title: 'Badezimmer-Sanierung Müller',
        customer: 'Familie Müller',
        baustelle: 'Hauptstr. 12, Berlin',
        status: 'in_bearbeitung',
      }),
    ]);
  });

  it('verarbeitet Werkvertrag mit Vertragsanalyse und Positionen', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((i) => i.id === 'inbox-001')!, {
      id: 'inbox-wf-werkvertrag',
      title: 'Werkvertrag Mustermann Sanitär GmbH Müller',
      recognizedData: {
        ...MOCK_INBOX_ITEMS[0]!.recognizedData,
        _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id);
    expect(result).not.toBeNull();
    expectCompleteWorkflow(result!);
    expect(result!.contractAnalysis?.isContract).toBe(true);
    expect(result!.suggestedOrderPositions.length).toBeGreaterThan(0);
    expect(result!.requiredDocuments.length).toBeGreaterThan(0);
  });

  it('verarbeitet Brief mit Erklärung', () => {
    const item = cloneInbox(
      classifyInboxItem({
        sourceFileName: 'Brief.pdf',
        titleHint: 'Schreiben Mustermann Sanitär GmbH',
        senderHint: 'Finanzamt Berlin',
        recognizedText: 'Allgemeines Schreiben an Mustermann Sanitär GmbH',
        kindHint: 'brief',
      }),
      { id: 'inbox-wf-brief', documentType: 'brief', status: 'neu' },
    );
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id);
    expect(result?.documentExplanation).not.toBeNull();
    expect(result?.documentExplanation?.about).toBeTruthy();
  });

  it('verarbeitet Mahnung mit Task-Proposals', () => {
    const item = cloneInbox(
      classifyInboxItem({
        recognizedText: 'Mahnung Zahlungsaufforderung Mustermann Sanitär GmbH',
        senderHint: 'Bauzentrum Nord GmbH',
      }),
      {
        id: 'inbox-wf-mahnung',
        status: 'neu',
        title: 'Mahnung Mustermann Sanitär GmbH',
        recognizedData: {
          Betreff: 'Mustermann Sanitär GmbH',
          Mahnung: '2. Mahnung offener Betrag',
        },
      },
    );
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id);
    expect(result?.classifiedKind).toBe('mahnung');
    expect(result!.suggestedTasks.length).toBeGreaterThan(0);
  });

  it('verarbeitet Rechnung mit Vorgangsvorschlag', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((i) => i.id === 'inbox-003')!, {
      id: 'inbox-wf-rechnung',
    });
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id);
    expect(result?.classifiedKind).toBe('eingangsrechnung');
    expect(result?.suggestedVorgang?.vorgangId).toBe('v-001');
  });

  it('verarbeitet BG BAU Schreiben', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((i) => i.id === 'inbox-004')!, {
      id: 'inbox-wf-bg',
      title: 'BG BAU Mustermann Sanitär GmbH',
      recognizedData: {
        ...MOCK_INBOX_ITEMS[3]!.recognizedData,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id);
    expect(result?.classifiedKind).toBe('bg_bau');
    expect(result?.suggestedArchiveFolder.path).toContain('BG-BAU');
  });

  it('verarbeitet Freistellungsbescheinigung', () => {
    const item = cloneInbox(
      classifyInboxItem({
        recognizedText: 'Freistellungsbescheinigung Mustermann Sanitär GmbH gültig bis 31.12.2026',
      }),
      {
        id: 'inbox-wf-freistellung',
        status: 'neu',
        title: 'Freistellungsbescheinigung Mustermann Sanitär GmbH',
        recognizedData: {
          Betreff: 'Mustermann Sanitär GmbH',
          Gültig_bis: '31.12.2026',
        },
      },
    );
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id);
    expect(result?.classifiedKind).toBe('freistellungsbescheinigung');
    expect(result?.suggestedTasks.length).toBeGreaterThan(0);
  });

  it('blockiert Analyse bei fehlendem Firmenbezug', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((i) => i.id === 'inbox-005')!, {
      id: 'inbox-wf-privat',
      title: 'Privates Schreiben',
      sender: 'Unbekannt',
      recognizedData: { Betreff: 'Privat' },
    });
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id);
    expect(result?.companyRelevant).toBe(false);
    expect(result?.classification).toBeNull();
    expect(result?.warnings.some((w) => w.id === 'company_relevance_blocked')).toBe(true);
  });

  it('findet vorhandenen Vorgang', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((i) => i.id === 'inbox-003')!, {
      id: 'inbox-wf-existing-vorgang',
    });
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id);
    expect(result?.suggestedVorgang?.vorgangId).toBe('v-001');
  });

  it('liefert leeren Vorgangsvorschlag wenn kein Treffer', () => {
    hydrateVorgangStore([]);
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((i) => i.id === 'inbox-001')!, {
      id: 'inbox-wf-no-vorgang',
      vorgangId: undefined,
      vorgangTitle: undefined,
      recognizedData: {
        Kunde: 'Neukunde GmbH',
        Baustelle: 'Fernstraße 99',
        Leistung: 'Heizungstausch',
        _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id);
    expect(result?.suggestedVorgang).toBeNull();
    expect(result?.nextActions.some((a) => a.id === 'create_vorgang')).toBe(true);
  });

  it('scannt Pending nicht während des Workflows', () => {
    const scanSpy = vi.spyOn(pendingEngineService, 'scanPendingItems');
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((i) => i.id === 'inbox-002')!, {
      id: 'inbox-wf-no-pending-scan',
      title: 'Zahlungserinnerung Mustermann Sanitär GmbH',
      recognizedData: {
        ...MOCK_INBOX_ITEMS[1]!.recognizedData,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id);
    expect(result?.pendingSummary).toBeNull();
    expect(scanSpy).not.toHaveBeenCalled();
    scanSpy.mockRestore();
  });

  it('liefert alle für die Detailansicht benötigten Workflow-Felder', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((i) => i.id === 'inbox-002')!, {
      id: 'inbox-wf-complete-fields',
      title: 'Zahlungserinnerung Mustermann Sanitär GmbH',
      recognizedData: {
        ...MOCK_INBOX_ITEMS[1]!.recognizedData,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id);
    expect(result).not.toBeNull();
    expect(result!.companyRelevance).toBeTruthy();
    expect(typeof result!.companyRelevant).toBe('boolean');
    expect(result!.classifiedKind).toBeTruthy();
    expect(result!.classification).toBeTruthy();
    expect(result!.contractAnalysis === null || result!.contractAnalysis.isContract !== undefined).toBe(
      true,
    );
  });

  it('übernimmt vorgeschlagene Aufgaben ohne Duplikate', () => {
    const item = cloneInbox(
      classifyInboxItem({
        recognizedText: 'Mahnung Mustermann Sanitär GmbH',
        senderHint: 'Bauzentrum Nord GmbH',
      }),
      {
        id: 'inbox-wf-tasks',
        status: 'neu',
        title: 'Mahnung Mustermann Sanitär GmbH',
        recognizedData: {
          Betreff: 'Mustermann Sanitär GmbH',
        },
      },
    );
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id)!;
    const first = acceptSuggestedTasks(result.suggestedTasks);
    const second = acceptSuggestedTasks(result.suggestedTasks);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(first.length);
  });
});
