import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../data/mockData';
import { AppProvider } from '../context/AppContext';
import { AssistentPage } from './AssistentPage';
import { KommunikationPage } from './KommunikationPage';
import { formatCommunicationDraftText } from '../components/communication/CommunicationDraftView';
import * as communicationOrchestrator from '../services/communicationOrchestrator';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { hydrateInboxStore } from '../services/inboxService';
import { createAbschlagInvoice, createTestVorgang } from '../test/fixtures';
import { hydrateVorgangStore } from '../services/vorgangService';
import { setCommunicationAiGenerateTextForTests } from '../services/communication/communicationAiService';
import type { InboxItem } from '../types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

function createBriefInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-brief-ui',
    title: 'Finanzamt Schreiben',
    sender: 'Finanzamt München',
    documentType: 'behoerde',
    priority: 'hoch',
    deadline: '2026-07-15',
    digitalFolder: { id: 'dig-1', name: 'Behörden', path: '/Behörden/' },
    paperFiling: { folderId: 'folder-1', register: 'A', label: 'Behörden' },
    status: 'neu',
    receivedAt: '2026-06-01',
    officePilotSuggestion: 'Steuerbescheid',
    nextTaskLabel: 'Prüfen',
    securityHint: 'Original aufbewahren',
    recommendedAction: 'archivieren',
    recognizedData: { Frist: '2026-07-15', Betreff: 'Steuerbescheid' },
    markedAsCompanyDocument: true,
    ...overrides,
  };
}

function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function setInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function clickByTestId(container: ParentNode, testId: string): void {
  const element = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  if (!element) {
    throw new Error(`Missing element: ${testId}`);
  }
  element.click();
}

type PageMount = { container: HTMLDivElement; root: Root };

function renderKommunikationPage(
  initialEntry: string | { pathname: string; search?: string } = '/kommunikation',
): PageMount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <AppProvider initialSetup={setupComplete}>
          <KommunikationPage />
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

function renderAssistentPage(): PageMount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={['/assistent']}>
        <AppProvider initialSetup={setupComplete}>
          <AssistentPage />
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

function cleanupPage({ container, root }: PageMount): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function submitCommunicationRequest(container: ParentNode, text: string): void {
  const textarea = container.querySelector('[data-testid="communication-input"]') as HTMLTextAreaElement;
  flushSync(() => {
    setTextareaValue(textarea, text);
  });
  flushSync(() => {
    clickByTestId(container, 'communication-submit');
  });
}

function fillCommunicationField(container: ParentNode, fieldId: string, value: string): void {
  flushSync(() => {
    setInputValue(
      container.querySelector(`[data-testid="communication-field-${fieldId}"]`) as HTMLInputElement,
      value,
    );
  });
}

function submitMissingInfo(container: ParentNode): void {
  flushSync(() => {
    clickByTestId(container, 'communication-missing-submit');
  });
}

async function flushUiUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('KommunikationPage', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  let mounted: PageMount | null = null;

  beforeEach(() => {
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Test GmbH' });
    hydrateVorgangStore([createTestVorgang()]);
    hydrateInboxStore([createBriefInboxItem()]);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    writeText.mockClear();
  });

  afterEach(() => {
    if (mounted) {
      cleanupPage(mounted);
      mounted = null;
    }
    document.body.innerHTML = '';
  });

  it('renders the communication page', () => {
    mounted = renderKommunikationPage();
    expect(mounted.container.querySelector('[data-testid="kommunikation-page"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Kommunikation');
  });

  it('accepts input without context and shows no_data for unknown intent', async () => {
    mounted = renderKommunikationPage();
    submitCommunicationRequest(mounted.container, 'lorem ipsum dolor sit amet');
    await flushUiUpdates();
    expect(mounted.container.querySelector('[data-testid="communication-no-data"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Keine Informationen gefunden');
  });

  it('shows needs_info for price_adjustment without details', async () => {
    mounted = renderKommunikationPage('/kommunikation?context=vorgang&id=v-test-1');
    submitCommunicationRequest(mounted.container, 'Ich möchte den Preis erhöhen');
    await flushUiUpdates();
    expect(mounted.container.querySelector('[data-testid="communication-needs-info"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="communication-field-reason"]')).not.toBeNull();
  });

  it('creates a draft after answering missing info questions', async () => {
    mounted = renderKommunikationPage('/kommunikation?context=vorgang&id=v-test-1');
    submitCommunicationRequest(mounted.container, 'Preis erhöhen');
    fillCommunicationField(mounted.container, 'position', 'Sanitär');
    fillCommunicationField(mounted.container, 'newPrice', '88 €');
    fillCommunicationField(mounted.container, 'reason', 'Mehraufwand');
    submitMissingInfo(mounted.container);
    await flushUiUpdates();

    expect(mounted.container.querySelector('[data-testid="communication-draft"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Mehraufwand');
  });

  it('switches channels between email, whatsapp and letter', () => {
    mounted = renderKommunikationPage('/kommunikation?context=vorgang&id=v-test-1');
    submitCommunicationRequest(mounted.container, 'Verzögerung melden');
    fillCommunicationField(mounted.container, 'delayReason', 'Material verzögert');
    submitMissingInfo(mounted.container);

    const emailBody = (mounted!.container.querySelector('[data-testid="communication-draft-body"]') as HTMLElement)
      .textContent;
    flushSync(() => clickByTestId(mounted!.container, 'communication-channel-whatsapp'));
    const whatsappBody = (mounted!.container.querySelector('[data-testid="communication-draft-body"]') as HTMLElement)
      .textContent;
    flushSync(() => clickByTestId(mounted!.container, 'communication-channel-letter'));
    const letterBody = (mounted.container.querySelector('[data-testid="communication-draft-body"]') as HTMLElement)
      .textContent;

    expect(whatsappBody?.length ?? 0).toBeLessThan(emailBody?.length ?? 0);
    expect(letterBody).toContain('Test GmbH');
    expect(mounted.container.querySelector('.communication-channel-tab--active')?.textContent).toContain('Brief');
  });

  it('copies draft text via copy button', async () => {
    mounted = renderKommunikationPage('/kommunikation?context=vorgang&id=v-test-1');
    submitCommunicationRequest(mounted.container, 'Verzögerung melden');
    fillCommunicationField(mounted.container, 'delayReason', 'Material verzögert');
    submitMissingInfo(mounted.container);
    await act(async () => {
      clickByTestId(mounted!.container, 'communication-copy');
    });

    expect(writeText).toHaveBeenCalled();
    const draftText = (mounted.container.querySelector('[data-testid="communication-draft-body"]') as HTMLElement)
      .textContent;
    expect(writeText).toHaveBeenCalledWith(draftText);
    expect(mounted.container.textContent).toContain('Kopiert!');
  });

  it('shows blocked state for non-relevant inbox context', async () => {
    hydrateInboxStore([
      createBriefInboxItem({
        id: 'inbox-blocked-ui',
        markedAsCompanyDocument: false,
        title: 'Privat',
        sender: 'Unbekannt',
        recognizedData: {},
        officePilotSuggestion: '',
      }),
    ]);
    mounted = renderKommunikationPage({
      pathname: '/kommunikation',
      search: '?context=inbox&id=inbox-blocked-ui',
    });
    expect(mounted.container.querySelector('[data-testid="communication-context-hint"]')).not.toBeNull();
    submitCommunicationRequest(mounted.container, 'Was wollen die von mir?');
    await flushUiUpdates();
    expect(mounted.container.querySelector('[data-testid="communication-blocked"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Firmenbezug');
  });

  it('answers document_question for inbox context', async () => {
    mounted = renderKommunikationPage({
      pathname: '/kommunikation',
      search: '?context=inbox&id=inbox-brief-ui',
    });
    expect(mounted.container.querySelector('[data-testid="communication-context-hint"]')).not.toBeNull();
    submitCommunicationRequest(mounted.container, 'Was wollen die von mir?');
    await flushUiUpdates();
    expect(mounted.container.querySelector('[data-testid="communication-qa"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Antwort zum Dokument');
  });

  it('handles price_adjustment with follow-up questions end-to-end', async () => {
    mounted = renderKommunikationPage('/kommunikation?context=vorgang&id=v-test-1');
    submitCommunicationRequest(mounted.container, 'Preiserhöhung für Fliesenarbeiten');
    await flushUiUpdates();
    expect(mounted.container.querySelector('[data-testid="communication-needs-info"]')).not.toBeNull();
    fillCommunicationField(mounted.container, 'position', 'Fliesenarbeiten');
    fillCommunicationField(mounted.container, 'newPrice', '120');
    fillCommunicationField(mounted.container, 'reason', 'Lieferengpass beim Material');
    submitMissingInfo(mounted.container);
    await flushUiUpdates();
    expect(mounted.container.querySelector('[data-testid="communication-draft"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Lieferengpass beim Material');
  });

  it('creates payment_reminder draft with invoice context', async () => {
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [
          createAbschlagInvoice('op-test-1', 5, {
            id: 'inv-ui-reminder',
            number: '2026-0500',
            paymentDueDate: '2026-01-01',
            customerSnapshot: {
              name: 'Test Kunde',
              contactPerson: '',
              street: '',
              zip: '',
              city: '',
              email: '',
              phone: '',
            },
          }),
        ],
      }),
    ]);
    mounted = renderKommunikationPage({
      pathname: '/kommunikation',
      search: '?context=invoice&id=inv-ui-reminder&vorgangId=v-test-1',
    });
    expect(mounted.container.textContent).toContain('Kontext: Rechnung');
    submitCommunicationRequest(mounted.container, 'Zahlungserinnerung schicken');
    await flushUiUpdates();
    expect(mounted.container.querySelector('[data-testid="communication-draft"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain('2026-0500');
  });

  it('passes context and userAnswers to the orchestrator', async () => {
    const spy = vi.spyOn(communicationOrchestrator, 'processCommunicationRequest');
    mounted = renderKommunikationPage('/kommunikation?context=vorgang&id=v-test-1');
    submitCommunicationRequest(mounted.container, 'Preis erhöhen');
    fillCommunicationField(mounted.container, 'position', 'Sanitär');
    fillCommunicationField(mounted.container, 'newPrice', '88 €');
    fillCommunicationField(mounted.container, 'reason', 'Mehraufwand');
    submitMissingInfo(mounted.container);
    await flushUiUpdates();

    expect(spy).toHaveBeenCalled();
    const lastCall = spy.mock.calls.at(-1)?.[0];
    expect(lastCall?.contextRef).toEqual({ type: 'vorgang', id: 'v-test-1' });
    expect(lastCall?.userAnswers?.reason).toBe('Mehraufwand');
    spy.mockRestore();
  });

  it('runs full integration: question, follow-up, draft, channel switch, copy', async () => {
    mounted = renderKommunikationPage('/kommunikation?context=vorgang&id=v-test-1');
    submitCommunicationRequest(mounted.container, 'Preis erhöhen');
    fillCommunicationField(mounted.container, 'position', 'Sanitär');
    fillCommunicationField(mounted.container, 'newPrice', '88 €');
    fillCommunicationField(mounted.container, 'reason', 'Mehraufwand');
    submitMissingInfo(mounted.container);
    await flushUiUpdates();

    const emailText = (mounted!.container.querySelector('[data-testid="communication-draft-body"]') as HTMLElement)
      .textContent ?? '';
    flushSync(() => clickByTestId(mounted!.container, 'communication-channel-letter'));
    const letterText = (mounted!.container.querySelector('[data-testid="communication-draft-body"]') as HTMLElement)
      .textContent ?? '';
    expect(letterText).not.toBe(emailText);

    await act(async () => {
      clickByTestId(mounted!.container, 'communication-copy');
    });
    expect(writeText).toHaveBeenCalledWith(letterText);
  });
});

describe('KommunikationPage KI verbessern', () => {
  let mounted: PageMount | null = null;

  beforeEach(() => {
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    setCommunicationAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: 'Aufgrund von Materialverzug informieren wir Sie über die Verzögerung.',
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setCommunicationAiGenerateTextForTests(null);
    if (mounted) {
      cleanupPage(mounted);
      mounted = null;
    }
    document.body.innerHTML = '';
  });

  async function createDelayDraft(): Promise<void> {
    mounted = renderKommunikationPage('/kommunikation?context=vorgang&id=v-test-1');
    submitCommunicationRequest(mounted.container, 'Verzögerung melden');
    fillCommunicationField(mounted.container, 'delayReason', 'Material verzögert');
    submitMissingInfo(mounted.container);
    await flushUiUpdates();
  }

  it('zeigt KI-Button bei fertigem Draft', async () => {
    await createDelayDraft();
    expect(mounted!.container.querySelector('[data-testid="communication-ai-enhance"]')).not.toBeNull();
  });

  it('deaktiviert Formulierung verbessern ohne API-Schlüssel', async () => {
    vi.stubEnv('VITE_GEMINI_API_KEY', '');
    await createDelayDraft();
    const button = mounted!.container.querySelector(
      '[data-testid="communication-ai-enhance"]',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(mounted!.container.textContent).not.toContain('Gemini');
  });

  it('zeigt Mock-KI-Vorschlag und behält Original beim Umschalten', async () => {
    await createDelayDraft();
    const originalText = (
      mounted!.container.querySelector('[data-testid="communication-draft-body"]') as HTMLElement
    ).textContent;

    flushSync(() => clickByTestId(mounted!.container, 'communication-ai-enhance'));
    await flushUiUpdates();

    expect(mounted!.container.querySelector('[data-testid="communication-ai-variant-tabs"]')).not.toBeNull();
    const aiText = (
      mounted!.container.querySelector('[data-testid="communication-draft-body-ai"]') as HTMLElement
    ).textContent;
    expect(aiText).toContain('Materialverzug');

    flushSync(() => clickByTestId(mounted!.container, 'communication-ai-variant-original'));
    const restoredText = (
      mounted!.container.querySelector('[data-testid="communication-draft-body"]') as HTMLElement
    ).textContent;
    expect(restoredText).toBe(originalText);
  });

  it('kopiert die aktive KI-Variante', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    await createDelayDraft();
    flushSync(() => clickByTestId(mounted!.container, 'communication-ai-enhance'));
    await flushUiUpdates();

    const aiText = (
      mounted!.container.querySelector('[data-testid="communication-draft-body-ai"]') as HTMLElement
    ).textContent;

    await act(async () => {
      clickByTestId(mounted!.container, 'communication-copy');
    });

    expect(writeText).toHaveBeenCalledWith(aiText);
  });
});

describe('AssistentPage communication link', () => {
  let mounted: PageMount | null = null;

  afterEach(() => {
    if (mounted) {
      cleanupPage(mounted);
      mounted = null;
    }
    document.body.innerHTML = '';
  });

  it('shows link to /kommunikation', () => {
    mounted = renderAssistentPage();
    const button = mounted.container.querySelector('[data-testid="assistant-write-message"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain('Nachricht schreiben');
  });
});

describe('formatCommunicationDraftText', () => {
  it('joins subject, greeting, body and closing', () => {
    const text = formatCommunicationDraftText({
      intent: 'delay_notice',
      channel: 'email',
      subject: 'Verzögerung',
      greeting: 'Guten Tag,',
      body: 'Es verzögert sich.',
      closing: 'Grüße',
      tone: 'neutral',
      basedOnFacts: [],
      notIncluded: [],
    });
    expect(text).toContain('Betreff: Verzögerung');
    expect(text).toContain('Es verzögert sich.');
  });
});
