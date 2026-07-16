import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { t } from '../../i18n';
import { DokumentDetailPage } from '../../pages/DokumentDetailPage';
import { askDocumentAi } from './documentAiService';
import { buildDocumentAiPrompt } from './documentAiPromptBuilder';
import { buildDocumentAiContextFromDocument } from './documentAiContextService';
import { setAiGenerateTextForTests } from '../ai/aiRequestRunner';
import { getAllDocuments, hydrateDocumentStore } from '../documentService';
import { getCommunicationEvents, hydrateCommunicationHistory } from '../communicationHistoryService';
import { hydrateInboxStore, getInboxItems } from '../inboxService';
import { getAllTasksFromStore, hydrateTaskStore } from '../taskStore';
import { resetTestStores } from '../../test/resetStores';
import type { CompanyDocument } from '../../types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

const testInvoice: CompanyDocument = {
  id: 'doc-quality-invoice',
  title: 'Testrechnung',
  category: 'rechnung',
  issuer: 'Demo Absender',
  recognizedText:
    'Dies ist eine Testrechnung. Es besteht keine echte Forderung. Bitte nicht bezahlen.',
  issueDate: '2026-01-01',
  validUntil: null,
  digitalFolder: { id: 'd', name: 'Rechnungen', path: '/Rechnungen/' },
  paperFolder: { folderId: 'f', register: 'A', label: 'Rechnungen' },
  tags: [],
  linkedCompany: 'Test GmbH',
  linkedVorgang: null,
  archived: true,
  classifiedKind: 'sonstiges',
  createdAt: '2026-01-01T12:00:00.000Z',
};

type Mount = { container: HTMLDivElement; root: Root };

function mountAt(path: string, element: ReactElement): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AppProvider initialSetup={setupComplete}>
          <Routes>
            <Route path="/dokumente/:id" element={element} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

describe('DOCUMENT-FREE-QUESTION-QUALITY-01', () => {
  let mounted: Mount | null = null;

  beforeEach(() => {
    resetTestStores();
    hydrateCommunicationHistory([]);
    hydrateTaskStore([]);
    hydrateInboxStore([]);
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setAiGenerateTextForTests(null);
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = null;
    }
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('Prompt verlangt structured directAnswer JSON', () => {
    const context = buildDocumentAiContextFromDocument(testInvoice);
    const prompt = buildDocumentAiPrompt('Muss ich das bezahlen?', context, 'de');
    expect(prompt).toContain('"directAnswer"');
    expect(prompt).toContain('"explanation"');
    expect(prompt).toMatch(/keine Ja-\/Nein-Erfindung|nicht eindeutig beantworten/i);
    expect(prompt).not.toContain(t('document.freeQuestion.note.customerUncertain', 'de'));
  });

  it('belegte Zahlungsfrage liefert directAnswer zuerst und beginnt sinngemäß mit Nein', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: JSON.stringify({
          directAnswer: 'Nein. Laut dem Hinweis im Dokument handelt es sich um eine Testrechnung und nicht um eine echte Forderung.',
          explanation:
            'Laut dem Hinweis im Dokument besteht keine echte Forderung und es soll nicht bezahlt werden.',
        }),
      }),
    );
    hydrateDocumentStore([testInvoice]);

    const answer = await askDocumentAi({
      source: { type: 'document', document: testInvoice },
      question: 'Muss ich das bezahlen?',
    });

    expect(answer.directAnswer?.toLowerCase().startsWith('nein')).toBe(true);
    expect(answer.explanation).toMatch(/Hinweis|Testrechnung|Forderung/i);
    expect(answer.uncertaintyNotes?.some((n) => /Kunde|Auftrag|zuordnet/i.test(n))).toBeFalsy();

    mounted = mountAt(`/dokumente/${testInvoice.id}`, <DokumentDetailPage />);
    const input = mounted.container.querySelector(
      '[data-testid="document-free-question-input"]',
    ) as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Muss ich das bezahlen?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (
        mounted!.container.querySelector(
          '[data-testid="document-free-question-ask"]',
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });

    const direct = mounted.container.querySelector(
      '[data-testid="document-free-question-direct-answer"]',
    );
    const explanation = mounted.container.querySelector(
      '[data-testid="document-free-question-explanation"]',
    );
    expect(direct?.textContent?.toLowerCase().startsWith('nein')).toBe(true);
    expect(explanation?.textContent).toMatch(/Hinweis|Forderung|Testrechnung/i);

    const answerRoot = mounted.container.querySelector(
      '[data-testid="document-free-question-answer"]',
    ) as HTMLElement;
    const directIndex = answerRoot.innerHTML.indexOf('document-free-question-direct-answer');
    const explIndex = answerRoot.innerHTML.indexOf('document-free-question-explanation');
    const uncertaintyIndex = answerRoot.innerHTML.indexOf('document-free-question-uncertainty');
    expect(directIndex).toBeGreaterThanOrEqual(0);
    expect(explIndex).toBeGreaterThan(directIndex);
    if (uncertaintyIndex >= 0) {
      expect(uncertaintyIndex).toBeGreaterThan(explIndex);
    }
  });

  it('Zahlungsfrage ohne sicheren Beleg erfindet kein Ja/Nein', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: JSON.stringify({
          directAnswer: 'Das lässt sich aus dem Dokument nicht eindeutig beantworten.',
          explanation: 'Im Dokument ist keine eindeutige Zahlungsaufforderung erkennbar.',
        }),
      }),
    );
    const vague: CompanyDocument = {
      ...testInvoice,
      id: 'doc-vague',
      title: 'Allgemeines Schreiben',
      recognizedText: 'Allgemeines Schreiben ohne Zahlungsangabe.',
      classifiedKind: 'sonstiges',
    };
    const answer = await askDocumentAi({
      source: { type: 'document', document: vague },
      question: 'Muss ich das bezahlen?',
    });
    expect(answer.directAnswer).toMatch(/nicht eindeutig|nicht erkennbar|genannt/i);
    expect(answer.directAnswer).not.toMatch(/^(Ja|Nein)\b/i);
    expect(answer.directAnswer).not.toMatch(/Sie müssen zahlen/i);
  });

  it('unsicherer Betrag bleibt bei Zahlungsfrage sichtbar', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: JSON.stringify({
          directAnswer: 'Im Dokument ist ein Betrag genannt.',
          explanation: 'OfficePilot erkennt 120,00 € – bitte prüfen.',
        }),
      }),
    );
    // Inbox path carries amountNeedsReview; archive docs do not — use inbox-like via context notes:
    // For archive, amount note is not collected. Simulate via ask on a doc and filter unit already covers amount.
    // Here we verify payment answer still can show amount note when present in context by using inbox service path.
    const { createMockInboxItemFromUpload } = await import('../inboxUploadFactory');
    const item = {
      ...createMockInboxItemFromUpload({
        sourceFileName: 'rechnung.pdf',
        recognizedText: 'Rechnung 120,00 € bitte prüfen',
        kind: 'rechnung',
      }),
      vorgangId: undefined,
      vorgangTitle: undefined,
      vorgangLinkStatus: 'none' as const,
      recognizedData: { Betrag: '120,00 €' },
      sender: 'Lieferant',
      deadline: '2026-08-01',
      classifiedKind: 'rechnung' as const,
    };
    const answer = await askDocumentAi({
      source: { type: 'inbox', item },
      question: 'Muss ich das bezahlen?',
    });
    expect(answer.uncertaintyNotes?.some((n) => /Betrag|tutar|сум/i.test(n))).toBe(true);
    expect(answer.uncertaintyNotes?.some((n) => /Kunde|Auftrag|müşteri|клиент/i.test(n))).toBe(
      false,
    );
  });

  it('fehlende Frist bleibt bei Fristfrage sichtbar', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: JSON.stringify({
          directAnswer: 'Im Dokument ist keine eindeutige Frist erkennbar.',
          explanation: 'Im Kontext fehlt ein Fristdatum.',
        }),
      }),
    );
    const noDeadline: CompanyDocument = {
      ...testInvoice,
      id: 'doc-no-deadline',
      validUntil: null,
      issueDate: null,
      recognizedText: 'Schreiben ohne Fristangabe.',
      linkedVorgang: { vorgangId: 'v-1', vorgangTitle: 'Bad' },
      classifiedKind: 'freistellungsbescheinigung',
      issuer: 'Amt',
    };
    const answer = await askDocumentAi({
      source: { type: 'document', document: noDeadline },
      question: 'Welche Frist gibt es?',
    });
    expect(answer.uncertaintyNotes?.some((n) => /Frist|süre|срок/i.test(n))).toBe(true);
  });

  it('fehlender Absender bleibt bei Absenderfrage sichtbar', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: JSON.stringify({
          directAnswer: 'Ein Absender ist nicht sicher erkennbar.',
          explanation: 'Im Dokumentkontext fehlt der Absender.',
        }),
      }),
    );
    const noSender: CompanyDocument = {
      ...testInvoice,
      id: 'doc-no-sender',
      issuer: '',
      linkedVorgang: { vorgangId: 'v-1', vorgangTitle: 'Bad' },
      classifiedKind: 'freistellungsbescheinigung',
      validUntil: '2026-12-31',
      issueDate: '2026-01-01',
    };
    const answer = await askDocumentAi({
      source: { type: 'document', document: noSender },
      question: 'Wer ist der Absender?',
    });
    expect(answer.uncertaintyNotes?.some((n) => /Absender|gönderen|подател/i.test(n))).toBe(true);
  });

  it('Kundenunsicherheit bleibt bei Kunden-/Auftragsfrage sichtbar', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: JSON.stringify({
          directAnswer: 'Ein Kunde oder Auftrag ist nicht sicher zugeordnet.',
          explanation: 'Es liegt keine bestätigte Vorgangsverknüpfung vor.',
        }),
      }),
    );
    const answer = await askDocumentAi({
      source: { type: 'document', document: testInvoice },
      question: 'Welcher Kunde oder Auftrag gehört dazu?',
    });
    expect(answer.uncertaintyNotes?.some((n) => /Kunde|Auftrag|zuordnet/i.test(n))).toBe(true);
  });

  it('kein erkannter Text bleibt bei jeder Frage sichtbar', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: JSON.stringify({
          directAnswer: 'Das lässt sich aus dem Dokument nicht eindeutig beantworten.',
          explanation: 'Im Dokument ist kein belastbarer Text erkennbar.',
        }),
      }),
    );
    const empty: CompanyDocument = {
      ...testInvoice,
      id: 'doc-empty-text',
      recognizedText: '',
      linkedVorgang: { vorgangId: 'v-1', vorgangTitle: 'Bad' },
      classifiedKind: 'rechnung',
      issuer: 'Amt',
      validUntil: '2026-12-31',
      issueDate: '2026-01-01',
    };
    const answer = await askDocumentAi({
      source: { type: 'document', document: empty },
      question: 'Was steht im Dokument?',
    });
    expect(
      answer.uncertaintyNotes?.some((n) => /Text|belgeden|документа|beantworten|yanıtlan/i.test(n)),
    ).toBe(true);
  });

  it('Antwort bleibt nur im React-State – kein Versand/Aufgabe/Kommunikation', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: JSON.stringify({
          directAnswer: 'Nein.',
          explanation: 'Testrechnung ohne echte Forderung.',
        }),
      }),
    );
    hydrateDocumentStore([testInvoice]);
    const docsBefore = JSON.stringify(getAllDocuments());
    const inboxBefore = JSON.stringify(getInboxItems());
    const historyBefore = JSON.stringify(getCommunicationEvents());
    const tasksBefore = JSON.stringify(getAllTasksFromStore());

    await askDocumentAi({
      source: { type: 'document', document: testInvoice },
      question: 'Muss ich das bezahlen?',
    });

    expect(JSON.stringify(getAllDocuments())).toBe(docsBefore);
    expect(JSON.stringify(getInboxItems())).toBe(inboxBefore);
    expect(JSON.stringify(getCommunicationEvents())).toBe(historyBefore);
    expect(JSON.stringify(getAllTasksFromStore())).toBe(tasksBefore);
  });
});
