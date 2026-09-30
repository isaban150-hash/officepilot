/**
 * EINGANG-01C-1 (T17) — „Vorgang anlegen" legt an und verknüpft nicht still.
 *
 * Bis hierher verknüpfte der Knopf „Vorgang anlegen" in der Übernahme-Übersicht
 * einen vorgeschlagenen bestehenden Vorgang — Handlung und Text wichen
 * voneinander ab, und der Audit-Grund lautete „vom Nutzer bestätigt".
 * Echte Seite, echte Workflow-Analyse, kein Netz.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { EingangDetailPage } from './EingangDetailPage';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import { getInboxItemById, hydrateInboxStore } from '../services/inboxService';
import { hydrateVorgangStore } from '../services/vorgangService';
import { hydrateCustomerStore } from '../services/customerStoreService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import type { InboxItem } from '../types/models';

const ITEM_ID = 'inbox-create-01c1';
let root: Root;
let host: HTMLDivElement;

async function settle(rounds = 30): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

function find(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  sessionStorage.clear();
  hydrateCustomerStore([]);
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

describe('EINGANG-01C-1 — „Vorgang anlegen"', () => {
  it('T17: bei vorhandenem sicheren Vorschlag öffnet „Vorgang anlegen" die Anlage — es wird nichts verknüpft', async () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-ref', title: 'Dachsanierung Beta', orderNumber: 'AU-2026-0077', status: 'in_bearbeitung' })]);
    const item: InboxItem = {
      ...createAuftragInboxItem({ id: ITEM_ID }),
      title: 'Lieferschein Baustoff Meyer',
      classifiedKind: 'lieferschein',
      documentType: 'lieferschein',
      sender: 'Baustoff Meyer GmbH',
      markedAsCompanyDocument: true,
      recognizedData: { Lieferant: 'Baustoff Meyer GmbH', _extractedText: 'Lieferschein\nIhr Auftrag AU-2026-0077' },
    } as InboxItem;
    hydrateInboxStore([item]);

    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: [`/ablage/${ITEM_ID}`] },
          createElement(
            AppProvider,
            { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
            createElement(Routes, null, createElement(Route, { path: '/ablage/:id', element: createElement(EingangDetailPage) })),
          ),
        ),
      );
    });
    await settle();

    // Wie im echten Weg: „Weitere Optionen", darin die Sektion „Technisches".
    for (const toggleId of ['document-review-more-toggle', 'review-section-toggle-technical']) {
      const toggle = find(toggleId);
      expect(toggle, `${toggleId} fehlt`).not.toBeNull();
      await act(async () => {
        toggle!.click();
      });
      await settle();
    }

    const createButton = find('smart-intake-create-vorgang') as HTMLButtonElement | null;
    expect(createButton, 'Knopf „Vorgang anlegen" fehlt').not.toBeNull();
    await act(async () => {
      createButton!.click();
    });
    await settle();

    const stored = getInboxItemById(ITEM_ID)!;
    expect(stored.vorgangId).toBeUndefined();
    expect(stored.vorgangLinkStatus).toBeUndefined();
    expect(stored.vorgangAssignment).toBeUndefined();
    expect(find('vorgang-dialog-create'), 'Anlage-Dialog öffnet sich nicht').not.toBeNull();
  }, 30_000); // echte Detailseite: unter Parallel-Last länger als der 5-s-Standard
});
