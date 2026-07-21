import { describe, expect, it, beforeEach } from 'vitest';
import { createTestVorgang } from '../test/fixtures';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import { hydrateDocumentStore } from './documentService';
import { hydrateInboxStore } from './inboxService';
import {
  archiveHasProofType,
  buildPendingSummary,
  dedupePendingItems,
  scanExpiringDocuments,
  scanOverdueInvoices,
  scanPendingInboxItems,
  scanPendingItems,
  scanRequiredContractDocuments,
  scanUpcomingInvoiceDueDates,
} from './pendingEngineService';
import { getAllTasksFromStore, setTaskStoreForTests } from './taskStore';
import { normalizeTask } from './taskNormalize';
import { hydrateVorgangStore } from './vorgangService';
import type { CompanyDocument, InboxItem } from '../types/models';

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

function baseInbox(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-pending-1',
    title: 'Test Mustermann Sanitär GmbH',
    documentType: 'behoerde',
    sender: 'BG BAU',
    priority: 'mittel',
    deadline: null,
    recommendedAction: 'abheften',
    digitalFolder: { id: 'd', name: 'n', path: '/' },
    paperFiling: { folderId: 'folder-5', register: 'A', label: 'x' },
    status: 'neu',
    receivedAt: '2026-03-27',
    recognizedData: { Betreff: 'Mustermann Sanitär GmbH' },
    officePilotSuggestion: 'Test',
    nextTaskLabel: 'Prüfen',
    securityHint: 'Test',
    ...overrides,
  };
}

function baseDocument(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-pending-1',
    title: 'Freistellungsbescheinigung 2026',
    category: 'steuer',
    issuer: 'Finanzamt',
    recognizedText: 'Freistellungsbescheinigung für Mustermann Sanitär GmbH',
    issueDate: '2026-01-01',
    validUntil: '2026-12-31',
    digitalFolder: { id: 'dig', name: 'Steuer', path: '/steuer/' },
    paperFolder: { folderId: 'folder-5', register: 'A', label: 'Steuer' },
    tags: ['Freistellung'],
    linkedCompany: 'Mustermann Sanitär GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('pendingEngineService inbox', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateInboxStore([]);
    hydrateDocumentStore([]);
    setTaskStoreForTests([]);
    hydrateCompanyProfileStore(testProfile);
  });

  it('erkennt neue Dokumente', () => {
    hydrateInboxStore([
      baseInbox({ id: 'inbox-new-1', status: 'neu' }),
      baseInbox({ id: 'inbox-new-2', status: 'neu' }),
    ]);
    const items = scanPendingInboxItems();
    expect(items.filter((item) => item.kind === 'inbox_new')).toHaveLength(2);
  });

  it('erkennt später klären', () => {
    hydrateInboxStore([baseInbox({ status: 'spaeter_klaeren' })]);
    const items = scanPendingInboxItems();
    expect(items.some((item) => item.kind === 'inbox_deferred')).toBe(true);
  });
});

describe('pendingEngineService documents', () => {
  beforeEach(() => {
    hydrateDocumentStore([]);
    setTaskStoreForTests([]);
  });

  it('erkennt ablaufende Dokumente', () => {
    hydrateDocumentStore([
      baseDocument({
        id: 'doc-expiring',
        validUntil: '2026-07-07',
      }),
    ]);
    const items = scanExpiringDocuments('2026-06-27');
    expect(items.some((item) => item.kind === 'document_expiring')).toBe(true);
    expect(items.find((item) => item.kind === 'document_expiring')?.daysUntilDue).toBe(10);
  });

  it('erkennt abgelaufene Dokumente', () => {
    hydrateDocumentStore([
      baseDocument({
        id: 'doc-expired',
        validUntil: '2026-01-01',
      }),
    ]);
    const items = scanExpiringDocuments('2026-06-27');
    expect(items.some((item) => item.kind === 'document_expired')).toBe(true);
  });
});

describe('pendingEngineService invoices', () => {
  beforeEach(() => {
    localStorage.clear();
    setTaskStoreForTests([]);
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-inv',
        invoices: [
          {
            id: 'inv-overdue',
            number: '2026-0001',
            type: 'schluss',
            positions: [],
            subtotal: 1000,
            taxStatus: 'standard_19',
            amount: 1190,
            status: 'versendet',
            date: '2026-01-01',
            createdAt: '2026-01-01T00:00:00.000Z',
            paymentDueDate: '2026-01-01',
          },
          {
            id: 'inv-soon',
            number: '2026-0002',
            type: 'schluss',
            positions: [],
            subtotal: 500,
            taxStatus: 'standard_19',
            amount: 595,
            status: 'versendet',
            date: '2026-06-01',
            createdAt: '2026-06-01T00:00:00.000Z',
            paymentDueDate: '2026-07-02',
          },
        ],
      }),
    ]);
  });

  it('erkennt überfällige Rechnungen und synchronisiert Tasks', () => {
    const items = scanOverdueInvoices('2026-06-27');
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('invoice_overdue');
    expect(getAllTasksFromStore()).toHaveLength(1);
  });

  it('erkennt bald fällige Rechnungen', () => {
    const items = scanUpcomingInvoiceDueDates('2026-06-27');
    expect(items.some((item) => item.kind === 'invoice_due_soon')).toBe(true);
  });

  it('ignores prepared invoices for due-date hints', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-prep',
        invoices: [
          {
            id: 'inv-prep-soon',
            number: '2026-0099',
            type: 'schluss',
            positions: [],
            subtotal: 500,
            taxStatus: 'standard_19',
            amount: 595,
            status: 'vorbereitet',
            date: '2026-06-01',
            createdAt: '2026-06-01T00:00:00.000Z',
            paymentDueDate: '2026-07-02',
          },
          {
            id: 'inv-prep-overdue-date',
            number: '2026-0098',
            type: 'schluss',
            positions: [],
            subtotal: 500,
            taxStatus: 'standard_19',
            amount: 595,
            status: 'vorbereitet',
            date: '2026-01-01',
            createdAt: '2026-01-01T00:00:00.000Z',
            paymentDueDate: '2026-01-01',
          },
        ],
      }),
    ]);

    expect(scanUpcomingInvoiceDueDates('2026-06-27')).toHaveLength(0);
    expect(scanOverdueInvoices('2026-06-27')).toHaveLength(0);
  });

  it('ignores paid sent invoices for due-date hints', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-paid',
        invoices: [
          {
            id: 'inv-paid-soon',
            number: '2026-0088',
            type: 'schluss',
            positions: [],
            subtotal: 500,
            taxStatus: 'standard_19',
            amount: 595,
            status: 'versendet',
            date: '2026-06-01',
            createdAt: '2026-06-01T00:00:00.000Z',
            paymentDueDate: '2026-07-02',
            paymentStatus: 'bezahlt',
            payments: [
              {
                id: 'pay-1',
                amount: 595,
                date: '2026-06-10',
                createdAt: '2026-06-10T00:00:00.000Z',
              },
            ],
          },
        ],
      }),
    ]);

    expect(scanUpcomingInvoiceDueDates('2026-06-27')).toHaveLength(0);
  });
});

describe('pendingEngineService contracts', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateDocumentStore([]);
    setTaskStoreForTests([]);
    hydrateCompanyProfileStore(testProfile);
  });

  it('erkennt fehlende Nachweise im Vertrag', () => {
    hydrateInboxStore([
      baseInbox({
        id: 'inbox-contract',
        documentType: 'kundenauftrag',
        recognizedData: {
          _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
          Betreff: 'Mustermann Sanitär GmbH',
        },
      }),
    ]);

    const items = scanRequiredContractDocuments();
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.kind === 'contract_missing_proof')).toBe(true);
  });

  it('ignoriert Nachweise die bereits im Archiv liegen', () => {
    hydrateDocumentStore([
      baseDocument({
        id: 'doc-freistellung',
        title: 'Freistellungsbescheinigung',
        recognizedText: 'Freistellungsbescheinigung gültig',
        tags: ['Freistellungsbescheinigung'],
      }),
      baseDocument({
        id: 'doc-bg',
        title: 'BG BAU Unbedenklichkeitsbescheinigung',
        recognizedText: 'BG BAU Mitgliedsbescheinigung',
        category: 'behoerde',
      }),
      baseDocument({
        id: 'doc-soka',
        title: 'SOKA-BAU',
        recognizedText: 'SOKA-BAU Nachweis',
        category: 'behoerde',
      }),
      baseDocument({
        id: 'doc-aok',
        title: 'AOK Bescheinigung',
        recognizedText: 'AOK Mitgliedschaft',
        category: 'behoerde',
      }),
      baseDocument({
        id: 'doc-haft',
        title: 'Betriebshaftpflichtversicherung',
        recognizedText: 'Haftpflichtversicherung Police',
        category: 'versicherung',
      }),
    ]);

    hydrateInboxStore([
      baseInbox({
        id: 'inbox-contract-covered',
        documentType: 'kundenauftrag',
        recognizedData: {
          _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
          Betreff: 'Mustermann Sanitär GmbH',
        },
      }),
    ]);

    expect(scanRequiredContractDocuments()).toHaveLength(0);
    expect(archiveHasProofType('freistellungsbescheinigung')).toBe(true);
  });
});

describe('pendingEngineService summary and dedupe', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateInboxStore([]);
    hydrateDocumentStore([]);
    setTaskStoreForTests([]);
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([]);
  });

  it('buildPendingSummary liefert Zähler und Highlights', () => {
    hydrateInboxStore([
      baseInbox({ id: 'inbox-a', status: 'neu' }),
      baseInbox({ id: 'inbox-b', status: 'spaeter_klaeren' }),
    ]);
    setTaskStoreForTests([
      normalizeTask({
        id: 't-1',
        title: 'Offene Aufgabe',
        description: 'Test',
        status: 'open',
        priority: 'mittel',
        category: 'dokumente',
        type: 'dokument_pruefen',
        done: false,
      }),
      normalizeTask({
        id: 't-2',
        title: 'Zweite Aufgabe',
        description: 'Test',
        status: 'open',
        priority: 'hoch',
        category: 'dokumente',
        type: 'dokument_pruefen',
        done: false,
      }),
      normalizeTask({
        id: 't-3',
        title: 'Dritte Aufgabe',
        description: 'Test',
        status: 'open',
        priority: 'niedrig',
        category: 'dokumente',
        type: 'dokument_pruefen',
        done: false,
      }),
    ]);

    const { summary } = scanPendingItems('2026-06-27');
    expect(summary.newInboxItems).toBe(1);
    expect(summary.deferredInboxItems).toBe(1);
    expect(summary.openTasks).toBe(3);
    expect(summary.highlights.some((h) => h.kind === 'open_tasks')).toBe(true);
  });

  it('dedupliziert Pending-Items', () => {
    const duplicateItems = [
      {
        id: 'inbox_new:inbox-1',
        kind: 'inbox_new' as const,
        title: 'A',
        priority: 'niedrig' as const,
        route: '/ablage/inbox-1',
        sourceType: 'inbox' as const,
      },
      {
        id: 'inbox_new:inbox-1',
        kind: 'inbox_new' as const,
        title: 'A',
        priority: 'niedrig' as const,
        route: '/ablage/inbox-1',
        sourceType: 'inbox' as const,
      },
    ];
    expect(dedupePendingItems(duplicateItems)).toHaveLength(1);
  });

  it('scanPendingItems erzeugt keine doppelten Einträge bei wiederholtem Scan', () => {
    hydrateInboxStore([baseInbox({ id: 'inbox-dup', status: 'neu' })]);
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-dup',
        invoices: [
          {
            id: 'inv-dup',
            number: '2026-9999',
            type: 'schluss',
            positions: [],
            subtotal: 100,
            taxStatus: 'standard_19',
            amount: 119,
            status: 'versendet',
            date: '2026-01-01',
            createdAt: '2026-01-01T00:00:00.000Z',
            paymentDueDate: '2026-01-01',
          },
        ],
      }),
    ]);

    const first = scanPendingItems('2026-06-27');
    const second = scanPendingItems('2026-06-27');
    expect(first.items.length).toBe(second.items.length);
    expect(getAllTasksFromStore()).toHaveLength(1);
  });

  it('Legacy-Daten ohne neue Felder crashen nicht', () => {
    hydrateDocumentStore([
      {
        id: 'legacy-doc',
        title: 'Altes Dokument',
        category: 'sonstiges',
        issuer: '',
        recognizedText: '',
        issueDate: null,
        validUntil: null,
        digitalFolder: { id: 'd', name: 'n', path: '/' },
        paperFolder: { folderId: 'f', register: 'A', label: 'l' },
        tags: [],
        linkedCompany: '',
        linkedVorgang: null,
        archived: true,
        createdAt: '2020-01-01T00:00:00.000Z',
      },
    ]);
    hydrateInboxStore([
      {
        ...baseInbox({ id: 'legacy-inbox' }),
        vorgangLinkStatus: undefined,
        importedToArchive: undefined,
      },
    ]);

    expect(() => buildPendingSummary([], '2026-06-27')).not.toThrow();
    expect(() => scanPendingItems('2026-06-27')).not.toThrow();
  });
});
