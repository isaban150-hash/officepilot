import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentFieldFillConfirmPanel } from './components/documents/DocumentFieldFillConfirmPanel';
import { DocumentConfirmedReplyDraftPanel } from './components/documents/DocumentConfirmedReplyDraftPanel';
import {
  buildConfirmedReplyDraft,
  isConfirmedReplyDraftSupported,
} from './services/documentConfirmedReplyDraftService';
import { buildDocumentFieldFillConfirmViewModel } from './services/documentFieldFillConfirmService';
import { applyStoredOverlayToFillConfirmRows } from './services/documentFieldFillConfirmTruthBridge';
import { withInboxExtractedDocumentText } from './services/inboxDocumentText';
import * as documentAiService from './services/document/documentAiService';
import * as persistenceService from './services/persistenceService';
import * as inboxService from './services/inboxService';
import * as communicationDraftService from './services/communicationDraftService';
import * as communicationOrchestrator from './services/communicationOrchestrator';
import { createAuftragInboxItem } from './test/fixtures';
import type { DocumentFieldFillConfirmRow } from './types/documentFieldFillConfirm';
import type { InboxItem } from './types/models';
import { hydrateInboxStore } from './services/inboxService';
import { processUploadedDocument } from './services/intakeWorkflowService';
import {
  getDocumentWorkResult,
  resetDocumentWorkResultStoreForTests,
} from './services/documentWorkResultService';

const FILL_PREFIX = 'document-field-fill-confirm';
const DRAFT_PREFIX = 'document-confirmed-reply-draft';

function seedDwr(item: InboxItem): void {
  hydrateInboxStore([item]);
  processUploadedDocument(item.id);
  expect(getDocumentWorkResult(item.id)).not.toBeNull();
}

function initialRows(item: InboxItem): DocumentFieldFillConfirmRow[] {
  const dwr = getDocumentWorkResult(item.id);
  return applyStoredOverlayToFillConfirmRows(
    [...buildDocumentFieldFillConfirmViewModel(item).rows],
    dwr?.overlay ?? null,
  );
}
function itemWithText(
  text: string,
  overrides: Partial<InboxItem> = {},
): InboxItem {
  const base = createAuftragInboxItem({
    id: 'inbox-reply-draft',
    sender: 'BG BAU',
    title: 'Beitragsbescheid 2026',
    deadline: null,
    classifiedKind: 'bg_bau',
    documentType: 'behoerde',
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

function ReplyHarness({ item }: { item: InboxItem }): ReactElement {
  const [rows, setRows] = useState<DocumentFieldFillConfirmRow[]>(() => initialRows(item));
  return createElement(
    'div',
    null,
    createElement(DocumentFieldFillConfirmPanel, {
      item,
      testIdPrefix: FILL_PREFIX,
      rows,
      onRowsChange: setRows,
    }),
    isConfirmedReplyDraftSupported(item)
      ? createElement(DocumentConfirmedReplyDraftPanel, {
          item,
          rows,
          testIdPrefix: DRAFT_PREFIX,
        })
      : null,
  );
}

async function renderHarness(item: InboxItem): Promise<{
  container: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ReplyHarness, { item }));
  });
  await flushUi();
  return { container, root };
}

async function confirmAbsender(container: HTMLElement): Promise<void> {
  const button = container.querySelector(
    `[data-testid="${FILL_PREFIX}-confirm-Absender"]`,
  ) as HTMLButtonElement | null;
  if (!button) return;
  await act(async () => {
    button.click();
  });
  await flushUi();
}

afterEach(() => {
  vi.restoreAllMocks();
  resetDocumentWorkResultStoreForTests();
  document.body.innerHTML = '';
});

describe('DOCUMENT-ASSIST-CONFIRMED-REPLY-DRAFT-01 — service', () => {
  it('unterstützt Behörde, BG BAU, Mahnung, Zahlungserinnerung', () => {
    expect(
      isConfirmedReplyDraftSupported(itemWithText('x', { classifiedKind: 'bg_bau' })),
    ).toBe(true);
    expect(
      isConfirmedReplyDraftSupported(
        itemWithText('x', { classifiedKind: 'mahnung', documentType: 'brief' }),
      ),
    ).toBe(true);
    expect(
      isConfirmedReplyDraftSupported(
        itemWithText('x', {
          classifiedKind: 'zahlungserinnerung',
          documentType: 'brief',
        }),
      ),
    ).toBe(true);
    expect(
      isConfirmedReplyDraftSupported(
        itemWithText('x', { classifiedKind: 'finanzamt', documentType: 'behoerde' }),
      ),
    ).toBe(true);
    expect(
      isConfirmedReplyDraftSupported(
        itemWithText('x', { classifiedKind: 'auftrag', documentType: 'kundenauftrag' }),
      ),
    ).toBe(false);
  });

  it('ohne Kernaussage kein Entwurf', () => {
    const item = itemWithText('Absender: X');
    const rows = buildDocumentFieldFillConfirmViewModel(item).rows;
    expect(
      buildConfirmedReplyDraft({
        coreMessage: '   ',
        subject: item.title,
        sender: item.sender,
        rows,
      }),
    ).toBeNull();
  });

  it('nur bestätigte Werte; proposed/missing/rejected nicht als Fakten', () => {
    const item = itemWithText(
      ['Absender: Amt X', 'Frist: 15.08.2026', 'Betrag: 100,00 EUR'].join('\n'),
    );
    const rows = buildDocumentFieldFillConfirmViewModel(item).rows.map((row) => {
      if (row.fieldKey === 'Absender') {
        return Object.freeze({
          ...row,
          status: 'confirmed' as const,
          confirmedValue: 'Amt X',
        });
      }
      if (row.fieldKey === 'Frist') {
        return Object.freeze({
          ...row,
          status: 'rejected' as const,
          confirmedValue: undefined,
        });
      }
      return row;
    });

    const draft = buildConfirmedReplyDraft({
      coreMessage: 'Unterlagen folgen nächste Woche.',
      subject: item.title,
      sender: item.sender,
      rows,
    });
    expect(draft).not.toBeNull();
    expect(draft!.considered).toEqual([{ label: 'Absender', value: 'Amt X' }]);
    expect(draft!.considered.map((f) => f.value)).not.toContain('15.08.2026');
    expect(draft!.considered.map((f) => f.value)).not.toContain('100,00 EUR');
    expect(draft!.notIncluded).toContain('Frist');
    expect(draft!.notIncluded).toContain('Betrag');
    expect(draft!.body).toContain('Unterlagen folgen nächste Woche.');
    expect(draft!.body).toBe(
      ['Bezug: Beitragsbescheid 2026', 'Schreiben von: BG BAU', '', 'Unterlagen folgen nächste Woche.'].join(
        '\n',
      ),
    );
  });

  it('Nutzer-Kernaussage bleibt unverändert', () => {
    const item = itemWithText('x');
    const draft = buildConfirmedReplyDraft({
      coreMessage: 'Bitte um Fristverlängerung bis Ende Monat.',
      subject: null,
      sender: null,
      rows: buildDocumentFieldFillConfirmViewModel(item).rows,
    });
    expect(draft!.body).toBe('Bitte um Fristverlängerung bis Ende Monat.');
  });

  it('fehlender Betreff/Absender wird nicht erfunden', () => {
    const item = itemWithText('x', { title: '', sender: '' });
    const draft = buildConfirmedReplyDraft({
      coreMessage: 'Nur die Kernaussage.',
      subject: item.title,
      sender: item.sender,
      rows: buildDocumentFieldFillConfirmViewModel(item).rows,
    });
    expect(draft!.body).toBe('Nur die Kernaussage.');
    expect(draft!.body).not.toMatch(/Bezug:|Schreiben von:|Sehr geehrte/);
  });
});

describe('DOCUMENT-ASSIST-CONFIRMED-REPLY-DRAFT-01 — UI', () => {
  it('Entwurf entsteht erst nach Nutzeraktion und ohne Kernaussage nicht', async () => {
    const item = itemWithText('Absender: Amt Y');
    seedDwr(item);
    const { container, root } = await renderHarness(item);
    await confirmAbsender(container);

    expect(container.querySelector(`[data-testid="${DRAFT_PREFIX}-result"]`)).toBeNull();

    await act(async () => {
      (container.querySelector(`[data-testid="${DRAFT_PREFIX}-prepare"]`) as HTMLButtonElement).click();
    });
    await flushUi();
    expect(container.querySelector(`[data-testid="${DRAFT_PREFIX}-result"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="${DRAFT_PREFIX}-error"]`)).not.toBeNull();

    const core = container.querySelector(
      `[data-testid="${DRAFT_PREFIX}-core"]`,
    ) as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(core, 'Wir melden uns schriftlich.');
      core.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector(`[data-testid="${DRAFT_PREFIX}-prepare"]`) as HTMLButtonElement).click();
    });
    await flushUi();

    expect(container.querySelector(`[data-testid="${DRAFT_PREFIX}-result"]`)).not.toBeNull();
    expect(
      container.querySelector(`[data-testid="${DRAFT_PREFIX}-proposal-badge"]`)?.textContent,
    ).toContain('Vorschlag – noch nicht gespeichert oder versendet');
    expect(container.querySelector(`[data-testid="${DRAFT_PREFIX}-body"]`)?.textContent).toContain(
      'Wir melden uns schriftlich.',
    );
    expect(
      container.querySelector(`[data-testid="${DRAFT_PREFIX}-considered"]`)?.textContent,
    ).toContain('Amt Y');

    await act(async () => {
      root.unmount();
    });
  });

  it('Kopieren erfolgt nur nach Klick', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const item = itemWithText('Absender: Amt Z');
    seedDwr(item);
    const { container, root } = await renderHarness(item);
    await confirmAbsender(container);

    const core = container.querySelector(
      `[data-testid="${DRAFT_PREFIX}-core"]`,
    ) as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(core, 'Kern.');
      core.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector(`[data-testid="${DRAFT_PREFIX}-prepare"]`) as HTMLButtonElement).click();
    });
    await flushUi();
    expect(writeText).not.toHaveBeenCalled();

    await act(async () => {
      (container.querySelector(`[data-testid="${DRAFT_PREFIX}-copy"]`) as HTMLButtonElement).click();
    });
    await flushUi();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('Kern.');

    await act(async () => {
      root.unmount();
    });
  });

  it('keine AI-, Kommunikations- oder Versandfunktion wird aufgerufen', async () => {
    const askSpy = vi.spyOn(documentAiService, 'askDocumentAi');
    const patchSpy = vi.spyOn(inboxService, 'patchInboxItem');
    const draftSpy = vi.spyOn(communicationDraftService, 'buildCommunicationDraft');
    const orchSpy = vi.spyOn(communicationOrchestrator, 'processCommunicationRequest');

    const item = itemWithText('Absender: No Side Effects');
    seedDwr(item);
    const { container, root } = await renderHarness(item);
    await confirmAbsender(container);
    const core = container.querySelector(
      `[data-testid="${DRAFT_PREFIX}-core"]`,
    ) as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(core, 'Ohne Side Effects.');
      core.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector(`[data-testid="${DRAFT_PREFIX}-prepare"]`) as HTMLButtonElement).click();
    });
    await flushUi();

    expect(askSpy).not.toHaveBeenCalled();
    expect(patchSpy).not.toHaveBeenCalled();
    expect(draftSpy).not.toHaveBeenCalled();
    expect(orchSpy).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/Versenden|Speichern im Kommunikations/);

    await act(async () => {
      root.unmount();
    });
  });

  it('Remount verwirft Entwurf', async () => {
    const item = itemWithText('Absender: Session');
    seedDwr(item);
    const first = await renderHarness(item);
    await confirmAbsender(first.container);
    const core = first.container.querySelector(
      `[data-testid="${DRAFT_PREFIX}-core"]`,
    ) as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(core, 'Temporär.');
      core.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (
        first.container.querySelector(
          `[data-testid="${DRAFT_PREFIX}-prepare"]`,
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(first.container.querySelector(`[data-testid="${DRAFT_PREFIX}-result"]`)).not.toBeNull();
    await act(async () => {
      first.root.unmount();
    });
    first.container.remove();

    const second = await renderHarness(item);
    expect(second.container.querySelector(`[data-testid="${DRAFT_PREFIX}-result"]`)).toBeNull();
    expect(
      (second.container.querySelector(`[data-testid="${DRAFT_PREFIX}-core"]`) as HTMLTextAreaElement)
        .value,
    ).toBe('');
    await act(async () => {
      second.root.unmount();
    });
  });

  it('nicht unterstützte Dokumentarten bleiben unverändert', async () => {
    const item = itemWithText('Absender: Firma', {
      classifiedKind: 'auftrag',
      documentType: 'kundenauftrag',
      title: 'Auftrag',
      sender: 'Kunde',
    });
    const { container, root } = await renderHarness(item);
    expect(container.querySelector(`[data-testid="${DRAFT_PREFIX}-panel"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="${FILL_PREFIX}-panel"]`)).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});
