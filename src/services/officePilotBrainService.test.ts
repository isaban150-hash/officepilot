import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestVorgang } from '../test/fixtures';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateCommunicationHistory } from './communicationHistoryService';
import { hydrateDocumentStore } from './documentService';
import { hydrateInboxStore } from './inboxService';
import { hydrateKnowledgeFacts } from './knowledgeService';
import { setTaskStoreForTests } from './taskStore';
import { normalizeTask } from './taskNormalize';
import { hydrateVorgangStore } from './vorgangService';
import { hydrateVorgangNotes } from './vorgangNoteService';
import { getAllVorgaenge } from './vorgangService';
import { getKnowledgeFacts } from './knowledgeService';
import { getCommunicationEvents } from './communicationHistoryService';
import { getAllDocuments } from './documentService';
import { getInboxItems } from './inboxService';
import { getAllTasksFromStore } from './taskStore';
import { getVorgangNoteStoreSnapshot } from './vorgangNoteService';
import {
  askOfficePilotBrain,
  buildBrainPrompt,
  buildBrainSnapshot,
  setBrainGenerateTextForTests,
} from './officePilotBrainService';
import { buildBrainSnapshotCounts } from './brain/brainSnapshotService';
import { setAiProviderFetchForTests } from './aiProviderService';
import * as supabaseLib from '../lib/supabase';
import type { CompanyDocument, InboxItem } from '../types/models';
import type { KnowledgeFact } from '../types/knowledge';

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

function captureStoreState() {
  return JSON.stringify({
    vorgaenge: getAllVorgaenge(),
    knowledge: getKnowledgeFacts(),
    communication: getCommunicationEvents(),
    documents: getAllDocuments(),
    inbox: getInboxItems(),
    tasks: getAllTasksFromStore(),
    notes: getVorgangNoteStoreSnapshot(),
  });
}

describe('officePilotBrainService', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    setBrainGenerateTextForTests(null);
    setAiProviderFetchForTests(null);
    hydrateInboxStore([]);
    hydrateDocumentStore([]);
    setTaskStoreForTests([]);
    hydrateVorgangStore([]);
    hydrateVorgangNotes([]);
    hydrateCommunicationHistory([]);
    hydrateKnowledgeFacts([]);
    hydrateCompanyProfileStore(testProfile);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setBrainGenerateTextForTests(null);
    setAiProviderFetchForTests(null);
    vi.restoreAllMocks();
  });

  it('buildBrainSnapshot enthält Daten aus den Stores', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-brain-1',
        title: 'Sanierung Brain',
        customer: 'Müller GmbH',
        status: 'in_bearbeitung',
        invoices: [
          {
            id: 'inv-brain-1',
            number: '2026-0042',
            type: 'schluss',
            positions: [],
            subtotal: 1000,
            taxStatus: 'standard_19',
            amount: 1190,
            status: 'versendet',
            date: '2026-06-01',
            createdAt: '2026-06-01T00:00:00.000Z',
            paymentDueDate: '2026-07-01',
          },
        ],
      }),
    ]);
    setTaskStoreForTests([
      normalizeTask({
        id: 't-brain',
        title: 'Brain-Aufgabe',
        description: 'Test',
        status: 'open',
        priority: 'mittel',
        category: 'dokumente',
        type: 'dokument_pruefen',
        dueDate: '2026-06-27',
        done: false,
      }),
    ]);
    hydrateDocumentStore([
      {
        id: 'doc-brain',
        title: 'Versicherungsnachweis',
        category: 'versicherung',
        issuer: 'Allianz',
        recognizedText: 'Test',
        issueDate: '2026-01-01',
        validUntil: null,
        digitalFolder: { id: 'd', name: 'n', path: '/' },
        paperFolder: { folderId: 'f', register: 'A', label: 'x' },
        tags: [],
        linkedCompany: 'Test',
        linkedVorgang: null,
        archived: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      } satisfies CompanyDocument,
    ]);
    const inboxItem: InboxItem = {
      id: 'inbox-brain',
      title: 'Anfrage Brain',
      sender: 'Kunde X',
      documentType: 'kundenauftrag',
      priority: 'mittel',
      deadline: null,
      digitalFolder: { id: 'd', name: 'n', path: '/' },
      paperFiling: { folderId: 'f', register: 'A', label: 'x' },
      status: 'neu',
      receivedAt: '2026-06-01',
      officePilotSuggestion: 'Prüfen',
      nextTaskLabel: 'Prüfen',
      securityHint: 'Test',
      recommendedAction: 'auftrag_annehmen',
      recognizedData: {},
    };
    hydrateInboxStore([inboxItem]);
    const knowledgeFact: KnowledgeFact = {
      id: 'kf-brain',
      scope: 'company',
      category: 'other',
      key: 'payment_terms',
      value: '14 Tage',
      displayText: 'Zahlungsziel 14 Tage',
      sourceType: 'user',
      confirmedAt: '2026-01-01T00:00:00.000Z',
      active: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    hydrateKnowledgeFacts([knowledgeFact]);
    hydrateVorgangNotes([
      {
        id: 'note-brain',
        vorgangId: 'v-brain-1',
        vorgangTitle: 'Sanierung Brain',
        body: 'Kunde hat angerufen',
        occurredAt: '2026-06-20T10:00:00.000Z',
        createdAt: '2026-06-20T10:00:00.000Z',
        source: 'user',
      },
    ]);
    hydrateCommunicationHistory([
      {
        id: 'comm-brain',
        type: 'draft_created',
        timestamp: '2026-06-21T12:00:00.000Z',
        channel: 'email',
        contextRef: { type: 'vorgang', id: 'v-brain-1' },
        status: 'complete',
        resultExcerpt: 'Entwurf an Kunde',
        disclaimerShown: true,
      },
    ]);

    const snapshot = buildBrainSnapshot('2026-06-27');
    const counts = buildBrainSnapshotCounts(snapshot);

    expect(snapshot.company.companyName).toBe('Mustermann Sanitär GmbH');
    expect(counts.vorgaenge).toBe(1);
    expect(snapshot.vorgaenge[0]?.title).toBe('Sanierung Brain');
    expect(counts.invoices).toBeGreaterThan(0);
    expect(snapshot.invoices[0]?.number).toBe('2026-0042');
    expect(counts.tasksOpen).toBe(1);
    expect(snapshot.tasksOpen[0]?.title).toBe('Brain-Aufgabe');
    expect(counts.documents).toBe(1);
    expect(counts.inbox).toBe(1);
    expect(counts.knowledge).toBe(1);
    expect(counts.notes).toBe(1);
    expect(counts.communicationHistory).toBe(1);
  });

  it('buildBrainPrompt enthält relevante Fakten und Guardrails', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-prompt',
        title: 'Dachsanierung',
        customer: 'Schmidt AG',
        invoices: [
          {
            id: 'inv-prompt',
            number: '2026-0099',
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

    const snapshot = buildBrainSnapshot('2026-06-27');
    const prompt = buildBrainPrompt('Welche Rechnungen sind offen?', snapshot);

    expect(prompt).toContain('Keine Rechtsberatung');
    expect(prompt).toContain('Steuerberatung');
    expect(prompt).toContain('Mustermann Sanitär GmbH');
    expect(prompt).toContain('Dachsanierung');
    expect(prompt).toContain('2026-0099');
    expect(prompt).toContain('Welche Rechnungen sind offen?');
  });

  it('ruft ohne eingerichtete Cloud-Verbindung keinen Provider auf', async () => {
    /*
     * SECURITY-GEMINI-KEY-01B: Der Browser kennt keinen Gemini-Schlüssel mehr.
     * Die Zusicherung bleibt dieselbe — ohne Verbindung wird nichts gesendet —
     * nur die Voraussetzung ist jetzt die Cloud-Konfiguration.
     */
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    const generateMock = vi.fn().mockResolvedValue({
      success: true,
      text: 'sollte nicht erscheinen',
    });
    setBrainGenerateTextForTests(generateMock);
    const fetchMock = vi.fn();
    setAiProviderFetchForTests(fetchMock);

    const answer = await askOfficePilotBrain('Was ist offen?');

    expect(answer.source).toBe('unavailable');
    expect(answer.errorCode).toBe('missing_api_key');
    expect(generateMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('liefert Mock-Antwort über Test-Override', async () => {
    const generateMock = vi.fn().mockResolvedValue({
      success: true,
      text: 'Es gibt eine offene Rechnung 2026-0099.',
    });
    setBrainGenerateTextForTests(generateMock);

    const answer = await askOfficePilotBrain('Welche Rechnungen sind offen?');

    expect(answer.source).toBe('ai');
    expect(answer.text).toBe('Es gibt eine offene Rechnung 2026-0099.');
    expect(answer.disclaimer).toContain('keine Rechts- oder Steuerberatung');
    expect(generateMock).toHaveBeenCalledOnce();
    const prompt = generateMock.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('NUTZERFRAGE');
    expect(prompt).toContain('Welche Rechnungen sind offen?');
  });

  it('mutiert keine Stores beim Beantworten', async () => {
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-immutable', title: 'Unverändert', status: 'in_bearbeitung' }),
    ]);
    setBrainGenerateTextForTests(
      vi.fn().mockResolvedValue({ success: true, text: 'Antwort ohne Änderung.' }),
    );

    const before = captureStoreState();
    await askOfficePilotBrain('Zeige offene Vorgänge');
    const after = captureStoreState();

    expect(after).toBe(before);
  });
});
