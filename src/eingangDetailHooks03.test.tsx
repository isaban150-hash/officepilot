/**
 * FINAL-ACCEPTANCE-FIX 03 — EingangDetailPage hält die Rules of Hooks ein.
 *
 * Eine einzige gemountete Seiteninstanz durchläuft alle Render-Zweige, die
 * früh zurückkehren (`!item`, Deferred-Shell, `!workflow`), und die fertige
 * Ansicht — so, wie es beim Wechsel zwischen `/ablage/:id` passiert (React
 * Router behält dieselbe Komponente). Vorher stand ein Effekt hinter diesen
 * Returns; jeder Wechsel zwischen den Zweigen änderte die Zahl der Hooks.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { hydrateInboxStore } from './services/inboxService';
import * as intakeWorkflowService from './services/intakeWorkflowService';
import { itemNeedsDeferredWorkflowAnalysis } from './services/inboxWorkflowAnalysisKey';
import { SAMPLE_WERKVERTRAG_TEXT } from './services/contractAnalysisService';
import { resetTestStores } from './test/resetStores';
import { createAuftragInboxItem } from './test/fixtures';
import type { InboxItem } from './types/models';

const HOOK_ERRORS = /Rendered (more|fewer) hooks|change in the order of Hooks|Should have a queue|Rules of Hooks/i;

function largeText(minLength = 50_000): string {
  const parts: string[] = [];
  let length = 0;
  while (length < minLength) {
    parts.push(SAMPLE_WERKVERTRAG_TEXT);
    length += SAMPLE_WERKVERTRAG_TEXT.length + 1;
  }
  return parts.join('\n');
}

const normalItem = (): InboxItem => ({ ...createAuftragInboxItem(), id: 'inbox-hooks-normal', title: 'Normales Dokument' }) as InboxItem;
const nullWorkflowItem = (): InboxItem => ({ ...createAuftragInboxItem(), id: 'inbox-hooks-null', title: 'Ohne Analyse' }) as InboxItem;
const deferredItem = (): InboxItem =>
  ({
    ...createAuftragInboxItem(),
    id: 'inbox-hooks-deferred',
    title: 'Grosser Werkvertrag',
    classifiedKind: 'werkvertrag',
    status: 'neu',
    fileRefId: 'file-ref-hooks-03',
    recognizedData: {
      Kunde: 'Müller Bau GmbH',
      Baustelle: 'Hauptstr. 12, Berlin',
      _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
      _extractedText: largeText(),
      _pageTexts: JSON.stringify([1, 2, 3, 4].map((pageNumber) => ({ pageNumber, text: `Seite ${pageNumber}` }))),
    },
  }) as unknown as InboxItem;

let navigateRef: NavigateFunction | null = null;
function NavigatorProbe() {
  navigateRef = useNavigate();
  return null;
}

describe('FINAL-ACCEPTANCE-FIX 03 — stabile Hook-Reihenfolge in EingangDetailPage', () => {
  beforeEach(() => {
    resetTestStores();
    navigateRef = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('eine Instanz: fertig → Shell → fertig → !workflow → fertig → !item — ohne Hook-Fehler', async () => {
    hydrateInboxStore([normalItem(), nullWorkflowItem(), deferredItem()]);
    expect(itemNeedsDeferredWorkflowAnalysis(deferredItem())).toBe(true);
    expect(itemNeedsDeferredWorkflowAnalysis(normalItem())).toBe(false);

    // !workflow: die reine Analyse liefert für genau dieses Dokument nichts.
    const realAnalyze = intakeWorkflowService.analyzeUploadedDocument;
    vi.spyOn(intakeWorkflowService, 'analyzeUploadedDocument').mockImplementation((id: string) =>
      id === 'inbox-hooks-null' ? null : realAnalyze(id),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const find = (id: string) => container.querySelector(`[data-testid="${id}"]`);
    const hookErrors = () =>
      consoleError.mock.calls.map((call) => call.map(String).join(' ')).filter((line) => HOOK_ERRORS.test(line));
    const go = async (path: string) => {
      await act(async () => {
        navigateRef!(path);
      });
    };

    act(() => {
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ['/ablage/inbox-hooks-normal'] },
          createElement(
            AppProvider,
            { initialSetup: DEFAULT_SETUP },
            createElement(NavigatorProbe),
            createElement(
              Routes,
              null,
              createElement(Route, { path: '/ablage/:id', element: createElement(EingangDetailPage) }),
              createElement(Route, { path: '/ablage', element: createElement('div', { 'data-testid': 'ablage-list-stub' }) }),
            ),
          ),
        ),
      );
    });

    // 1) fertige Ansicht
    expect(find('ablage-detail-page')).not.toBeNull();

    // 2) fertig → Deferred-Shell (dieselbe Instanz, andere :id)
    await go('/ablage/inbox-hooks-deferred');
    expect(find('eingang-detail-analysis-pending')).not.toBeNull();
    expect(hookErrors()).toEqual([]);

    // 3) Shell → fertig (Analyse nach dem Paint)
    await act(async () => {
      vi.runAllTimers();
    });
    expect(find('ablage-detail-page')).not.toBeNull();
    expect(find('eingang-detail-analysis-pending')).toBeNull();
    expect(find('server-error-page')).toBeNull();
    expect(hookErrors()).toEqual([]);

    // 4) fertig → !workflow
    await go('/ablage/inbox-hooks-null');
    expect(find('ablage-detail-page')).toBeNull();
    expect(find('eingang-detail-analysis-pending')).not.toBeNull(); // Rückfall-Anzeige bei fehlender Analyse
    expect(hookErrors()).toEqual([]);

    // 5) !workflow → fertig
    await go('/ablage/inbox-hooks-normal');
    expect(find('ablage-detail-page')).not.toBeNull();
    expect(hookErrors()).toEqual([]);

    // 6) fertig → !item (unbekannte ID; die Seite leitet danach zur Liste um)
    await go('/ablage/inbox-gibt-es-nicht');
    expect(find('server-error-page')).toBeNull();
    expect(hookErrors()).toEqual([]);

    act(() => root.unmount());
    container.remove();
  });
});
