import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { DocumentConfirmedReplyDraftPanel } from './components/documents/DocumentConfirmedReplyDraftPanel';
import { DocumentFieldFillConfirmPanel } from './components/documents/DocumentFieldFillConfirmPanel';
import { KommunikationPage } from './pages/KommunikationPage';
import { buildConfirmedReplyDraft } from './services/documentConfirmedReplyDraftService';
import { buildDocumentFieldFillConfirmViewModel } from './services/documentFieldFillConfirmService';
import {
  buildCommunicationResultFromReplyHandoff,
  buildDocumentReplyDraftHandoffPayload,
  createDocumentReplyDraftHandoffLocationState,
  readDocumentReplyDraftHandoffFromLocationState,
} from './services/documentReplyDraftHandoffService';
import { withInboxExtractedDocumentText } from './services/inboxDocumentText';
import * as communicationHistoryService from './services/communicationHistoryService';
import * as communicationOrchestrator from './services/communicationOrchestrator';
import * as persistenceService from './services/persistenceService';
import { hydrateInboxStore } from './services/inboxService';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { DocumentFieldFillConfirmRow } from './types/documentFieldFillConfirm';
import type { DocumentReplyDraftHandoffPayload } from './types/documentReplyDraftHandoff';
import type { InboxItem } from './types/models';
import { buildKommunikationPath } from './components/communication/communicationNavigation';

const FILL_PREFIX = 'document-field-fill-confirm';
const DRAFT_PREFIX = 'document-confirmed-reply-draft';
const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

function itemWithText(text: string, overrides: Partial<InboxItem> = {}): InboxItem {
  const base = createAuftragInboxItem({
    id: 'inbox-handoff-1',
    sender: 'BG BAU',
    title: 'Beitragsbescheid 2026',
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

function LocationProbe({ onLocation }: { onLocation: (path: string, state: unknown) => void }): null {
  const location = useLocation();
  onLocation(`${location.pathname}${location.search}`, location.state);
  return null;
}

function InboxHandoffHarness({
  item,
  onHandoff,
}: {
  item: InboxItem;
  onHandoff: (payload: DocumentReplyDraftHandoffPayload) => void;
}): ReactElement {
  const [rows, setRows] = useState<DocumentFieldFillConfirmRow[]>(() => [
    ...buildDocumentFieldFillConfirmViewModel(item).rows,
  ]);
  return createElement(
    'div',
    null,
    createElement(DocumentFieldFillConfirmPanel, {
      item,
      testIdPrefix: FILL_PREFIX,
      rows,
      onRowsChange: setRows,
    }),
    createElement(DocumentConfirmedReplyDraftPanel, {
      item,
      rows,
      testIdPrefix: DRAFT_PREFIX,
      onHandoffToCommunication: onHandoff,
    }),
  );
}

async function prepareDraft(container: HTMLElement, core: string): Promise<void> {
  const confirm = container.querySelector(
    `[data-testid="${FILL_PREFIX}-confirm-Absender"]`,
  ) as HTMLButtonElement | null;
  if (confirm) {
    await act(async () => {
      confirm.click();
    });
    await flushUi();
  }
  const textarea = container.querySelector(
    `[data-testid="${DRAFT_PREFIX}-core"]`,
  ) as HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, core);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    (container.querySelector(`[data-testid="${DRAFT_PREFIX}-prepare"]`) as HTMLButtonElement).click();
  });
  await flushUi();
}

afterEach(() => {
  vi.restoreAllMocks();
  resetTestStores();
  document.body.innerHTML = '';
});

describe('DOCUMENT-ASSIST-REPLY-DRAFT-HANDOFF-01 — payload', () => {
  it('baut geprüften Payload ohne erfundenen Betreff/Absender', () => {
    const withMeta = itemWithText('Absender: Amt');
    const rows = buildDocumentFieldFillConfirmViewModel(withMeta).rows.map((row) =>
      row.fieldKey === 'Absender'
        ? Object.freeze({
            ...row,
            status: 'confirmed' as const,
            confirmedValue: 'Amt',
          })
        : row,
    );
    const draft = buildConfirmedReplyDraft({
      coreMessage: 'Unterlagen folgen.',
      subject: withMeta.title,
      sender: withMeta.sender,
      rows,
    })!;
    const payload = buildDocumentReplyDraftHandoffPayload({
      item: withMeta,
      draft,
      coreMessage: 'Unterlagen folgen.',
    })!;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.documentId).toBe('inbox-handoff-1');
    expect(payload.contextRef).toEqual({ type: 'inbox', id: 'inbox-handoff-1' });
    expect(payload.coreMessage).toBe('Unterlagen folgen.');
    expect(payload.draftText).toContain('Unterlagen folgen.');
    expect(payload.subject).toBe('Beitragsbescheid 2026');
    expect(payload.sender).toBe('BG BAU');
    expect(payload.considered).toEqual([{ label: 'Absender', value: 'Amt' }]);
    expect(payload.notIncluded.length).toBeGreaterThan(0);

    const bare = itemWithText('x', { title: '', sender: '' });
    const bareDraft = buildConfirmedReplyDraft({
      coreMessage: 'Nur Kern.',
      subject: bare.title,
      sender: bare.sender,
      rows: buildDocumentFieldFillConfirmViewModel(bare).rows,
    })!;
    const barePayload = buildDocumentReplyDraftHandoffPayload({
      item: bare,
      draft: bareDraft,
      coreMessage: 'Nur Kern.',
    })!;
    expect(barePayload.subject).toBeUndefined();
    expect(barePayload.sender).toBeUndefined();
    expect(barePayload.draftText).toBe('Nur Kern.');
  });

  it('mapped Result behält Entwurf und Fakten unverändert', () => {
    const payload: DocumentReplyDraftHandoffPayload = {
      schemaVersion: 1,
      contextRef: { type: 'inbox', id: 'inbox-handoff-1' },
      documentId: 'inbox-handoff-1',
      draftText: 'Bezug: Test\n\nKern unverändert.',
      coreMessage: 'Kern unverändert.',
      considered: [{ label: 'Frist', value: '15.08.2026' }],
      notIncluded: ['Betrag', 'Aktenzeichen'],
      subject: 'Test',
      sender: 'Amt',
    };
    const result = buildCommunicationResultFromReplyHandoff(payload);
    expect(result.intent).toBe('document_reply');
    expect(result.status).toBe('complete');
    expect(result.drafts?.email?.body).toBe(payload.draftText);
    expect(result.drafts?.email?.basedOnFacts).toEqual(['Frist: 15.08.2026']);
    expect(result.drafts?.email?.notIncluded).toEqual(['Betrag', 'Aktenzeichen']);
    expect(result.drafts?.email?.greeting).toBeUndefined();
    expect(result.drafts?.email?.closing).toBeUndefined();
    expect(result.drafts?.email?.subject).toBe('Test');
  });
});

describe('DOCUMENT-ASSIST-REPLY-DRAFT-HANDOFF-01 — UI', () => {
  it('ohne erzeugten Entwurf kein Handoff-Button', async () => {
    const item = itemWithText('Absender: X');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onHandoff = vi.fn();
    await act(async () => {
      root.render(createElement(InboxHandoffHarness, { item, onHandoff }));
    });
    await flushUi();
    expect(container.querySelector(`[data-testid="${DRAFT_PREFIX}-handoff"]`)).toBeNull();
    expect(onHandoff).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it('Klick navigiert mit exakt dem geprüften Payload; keine Übergabe ohne Klick', async () => {
    const item = itemWithText('Absender: Amt Y');
    hydrateInboxStore([item]);
    let seenPath = '';
    let seenState: unknown = null;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: [`/ablage/${item.id}`] },
          createElement(AppProvider, { initialSetup: setupComplete },
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: `/ablage/${item.id}`,
                element: createElement(InboxHandoffHarness, {
                  item,
                  onHandoff: (payload) => {
                    seenPath = buildKommunikationPath(payload.contextRef);
                    seenState = createDocumentReplyDraftHandoffLocationState(payload);
                  },
                }),
              }),
              createElement(Route, {
                path: '/kommunikation',
                element: createElement(LocationProbe, {
                  onLocation: (path, state) => {
                    seenPath = path;
                    seenState = state;
                  },
                }),
              }),
            ),
          ),
        ),
      );
    });
    await flushUi();
    expect(seenState).toBeNull();

    await prepareDraft(container, 'Bitte prüfen.');
    expect(container.querySelector(`[data-testid="${DRAFT_PREFIX}-handoff"]`)).not.toBeNull();
    expect(readDocumentReplyDraftHandoffFromLocationState(seenState)).toBeNull();

    await act(async () => {
      (container.querySelector(`[data-testid="${DRAFT_PREFIX}-handoff"]`) as HTMLButtonElement).click();
    });
    await flushUi();

    expect(seenPath).toBe('/kommunikation?context=inbox&id=inbox-handoff-1');
    const payload = readDocumentReplyDraftHandoffFromLocationState(seenState);
    expect(payload).not.toBeNull();
    expect(payload!.coreMessage).toBe('Bitte prüfen.');
    expect(payload!.draftText).toContain('Bitte prüfen.');
    expect(payload!.considered).toEqual([{ label: 'Absender', value: 'Amt Y' }]);
    expect(payload!.schemaVersion).toBe(1);

    await act(async () => {
      root.unmount();
    });
  });

  it('Kommunikationsbereich wird korrekt vorbefüllt; kein Auto-Save/Send; einmal konsumiert', async () => {
    const item = itemWithText('Absender: Amt Z');
    hydrateInboxStore([item]);
    const rows = buildDocumentFieldFillConfirmViewModel(item).rows.map((row) =>
      row.fieldKey === 'Absender'
        ? Object.freeze({
            ...row,
            status: 'confirmed' as const,
            confirmedValue: 'Amt Z',
          })
        : row,
    );
    const draft = buildConfirmedReplyDraft({
      coreMessage: 'Handoff Kern.',
      subject: item.title,
      sender: item.sender,
      rows,
    })!;
    const payload = buildDocumentReplyDraftHandoffPayload({
      item,
      draft,
      coreMessage: 'Handoff Kern.',
    })!;

    const recordSpy = vi.spyOn(communicationHistoryService, 'recordCommunicationResult');
    const orchSpy = vi.spyOn(communicationOrchestrator, 'processCommunicationRequest');
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          {
            initialEntries: [
              {
                pathname: '/kommunikation',
                search: '?context=inbox&id=inbox-handoff-1',
                state: createDocumentReplyDraftHandoffLocationState(payload),
              },
            ],
          },
          createElement(AppProvider, { initialSetup: setupComplete },
            createElement(Routes, null, createElement(Route, {
              path: '/kommunikation',
              element: createElement(KommunikationPage),
            })),
          ),
        ),
      );
    });
    await flushUi();

    expect(container.querySelector('[data-testid="communication-draft"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="communication-handoff-proposal-badge"]')?.textContent,
    ).toContain('Vorschlag – noch nicht gespeichert oder versendet');
    expect(
      container.querySelector('[data-testid="communication-draft-body"]')?.textContent,
    ).toContain(payload.draftText);
    expect(buildCommunicationResultFromReplyHandoff(payload).drafts?.email?.body).toBe(
      payload.draftText,
    );
    expect(container.textContent).toContain('Absender: Amt Z');
    expect(container.textContent).toContain('Nicht enthalten');
    expect(
      (container.querySelector('[data-testid="communication-input"]') as HTMLTextAreaElement | null)
        ?.value ??
        (container.querySelector('textarea') as HTMLTextAreaElement).value,
    ).toBe('Handoff Kern.');

    expect(recordSpy).not.toHaveBeenCalled();
    expect(orchSpy).not.toHaveBeenCalled();
    expect(persistSpy).not.toHaveBeenCalled();

    // Remount without state must not recreate draft from consumed handoff.
    await act(async () => {
      root.unmount();
    });
    container.remove();

    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    const root2 = createRoot(container2);
    await act(async () => {
      root2.render(
        createElement(
          MemoryRouter,
          {
            initialEntries: [
              {
                pathname: '/kommunikation',
                search: '?context=inbox&id=inbox-handoff-1',
                state: {},
              },
            ],
          },
          createElement(AppProvider, { initialSetup: setupComplete },
            createElement(Routes, null, createElement(Route, {
              path: '/kommunikation',
              element: createElement(KommunikationPage),
            })),
          ),
        ),
      );
    });
    await flushUi();
    expect(container2.querySelector('[data-testid="communication-draft"]')).toBeNull();
    expect(
      container2.querySelector('[data-testid="communication-handoff-proposal-badge"]'),
    ).toBeNull();

    await act(async () => {
      root2.unmount();
    });
  });

  it('Handoff wird nur einmal konsumiert (replace leert state)', async () => {
    const item = itemWithText('Absender: Once');
    hydrateInboxStore([item]);
    const rows = buildDocumentFieldFillConfirmViewModel(item).rows.map((row) =>
      row.fieldKey === 'Absender'
        ? Object.freeze({
            ...row,
            status: 'confirmed' as const,
            confirmedValue: 'Once',
          })
        : row,
    );
    const draft = buildConfirmedReplyDraft({
      coreMessage: 'Einmal.',
      subject: item.title,
      sender: item.sender,
      rows,
    })!;
    const payload = buildDocumentReplyDraftHandoffPayload({
      item,
      draft,
      coreMessage: 'Einmal.',
    })!;

    let latestState: unknown = { keep: true };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function ProbePage(): ReactElement {
      const location = useLocation();
      latestState = location.state;
      return createElement(KommunikationPage);
    }

    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          {
            initialEntries: [
              {
                pathname: '/kommunikation',
                search: '?context=inbox&id=inbox-handoff-1',
                state: createDocumentReplyDraftHandoffLocationState(payload),
              },
            ],
          },
          createElement(AppProvider, { initialSetup: setupComplete },
            createElement(Routes, null, createElement(Route, {
              path: '/kommunikation',
              element: createElement(ProbePage),
            })),
          ),
        ),
      );
    });
    await flushUi();

    expect(readDocumentReplyDraftHandoffFromLocationState(latestState)).toBeNull();
    expect(container.querySelectorAll('[data-testid="communication-draft"]').length).toBe(1);

    await act(async () => {
      root.unmount();
    });
  });

  it('nicht unterstützte Dokumentarten bleiben unverändert', async () => {
    const { isConfirmedReplyDraftSupported } = await import(
      './services/documentConfirmedReplyDraftService'
    );
    const item = itemWithText('Absender: Firma', {
      classifiedKind: 'auftrag',
      documentType: 'kundenauftrag',
    });
    expect(isConfirmedReplyDraftSupported(item)).toBe(false);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          createElement(DocumentFieldFillConfirmPanel, {
            item,
            testIdPrefix: FILL_PREFIX,
          }),
          isConfirmedReplyDraftSupported(item)
            ? createElement(DocumentConfirmedReplyDraftPanel, {
                item,
                rows: buildDocumentFieldFillConfirmViewModel(item).rows,
                testIdPrefix: DRAFT_PREFIX,
                onHandoffToCommunication: vi.fn(),
              })
            : null,
        ),
      );
    });
    await flushUi();
    expect(container.querySelector(`[data-testid="${FILL_PREFIX}-panel"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="${DRAFT_PREFIX}-panel"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="${DRAFT_PREFIX}-handoff"]`)).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});
