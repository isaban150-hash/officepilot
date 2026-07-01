import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../data/mockData';
import { AppProvider } from '../context/AppContext';
import { AssistentPage } from './AssistentPage';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { setBrainGenerateTextForTests } from '../services/officePilotBrainService';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

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

async function flushUiUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('AssistentPage ausführliche Antwort', () => {
  let mounted: PageMount | null = null;

  beforeEach(() => {
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Test GmbH' });
    setBrainGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: 'Mock-KI: Keine offenen Rechnungen gefunden.',
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setBrainGenerateTextForTests(null);
    if (mounted) {
      cleanupPage(mounted);
      mounted = null;
    }
    document.body.innerHTML = '';
  });

  it('zeigt ausführliche Antwort nach Klick auf Ausführliche Antwort', async () => {
    mounted = renderAssistentPage();
    const input = mounted.container.querySelector('[data-testid="assistant-input"]') as HTMLInputElement;

    flushSync(() => {
      setInputValue(input, 'Was ist offen?');
    });
    flushSync(() => {
      clickByTestId(mounted!.container, 'assistant-ask-deep');
    });
    await flushUiUpdates();

    expect(mounted.container.querySelector('[data-testid="assistant-brain-answer"]')).not.toBeNull();
    const answerText = mounted.container.querySelector('[data-testid="brain-answer-text"]');
    expect(answerText?.textContent).toContain('Mock-KI: Keine offenen Rechnungen gefunden.');
  });
});
