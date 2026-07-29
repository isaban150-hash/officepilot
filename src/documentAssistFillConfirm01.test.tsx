import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentFieldFillConfirmPanel } from './components/documents/DocumentFieldFillConfirmPanel';
import { buildDocumentFieldFillConfirmViewModel } from './services/documentFieldFillConfirmService';
import {
  getDocumentWorkResult,
  resetDocumentWorkResultStoreForTests,
} from './services/documentWorkResultService';
import { withInboxExtractedDocumentText } from './services/inboxDocumentText';
import { hydrateInboxStore } from './services/inboxService';
import { processUploadedDocument } from './services/intakeWorkflowService';
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

function seedDwr(item: InboxItem): void {
  hydrateInboxStore([item]);
  processUploadedDocument(item.id);
  expect(getDocumentWorkResult(item.id)).not.toBeNull();
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
  resetDocumentWorkResultStoreForTests();
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
    const item = itemWithText('Hinweis ohne Label zum Projekt Nordseite');
    const withLow: InboxItem = {
      ...item,
      recognizedData: withInboxExtractedDocumentText({}, 'Aktenzeichen: AZ-LOW-1\nIrgendwas'),
    };
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

  it('Bestätigen setzt Status und schreibt lokal ins DWR-Overlay', async () => {
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const patchSpy = vi.spyOn(inboxService, 'patchInboxItem');
    const item = itemWithText('Absender: Bestätig GmbH');
    seedDwr(item);
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
    expect(persistSpy).toHaveBeenCalled();
    expect(patchSpy).not.toHaveBeenCalled();
    expect(
      getDocumentWorkResult(item.id)?.overlay.find((e) => e.slotId === 'facts.parties.counterparty'),
    ).toMatchObject({ status: 'user_confirmed', value: 'Bestätig GmbH' });

    await act(async () => {
      root.unmount();
    });
  });

  it('Korrigieren übernimmt den eingegebenen Wert als confirmed', async () => {
    const item = itemWithText('Absender: Alt Name');
    seedDwr(item);
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
    expect(
      getDocumentWorkResult(item.id)?.overlay.find((e) => e.slotId === 'facts.parties.counterparty'),
    ).toMatchObject({ status: 'user_corrected', value: 'Neu Name' });

    await act(async () => {
      root.unmount();
    });
  });

  it('Verwerfen setzt rejected', async () => {
    const item = itemWithText('Absender: Weg damit');
    seedDwr(item);
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
    expect(
      getDocumentWorkResult(item.id)?.overlay.find((e) => e.slotId === 'facts.parties.counterparty')
        ?.status,
    ).toBe('discarded');

    await act(async () => {
      root.unmount();
    });
  });

  it('leeres Feld kann manuell ergänzt werden', async () => {
    const item = itemWithText('Nur Fließtext ohne Felder');
    seedDwr(item);
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

  it('keine Archiv- oder Versandfunktion wird ausgelöst', async () => {
    const item = itemWithText('Absender: No Persist');
    seedDwr(item);
    const { container, root } = await renderPanel(item);

    await act(async () => {
      (
        container.querySelector(
          `[data-testid="${PREFIX}-confirm-Absender"]`,
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(container.textContent).not.toMatch(/Versenden|Archivieren/);
    expect(container.textContent).toMatch(/lokal auf diesem Gerät/i);

    await act(async () => {
      root.unmount();
    });
  });

  it('Remount stellt bestätigte Werte aus DWR-Overlay wieder her', async () => {
    const item = itemWithText('Absender: Session Weg');
    seedDwr(item);
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
    ).toBe('confirmed');
    await act(async () => {
      second.root.unmount();
    });
  });

  it('freies Fragenfeld bleibt vorhanden und unverändert', async () => {
    const item = itemWithText('Absender: X');
    const { container, root } = await renderPanel(item);
    expect(container.querySelector('[data-testid="document-free-question-panel"]')).toBeNull();
    expect(container.querySelector(`[data-testid="${PREFIX}-panel"]`)).not.toBeNull();
    expect(container.querySelector('input[placeholder]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});
