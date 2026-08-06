import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_INBOX_ITEMS } from './data/inboxMockData';
import { createTestVorgang } from './test/fixtures';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import * as documentCaseMatchService from './services/documentCaseMatchService';
import { hydrateInboxStore } from './services/inboxService';
import { processUploadedDocument } from './services/intakeWorkflowService';
import { setTaskStoreForTests } from './services/taskStore';
import { hydrateVorgangStore } from './services/vorgangService';
import type { InboxItem } from './types/models';

const testProfile = {
  companyName: 'Mustermann Sanit\u00e4r GmbH',
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

function installLocalStorageMock(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  });
}

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

describe('DOCUMENT-PRIMARY-TARGET-02A core', () => {
  beforeEach(() => {
    installLocalStorageMock();
    localStorage.clear();
    vi.restoreAllMocks();
    setTaskStoreForTests([]);
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-001',
        title: 'Badezimmer-Sanierung M\u00fcller',
        customer: 'Familie M\u00fcller',
        baustelle: 'Hauptstr. 12, Berlin',
        status: 'in_bearbeitung',
      }),
      createTestVorgang({
        id: 'v-002',
        title: 'Heizungstausch Schmidt',
        customer: 'Familie Schmidt',
        baustelle: 'Marktweg 5, Berlin',
        status: 'in_bearbeitung',
      }),
    ]);
  });

  it('caseMatch exact -> link_vorgang', () => {
    vi.spyOn(documentCaseMatchService, 'buildDocumentCaseMatch').mockReturnValue({
      matchStatus: 'exact',
      matchedCaseId: 'v-001',
      matchedCaseTitle: 'Badezimmer-Sanierung M\u00fcller',
      reasons: ['known_link'],
      candidates: [],
    });

    const item = cloneInbox(MOCK_INBOX_ITEMS.find((entry) => entry.id === 'inbox-003')!, {
      id: 'inbox-primary-target-02a-exact',
      vorgangId: undefined,
      vorgangTitle: undefined,
    });
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id);
    expect(result).not.toBeNull();
    expect(result!.nextActions.some((action) => action.id === 'link_vorgang' && action.enabled)).toBe(
      true,
    );
    expect(result!.nextActions.some((action) => action.id === 'select_vorgang')).toBe(false);
    expect(result!.suggestedVorgang?.vorgangId).toBe('v-001');
  });

  it('caseMatch multiple -> select_vorgang', () => {
    vi.spyOn(documentCaseMatchService, 'buildDocumentCaseMatch').mockReturnValue({
      matchStatus: 'multiple',
      matchedCaseId: null,
      matchedCaseTitle: null,
      reasons: ['same_customer'],
      candidates: [
        {
          caseId: 'v-001',
          caseTitle: 'Badezimmer-Sanierung M\u00fcller',
          reasons: ['same_customer'],
          score: 20,
        },
        {
          caseId: 'v-002',
          caseTitle: 'Heizungstausch Schmidt',
          reasons: ['same_customer'],
          score: 20,
        },
      ],
    });

    const item = cloneInbox(MOCK_INBOX_ITEMS.find((entry) => entry.id === 'inbox-003')!, {
      id: 'inbox-primary-target-02a-multiple',
      vorgangId: undefined,
      vorgangTitle: undefined,
    });
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id);
    expect(result).not.toBeNull();
    expect(result!.nextActions.some((action) => action.id === 'select_vorgang' && action.enabled)).toBe(
      true,
    );
    expect(result!.nextActions.some((action) => action.id === 'link_vorgang')).toBe(false);
    expect(result!.nextActions.some((action) => action.id === 'create_vorgang')).toBe(false);
    expect(result!.suggestedVorgang).toBeNull();
  });

  it('caseMatch none -> create_vorgang', () => {
    vi.spyOn(documentCaseMatchService, 'buildDocumentCaseMatch').mockReturnValue({
      matchStatus: 'none',
      matchedCaseId: null,
      matchedCaseTitle: null,
      reasons: [],
      candidates: [],
    });

    hydrateVorgangStore([]);
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((entry) => entry.id === 'inbox-001')!, {
      id: 'inbox-primary-target-02a-none',
      vorgangId: undefined,
      vorgangTitle: undefined,
      markedAsCompanyDocument: true,
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
    });
    hydrateInboxStore([item]);

    const result = processUploadedDocument(item.id);
    expect(result).not.toBeNull();
    expect(result!.nextActions.some((action) => action.id === 'create_vorgang' && action.enabled)).toBe(
      true,
    );
    expect(result!.nextActions.some((action) => action.id === 'link_vorgang')).toBe(false);
    expect(result!.nextActions.some((action) => action.id === 'select_vorgang')).toBe(false);
  });
});
