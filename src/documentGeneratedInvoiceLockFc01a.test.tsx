/**
 * FINANZ-CORE-01A (STO-03) — erzeugte Rechnungs- und Korrekturbelege bleiben
 * geschützt.
 *
 * Bisher: „Bearbeiten" auch für den Beleg einer festgeschriebenen Rechnung,
 * und ein Kategoriewechsel im Formular hob Lösch- und Hochladeschutz auf (der
 * Schutz hing allein an `category === 'ausgangsrechnung'`). Jetzt hängt er an
 * Rechnungsbezug und Belegart; die Seite bietet „Bearbeiten" nicht an.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { alsInhaber } from './test/workspaceRoleTestUtils';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { DokumentDetailPage } from './pages/DokumentDetailPage';
import { archiveOutgoingInvoice } from './services/invoiceArchiveService';
import {
  addDocument,
  getDocumentById,
  isFinalizedInvoiceArchiveDocument,
  isGeneratedOutgoingInvoiceDocument,
  updateDocument,
} from './services/documentService';
import { isGeneratedInvoiceDocumentKind } from './services/document/generatedInvoiceDocumentKind';
import { getVorgangInvoice, hydrateVorgangStore } from './services/vorgangService';
import { resetTestStores } from './test/resetStores';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import type { CompanyDocument, Vorgang, VorgangInvoice } from './types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };
const VORGANG_ID = 'v-sto03';
const INVOICE_ID = 'inv-sto03';

type Mount = { container: HTMLDivElement; root: Root };

function buildInvoice(): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0031',
    type: 'rechnung',
    positions: [
      { id: 'line-1', orderPositionId: 'op-1', description: 'Fassadenanstrich', quantity: 10, unit: 'm²', unitPrice: 100, lineTotal: 1000 },
    ],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    date: '2026-09-20',
    issueDate: '2026-09-20',
    createdAt: '2026-09-20T10:00:00.000Z',
    paymentDueDate: '2099-12-31',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: { name: 'Muster GmbH', contactPerson: '', street: 'Weg 1', zip: '33330', city: 'Beispielstadt', email: '', phone: '' },
  } as VorgangInvoice;
}

function seedAndArchive(): CompanyDocument {
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG_ID,
        status: 'beauftragt',
        customer: 'Muster GmbH',
        title: 'Fassade',
        orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 100 })],
      }),
      invoices: [buildInvoice()],
    } as Vorgang,
  ]);
  const result = archiveOutgoingInvoice(VORGANG_ID, getVorgangInvoice(VORGANG_ID, INVOICE_ID)!, 'Test GmbH');
  if (!result.success) throw new Error('Archivierung fehlgeschlagen');
  return result.document;
}

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
          { initialSetup: setupComplete },
          createElement(Routes, null, createElement(Route, { path: '/dokumente/:id', element: createElement(DokumentDetailPage) })),
        ),
      ),
    );
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (container.querySelector('[data-testid="document-detail-page"]')) break;
    await settle();
  }
  // Die Aktionen liegen hinter „Mehr anzeigen" — wie in browserAcceptanceFix01a.
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

function editButton(mount: Mount): HTMLElement | undefined {
  return [...mount.container.querySelectorAll('.document-detail__actions button')].find(
    (node) => node.textContent?.trim() === 'Bearbeiten',
  ) as HTMLElement | undefined;
}

beforeEach(() => {
  alsInhaber();
  resetTestStores();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetTestStores();
});

describe('STO-03 — erzeugte Rechnungsbelege', () => {
  it('L1: die Detailseite bietet für den erzeugten Beleg kein „Bearbeiten" an', async () => {
    const document = seedAndArchive();
    const mount = await mountDetail(document.id);
    expect(mount.container.querySelector('[data-testid="document-detail-generated-locked"]')).not.toBeNull();
    expect(editButton(mount)).toBeUndefined();
    unmount(mount);
  });

  it('L2: ein Kategoriewechsel (Altbestand oder anderer Weg) hebt den Schutz nicht auf', () => {
    const document = seedAndArchive();
    const changed = updateDocument(document.id, { category: 'sonstiges' });
    expect(changed.success).toBe(true);
    const stored = getDocumentById(document.id)!;
    expect(stored.category).toBe('sonstiges');
    expect(isGeneratedOutgoingInvoiceDocument(stored)).toBe(true);
    expect(isGeneratedInvoiceDocumentKind(stored)).toBe(true);
    expect(isFinalizedInvoiceArchiveDocument(stored)).toBe(true);
  });

  it('L3: ein Fremddokument bleibt bearbeitbar und ist kein Rechnungsbeleg', async () => {
    seedAndArchive();
    const foreign = addDocument({
      title: 'Eingangsrechnung Holz AG',
      category: 'eingangsrechnung',
      issuer: 'Holz AG',
      recognizedText: 'Eingangsrechnung RE-2026-1',
      issueDate: '2026-08-01',
      classifiedKind: 'eingangsrechnung',
      archived: true,
    });
    if (!foreign.success) throw new Error('Fremddokument nicht angelegt');
    expect(isGeneratedInvoiceDocumentKind(foreign.document)).toBe(false);
    const mount = await mountDetail(foreign.document.id);
    expect(editButton(mount)).toBeDefined();
    expect(mount.container.querySelector('[data-testid="document-detail-generated-locked"]')).toBeNull();
    unmount(mount);
  });
});
