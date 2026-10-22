/**
 * DOKUMENTE-01 / D-017 — Aufbewahrung auf der Dokumentseite.
 *
 * Die Karte „Aufbewahrung" nennt Klasse, Mindestfrist und Grund. Während der
 * Frist gibt es kein „Löschen"; sonst nur über die ausdrückliche
 * Prüfbestätigung. Neutrale Beispieldaten, kein Netzwerk.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alsInhaber } from '../test/workspaceRoleTestUtils';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { getDocumentById, hydrateDocumentStore } from '../services/documentService';
import { resetTestStores } from '../test/resetStores';
import * as supabaseLib from '../lib/supabase';
import { DokumentDetailPage } from './DokumentDetailPage';
import type { CompanyDocument } from '../types/models';

type Mount = { container: HTMLDivElement; root: Root };

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountDetail(documentId: string): Promise<Mount> {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/dokumente/${documentId}`] },
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/dokumente/:id', element: createElement(DokumentDetailPage) }),
            createElement(Route, { path: '/dokumente', element: createElement('div', { 'data-testid': 'liste' }) }),
          ),
        ),
      ),
    );
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (container.querySelector('[data-testid="document-detail-page"]')) break;
    await settle();
  }
  const toggle = container.querySelector('[data-testid="show-more-toggle"]') as HTMLButtonElement | null;
  if (toggle) {
    await act(async () => toggle.click());
    await settle();
  }
  return { container, root };
}

function unmount(mount: Mount): void {
  act(() => mount.root.unmount());
  mount.container.remove();
}

const byTestId = (mount: Mount, id: string) =>
  mount.container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function klick(mount: Mount, id: string): Promise<void> {
  const element = byTestId(mount, id);
  if (!element) throw new Error(`${id} fehlt`);
  await act(async () => element.click());
  for (let attempt = 0; attempt < 10; attempt += 1) await settle();
}

function dokument(id: string, overrides: Partial<CompanyDocument>): CompanyDocument {
  return {
    id,
    title: id,
    category: 'sonstiges',
    issuer: 'Beispiel GmbH',
    recognizedText: 'Sehr geehrte Damen und Herren',
    issueDate: null,
    validUntil: null,
    digitalFolder: { id: 'dig-belege', name: 'Belege', path: '/Belege/' },
    paperFolder: { folderId: 'folder-5', register: 'B', label: 'Belege' },
    tags: [],
    linkedCompany: '',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-03-16T08:00:00.000Z',
    ...overrides,
  } as CompanyDocument;
}

beforeEach(() => {
  resetTestStores();
  alsInhaber();
  // Die Cloud kennt kein Dokument als Zahlungsnachweis.
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    rpc: vi.fn(async () => ({ data: false, error: null })),
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetTestStores();
});

describe('DOKUMENTE-01 — Aufbewahrung auf der Dokumentseite', () => {
  it('D1: Eingangsrechnung — Frist, Grund und Grundlage sichtbar, kein „Löschen"', async () => {
    hydrateDocumentStore([dokument('doc-d1', { classifiedKind: 'eingangsrechnung', issueDate: '2026-03-15' })]);
    const mount = await mountDetail('doc-d1');

    const status = byTestId(mount, 'document-retention-status');
    expect(status?.dataset.retentionStatus).toBe('laeuft');
    expect(status?.textContent).toMatch(/^Buchungsbeleg: gesetzliche Aufbewahrung 8 Jahre, mindestens bis 31\.12\.20\d\d\.$/);
    expect(byTestId(mount, 'document-retention-reason')?.textContent).toBe('Rechnung oder Beleg');
    expect(byTestId(mount, 'document-retention-basis')?.textContent).toContain('§ 14b Abs. 1 UStG');
    expect(byTestId(mount, 'document-retention-paper')).not.toBeNull();
    expect(mount.container.textContent).not.toContain('entsorgt werden');

    expect(byTestId(mount, 'document-detail-delete-trigger')).toBeNull();
    expect(byTestId(mount, 'document-detail-delete-retention')?.textContent).toMatch(
      /^Gesetzliche Aufbewahrung bis 31\.12\.20\d\d – Löschen ist bis dahin gesperrt\.$/,
    );
    unmount(mount);
  });

  it('D2: ohne feste Frist — „prüfen", Löschen nur über die Prüfbestätigung', async () => {
    hydrateDocumentStore([dokument('doc-d2', { classifiedKind: 'brief' })]);
    const mount = await mountDetail('doc-d2');

    expect(byTestId(mount, 'document-retention-status')?.dataset.retentionStatus).toBe('pruefen');
    expect(byTestId(mount, 'document-retention-hint')?.textContent).toContain('schlägt keine Entsorgung vor');
    expect(byTestId(mount, 'document-retention-basis')).toBeNull();
    expect(byTestId(mount, 'document-detail-delete-retention-review')).toBeNull();

    await klick(mount, 'document-detail-delete-trigger');
    expect(byTestId(mount, 'document-detail-delete-retention-review')?.textContent).toContain(
      'nur, wenn Sie geprüft haben, dass es nicht mehr aufbewahrt werden muss',
    );
    expect(byTestId(mount, 'document-detail-delete-confirm')?.textContent).toBe('Aufbewahrung geprüft – endgültig löschen');
    expect(getDocumentById('doc-d2')).toBeDefined();

    await klick(mount, 'document-detail-delete-confirm');
    expect(getDocumentById('doc-d2')).toBeUndefined();
    unmount(mount);
  });

  it('D3: rechnerisch abgelaufen — Hinweis auf die Ablaufhemmung, Löschen nur nach Prüfung', async () => {
    hydrateDocumentStore([
      dokument('doc-d3', {
        classifiedKind: 'quittung',
        documentDate: '2016-05-01',
        uploadedAt: '2016-05-02T09:00:00.000Z',
        createdAt: '2016-05-02T09:00:00.000Z',
      }),
    ]);
    const mount = await mountDetail('doc-d3');

    expect(byTestId(mount, 'document-retention-status')?.textContent).toBe(
      'Buchungsbeleg: Die gesetzliche Mindestfrist von 8 Jahren endete rechnerisch am 31.12.2024.',
    );
    expect(byTestId(mount, 'document-retention-hint')?.textContent).toContain('§ 147 Abs. 3 AO');

    await klick(mount, 'document-detail-delete-trigger');
    expect(byTestId(mount, 'document-detail-delete-retention-review')?.textContent).toContain('31.12.2024');
    await klick(mount, 'document-detail-delete-confirm');
    expect(getDocumentById('doc-d3')).toBeUndefined();
    unmount(mount);
  });
});
