/**
 * GO-LIVE-SECURITY-01 — Client-Nacharbeit, Oberfläche: Löschen auf der
 * Dokumentseite.
 *
 * Löschen ist Verwaltung. Ein Mitglied sieht statt „Löschen" einen
 * Rollenhinweis; Inhaber behalten den Löschweg. Neutrale Beispieldaten, kein
 * Netzwerk.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alsInhaber, alsMitglied } from '../test/workspaceRoleTestUtils';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { addDocument, getDocumentById } from '../services/documentService';
import { resetTestStores } from '../test/resetStores';
import { DokumentDetailPage } from './DokumentDetailPage';

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

function fremddokument(): string {
  const result = addDocument({
    title: 'Eingangsrechnung Holz AG',
    category: 'eingangsrechnung',
    issuer: 'Holz AG',
    recognizedText: 'Eingangsrechnung RE-2026-1',
    issueDate: '2026-08-01',
    classifiedKind: 'eingangsrechnung',
    archived: true,
  });
  if (!result.success) throw new Error('Dokument nicht angelegt');
  return result.document.id;
}

const byTestId = (mount: Mount, id: string) =>
  mount.container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

beforeEach(() => resetTestStores());
afterEach(() => {
  vi.restoreAllMocks();
  resetTestStores();
});

describe('GLS01 UI — Löschen auf der Dokumentseite', () => {
  it('U8: ein Mitglied sieht einen Rollenhinweis statt „Löschen"; das Dokument bleibt', async () => {
    alsMitglied();
    const id = fremddokument();
    const mount = await mountDetail(id);

    expect(byTestId(mount, 'document-detail-delete-trigger')).toBeNull();
    expect(byTestId(mount, 'document-detail-delete-confirm')).toBeNull();
    expect(byTestId(mount, 'document-detail-delete-role-hint')?.textContent).toBe(
      'Dokumente löschen nur Inhaber und Verwaltung.',
    );
    // Bearbeiten bleibt; gelöscht ist nichts.
    expect(mount.container.textContent).toContain('Bearbeiten');
    expect(getDocumentById(id)).toBeDefined();

    unmount(mount);
  });

  it('U9: Inhaber behalten den Löschweg', async () => {
    alsInhaber();
    /*
     * DOKUMENTE-01 / D-017 — die Eingangsrechnung aus U8 ist ein Buchungsbeleg mit
     * laufender Aufbewahrung; den Löschweg zeigt hier ein Dokument ohne feste Frist.
     */
    const result = addDocument({
      title: 'Schreiben Holz AG',
      category: 'sonstiges',
      issuer: 'Holz AG',
      recognizedText: 'Sehr geehrte Damen und Herren',
      issueDate: '2026-08-01',
      classifiedKind: 'brief',
      archived: true,
    });
    if (!result.success) throw new Error('Dokument nicht angelegt');
    const mount = await mountDetail(result.document.id);

    expect(byTestId(mount, 'document-detail-delete-trigger')).not.toBeNull();
    expect(byTestId(mount, 'document-detail-delete-role-hint')).toBeNull();

    unmount(mount);
  });

  it('U9b: bei laufender Aufbewahrung sieht auch der Inhaber die Frist statt „Löschen"', async () => {
    alsInhaber();
    const id = fremddokument();
    const mount = await mountDetail(id);

    expect(byTestId(mount, 'document-detail-delete-trigger')).toBeNull();
    expect(byTestId(mount, 'document-detail-delete-role-hint')).toBeNull();
    expect(byTestId(mount, 'document-detail-delete-retention')).not.toBeNull();

    unmount(mount);
  });
});
