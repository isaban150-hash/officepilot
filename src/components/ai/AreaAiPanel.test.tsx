import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AreaAiPanel } from './AreaAiPanel';
import { setAiGenerateTextForTests } from '../../services/ai/aiRequestRunner';
import * as aiRequestRunner from '../../services/ai/aiRequestRunner';
import type { AreaAiAnswer } from '../../types/areaAi';

function setInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function clickByTestId(container: ParentNode, testId: string): void {
  const element = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  if (!element) throw new Error(`Missing element: ${testId}`);
  element.click();
}

describe('AreaAiPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  const mockAnswer: AreaAiAnswer = {
    question: 'Was steht hier?',
    text: 'Es geht um eine Frist bis Juli 2026.',
    source: 'ai',
    disclaimer: 'Disclaimer',
    generatedAt: '2026-06-27T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(
        <AreaAiPanel
          title="Frage zu diesem Dokument"
          placeholder="Frage eingeben"
          askLabel="KI fragen"
          loadingLabel="KI denkt nach…"
          notConfiguredLabel="KI nicht eingerichtet"
          testIdPrefix="test-ai"
          onAsk={async () => mockAnswer}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllEnvs();
    setAiGenerateTextForTests(null);
  });

  it('rendert Panel und fragt KI', async () => {
    expect(container.querySelector('[data-testid="test-ai-panel"]')).not.toBeNull();

    const input = container.querySelector('[data-testid="test-ai-input"]') as HTMLInputElement;
    flushSync(() => setInputValue(input, 'Was steht hier?'));
    flushSync(() => clickByTestId(container, 'test-ai-ask'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="test-ai-answer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="test-ai-answer-text"]')?.textContent).toContain(
      'Frist bis Juli 2026',
    );
  });

  /*
   * DOCUMENT-ACTION-LABELS-01B — der Gemini-Schlüssel steht nicht mehr im Browser.
   *
   * Seit `1a297c7` („secure Gemini behind edge function") liegt er serverseitig;
   * `isAiProviderConfigured()` fragt heute `isSupabaseConfigured()`. Ein
   * fehlender Browser-Schlüssel sagt über die KI-Verfügbarkeit deshalb nichts
   * mehr aus — der Test würde die Sicherheitsverbesserung sonst zurückfordern.
   *
   * Der nicht eingerichtete Zustand wird deshalb über die **heutige** Quelle
   * erzeugt: keine Supabase-Konfiguration.
   */
  it('deaktiviert Button ohne eingerichtete KI', () => {
    vi.spyOn(aiRequestRunner, 'isAiProviderConfigured').mockReturnValue(false);
    act(() => {
      root.render(
        <AreaAiPanel
          title="Frage"
          placeholder="Frage"
          askLabel="KI fragen"
          loadingLabel="Lädt"
          notConfiguredLabel="KI nicht eingerichtet"
          testIdPrefix="test-ai"
          onAsk={async () => mockAnswer}
        />,
      );
    });

    const button = container.querySelector('[data-testid="test-ai-ask"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('KI nicht eingerichtet');
  });
});
