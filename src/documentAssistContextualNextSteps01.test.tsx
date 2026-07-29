import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentContextualNextStepsPanel } from './components/documents/DocumentContextualNextStepsPanel';
import { DocumentConfirmedReplyDraftPanel } from './components/documents/DocumentConfirmedReplyDraftPanel';
import { DocumentFieldFillConfirmPanel } from './components/documents/DocumentFieldFillConfirmPanel';
import {
  buildDocumentContextualNextSteps,
  contextualNextStepsTextLooksUnsafe,
} from './services/documentContextualNextStepsService';
import { buildDocumentFieldFillConfirmViewModel } from './services/documentFieldFillConfirmService';
import { applyStoredOverlayToFillConfirmRows } from './services/documentFieldFillConfirmTruthBridge';
import { isConfirmedReplyDraftSupported } from './services/documentConfirmedReplyDraftService';
import { withInboxExtractedDocumentText } from './services/inboxDocumentText';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { DocumentFieldFillConfirmRow } from './types/documentFieldFillConfirm';
import type { InboxItem } from './types/models';
import * as documentAiService from './services/document/documentAiService';
import { hydrateInboxStore } from './services/inboxService';
import { processUploadedDocument } from './services/intakeWorkflowService';
import {
  getDocumentWorkResult,
  resetDocumentWorkResultStoreForTests,
} from './services/documentWorkResultService';

const NEXT_PREFIX = 'document-contextual-next-steps';
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
function itemWithText(text: string, overrides: Partial<InboxItem> = {}): InboxItem {
  const base = createAuftragInboxItem({
    id: 'inbox-contextual-next',
    sender: 'BG BAU',
    title: 'Beitragsbescheid',
    classifiedKind: 'bg_bau',
    documentType: 'behoerde',
    ...overrides,
  });
  return {
    ...base,
    recognizedData: withInboxExtractedDocumentText(base.recognizedData, text),
  };
}

function confirmRows(
  item: InboxItem,
  confirmedKeys: Partial<Record<string, string>>,
): DocumentFieldFillConfirmRow[] {
  return buildDocumentFieldFillConfirmViewModel(item).rows.map((row) => {
    const value = confirmedKeys[row.fieldKey];
    if (value === undefined) return row;
    return Object.freeze({
      ...row,
      status: 'confirmed' as const,
      confirmedValue: value,
      proposedValue: value,
    });
  });
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function NextStepsHarness({ item }: { item: InboxItem }): ReactElement {
  const [rows, setRows] = useState<DocumentFieldFillConfirmRow[]>(() => initialRows(item));
  const [coreMessage, setCoreMessage] = useState('');
  const [hasDraft, setHasDraft] = useState(false);
  return createElement(
    'div',
    { 'data-testid': 'next-steps-harness' },
    createElement(DocumentFieldFillConfirmPanel, {
      item,
      testIdPrefix: FILL_PREFIX,
      rows,
      onRowsChange: setRows,
    }),
    createElement(DocumentContextualNextStepsPanel, {
      rows,
      coreMessage,
      hasReplyDraft: hasDraft,
      testIdPrefix: NEXT_PREFIX,
    }),
    createElement(DocumentConfirmedReplyDraftPanel, {
      item,
      rows,
      testIdPrefix: DRAFT_PREFIX,
      onCoreMessageChange: setCoreMessage,
      onReplyDraftPresenceChange: setHasDraft,
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  resetDocumentWorkResultStoreForTests();
  resetTestStores();
  document.body.innerHTML = '';
});

describe('DOCUMENT-ASSIST-CONTEXTUAL-NEXT-STEPS-01 — service', () => {
  it('nur bestätigte Werte erscheinen als berücksichtigte Fakten', () => {
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
          status: 'proposed' as const,
          proposedValue: '15.08.2026',
        });
      }
      if (row.fieldKey === 'Betrag') {
        return Object.freeze({
          ...row,
          status: 'rejected' as const,
          confirmedValue: undefined,
        });
      }
      return row;
    });

    const model = buildDocumentContextualNextSteps({
      rows,
      coreMessage: '',
      hasReplyDraft: false,
    });
    expect(model.consideredFacts).toEqual([{ label: 'Absender', value: 'Amt X' }]);
    expect(model.consideredFacts.map((f) => f.value)).not.toContain('15.08.2026');
    expect(model.consideredFacts.map((f) => f.value)).not.toContain('100,00 EUR');
    expect(model.missingOrUnconfirmed).toContain('Frist');
    expect(model.missingOrUnconfirmed).toContain('Betrag');
  });

  it('bestätigte Frist oder Betrag wird neutral formuliert; unbestätigte nicht als Vorgabe', () => {
    const item = itemWithText('Frist: 01.09.2026\nBetrag: 250,00 EUR');
    const withConfirmed = confirmRows(item, {
      Frist: '01.09.2026',
      Betrag: '250,00 EUR',
    });
    const confirmedModel = buildDocumentContextualNextSteps({
      rows: withConfirmed,
      coreMessage: '',
      hasReplyDraft: false,
    });
    const joined = confirmedModel.suggestions.join('\n');
    expect(joined).toContain('Frist: 01.09.2026');
    expect(joined).toContain('Betrag: 250,00 EUR');
    expect(joined).toMatch(/im Entwurf berücksichtigen/);
    expect(contextualNextStepsTextLooksUnsafe(joined)).toBe(false);

    const proposedOnly = buildDocumentFieldFillConfirmViewModel(item).rows;
    const proposedModel = buildDocumentContextualNextSteps({
      rows: proposedOnly,
      coreMessage: '',
      hasReplyDraft: false,
    });
    const proposedText = [
      ...proposedModel.suggestions,
      ...proposedModel.consideredFacts.map((f) => `${f.label}: ${f.value}`),
    ].join('\n');
    expect(proposedText).not.toMatch(/Zahlen|Widersprechen|Sie müssen|01\.09\.2026/);
    expect(proposedModel.consideredFacts).toEqual([]);
  });

  it('ohne Nutzerziel keine Antwortabsicht; mit Kernaussage Entwurf vorbereiten', () => {
    const item = itemWithText('Absender: X');
    const rows = confirmRows(item, { Absender: 'X' });
    const withoutGoal = buildDocumentContextualNextSteps({
      rows,
      coreMessage: '',
      hasReplyDraft: false,
    });
    expect(withoutGoal.suggestions.join('\n')).not.toContain('Antwortentwurf vorbereiten');
    expect(withoutGoal.suggestions.join('\n')).not.toContain('Kommunikationsbereich');

    const withGoal = buildDocumentContextualNextSteps({
      rows,
      coreMessage: 'Unterlagen folgen nächste Woche.',
      hasReplyDraft: false,
    });
    expect(withGoal.suggestions).toContain('Antwortentwurf vorbereiten.');
  });

  it('mit vorhandenem Entwurf wird Kommunikationsprüfung vorgeschlagen', () => {
    const item = itemWithText('x');
    const model = buildDocumentContextualNextSteps({
      rows: buildDocumentFieldFillConfirmViewModel(item).rows,
      coreMessage: 'Kern.',
      hasReplyDraft: true,
    });
    expect(model.suggestions).toContain('Im Kommunikationsbereich prüfen.');
  });

  it('keine Pflicht-, Rechtsfolge- oder Zahlungsbehauptung', () => {
    const item = itemWithText('Frist: 15.08.2026\nBetrag: 99,00 EUR');
    const model = buildDocumentContextualNextSteps({
      rows: confirmRows(item, { Frist: '15.08.2026', Betrag: '99,00 EUR' }),
      coreMessage: 'Bitte prüfen.',
      hasReplyDraft: true,
    });
    const all = [
      ...model.suggestions,
      ...model.missingOrUnconfirmed,
      ...model.consideredFacts.map((f) => `${f.label}: ${f.value}`),
    ].join('\n');
    expect(contextualNextStepsTextLooksUnsafe(all)).toBe(false);
    expect(all).not.toMatch(/Sie müssen|Rechtsfolge|zahlen bis|Widersprechen bis/i);
  });
});

describe('DOCUMENT-ASSIST-CONTEXTUAL-NEXT-STEPS-01 — UI', () => {
  it('zeigt fehlende Angaben und bestätigt nur confirmed Fakten; Reply-Callbacks wirken', async () => {
    const askSpy = vi.spyOn(documentAiService, 'askDocumentAi');
    const item = itemWithText('Absender: Amt Y\nFrist: 20.08.2026');
    seedDwr(item);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(NextStepsHarness, { item }));
    });
    await flushUi();

    expect(container.querySelector(`[data-testid="${NEXT_PREFIX}-panel"]`)).not.toBeNull();
    expect(
      container.querySelector(`[data-testid="${NEXT_PREFIX}-missing"]`)?.textContent,
    ).toContain('Frist');
    expect(
      container.querySelector(`[data-testid="${NEXT_PREFIX}-considered"]`)?.textContent,
    ).toContain('Noch keine bestätigten Angaben');

    await act(async () => {
      (
        container.querySelector(
          `[data-testid="${FILL_PREFIX}-confirm-Absender"]`,
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(
      container.querySelector(`[data-testid="${NEXT_PREFIX}-considered"]`)?.textContent,
    ).toContain('Amt Y');
    expect(
      container.querySelector(`[data-testid="${NEXT_PREFIX}-suggestions"]`)?.textContent,
    ).not.toContain('Antwortentwurf vorbereiten');

    const core = container.querySelector(
      `[data-testid="${DRAFT_PREFIX}-core"]`,
    ) as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(core, 'Unterlagen folgen.');
      core.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushUi();
    expect(
      container.querySelector(`[data-testid="${NEXT_PREFIX}-suggestions"]`)?.textContent,
    ).toContain('Antwortentwurf vorbereiten');

    await act(async () => {
      (container.querySelector(`[data-testid="${DRAFT_PREFIX}-prepare"]`) as HTMLButtonElement).click();
    });
    await flushUi();
    expect(
      container.querySelector(`[data-testid="${NEXT_PREFIX}-suggestions"]`)?.textContent,
    ).toContain('Im Kommunikationsbereich prüfen');

    expect(askSpy).not.toHaveBeenCalled();
    expect(container.querySelector(`[data-testid="${NEXT_PREFIX}-panel"] button`)).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('andere Dokumentarten bleiben ohne Panel wenn nicht im Scope verdrahtet', () => {
    const item = itemWithText('Absender: Firma', {
      classifiedKind: 'auftrag',
      documentType: 'kundenauftrag',
    });
    expect(isConfirmedReplyDraftSupported(item)).toBe(false);
  });

  it('Remount behält DWR-Bestätigung; Entwurf-Session bleibt ephemer', async () => {
    const item = itemWithText('Absender: Session');
    seedDwr(item);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(NextStepsHarness, { item }));
    });
    await flushUi();
    await act(async () => {
      (
        container.querySelector(
          `[data-testid="${FILL_PREFIX}-confirm-Absender"]`,
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(
      container.querySelector(`[data-testid="${NEXT_PREFIX}-considered"]`)?.textContent,
    ).toContain('Session');
    await act(async () => {
      root.unmount();
    });
    container.remove();

    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    const root2 = createRoot(container2);
    await act(async () => {
      root2.render(createElement(NextStepsHarness, { item }));
    });
    await flushUi();
    expect(
      container2.querySelector(`[data-testid="${NEXT_PREFIX}-considered"]`)?.textContent,
    ).toContain('Session');
    expect(container2.querySelector(`[data-testid="${DRAFT_PREFIX}-result"]`)).toBeNull();
    await act(async () => {
      root2.unmount();
    });
  });
});
