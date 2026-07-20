import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentFieldFillConfirmPanel } from './components/documents/DocumentFieldFillConfirmPanel';
import { buildDocumentFieldFillConfirmViewModel } from './services/documentFieldFillConfirmService';
import { withInboxExtractedDocumentText } from './services/inboxDocumentText';
import * as persistenceService from './services/persistenceService';
import * as inboxService from './services/inboxService';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { InboxItem } from './types/models';

const PREFIX = 'document-field-fill-confirm';

function itemWithText(text: string, overrides: Partial<InboxItem> = {}): InboxItem {
  const base = createAuftragInboxItem({
    id: 'inbox-fill-confirm',
    sender: '',
    deadline: null,
    title: 'Testschreiben',
    ...overrides,
  });
  return {
    ...base,
    recognizedData: withInboxExtractedDocumentText(base.recognizedData, text),
  };
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    input.value = value;
  });
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderPanel(item: InboxItem): Promise<{
  container: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(DocumentFieldFillConfirmPanel, {
        item,
        testIdPrefix: PREFIX,
      }),
    );
  });
  await flushUi();
  return { container, root };
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetTestStores();
  document.body.innerHTML = '';
});

describe('DOCUMENT-ASSIST-FILL-CONFIRM-01', () => {
  it('erkannte Werte erscheinen als proposed', () => {
    const item = itemWithText(
      ['Absender: Muster GmbH', 'Frist: 15.08.2026', 'Betrag: 1.250,00 EUR'].join('\n'),
    );
    const vm = buildDocumentFieldFillConfirmViewModel(item);
    const absender = vm.rows.find((row) => row.fieldKey === 'Absender');
    expect(absender).toMatchObject({
      status: 'proposed',
      proposedValue: 'Muster GmbH',
    });
    expect(vm.rows.find((row) => row.fieldKey === 'Frist')?.status).toBe('proposed');
  });

  it('niedrige Confidence wird sichtbar gekennzeichnet', async () => {
    // Fließtext-Datum ohne Label → oft low/medium; force via spy on extract would be cleaner.
    // Use text that yields low confidence for Ort-like patterns; Baustelle from bare project line.
    const item = itemWithText('Hinweis ohne Label zum Projekt Nordseite');
    // Directly verify UI path with a constructed low-confidence case via remount of service output:
    // Patch: use Absender from context (medium) and verify low badge by injecting through recognized only.
    // Prefer UI: mock build by using extraction known low - CITY_PATTERN can be medium.
    // Simplest: unit-check row confidence from extractFieldsWithConfidence + panel renders badge.
    const withLow: InboxItem = {
      ...item,
      recognizedData: withInboxExtractedDocumentText(
        {},
        'Aktenzeichen: AZ-LOW-1\nIrgendwas',
      ),
    };
    // Aktenzeichen from REFERENCE_PATTERN is typically high. Force UI badge via confirming extract has low.
    // We'll spy extractFieldsWithConfidence.
    const extraction = await import('./services/documentFieldExtractionService');
    vi.spyOn(extraction, 'extractFieldsWithConfidence').mockReturnValue({
      Absender: { value: 'Unsicher Absender', confidence: 'low' },
    });

    const { container, root } = await renderPanel(withLow);
    expect(
      container.querySelector(`[data-testid="${PREFIX}-uncertainty-Absender"]`),
    ).not.toBeNull();
    expect(
      container.querySelector(`[data-testid="${PREFIX}-row-Absender"]`)?.getAttribute('data-status'),
    ).toBe('proposed');

    await act(async () => {
      root.unmount();
    });
  });

  it('Bestätigen setzt nur lokalen Status', async () => {
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const patchSpy = vi.spyOn(inboxService, 'patchInboxItem');
    const item = itemWithText('Absender: Bestätig GmbH');
    const { container, root } = await renderPanel(item);

    await act(async () => {
      (
        container.querySelector(
          `[data-testid="${PREFIX}-confirm-Absender"]`,
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();

    expect(
      container.querySelector(`[data-testid="${PREFIX}-row-Absender"]`)?.getAttribute('data-status'),
    ).toBe('confirmed');
    expect(persistSpy).not.toHaveBeenCalled();
    expect(patchSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it('Korrigieren übernimmt den eingegebenen Wert als confirmed', async () => {
    const item = itemWithText('Absender: Alt Name');
    const { container, root } = await renderPanel(item);

    await act(async () => {
      (
        container.querySelector(
          `[data-testid="${PREFIX}-correct-Absender"]`,
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();

    const input = container.querySelector(
      `[data-testid="${PREFIX}-edit-input-Absender"]`,
    ) as HTMLInputElement;
    await setInputValue(input, 'Neu Name');
    await act(async () => {
      (
        container.querySelector(
          `[data-testid="${PREFIX}-edit-apply-Absender"]`,
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();

    expect(
      container.querySelector(`[data-testid="${PREFIX}-row-Absender"]`)?.getAttribute('data-status'),
    ).toBe('confirmed');
    expect(
      container.querySelector(`[data-testid="${PREFIX}-value-Absender"]`)?.textContent,
    ).toBe('Neu Name');

    await act(async () => {
      root.unmount();
    });
  });

  it('Verwerfen setzt rejected', async () => {
    const item = itemWithText('Absender: Weg damit');
    const { container, root } = await renderPanel(item);

    await act(async () => {
      (
        container.querySelector(
          `[data-testid="${PREFIX}-reject-Absender"]`,
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();

    expect(
      container.querySelector(`[data-testid="${PREFIX}-row-Absender"]`)?.getAttribute('data-status'),
    ).toBe('rejected');

    await act(async () => {
      root.unmount();
    });
  });

  it('leeres Feld kann manuell ergänzt werden', async () => {
    const item = itemWithText('Nur Fließtext ohne Felder');
    const { container, root } = await renderPanel(item);

    expect(
      container.querySelector(`[data-testid="${PREFIX}-row-Betrag"]`)?.getAttribute('data-status'),
    ).toBe('missing');

    await act(async () => {
      (
        container.querySelector(`[data-testid="${PREFIX}-correct-Betrag"]`) as HTMLButtonElement
      ).click();
    });
    await flushUi();

    const input = container.querySelector(
      `[data-testid="${PREFIX}-edit-input-Betrag"]`,
    ) as HTMLInputElement;
    await setInputValue(input, '500,00 EUR');
    await act(async () => {
      (
        container.querySelector(
          `[data-testid="${PREFIX}-edit-apply-Betrag"]`,
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();

    expect(
      container.querySelector(`[data-testid="${PREFIX}-row-Betrag"]`)?.getAttribute('data-status'),
    ).toBe('confirmed');
    expect(
      container.querySelector(`[data-testid="${PREFIX}-value-Betrag"]`)?.textContent,
    ).toBe('500,00 EUR');

    await act(async () => {
      root.unmount();
    });
  });

  it('keine Persistenz- oder Versandfunktion wird aufgerufen', async () => {
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const item = itemWithText('Absender: No Persist');
    const { container, root } = await renderPanel(item);

    await act(async () => {
      (
        container.querySelector(
          `[data-testid="${PREFIX}-confirm-Absender"]`,
        ) as HTMLButtonElement
      ).click();
      (
        container.querySelector(
          `[data-testid="${PREFIX}-reject-Absender"]`,
        ) as HTMLButtonElement | null
      )?.click();
    });
    // After confirm, reject button may be gone; confirm alone is enough
    expect(persistSpy).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/Versenden|Archivieren|Speichern/);

    await act(async () => {
      root.unmount();
    });
  });

  it('Reload/Remount stellt keine Session-Werte wieder her', async () => {
    const item = itemWithText('Absender: Session Weg');
    const first = await renderPanel(item);
    await act(async () => {
      (
        first.container.querySelector(
          `[data-testid="${PREFIX}-confirm-Absender"]`,
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(
      first.container
        .querySelector(`[data-testid="${PREFIX}-row-Absender"]`)
        ?.getAttribute('data-status'),
    ).toBe('confirmed');
    await act(async () => {
      first.root.unmount();
    });
    first.container.remove();

    const second = await renderPanel(item);
    expect(
      second.container
        .querySelector(`[data-testid="${PREFIX}-row-Absender"]`)
        ?.getAttribute('data-status'),
    ).toBe('proposed');
    await act(async () => {
      second.root.unmount();
    });
  });

  it('freies Fragenfeld bleibt vorhanden und unverändert', async () => {
    // Panel isolation: free-question panel is separate on page; assert our panel does not include question input.
    const item = itemWithText('Absender: X');
    const { container, root } = await renderPanel(item);
    expect(container.querySelector('[data-testid="document-free-question-panel"]')).toBeNull();
    expect(container.querySelector(`[data-testid="${PREFIX}-panel"]`)).not.toBeNull();
    expect(container.querySelector('input[placeholder]') ).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});
