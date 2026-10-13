/**
 * FINANZ-CORE-01A (Nebenbefund) — der Kopier-Knopf (u. a. im Entwurf einer Zahlungserinnerung)
 * löscht seinen Rückstell-Timer beim Abbau. Vorher lief der Timer weiter und setzte nach dem
 * Verlassen noch Zustand; in der Domänenregression erschien das als unbehandelter Fehler
 * „window is not defined".
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommunicationCopyButton } from './CommunicationCopyButton';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Kopier-Knopf', () => {
  it('kein Timer bleibt nach dem Abbau zurück', async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(CommunicationCopyButton, { text: 'Text', label: 'Kopieren', copiedLabel: 'Kopiert' }));
    });
    const knopf = container.querySelector('[data-testid="communication-copy"]') as HTMLButtonElement;
    await act(async () => {
      knopf.click();
      await Promise.resolve();
    });
    expect(knopf.textContent).toBe('Kopiert');
    expect(vi.getTimerCount()).toBe(1);

    act(() => root.unmount());
    container.remove();
    expect(vi.getTimerCount()).toBe(0);
  });
});
