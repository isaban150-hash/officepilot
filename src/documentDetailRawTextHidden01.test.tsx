/**
 * OFFICEPILOT-DOCUMENT-DETAIL-RAW-TEXT-01B — der Rohtext gehört nicht auf die Seite.
 *
 * Der erkannte Dokumenttext wurde auf der Detailseite als „Textauszug“ in voller
 * Länge ausgegeben. Für den Nutzer ist das keine Information, sondern eine Wand,
 * durch die er scrollen muss, um an Bearbeiten, Löschen und „Verknüpfung lösen“
 * zu kommen — die liegen im selben aufgeklappten Bereich.
 *
 * Entfernt wird ausschließlich die Darstellung. Der Text bleibt vollständig auf
 * der Entität: Klassifikation, Extraktion, Suche, Contract Intelligence und die
 * freien Dokumentfragen leben davon. Dieser Test hält beides zusammen fest —
 * unsichtbar und trotzdem da.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { t } from './i18n';
import { DokumentDetailPage } from './pages/DokumentDetailPage';
import { getDocumentById, hydrateDocumentStore } from './services/documentService';
import { resetTestStores } from './test/resetStores';
import type { CompanyDocument } from './types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };
const DOC_ID = 'doc-raw-text-hidden';

/** Kommt sonst nirgends im Projekt vor — jeder Treffer stammt aus dem Fixture. */
const MARKER = 'ZZMARKERROHTEXTZZ';
const RAW_TEXT = [
  `Werkvertrag ${MARKER}`,
  'Auftraggeber: Beispiel Bau GmbH',
  'Leistungsverzeichnis Position 01 950 m² PE-Dampfsperre',
  'Zahlungsziel 30 Tage netto',
].join('\n');

type Mount = { container: HTMLDivElement; root: Root };

function unmount(mount: Mount): void {
  act(() => mount.root.unmount());
  mount.container.remove();
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function find(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

async function click(container: HTMLElement, testId: string): Promise<void> {
  await waitFor(() => find(container, testId) !== null, testId);
  const element = find(container, testId) as HTMLButtonElement;
  await act(async () => element.click());
  await settle();
}

function buildDocument(): CompanyDocument {
  return {
    id: DOC_ID,
    title: 'Werkvertrag Beispiel',
    category: 'vertrag',
    issuer: 'Beispiel Bau GmbH',
    recognizedText: RAW_TEXT,
    issueDate: '2026-03-01',
    digitalFolder: { id: 'dig-1', name: 'Verträge', path: '/Firma/Vertraege/' },
    paperFolder: { folderId: 'folder-1', register: 'A', label: 'Verträge' },
    tags: ['Vertrag'],
    linkedCompany: 'Test GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-03-01T10:00:00.000Z',
  } as CompanyDocument;
}

async function mountDetail(): Promise<Mount> {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/dokumente/${DOC_ID}`] },
        createElement(
          AppProvider,
          { initialSetup: setupComplete },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/dokumente/:id',
              element: createElement(DokumentDetailPage),
            }),
          ),
        ),
      ),
    );
  });
  await settle();
  return { container, root };
}

describe('OFFICEPILOT-DOCUMENT-DETAIL-RAW-TEXT-01B', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateDocumentStore([buildDocument()]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('A/B: weder der Rohtext noch die Überschrift „Textauszug“ stehen auf der Seite', async () => {
    const mount = await mountDetail();

    // Zugeklappt darf ohnehin nichts davon zu sehen sein …
    expect(mount.container.textContent).not.toContain(MARKER);

    // … und aufgeklappt erst recht nicht: dort liegen die Aktionen, dorthin
    // muss der Nutzer, und genau dort stand bisher die Rohtextwand.
    await click(mount.container, 'show-more-toggle');

    expect(mount.container.textContent).not.toContain(MARKER);
    expect(mount.container.textContent).not.toContain('Leistungsverzeichnis Position 01');
    expect(mount.container.textContent).not.toContain(t('document.fieldRecognizedText', 'de'));

    unmount(mount);
  });

  it('C: der gespeicherte Text ist unverändert vorhanden', async () => {
    const mount = await mountDetail();
    await click(mount.container, 'show-more-toggle');

    // Entfernt wurde die Darstellung, nicht der Inhalt.
    expect(getDocumentById(DOC_ID)?.recognizedText).toBe(RAW_TEXT);

    unmount(mount);
  });

  it('die übrigen Angaben und Aktionen bleiben erreichbar', async () => {
    const mount = await mountDetail();
    await click(mount.container, 'show-more-toggle');

    const text = mount.container.textContent ?? '';
    // Aussteller, Tag und Unternehmen stehen weiterhin da …
    expect(text).toContain('Beispiel Bau GmbH');
    expect(text).toContain('Vertrag');
    expect(text).toContain('Test GmbH');

    // … und die Aktionen sind unberührt.
    expect(find(mount.container, 'document-detail-delete-trigger')).not.toBeNull();
    expect(text).toContain(t('document.edit', 'de'));

    unmount(mount);
  });
});
