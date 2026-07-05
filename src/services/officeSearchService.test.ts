import { beforeEach, describe, expect, it } from 'vitest';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import { resetCommunicationHistoryStore } from './communicationHistoryStore';
import { recordCommunicationResult } from './communicationHistoryService';
import { hydrateDocumentStore, importInboxDocument } from './documentService';
import { hydrateInboxStore } from './inboxService';
import {
  createMailImport,
  importMailAsInboxItem,
  resetMailImports,
} from './mailImportService';
import {
  getPaperRegisterEntries,
  resetMemory,
  syncContractProofRequirementsFromInbox,
} from './officePilotMemoryService';
import {
  expandSearchTerms,
  groupSearchResults,
  isSearchQuestion,
  rankSearchResults,
  searchOffice,
  trySearchAssistantAnswer,
} from './officeSearchService';
import { answerQuestion } from './officeAssistantService';
import { normalizeTask } from './taskNormalize';
import { setTaskStoreForTests } from './taskStore';
import { hydrateVorgangStore } from './vorgangService';
import { withInboxExtractedDocumentText } from './inboxDocumentText';
import { createAuftragInboxItem, createAbschlagInvoice, createOrderPosition, createTestVorgang } from '../test/fixtures';

const TODAY = '2026-06-27';

describe('officeSearchService', () => {
  beforeEach(() => {
    resetMemory();
    resetMailImports();
    resetCommunicationHistoryStore();
    hydrateDocumentStore([]);
    hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-search-mueller',
        title: 'Projekt Müller',
        customer: 'Müller Bau GmbH',
        baustelle: 'Kindergarten Sonnenschein',
        orderPositions: [createOrderPosition()],
        invoices: [
          createAbschlagInvoice(createOrderPosition().id, 10, {
            id: 'inv-search-1',
            number: 'AR-2026-99',
            status: 'versendet',
          }),
        ],
      }),
    ]);
    setTaskStoreForTests([
      normalizeTask({
        id: 'task-search-1',
        title: 'Freistellung für Müller nachreichen',
        status: 'open',
        priority: 'hoch',
        dueDate: '2026-07-01',
      }),
    ]);
  });

  it('findet Dokumente', () => {
    importInboxDocument(
      createAuftragInboxItem({
        id: 'inbox-doc-search',
        title: 'Freistellungsbescheinigung §48b',
        classifiedKind: 'freistellungsbescheinigung',
        sender: 'Finanzamt München',
      }),
      'Test GmbH',
    );

    const results = searchOffice({ query: 'Freistellung', todayIso: TODAY });
    expect(results.some((item) => item.type === 'document')).toBe(true);
  });

  it('findet OCR-Text im Eingang', () => {
    hydrateInboxStore([
      createAuftragInboxItem({
        id: 'inbox-ocr-search',
        title: 'Scan Eingang',
        recognizedData: {
          _extractedText: 'Werkvertrag Subunternehmer Müller Bau',
        },
      }),
    ]);

    const results = searchOffice({ query: 'Werkvertrag', todayIso: TODAY });
    expect(
      results.some((item) => item.type === 'inbox' && item.snippet.toLowerCase().includes('werkvertrag')),
    ).toBe(true);
  });

  it('findet Mail-Import', () => {
    const mail = createMailImport({
      from: 'service@bg-bau.de',
      subject: 'BG BAU Beitragsbescheid',
      bodyText: 'Beitragsbescheid im Anhang.',
    });
    importMailAsInboxItem(mail.id);

    const results = searchOffice({ query: 'BG BAU', todayIso: TODAY });
    expect(results.some((item) => item.type === 'mail' || item.source.includes('E-Mail'))).toBe(true);
  });

  it('findet ProofMemory', () => {
    const werkvertrag = createAuftragInboxItem({
      id: 'inbox-proof-search',
      title: 'Werkvertrag',
      classifiedKind: 'werkvertrag',
      vorgangId: 'v-search-mueller',
      vorgangLinkStatus: 'linked',
      recognizedData: withInboxExtractedDocumentText({}, SAMPLE_WERKVERTRAG_TEXT),
    });
    syncContractProofRequirementsFromInbox(werkvertrag);
    importInboxDocument(werkvertrag, 'Test GmbH');

    const results = searchOffice({ query: 'bg bau', todayIso: TODAY, limit: 50 });
    expect(results.some((item) => item.type === 'proof')).toBe(true);
  });

  it('findet BG BAU', () => {
    const results = searchOffice({ query: 'BG BAU', todayIso: TODAY });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((item) => buildHaystack(item.title, item.subtitle, item.snippet).includes('bg'))).toBe(
      true,
    );
  });

  it('findet Finanzamt', () => {
    const results = searchOffice({ query: 'Finanzamt', todayIso: TODAY });
    expect(results.some((item) => buildHaystack(item.title, item.subtitle, item.snippet).includes('finanzamt'))).toBe(
      true,
    );
  });

  it('findet Kunden-/Baustellensuche', () => {
    const mueller = searchOffice({ query: 'Müller', todayIso: TODAY });
    expect(mueller.some((item) => item.type === 'vorgang')).toBe(true);

    const kindergarten = searchOffice({ query: 'Kindergarten', todayIso: TODAY });
    expect(
      kindergarten.some((item) => buildHaystack(item.title, item.subtitle, item.snippet).includes('kindergarten')),
    ).toBe(true);
  });

  it('findet Rechnungen', () => {
    const results = searchOffice({ query: 'AR-2026-99', todayIso: TODAY, limit: 50 });
    expect(results.some((item) => item.type === 'invoice')).toBe(true);
  });

  it('findet Vorgänge', () => {
    const results = searchOffice({ query: 'Projekt Müller', todayIso: TODAY });
    expect(results.some((item) => item.type === 'vorgang')).toBe(true);
  });

  it('findet Tasks', () => {
    const results = searchOffice({ query: 'Freistellung nachreichen', todayIso: TODAY });
    expect(results.some((item) => item.type === 'task')).toBe(true);
  });

  it('findet Register und Papierordner', () => {
    importInboxDocument(
      createAuftragInboxItem({
        id: 'inbox-register-search',
        title: 'Freistellungsbescheinigung Register',
        classifiedKind: 'freistellungsbescheinigung',
        sender: 'Finanzamt',
      }),
      'Test GmbH',
    );

    expect(getPaperRegisterEntries().length).toBeGreaterThan(0);
    const results = searchOffice({ query: 'Freistellungsbescheinigungen', todayIso: TODAY });
    expect(
      results.some(
        (item) => item.source === 'Register' || item.matchedField === 'Papierordner' || item.source === 'Papierordner',
      ),
    ).toBe(true);
  });

  it('findet „Papier fehlt“ über Lebenszyklus', () => {
    importInboxDocument(
      createAuftragInboxItem({
        id: 'inbox-paper-missing',
        title: 'Freistellung Papier offen',
        classifiedKind: 'freistellungsbescheinigung',
        sender: 'Finanzamt',
      }),
      'Test GmbH',
    );

    const results = searchOffice({ query: 'Papier fehlt', todayIso: TODAY, limit: 50 });
    expect(results.some((item) => item.status === 'Original noch abheften')).toBe(true);
  });

  it('findet „Antwort offen“', () => {
    const inboxItem = createAuftragInboxItem({
      id: 'inbox-reply-open',
      title: 'Finanzamt Rückfrage',
      sender: 'Finanzamt München',
      classifiedKind: 'finanzamt',
    });
    hydrateInboxStore([inboxItem]);
    recordCommunicationResult(
      {
        mode: 'draft',
        intent: 'document_reply',
        status: 'complete',
        title: 'Antwort',
        summary: 'Entwurf',
        drafts: {
          email: {
            intent: 'document_reply',
            channel: 'email',
            subject: 'Antwort',
            body: 'Sehr geehrte Damen und Herren, vielen Dank für Ihr Schreiben.',
            tone: 'formal',
            basedOnFacts: [],
            notIncluded: [],
          },
        },
        disclaimer: 'Bitte prüfen.',
      },
      { type: 'inbox', id: inboxItem.id },
      'Antwort vorbereiten',
    );

    const results = searchOffice({ query: 'Finanzamt', todayIso: TODAY, limit: 50 });
    expect(results.some((item) => item.type === 'inbox' || item.type === 'communication')).toBe(true);
  });

  it('ranking bevorzugt exakte Titel-Treffer', () => {
    hydrateInboxStore([
      createAuftragInboxItem({ id: 'inbox-rank-1', title: 'Finanzamt', sender: 'Sonstiges' }),
      createAuftragInboxItem({ id: 'inbox-rank-2', title: 'Allgemeines Schreiben', sender: 'Finanzamt Berlin' }),
    ]);

    const results = rankSearchResults(searchOffice({ query: 'Finanzamt', todayIso: TODAY, limit: 20 }));
    expect(results[0]?.title).toBe('Finanzamt');
  });

  it('Filter nach Typ', () => {
    const results = searchOffice({
      query: 'Müller',
      filter: { types: ['vorgang'] },
      todayIso: TODAY,
    });
    expect(results.every((item) => item.type === 'vorgang')).toBe(true);
  });

  it('gruppiert Ergebnisse nach Typ', () => {
    const groups = groupSearchResults(searchOffice({ query: 'Finanzamt', todayIso: TODAY, limit: 20 }));
    expect(groups.length).toBeGreaterThan(0);
  });

  it('expandiert Regelbegriffe', () => {
    const terms = expandSearchTerms('BG BAU');
    expect(terms.some((term) => term.includes('bg'))).toBe(true);
  });
});

describe('officeSearchService assistant integration', () => {
  beforeEach(() => {
    resetMemory();
    hydrateDocumentStore([]);
    hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-assist-search', customer: 'Müller Bau GmbH', title: 'Projekt Müller' }),
    ]);
  });

  it('Assistent nutzt SearchService bei Suchfragen', () => {
    expect(isSearchQuestion('Welche Dokumente betreffen Müller?')).toBe(true);
    const direct = trySearchAssistantAnswer('Welche Dokumente betreffen Müller?', TODAY);
    expect(direct?.title).toBe('Suchergebnisse');
    expect(direct?.actions.length).toBeGreaterThan(0);

    const viaAssistant = answerQuestion('Zeig mir alle Schreiben vom Finanzamt', TODAY);
    expect(viaAssistant.title).toBe('Suchergebnisse');
    expect(viaAssistant.bullets.length).toBeGreaterThan(0);
  });
});

function buildHaystack(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ').toLowerCase();
}
