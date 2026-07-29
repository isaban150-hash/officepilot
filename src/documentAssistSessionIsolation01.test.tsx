import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { createMockInboxItemFromUpload } from './services/inboxUploadFactory';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { hydrateInboxStore } from './services/inboxService';
import { resetDeferredWorkflowAnalysisCacheForTests } from './services/inboxWorkflowAnalysisKey';
import { hydrateVorgangStore } from './services/vorgangService';
import { resetTestStores } from './test/resetStores';
import type { AreaAiAnswer } from './types/areaAi';
import type { InboxItem } from './types/models';
import { readDocumentReplyDraftHandoffFromLocationState } from './services/documentReplyDraftHandoffService';
import * as documentAiService from './services/document/documentAiService';
import { setAiGenerateTextForTests } from './services/ai/aiRequestRunner';
import * as persistenceService from './services/persistenceService';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

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

const ID_A = 'inbox-session-iso-a';
const ID_B = 'inbox-session-iso-b';

function createBgItem(id: string, sender: string, title: string): InboxItem {
  return {
    ...createMockInboxItemFromUpload({
      sourceFileName: `${id}.pdf`,
      recognizedText: [
        `BG BAU ${title}`,
        `Absender: ${sender}`,
        'Frist: 15.08.2026',
        'Betrag: 250,00 EUR',
      ].join('\n'),
      kind: 'bg_bau',
    }),
    id,
    title,
    sender,
    classifiedKind: 'bg_bau',
    documentType: 'behoerde',
    markedAsCompanyDocument: true,
    fileRefId: `file-ref-${id}`,
  };
}

function DetailShell(): ReactElement {
  const navigate = useNavigate();
  return createElement(
    'div',
    { 'data-testid': 'session-iso-shell' },
    createElement('button', {
      type: 'button',
      'data-testid': 'session-iso-goto-a',
      onClick: () => navigate(`/ablage/${ID_A}`),
    }),
    createElement('button', {
      type: 'button',
      'data-testid': 'session-iso-goto-b',
      onClick: () => navigate(`/ablage/${ID_B}`),
    }),
    createElement(EingangDetailPage),
  );
}

function HandoffStateProbe(): ReactElement {
  const location = useLocation();
  return createElement('pre', {
    'data-testid': 'session-iso-handoff-probe',
    children: JSON.stringify(location.state ?? null),
  });
}

type Mount = { container: HTMLDivElement; root: Root };

async function mountSessionApp(startId: string): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/ablage/${startId}`] },
        createElement(
          AppProvider,
          { initialSetup: setupComplete },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/ablage/:id',
              element: createElement(DetailShell),
            }),
            createElement(Route, {
              path: '/kommunikation',
              element: createElement(HandoffStateProbe),
            }),
          ),
        ),
      ),
    );
  });
  await flushUi();
  return { container, root };
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function goTo(container: HTMLElement, which: 'a' | 'b'): Promise<void> {
  await act(async () => {
    (
      container.querySelector(
        `[data-testid="session-iso-goto-${which}"]`,
      ) as HTMLButtonElement
    ).click();
  });
  await flushUi();
}

function setTextarea(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function makeAnswer(text: string): AreaAiAnswer {
  return {
    question: 'q',
    text,
    directAnswer: text,
    source: 'ai',
    disclaimer: 'test',
    generatedAt: new Date().toISOString(),
  };
}

describe('DOCUMENT-ASSIST-SESSION-ISOLATION-01', () => {
  beforeEach(() => {
    resetTestStores();
    resetDeferredWorkflowAnalysisCacheForTests();
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([]);
    hydrateInboxStore([
      createBgItem(ID_A, 'Absender A GmbH', 'Dokument A'),
      createBgItem(ID_B, 'Absender B GmbH', 'Dokument B'),
    ]);
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: 'Antwort Standard.',
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    setAiGenerateTextForTests(null);
    vi.restoreAllMocks();
    resetTestStores();
    document.body.innerHTML = '';
  });

  it('SPA-Wechsel A→B leert Frage, AI-Antwort, Kernaussage, Entwurf und Fill/Next-Steps', async () => {
    const askSpy = vi
      .spyOn(documentAiService, 'askDocumentAi')
      .mockResolvedValue(makeAnswer('Antwort nur für Dokument A'));

    const { container, root } = await mountSessionApp(ID_A);
    expect(container.querySelector('[data-testid="ablage-detail-page"]')).not.toBeNull();

    const questionInput = container.querySelector(
      '[data-testid="document-free-question-input"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInput(questionInput, 'Was steht im Dokument?');
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-free-question-ask"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(
      container.querySelector('[data-testid="document-free-question-answer"]')?.textContent,
    ).toContain('Antwort nur für Dokument A');
    expect(askSpy).toHaveBeenCalled();

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-field-fill-confirm-confirm-Absender"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(
      container.querySelector('[data-testid="document-contextual-next-steps-considered"]')
        ?.textContent,
    ).toContain('Absender A GmbH');

    const core = container.querySelector(
      '[data-testid="document-confirmed-reply-draft-core"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      setTextarea(core, 'Kernaussage nur A');
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-confirmed-reply-draft-prepare"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(
      container.querySelector('[data-testid="document-confirmed-reply-draft-result"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="document-confirmed-reply-draft-body"]')?.textContent,
    ).toContain('Kernaussage nur A');

    await goTo(container, 'b');

    expect(container.querySelector('[data-testid="ablage-detail-page"]')).not.toBeNull();
    expect(
      (
        container.querySelector(
          '[data-testid="document-free-question-input"]',
        ) as HTMLInputElement
      ).value,
    ).toBe('');
    expect(container.querySelector('[data-testid="document-free-question-answer"]')).toBeNull();
    expect(container.querySelector('[data-testid="document-free-question-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="document-free-question-loading"]')).toBeNull();

    expect(
      (
        container.querySelector(
          '[data-testid="document-confirmed-reply-draft-core"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe('');
    expect(
      container.querySelector('[data-testid="document-confirmed-reply-draft-result"]'),
    ).toBeNull();

    expect(
      container.querySelector('[data-testid="document-contextual-next-steps-considered"]')
        ?.textContent,
    ).toContain('Noch keine bestätigten Angaben');
    expect(
      container.querySelector('[data-testid="document-field-fill-confirm-row-Absender"]')
        ?.getAttribute('data-status'),
    ).not.toBe('confirmed');
    expect(
      container.querySelector('[data-testid="document-field-fill-confirm-value-Absender"]')
        ?.textContent,
    ).toContain('Absender B GmbH');

    await act(async () => {
      root.unmount();
    });
  });

  it('verspätete AI-Antwort von A erscheint nicht bei B', async () => {
    let resolveAsk: ((value: AreaAiAnswer) => void) | null = null;
    vi.spyOn(documentAiService, 'askDocumentAi').mockImplementation(
      () =>
        new Promise<AreaAiAnswer>((resolve) => {
          resolveAsk = resolve;
        }),
    );

    const { container, root } = await mountSessionApp(ID_A);
    await act(async () => {
      setInput(
        container.querySelector(
          '[data-testid="document-free-question-input"]',
        ) as HTMLInputElement,
        'Frage A',
      );
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-free-question-ask"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(container.querySelector('[data-testid="document-free-question-loading"]')).not.toBeNull();

    await goTo(container, 'b');
    expect(container.querySelector('[data-testid="document-free-question-answer"]')).toBeNull();
    expect(container.querySelector('[data-testid="document-free-question-loading"]')).toBeNull();

    await act(async () => {
      resolveAsk?.(makeAnswer('Verspätete Antwort von A'));
      await Promise.resolve();
    });
    await flushUi();

    expect(container.querySelector('[data-testid="document-free-question-answer"]')).toBeNull();
    expect(container.textContent).not.toContain('Verspätete Antwort von A');

    await act(async () => {
      root.unmount();
    });
  });

  it('Handoff bei B enthält ausschließlich Daten von B (nicht von A)', async () => {
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const { container, root } = await mountSessionApp(ID_A);

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-field-fill-confirm-confirm-Absender"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    await act(async () => {
      setTextarea(
        container.querySelector(
          '[data-testid="document-confirmed-reply-draft-core"]',
        ) as HTMLTextAreaElement,
        'Kern nur A',
      );
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-confirmed-reply-draft-prepare"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(
      container.querySelector('[data-testid="document-confirmed-reply-draft-result"]'),
    ).not.toBeNull();

    await goTo(container, 'b');
    expect(
      container.querySelector('[data-testid="document-confirmed-reply-draft-result"]'),
    ).toBeNull();

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-field-fill-confirm-confirm-Absender"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    await act(async () => {
      setTextarea(
        container.querySelector(
          '[data-testid="document-confirmed-reply-draft-core"]',
        ) as HTMLTextAreaElement,
        'Kern nur B',
      );
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-confirmed-reply-draft-prepare"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();

    // Fill-Confirm persist (03A1) may call persistAll; handoff itself must not.
    persistSpy.mockClear();
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-confirmed-reply-draft-handoff"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();

    const probe = container.querySelector(
      '[data-testid="session-iso-handoff-probe"]',
    ) as HTMLElement;
    expect(probe).not.toBeNull();
    const payload = readDocumentReplyDraftHandoffFromLocationState(
      JSON.parse(probe.textContent || 'null'),
    );
    expect(payload).not.toBeNull();
    expect(payload!.documentId).toBe(ID_B);
    expect(payload!.contextRef.id).toBe(ID_B);
    expect(payload!.coreMessage).toBe('Kern nur B');
    expect(payload!.draftText).toContain('Kern nur B');
    expect(payload!.draftText).not.toContain('Kern nur A');
    expect(payload!.considered).toEqual([{ label: 'Absender', value: 'Absender B GmbH' }]);
    expect(persistSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it('erster Freitext-Bridge-Vorschlag bei B wird nicht übersprungen', async () => {
    const { container, root } = await mountSessionApp(ID_A);

    await act(async () => {
      setInput(
        container.querySelector(
          '[data-testid="document-free-question-input"]',
        ) as HTMLInputElement,
        'Absender: Bridge Firma A',
      );
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-free-question-ask"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(
      container.querySelector('[data-testid="document-field-fill-confirm-value-Absender"]')
        ?.textContent,
    ).toContain('Bridge Firma A');

    await goTo(container, 'b');

    await act(async () => {
      setInput(
        container.querySelector(
          '[data-testid="document-free-question-input"]',
        ) as HTMLInputElement,
        'Absender: Bridge Firma B',
      );
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-free-question-ask"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(
      container.querySelector('[data-testid="document-field-fill-confirm-value-Absender"]')
        ?.textContent,
    ).toContain('Bridge Firma B');
    expect(
      container
        .querySelector('[data-testid="document-field-fill-confirm-row-Absender"]')
        ?.getAttribute('data-status'),
    ).toBe('proposed');

    await act(async () => {
      root.unmount();
    });
  });

  it('Ablauf innerhalb desselben Dokuments bleibt funktionsfähig', async () => {
    vi.spyOn(documentAiService, 'askDocumentAi').mockResolvedValue(
      makeAnswer('Gleiche-Dokument-Antwort'),
    );
    const { container, root } = await mountSessionApp(ID_A);

    await act(async () => {
      setInput(
        container.querySelector(
          '[data-testid="document-free-question-input"]',
        ) as HTMLInputElement,
        'Kurzfrage?',
      );
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-free-question-ask"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(
      container.querySelector('[data-testid="document-free-question-answer"]')?.textContent,
    ).toContain('Gleiche-Dokument-Antwort');

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-field-fill-confirm-confirm-Absender"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    await act(async () => {
      setTextarea(
        container.querySelector(
          '[data-testid="document-confirmed-reply-draft-core"]',
        ) as HTMLTextAreaElement,
        'Noch im Dokument A',
      );
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-confirmed-reply-draft-prepare"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(
      container.querySelector('[data-testid="document-confirmed-reply-draft-result"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="document-contextual-next-steps-suggestions"]')
        ?.textContent,
    ).toContain('Kommunikationsbereich');

    await act(async () => {
      root.unmount();
    });
  });

  it('Wechsel zurück zu A ohne Remount stellt alten Session-State nicht wieder her', async () => {
    const { container, root } = await mountSessionApp(ID_A);

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-field-fill-confirm-confirm-Absender"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    await act(async () => {
      setTextarea(
        container.querySelector(
          '[data-testid="document-confirmed-reply-draft-core"]',
        ) as HTMLTextAreaElement,
        'Persistiert nicht',
      );
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-confirmed-reply-draft-prepare"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();

    await goTo(container, 'b');
    await goTo(container, 'a');

    // Ephemeral session UI (draft / prepared reply) must not leak across navigation.
    expect(
      (
        container.querySelector(
          '[data-testid="document-confirmed-reply-draft-core"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe('');
    expect(
      container.querySelector('[data-testid="document-confirmed-reply-draft-result"]'),
    ).toBeNull();
    // Durable Fill-Confirm (DWR overlay, 03A1) correctly rehydrates — not session leak.
    expect(
      container
        .querySelector('[data-testid="document-field-fill-confirm-row-Absender"]')
        ?.getAttribute('data-status'),
    ).toBe('confirmed');
    expect(
      container.querySelector('[data-testid="document-contextual-next-steps-considered"]')
        ?.textContent,
    ).toContain('Absender A GmbH');

    await act(async () => {
      root.unmount();
    });
  });
});
