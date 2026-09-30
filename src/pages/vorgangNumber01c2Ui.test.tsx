/**
 * EINGANG-01C-2 (T9/T14) — minimale Anzeige der Vorgangsnummer.
 *
 * Mit Nummer: Detailkopf, Liste, Auswahl im Eingang, Office-Suche. Ohne Nummer
 * (Altbestand, noch nicht bestätigter Neuanlage): nichts — kein Platzhalter,
 * kein Fake, und alles funktioniert weiter über Titel/ID.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { VorgangDetailPage } from './VorgangDetailPage';
import { VorgaengePage } from './VorgaengePage';
import { InboxVorgangPanel } from '../components/inbox/InboxVorgangPanel';
import { getInboxItemById, hydrateInboxStore } from '../services/inboxService';
import { getVorgangCardMode, hydrateVorgangStore } from '../services/vorgangService';
import { searchOffice } from '../services/officeSearchService';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };
const NUMBERED = createTestVorgang({ id: 'v-numbered', title: 'Dachsanierung Nord', customer: 'Nordbau GmbH', vorgangNumber: 'VG-2026-0042' });
const LEGACY = createTestVorgang({ id: 'v-legacy', title: 'Altauftrag Süd', customer: 'Südbau GmbH' });
const PENDING = createTestVorgang({ id: 'v-pending', title: 'Neu offline', customer: 'Westbau GmbH', vorgangNumberRequested: true });

let host: HTMLDivElement;
let root: Root;

async function mount(element: ReturnType<typeof createElement>, path = '/'): Promise<void> {
  await act(async () => {
    root.render(
      createElement(MemoryRouter, { initialEntries: [path] }, createElement(AppProvider, { initialSetup: setupComplete }, element)),
    );
  });
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function byTestId(id: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${id}"]`);
}

beforeEach(() => {
  localStorage.clear();
  resetTestStores();
  hydrateVorgangStore([NUMBERED, LEGACY, PENDING]);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetTestStores();
  localStorage.clear();
});

describe('EINGANG-01C-2 — Anzeige', () => {
  it('Liste: Nummer vor dem Titel nur bei vergebener Nummer; Altbestand und unbestätigte Neuanlage ohne', async () => {
    await mount(createElement(VorgaengePage), '/vorgaenge');
    expect(byTestId('vorgaenge-row-number-v-numbered')?.textContent).toBe('VG-2026-0042');
    expect(byTestId('vorgaenge-row-v-numbered')?.textContent).toContain('Dachsanierung Nord');
    for (const id of ['v-legacy', 'v-pending']) {
      expect(byTestId(`vorgaenge-row-${id}`), id).not.toBeNull();
      expect(byTestId(`vorgaenge-row-number-${id}`), id).toBeNull();
      expect(byTestId(`vorgaenge-row-${id}`)!.textContent, id).not.toMatch(/VG-/);
    }
  });

  it('Detail: Nummer im Kopf; Altbestand und unbestätigte Neuanlage ohne Nummer, Seite funktioniert', async () => {
    await mount(createElement(Routes, null, createElement(Route, { path: '/vorgaenge/:id', element: createElement(VorgangDetailPage) })), '/vorgaenge/v-numbered');
    expect(byTestId('vorgang-detail-number')?.textContent).toBe('VG-2026-0042');
    expect(byTestId('vorgang-detail-header')?.textContent).toContain('Dachsanierung Nord');

    for (const [id, title] of [['v-legacy', 'Altauftrag Süd'], ['v-pending', 'Neu offline']] as const) {
      act(() => root.unmount());
      root = createRoot(host);
      await mount(createElement(Routes, null, createElement(Route, { path: '/vorgaenge/:id', element: createElement(VorgangDetailPage) })), `/vorgaenge/${id}`);
      expect(byTestId('vorgang-detail-page'), id).not.toBeNull();
      expect(byTestId('vorgang-detail-number'), id).toBeNull();
      expect(byTestId('vorgang-detail-header')?.textContent, id).toContain(title);
      expect(byTestId('vorgang-detail-header')?.textContent, id).not.toMatch(/VG-/);
    }
  });

  it('Auswahl im Eingang: nummerierter Vorgang zeigt VG, Altbestand nur den Titel', async () => {
    const item = createAuftragInboxItem({ id: 'inbox-link-01c2', documentType: 'lieferschein', recommendedAction: 'zuordnen', sender: 'Unbekannt AG', recognizedData: {} });
    hydrateInboxStore([item]);
    const stored = getInboxItemById(item.id)!;
    expect(getVorgangCardMode(stored)).toBe('link');
    await mount(createElement(InboxVorgangPanel, { item: stored, materialDefault: 'betrieb', onLinked: () => {} }));
    await act(async () => {
      (host.querySelector('.vorgang-panel button') as HTMLElement).click();
    });
    expect(byTestId('similar-vorgang-number-v-numbered')?.textContent).toContain('VG-2026-0042');
    expect(byTestId('similar-vorgang-number-v-legacy')).toBeNull();
    expect(host.textContent).toContain('Altauftrag Süd');
  });

  it('Office-Suche: Nummer findet den Vorgang und steht im Treffer; Titelsuche für Altbestand unverändert', () => {
    const byNumber = searchOffice({ query: 'VG-2026-0042' }).filter((r) => r.type === 'vorgang');
    expect(byNumber.map((r) => r.route)).toEqual(['/vorgaenge/v-numbered']);
    expect(byNumber[0].title).toBe('VG-2026-0042 · Dachsanierung Nord');
    const legacy = searchOffice({ query: 'Altauftrag' }).filter((r) => r.type === 'vorgang');
    expect(legacy.map((r) => [r.route, r.title])).toEqual([['/vorgaenge/v-legacy', 'Altauftrag Süd']]);
  });
});
