import { describe, expect, it, beforeEach } from 'vitest';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { createTestVorgang } from '../test/fixtures';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import { hydrateDocumentStore, getAllDocuments } from './documentService';
import { executeSmartIntake } from './intakeExecutionService';
import { processUploadedDocument } from './intakeWorkflowService';
import { hydrateInboxStore, getInboxItemById } from './inboxService';
import { getAllTasksFromStore, setTaskStoreForTests } from './taskStore';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
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

describe('intakeExecutionService', () => {
  beforeEach(() => {
    localStorage.clear();
    setTaskStoreForTests([]);
    hydrateDocumentStore([]);
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

  it('führt kompletten Workflow für Werkvertrag aus', () => {
    hydrateVorgangStore([]);
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((entry) => entry.id === 'inbox-001')!, {
      id: 'exec-werkvertrag',
      title: 'Werkvertrag Mustermann Sanitär GmbH',
      recognizedData: {
        ...MOCK_INBOX_ITEMS[0]!.recognizedData,
        _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);

    const workflow = processUploadedDocument(item.id)!;
    const result = executeSmartIntake(workflow, {
      companyName: testProfile.companyName,
      materialStandard: 'betrieb',
    });

    expect(result.completed).toBe(true);
    expect(result.successSteps).toContain('archive_document');
    expect(result.successSteps).toContain('create_vorgang');
    expect(result.successSteps).toContain('import_positions');
    expect(result.successSteps).toContain('accept_tasks');
    expect(result.successSteps).toContain('finalize_inbox');
    expect(result.inboxItem?.isNewUpload).toBe(false);
    expect(result.archiveDocumentId).toBeTruthy();
    expect(result.positionsAdded).toBeGreaterThan(0);
    expect(result.tasksCreated).toBeGreaterThan(0);
    expect(getAllDocuments().length).toBe(1);
  });

  it('verknüpft bestehenden Vorgang statt neuen anzulegen', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((entry) => entry.id === 'inbox-003')!, {
      id: 'exec-link-vorgang',
    });
    hydrateInboxStore([item]);

    const workflow = processUploadedDocument(item.id)!;
    const result = executeSmartIntake(workflow, { companyName: testProfile.companyName });

    expect(result.successSteps).toContain('link_vorgang');
    expect(result.vorgangId).toBe('v-001');
    expect(result.inboxItem?.vorgangId).toBe('v-001');
  });

  it('legt neuen Vorgang an wenn kein Treffer vorhanden ist', () => {
    hydrateVorgangStore([]);
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((entry) => entry.id === 'inbox-001')!, {
      id: 'exec-create-vorgang',
      vorgangId: undefined,
      vorgangTitle: undefined,
      recognizedData: {
        ...MOCK_INBOX_ITEMS[0]!.recognizedData,
        _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);

    const workflow = processUploadedDocument(item.id)!;
    const result = executeSmartIntake(workflow, {
      companyName: testProfile.companyName,
      materialStandard: 'betrieb',
    });

    expect(result.successSteps).toContain('create_vorgang');
    expect(result.vorgangId).toBeTruthy();
    expect(getVorgangById(result.vorgangId!)?.createdFromInboxId).toBe(item.id);
  });

  it('behandelt Archiv-Duplikat per Update', () => {
    const base = cloneInbox(MOCK_INBOX_ITEMS.find((entry) => entry.id === 'inbox-004')!, {
      title: 'BG BAU Mustermann Sanitär GmbH',
      sender: 'BG BAU – Berufsgenossenschaft',
      recognizedData: {
        ...MOCK_INBOX_ITEMS[3]!.recognizedData,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });

    const firstItem = cloneInbox(base, { id: 'exec-duplicate-1' });
    hydrateInboxStore([firstItem]);
    executeSmartIntake(processUploadedDocument(firstItem.id)!, {
      companyName: testProfile.companyName,
    });
    expect(getAllDocuments().length).toBe(1);

    const secondItem = cloneInbox(base, { id: 'exec-duplicate-2' });
    hydrateInboxStore([secondItem]);
    const result = executeSmartIntake(processUploadedDocument(secondItem.id)!, {
      companyName: testProfile.companyName,
      duplicateMode: 'update',
    });

    expect(result.successSteps).toContain('archive_document');
    expect(getAllDocuments().length).toBe(1);
  });

  it('überspringt Positionsimport wenn keine Positionen vorhanden sind', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((entry) => entry.id === 'inbox-004')!, {
      id: 'exec-no-positions',
      title: 'BG BAU Mustermann Sanitär GmbH',
      recognizedData: {
        ...MOCK_INBOX_ITEMS[3]!.recognizedData,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);

    const workflow = processUploadedDocument(item.id)!;
    const result = executeSmartIntake(workflow, { companyName: testProfile.companyName });

    expect(result.successSteps).not.toContain('import_positions');
    expect(result.positionsAdded).toBe(0);
  });

  it('dedupliziert Aufgaben bei wiederholter Ausführung', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((entry) => entry.id === 'inbox-002')!, {
      id: 'exec-task-dedupe',
      title: 'Mahnung Mustermann Sanitär GmbH',
      recognizedData: {
        ...MOCK_INBOX_ITEMS[1]!.recognizedData,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);

    const workflow = processUploadedDocument(item.id)!;
    const first = executeSmartIntake(workflow, { companyName: testProfile.companyName });
    const taskCountAfterFirst = getAllTasksFromStore().length;
    expect(first.tasksCreated).toBeGreaterThan(0);

    const resetItem = getInboxItemById(item.id)!;
    hydrateInboxStore([{ ...resetItem, isNewUpload: false }]);
    const second = executeSmartIntake(processUploadedDocument(item.id)!, {
      companyName: testProfile.companyName,
    });

    expect(getAllTasksFromStore().length).toBe(taskCountAfterFirst);
    expect(second.tasksCreated).toBeGreaterThan(0);
  });

  it('erlaubt Teilfehler ohne Absturz', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((entry) => entry.id === 'inbox-002')!, {
      id: 'exec-partial',
      title: 'Zahlungserinnerung Mustermann Sanitär GmbH',
      recognizedData: {
        ...MOCK_INBOX_ITEMS[1]!.recognizedData,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);

    const workflow = processUploadedDocument(item.id)!;
    const result = executeSmartIntake(workflow, { companyName: '' });

    expect(result.failedSteps.some((failure) => failure.step === 'archive_document')).toBe(true);
    expect(result.inboxItem).not.toBeNull();
    expect(Array.isArray(result.successSteps)).toBe(true);
  });

  it('setzt Inbox nach Abschluss zurück', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((entry) => entry.id === 'inbox-004')!, {
      id: 'exec-finalize',
      title: 'BG BAU Mustermann Sanitär GmbH',
      isNewUpload: true,
      recognizedData: {
        ...MOCK_INBOX_ITEMS[3]!.recognizedData,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);

    const workflow = processUploadedDocument(item.id)!;
    const result = executeSmartIntake(workflow, { companyName: testProfile.companyName });

    expect(result.inboxItem?.isNewUpload).toBe(false);
    expect(result.successSteps).toContain('finalize_inbox');
  });

  it('aktualisiert Pending Summary', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((entry) => entry.id === 'inbox-004')!, {
      id: 'exec-pending',
      title: 'BG BAU Mustermann Sanitär GmbH',
      recognizedData: {
        ...MOCK_INBOX_ITEMS[3]!.recognizedData,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);

    const workflow = processUploadedDocument(item.id)!;
    const result = executeSmartIntake(workflow, { companyName: testProfile.companyName });

    expect(result.pendingSummary).toBeTruthy();
    expect(result.successSteps).toContain('refresh_pending');
  });
});
