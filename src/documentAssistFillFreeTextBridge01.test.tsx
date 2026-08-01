import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentFieldFillConfirmPanel } from './components/documents/DocumentFieldFillConfirmPanel';
import { DocumentFreeQuestionPanel } from './components/documents/DocumentFreeQuestionPanel';
import {
  applyFreeTextBridgeProposalToRows,
  parseFreeTextFieldBridge,
} from './services/documentFieldFillFreeTextBridgeService';
import { buildDocumentFieldFillConfirmViewModel } from './services/documentFieldFillConfirmService';
import { withInboxExtractedDocumentText } from './services/inboxDocumentText';
import * as documentAiService from './services/document/documentAiService';
import * as persistenceService from './services/persistenceService';
import * as inboxService from './services/inboxService';
import { setAiGenerateTextForTests } from './services/ai/aiRequestRunner';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { createAuftragInboxItem } from './test/fixtures';
import type { DocumentFieldFillFreeTextBridgeProposal } from './types/documentFieldFillFreeTextBridge';
import type { InboxItem } from './types/models';
import { hydrateInboxStore } from './services/inboxService';
import { processUploadedDocument } from './services/intakeWorkflowService';
import {
  getDocumentWorkResult,
  resetDocumentWorkResultStoreForTests,
} from './services/documentWorkResultService';

const FILL_PREFIX = 'document-field-fill-confirm';
const ASK_PREFIX = 'document-free-question';

function seedDwr(item: InboxItem): void {
  hydrateInboxStore([item]);
  processUploadedDocument(item.id);
  expect(getDocumentWorkResult(item.id)).not.toBeNull();
}

function itemWithText(text: string, overrides: Partial<InboxItem> = {}): InboxItem {
  const base = createAuftragInboxItem({
    id: 'inbox-freetext-bridge',
    sender: '',
    deadline: null,
    title: 'Bridge-Test',
    ...overrides,
  });
  return {
    ...base,
    recognizedData: withInboxExtractedDocumentText(base.recognizedData, text),
  };
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function BridgeHarness({ item }: { item: InboxItem }): ReactElement {
  const [proposal, setProposal] = useState<DocumentFieldFillFreeTextBridgeProposal | null>(null);
  const seqRef = useRef(0);
  return createElement(
    AppProvider,
    { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
    createElement(
      'div',
      null,
      createElement(DocumentFreeQuestionPanel, {
        source: { type: 'inbox', item },
        testIdPrefix: ASK_PREFIX,
        onFieldStatementProposal: (statement) => {
          seqRef.current += 1;
          setProposal({
            id: seqRef.current,
            fieldKey: statement.fieldKey,
            value: statement.value,
          });
        },
      }),
      createElement(DocumentFieldFillConfirmPanel, {
        item,
        testIdPrefix: FILL_PREFIX,
        freeTextBridgeProposal: proposal,
      }),
    ),
  );
}

async function renderBridge(item: InboxItem): Promise<{
  container: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(BridgeHarness, { item }));
  });
  await flushUi();
  return { container, root };
}

async function submitFreeText(container: HTMLElement, text: string): Promise<void> {
  const input = container.querySelector(
    `[data-testid="${ASK_PREFIX}-input"]`,
  ) as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    (container.querySelector(`[data-testid="${ASK_PREFIX}-ask"]`) as HTMLButtonElement).click();
  });
  await flushUi();
}

afterEach(async () => {
  vi.restoreAllMocks();
  setAiGenerateTextForTests(null);
  resetDocumentWorkResultStoreForTests();
  document.body.innerHTML = '';
});

describe('DOCUMENT-ASSIST-FILL-FREETEXT-BRIDGE-01 — parser', () => {
  it('ordnet eindeutige Rechnungsnummer zu', () => {
    expect(parseFreeTextFieldBridge('Die Rechnungsnummer ist 4711')).toEqual({
      kind: 'field_statement',
      fieldKey: 'Rechnungsnummer',
      value: '4711',
    });
  });

  it('ordnet Betrag, Frist, Datum und Absender zu', () => {
    expect(parseFreeTextFieldBridge('Der Betrag beträgt 250 Euro')).toMatchObject({
      kind: 'field_statement',
      fieldKey: 'Betrag',
      value: expect.stringMatching(/250/),
    });
    expect(parseFreeTextFieldBridge('Die Frist ist der 15.08.2026')).toEqual({
      kind: 'field_statement',
      fieldKey: 'Frist',
      value: '15.08.2026',
    });
    expect(parseFreeTextFieldBridge('Das Datum ist der 01.03.2026')).toEqual({
      kind: 'field_statement',
      fieldKey: 'Datum',
      value: '01.03.2026',
    });
    expect(parseFreeTextFieldBridge('Der Absender ist Muster GmbH')).toEqual({
      kind: 'field_statement',
      fieldKey: 'Absender',
      value: 'Muster GmbH',
    });
  });

  it('blockiert Fragezeichen und Fragewörter', () => {
    expect(parseFreeTextFieldBridge('Die Rechnungsnummer ist 4711?')).toEqual({
      kind: 'question',
    });
    expect(parseFreeTextFieldBridge('Wie hoch ist der Betrag?')).toEqual({ kind: 'question' });
    expect(parseFreeTextFieldBridge('Wann ist die Frist?')).toEqual({ kind: 'question' });
  });

  it('übernimmt mehrdeutige Eingaben nicht', () => {
    expect(
      parseFreeTextFieldBridge(
        'Die Rechnungsnummer ist 4711 und der Betrag beträgt 250 Euro',
      ),
    ).toEqual({ kind: 'ambiguous' });
  });

  it('überschreibt bestätigte Werte nicht', () => {
    const item = itemWithText('Absender: Alt GmbH');
    const rows = buildDocumentFieldFillConfirmViewModel(item).rows.map((row) =>
      row.fieldKey === 'Absender'
        ? Object.freeze({
            ...row,
            status: 'confirmed' as const,
            confirmedValue: 'Alt GmbH',
          })
        : row,
    );
    const next = applyFreeTextBridgeProposalToRows(rows, {
      id: 1,
      fieldKey: 'Absender',
      value: 'Neu GmbH',
    });
    const absender = next.find((row) => row.fieldKey === 'Absender');
    expect(absender?.status).toBe('confirmed');
    expect(absender?.confirmedValue).toBe('Alt GmbH');
    expect(absender?.proposedValue).toBe('Alt GmbH');
  });
});

describe('DOCUMENT-ASSIST-FILL-FREETEXT-BRIDGE-01 — UI bridge', () => {
  it('eindeutige Rechnungsnummer wird proposed und bleibt unbestätigt', async () => {
    const askSpy = vi.spyOn(documentAiService, 'askDocumentAi');
    const item = itemWithText('Nur Fließtext ohne Felder');
    const { container, root } = await renderBridge(item);

    await submitFreeText(container, 'Die Rechnungsnummer ist 4711');

    const row = container.querySelector(`[data-testid="${FILL_PREFIX}-row-Rechnungsnummer"]`);
    expect(row?.getAttribute('data-status')).toBe('proposed');
    expect(
      container.querySelector(`[data-testid="${FILL_PREFIX}-value-Rechnungsnummer"]`)?.textContent,
    ).toBe('4711');
    expect(
      container.querySelector(`[data-testid="${FILL_PREFIX}-bridge-hint-Rechnungsnummer"]`)
        ?.textContent,
    ).toContain('Aus deiner Eingabe vorgeschlagen');
    expect(
      container.querySelector(`[data-testid="${FILL_PREFIX}-confirmed-badge-Rechnungsnummer"]`),
    ).toBeNull();
    expect(askSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it('Betrag, Frist, Datum und Absender werden korrekt zugeordnet', async () => {
    const cases: Array<{ text: string; key: string; valuePart: string }> = [
      { text: 'Der Betrag beträgt 250 Euro', key: 'Betrag', valuePart: '250' },
      { text: 'Die Frist ist der 15.08.2026', key: 'Frist', valuePart: '15.08.2026' },
      { text: 'Das Datum ist der 01.03.2026', key: 'Datum', valuePart: '01.03.2026' },
      { text: 'Der Absender ist Muster GmbH', key: 'Absender', valuePart: 'Muster GmbH' },
    ];

    for (const testCase of cases) {
      document.body.innerHTML = '';
      const item = itemWithText('Ohne Felder');
      const { container, root } = await renderBridge(item);
      await submitFreeText(container, testCase.text);
      expect(
        container.querySelector(`[data-testid="${FILL_PREFIX}-row-${testCase.key}"]`)?.getAttribute(
          'data-status',
        ),
      ).toBe('proposed');
      expect(
        container.querySelector(`[data-testid="${FILL_PREFIX}-value-${testCase.key}"]`)
          ?.textContent,
      ).toContain(testCase.valuePart);
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('bestehender bestätigter Wert wird nicht überschrieben', async () => {
    const item = itemWithText('Absender: Alt GmbH');
    seedDwr(item);
    const { container, root } = await renderBridge(item);

    await act(async () => {
      (
        container.querySelector(
          `[data-testid="${FILL_PREFIX}-confirm-Absender"]`,
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(
      container.querySelector(`[data-testid="${FILL_PREFIX}-row-Absender"]`)?.getAttribute(
        'data-status',
      ),
    ).toBe('confirmed');

    await submitFreeText(container, 'Der Absender ist Neu GmbH');

    expect(
      container.querySelector(`[data-testid="${FILL_PREFIX}-row-Absender"]`)?.getAttribute(
        'data-status',
      ),
    ).toBe('confirmed');
    expect(
      container.querySelector(`[data-testid="${FILL_PREFIX}-value-Absender"]`)?.textContent,
    ).toBe('Alt GmbH');
    expect(
      container.querySelector(`[data-testid="${FILL_PREFIX}-bridge-hint-Absender"]`),
    ).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('normale Fragen verändern keine Felder und nutzen weiter den AI-Pfad', async () => {
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    const generate = vi.fn().mockResolvedValue({
      success: true,
      text: 'Im Dokument ist keine Frist klar erkennbar.',
    });
    setAiGenerateTextForTests(generate);
    const askSpy = vi.spyOn(documentAiService, 'askDocumentAi');

    const item = itemWithText('Absender: Bleibt GmbH\nFrist: 10.10.2026');
    const { container, root } = await renderBridge(item);

    const before = container.querySelector(
      `[data-testid="${FILL_PREFIX}-value-Frist"]`,
    )?.textContent;

    await submitFreeText(container, 'Wann ist die Frist?');

    expect(askSpy).toHaveBeenCalled();
    expect(
      container.querySelector(`[data-testid="${FILL_PREFIX}-value-Frist"]`)?.textContent,
    ).toBe(before);
    expect(
      container.querySelector(`[data-testid="${FILL_PREFIX}-bridge-hint-Frist"]`),
    ).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('mehrdeutige Eingabe wird nicht übernommen', async () => {
    const askSpy = vi.spyOn(documentAiService, 'askDocumentAi').mockResolvedValue({
      text: 'Antwort',
      source: 'ai',
      disclaimer: 'Hinweis',
      uncertain: false,
    });
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({ success: true, text: 'Antwort' }),
    );

    const item = itemWithText('Ohne Felder');
    const { container, root } = await renderBridge(item);

    await submitFreeText(
      container,
      'Die Rechnungsnummer ist 4711 und der Betrag beträgt 250 Euro',
    );

    expect(
      container.querySelector(`[data-testid="${FILL_PREFIX}-row-Rechnungsnummer"]`)?.getAttribute(
        'data-status',
      ),
    ).toBe('missing');
    expect(
      container.querySelector(`[data-testid="${FILL_PREFIX}-row-Betrag"]`)?.getAttribute(
        'data-status',
      ),
    ).toBe('missing');
    expect(askSpy).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it('eindeutige Feldangabe verursacht keinen AI-Aufruf', async () => {
    const askSpy = vi.spyOn(documentAiService, 'askDocumentAi');
    const item = itemWithText('x');
    const { container, root } = await renderBridge(item);
    await submitFreeText(container, 'Die Frist ist der 15.08.2026');
    expect(askSpy).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it('Remount verwirft den Vorschlag', async () => {
    const item = itemWithText('Ohne');
    const first = await renderBridge(item);
    await submitFreeText(first.container, 'Die Rechnungsnummer ist 4711');
    expect(
      first.container
        .querySelector(`[data-testid="${FILL_PREFIX}-row-Rechnungsnummer"]`)
        ?.getAttribute('data-status'),
    ).toBe('proposed');
    await act(async () => {
      first.root.unmount();
    });
    first.container.remove();

    const second = await renderBridge(item);
    expect(
      second.container
        .querySelector(`[data-testid="${FILL_PREFIX}-row-Rechnungsnummer"]`)
        ?.getAttribute('data-status'),
    ).toBe('missing');
    expect(
      second.container.querySelector(
        `[data-testid="${FILL_PREFIX}-bridge-hint-Rechnungsnummer"]`,
      ),
    ).toBeNull();
    await act(async () => {
      second.root.unmount();
    });
  });

  it('Bridge-Vorschlag ohne Bestätigen löst keine Persistenz aus', async () => {
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const patchSpy = vi.spyOn(inboxService, 'patchInboxItem');
    const item = itemWithText('x');
    const { container, root } = await renderBridge(item);
    await submitFreeText(container, 'Der Absender ist No Persist GmbH');
    expect(persistSpy).not.toHaveBeenCalled();
    expect(patchSpy).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/Versenden|Archivieren/);
    await act(async () => {
      root.unmount();
    });
  });
});
