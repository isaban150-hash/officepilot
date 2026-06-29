import { describe, expect, it, beforeEach } from 'vitest';
import { createTestVorgang } from '../test/fixtures';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import { hydrateDocumentStore } from './documentService';
import { hydrateInboxStore } from './inboxService';
import {
  NO_DATA_MESSAGE,
  answerQuestion,
  detectIntent,
} from './officeAssistantService';
import { normalizeTask } from './taskNormalize';
import { setTaskStoreForTests } from './taskStore';
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
    id: 'inbox-assistant-1',
    title: 'Test Mustermann Sanitär GmbH',
    documentType: 'kundenauftrag',
    sender: 'Müller Bau GmbH',
    priority: 'mittel',
    deadline: null,
    recommendedAction: 'auftrag_annehmen',
    digitalFolder: { id: 'd', name: 'n', path: '/' },
    paperFiling: { folderId: 'folder-5', register: 'A', label: 'x' },
    status: 'neu',
    receivedAt: '2026-03-27',
    recognizedData: {
      _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
      Betreff: 'Mustermann Sanitär GmbH',
    },
    officePilotSuggestion: 'Test',
    nextTaskLabel: 'Prüfen',
    securityHint: 'Test',
    ...overrides,
  };
}

function baseDocument(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-assistant-1',
    title: 'Freistellungsbescheinigung 2026',
    category: 'steuer',
    issuer: 'Finanzamt Berlin',
    recognizedText: 'Freistellungsbescheinigung für Mustermann Sanitär GmbH',
    issueDate: '2026-01-01',
    validUntil: '2026-07-07',
    digitalFolder: { id: 'dig', name: 'Steuer', path: '/Firma/Steuer/Freistellung/' },
    paperFolder: { folderId: 'folder-5', register: 'A', label: 'Steuer' },
    tags: ['Freistellungsbescheinigung'],
    linkedCompany: 'Mustermann Sanitär GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('officeAssistantService intent detection', () => {
  it('erkennt Aufgaben-Intents', () => {
    expect(detectIntent('Was muss ich heute erledigen?')).toBe('tasks_today');
    expect(detectIntent('Welche Aufgaben habe ich?')).toBe('tasks_open');
    expect(detectIntent('Was ist offen?')).toBe('tasks_open');
  });

  it('erkennt Rechnungs-Intents', () => {
    expect(detectIntent('Welche Rechnungen sind offen?')).toBe('invoices_open');
    expect(detectIntent('Welche Rechnungen sind überfällig?')).toBe('invoices_overdue');
    expect(detectIntent('Welche Rechnungen sind bezahlt?')).toBe('invoices_paid');
  });

  it('erkennt Dokument- und Vertrags-Intents', () => {
    expect(detectIntent('Welche Dokumente fehlen?')).toBe('documents_missing');
    expect(detectIntent('Welche Nachweise fehlen?')).toBe('contracts_missing_proofs');
    expect(detectIntent('Welche Dokumente laufen ab?')).toBe('documents_expiring');
  });

  it('erkennt Dashboard-Intents', () => {
    expect(detectIntent('Was ist heute wichtig?')).toBe('dashboard_important');
    expect(detectIntent('Was muss ich beachten?')).toBe('dashboard_attention');
  });
});

describe('officeAssistantService answers', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateInboxStore([]);
    hydrateDocumentStore([]);
    setTaskStoreForTests([]);
    hydrateVorgangStore([]);
    hydrateCompanyProfileStore(testProfile);
  });

  it('beantwortet heute-Aufgaben mit Daten', () => {
    setTaskStoreForTests([
      normalizeTask({
        id: 't-today',
        title: 'Frist heute',
        description: 'Test',
        status: 'open',
        priority: 'hoch',
        category: 'dokumente',
        type: 'dokument_pruefen',
        dueDate: '2026-06-27',
        done: false,
      }),
    ]);

    const answer = answerQuestion('Was muss ich heute erledigen?', '2026-06-27');
    expect(answer.summary).not.toBe(NO_DATA_MESSAGE);
    expect(answer.bullets.some((b) => b.includes('Frist heute'))).toBe(true);
    expect(answer.actions.some((a) => a.route === '/aufgaben')).toBe(true);
  });

  it('beantwortet offene Aufgaben', () => {
    setTaskStoreForTests([
      normalizeTask({
        id: 't-open',
        title: 'Offene Prüfung',
        description: 'Test',
        status: 'open',
        priority: 'mittel',
        category: 'dokumente',
        type: 'dokument_pruefen',
        done: false,
      }),
    ]);

    const answer = answerQuestion('Welche Aufgaben habe ich?');
    expect(answer.bullets.some((b) => b.includes('Offene Prüfung'))).toBe(true);
  });

  it('beantwortet überfällige Rechnungen', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-overdue',
        customer: 'Müller GmbH',
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
        ],
      }),
    ]);

    const answer = answerQuestion('Welche Rechnungen sind überfällig?', '2026-06-27');
    expect(answer.bullets.some((b) => b.includes('2026-0001'))).toBe(true);
    expect(answer.actions.some((a) => a.route.includes('inv-overdue'))).toBe(true);
  });

  it('beantwortet ablaufende Dokumente', () => {
    hydrateDocumentStore([
      baseDocument({
        id: 'doc-expiring',
        validUntil: '2026-07-07',
      }),
    ]);

    const answer = answerQuestion('Welche Dokumente laufen ab?', '2026-06-27');
    expect(answer.bullets.some((b) => b.includes('läuft in'))).toBe(true);
  });

  it('beantwortet fehlende Nachweise', () => {
    hydrateInboxStore([baseInbox()]);

    const answer = answerQuestion('Welche Nachweise fehlen?');
    expect(answer.summary).not.toBe(NO_DATA_MESSAGE);
    expect(answer.bullets.length).toBeGreaterThan(0);
  });

  it('beantwortet offene Vorgänge', () => {
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-open', title: 'Sanierung A', status: 'in_bearbeitung' }),
    ]);

    const answer = answerQuestion('Zeige mir alle offenen Vorgänge.');
    expect(answer.bullets.some((b) => b.includes('Sanierung A'))).toBe(true);
    expect(answer.actions.some((a) => a.route === '/vorgaenge/v-open')).toBe(true);
  });

  it('beantwortet offene Zahlungen', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-pay',
        customer: 'Schmidt AG',
        invoices: [
          {
            id: 'inv-open',
            number: '2026-0100',
            type: 'schluss',
            positions: [],
            subtotal: 500,
            taxStatus: 'standard_19',
            amount: 595,
            status: 'versendet',
            date: '2026-06-01',
            createdAt: '2026-06-01T00:00:00.000Z',
            paymentDueDate: '2026-07-15',
          },
        ],
      }),
    ]);

    const answer = answerQuestion('Wie viel Geld ist noch offen?', '2026-06-27');
    expect(answer.summary).toContain('595');
    expect(answer.linkedRoute).toBe('/rechnungen/offen');
  });

  it('gibt keine Informationen ohne passende Daten', () => {
    const unknown = answerQuestion('Wie ist das Wetter morgen?');
    expect(unknown.summary).toBe(NO_DATA_MESSAGE);
    expect(unknown.bullets).toHaveLength(0);

    const emptyTasks = answerQuestion('Welche Aufgaben habe ich?');
    expect(emptyTasks.summary).toBe(NO_DATA_MESSAGE);
  });
});
