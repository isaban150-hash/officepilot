/**
 * PRODUCT-ACCEPTANCE-FIX-01B (F-15) — „Als Ausgabe speichern" im Eingang.
 *
 * Vertrag der Hauptaktion: Ablage bestätigen (bestehende Regel) → genau eine
 * Ausgabe über den kanonischen Dienst → Beleg und Ausgabe verbunden → Eingang
 * abgeschlossen. Wiederholung erzeugt keine Dublette; ohne Ausgabe wird nicht
 * archiviert und kein Erfolg gemeldet.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { createAuftragInboxItem } from './test/fixtures';
import { getInboxItemById, hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateCustomerStore } from './services/customerStoreService';
import { hydrateExpenseStore } from './services/expenseStore';
import { getAllExpenses } from './services/expenseService';
import * as expenseService from './services/expenseService';
import { createExpenseFromInbox } from './services/officeActionService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import type { ClassifiedDocumentKind, InboxItem } from './types/models';

const ITEM_ID = 'inbox-expense-f15';

let root: Root;
let host: HTMLDivElement;

function seed(kind: ClassifiedDocumentKind, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    ...createAuftragInboxItem({ id: ITEM_ID }),
    title: `${kind} Testbeleg`,
    sender: 'Aral Station Nord',
    classifiedKind: kind,
    documentType: 'eingangsrechnung',
    markedAsCompanyDocument: true,
    recognizedData: {
      Betrag: '92,95 EUR',
      Datum: '2026-02-10',
      Lieferant: 'Aral Station Nord',
    },
    ...overrides,
  } as InboxItem;
}

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  sessionStorage.clear();
  hydrateVorgangStore([]);
  hydrateCustomerStore([]);
  hydrateExpenseStore([]);
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

async function settle(rounds = 30): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

function LocationProbe() {
  const location = useLocation();
  return createElement('span', { 'data-testid': 'location-probe' }, location.pathname + location.search);
}

async function renderDetail(item: InboxItem): Promise<void> {
  hydrateInboxStore([item]);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/ablage/${ITEM_ID}`] },
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/ablage/:id', element: createElement(EingangDetailPage) }),
            createElement(Route, { path: '*', element: createElement(LocationProbe) }),
          ),
        ),
      ),
    );
  });
  await settle();
}

function find(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle(10);
}

async function runPrimaryWithFilingConfirm(): Promise<void> {
  const primary = find('document-review-apply-button');
  expect(primary, 'Hauptaktion fehlt').not.toBeNull();
  expect(primary!.textContent).toMatch(/Als Ausgabe speichern|Ausgabe erfassen/);
  await click(primary!);
  const prompt = find('action-filing-confirm');
  expect(prompt, 'Ablagebestätigung erscheint nicht').not.toBeNull();
  expect(prompt!.textContent).toMatch(/Als Ausgabe speichern|Ausgabe erfassen/);
  expect(getAllExpenses(), 'Ausgabe vor der Ablagebestätigung').toHaveLength(0);
  await click(find('document-filing-decision-confirm')!);
  await settle(20);
}

describe('F-15 — Als Ausgabe speichern: kanonischer Dienst', () => {
  it('createExpenseFromInbox ist am Eingangsbezug idempotent (ohne Belegnummer)', () => {
    const item = seed('tankbeleg');
    hydrateInboxStore([item]);
    const first = createExpenseFromInbox(item);
    expect(first.ok).toBe(true);
    expect(getAllExpenses()).toHaveLength(1);
    const second = createExpenseFromInbox(item);
    expect(second.ok).toBe(true);
    expect(getAllExpenses(), 'zweiter Aufruf legt keine Dublette an').toHaveLength(1);
    expect(second.ok && second.kind === 'navigate' ? second.route : '').toBe(`/ausgaben/${getAllExpenses()[0]!.id}`);
    expect(getAllExpenses()[0]!.linkedInboxId).toBe(ITEM_ID);
    expect(getAllExpenses()[0]!.grossAmount).toBe(92.95);
    expect(getAllExpenses()[0]!.supplierName).toBe('Aral Station Nord');
    expect(getAllExpenses()[0]!.issueDate).toBe('2026-02-10');
  });

  it('erkanntes Datum TT.MM.JJJJ wird nicht als ISO fehlgedeutet', () => {
    const item = seed('tankbeleg', { recognizedData: { Betrag: '92,95 EUR', Datum: '10.02.2026' } });
    hydrateInboxStore([item]);
    expect(createExpenseFromInbox(item).ok).toBe(true);
    expect(getAllExpenses()[0]!.issueDate).toBe('2026-02-10');
  });
});

describe('F-15 — Als Ausgabe speichern: Seitenfluss', () => {
  it('einmaliger Ablauf: Ablage bestätigen → genau eine Ausgabe, Beleg verbunden, Eingang abgeschlossen', async () => {
    await renderDetail(seed('tankbeleg'));
    await runPrimaryWithFilingConfirm();

    const expenses = getAllExpenses();
    expect(expenses, 'genau eine Ausgabe').toHaveLength(1);
    expect(expenses[0]!.linkedInboxId).toBe(ITEM_ID);
    expect(expenses[0]!.grossAmount).toBe(92.95);

    const after = getInboxItemById(ITEM_ID)!;
    expect(after.status, 'Eingang abgeschlossen').toBe('abgelegt');
    expect(after.archiveDocumentId?.trim(), 'Archivdokument verknüpft').toBeTruthy();
    expect(find('action-filing-confirm'), 'Ablagebestätigung geschlossen').toBeNull();
  });

  it('Eingangsrechnung mit Belegnummer: derselbe Weg, eine Ausgabe', async () => {
    await renderDetail(seed('eingangsrechnung', { sender: 'Westfalen SHK Grosshandel GmbH', recognizedData: { Rechnungsnummer: 'RE-4711', Betrag: '486,20 EUR', Lieferant: 'Westfalen SHK Grosshandel GmbH' } }));
    await runPrimaryWithFilingConfirm();
    expect(getAllExpenses()).toHaveLength(1);
    expect(getAllExpenses()[0]!.invoiceNumber).toBe('RE-4711');
    expect(getInboxItemById(ITEM_ID)!.status).toBe('abgelegt');
  });

  it('Doppelklick auf die Hauptaktion und doppelte Bestätigung erzeugen keine zweite Ausgabe', async () => {
    await renderDetail(seed('tankbeleg'));
    const primary = find('document-review-apply-button')!;
    await act(async () => {
      primary.click();
      primary.click();
    });
    await settle(10);
    const confirm = find('document-filing-decision-confirm')!;
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    await settle(20);
    expect(getAllExpenses()).toHaveLength(1);
  });

  it('bereits verarbeitetes Dokument: erneuter Aufruf legt keine zweite Ausgabe an', async () => {
    await renderDetail(seed('tankbeleg'));
    await runPrimaryWithFilingConfirm();
    expect(getAllExpenses()).toHaveLength(1);
    // Wiederaufnahme/Reload: Seite mit demselben Dokument erneut geöffnet.
    const processed = getInboxItemById(ITEM_ID)!;
    await act(async () => root.unmount());
    root = createRoot(host);
    await renderDetail(processed);
    const primary = find('document-review-apply-button');
    if (primary && !(primary as HTMLButtonElement).disabled) {
      await click(primary);
      const confirm = find('document-filing-decision-confirm');
      if (confirm) await click(confirm);
    }
    // Und der Dienst direkt — derselbe Bezug, dieselbe Ausgabe.
    createExpenseFromInbox(getInboxItemById(ITEM_ID)!);
    expect(getAllExpenses()).toHaveLength(1);
  });

  it('Fehler beim Anlegen der Ausgabe: kein Archiv, kein Abschluss, kein Erfolg', async () => {
    vi.spyOn(expenseService, 'addExpense').mockReturnValue({ success: false, errorKey: 'expense.invalidAmount' } as never);
    await renderDetail(seed('tankbeleg'));
    await runPrimaryWithFilingConfirm();
    expect(getAllExpenses()).toHaveLength(0);
    const after = getInboxItemById(ITEM_ID)!;
    expect(after.status, 'Eingang bleibt offen').not.toBe('abgelegt');
    expect(after.archiveDocumentId?.trim() ?? '').toBe('');
    expect(host.textContent).not.toContain('Ausgabe wurde erfasst');
  });

  it('ohne erkannten Betrag: Weg zur manuellen Ausgabe, kein Archiv, keine Ausgabe', async () => {
    await renderDetail(seed('tankbeleg', { recognizedData: { Lieferant: 'Aral Station Nord' } }));
    await runPrimaryWithFilingConfirm();
    expect(getAllExpenses()).toHaveLength(0);
    expect(find('location-probe')?.textContent ?? '').toContain('/ausgaben/neu?inboxId=');
    expect(getInboxItemById(ITEM_ID)!.status).not.toBe('abgelegt');
  });
});
