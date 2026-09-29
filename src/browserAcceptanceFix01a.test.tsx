/**
 * BROWSER-ACCEPTANCE-FIX 01 / Block A — A1 und A3 an der gerenderten Seite.
 *
 * A1: Der Beleg einer festgeschriebenen Ausgangsrechnung bietet kein „Löschen"
 *     an und sagt, warum. Fremddokumente behalten den Löschweg.
 * A3: Die eigene, verknüpfte Ausgangsrechnung wird aus ihrer Verknüpfung
 *     verstanden — kein anderer „wahrscheinlicher Kunde", kein „Nicht sicher
 *     erkannt" neben „Ja – Zahlungseingang überwachen", keine Auswahlaufforderung,
 *     keine Zuordnungsunsicherheit. Eingehende Post bleibt unverändert.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { DokumentDetailPage } from './pages/DokumentDetailPage';
import { archiveOutgoingInvoice } from './services/invoiceArchiveService';
import { addDocument } from './services/documentService';
import { hydrateCustomerStore } from './services/customerStoreService';
import { getVorgangInvoice, hydrateVorgangStore } from './services/vorgangService';
import { buildDocumentMeaningView } from './services/document/documentMeaningPresentationService';
import { resetTestStores } from './test/resetStores';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import type { CompanyDocument, Customer, Vorgang, VorgangInvoice } from './types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };
const VORGANG_ID = 'v-baf01';
const INVOICE_ID = 'inv-baf01';
const CUSTOMER = 'Resume Testbau GmbH';

type Mount = { container: HTMLDivElement; root: Root };

function buildInvoice(status: VorgangInvoice['status']): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0018',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Fassadenanstrich',
        quantity: 10,
        unit: 'm²',
        unitPrice: 100,
        lineTotal: 1000,
      },
    ],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status,
    date: '2026-09-20',
    issueDate: '2026-09-20',
    createdAt: '2026-09-20T10:00:00.000Z',
    paymentDueDate: '2099-12-31',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: {
      name: CUSTOMER,
      contactPerson: '',
      street: 'Weg 1',
      zip: '33330',
      city: 'Beispielstadt',
      email: '',
      phone: '',
    },
  } as VorgangInvoice;
}

function customer(id: string, name: string): Customer {
  return {
    id,
    name,
    contactPerson: '',
    street: 'Weg 1',
    zip: '33330',
    city: 'Beispielstadt',
    email: '',
    phone: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as Customer;
}

function seed(status: VorgangInvoice['status'] = 'versendet'): void {
  /*
   * Zwei ähnliche Kunden — genau die Lage, in der die Fremdpost-Heuristik einen
   * anderen „wahrscheinlichen Kunden" vorschlug und zur Auswahl aufforderte.
   */
  hydrateCustomerStore([
    customer('c-resume', CUSTOMER),
    customer('c-testbau', 'Testbau Nord GmbH'),
  ]);
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG_ID,
        status: 'beauftragt',
        customer: CUSTOMER,
        customerId: 'c-resume',
        title: 'Fassade Testbau',
        orderPositions: [
          createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 100 }),
        ],
      }),
      invoices: [buildInvoice(status)],
    } as Vorgang,
  ]);
}

function archiveInvoice(): CompanyDocument {
  const invoice = getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
  const result = archiveOutgoingInvoice(VORGANG_ID, invoice, 'Test GmbH');
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

describe('BROWSER-ACCEPTANCE-FIX 01 / A1 — Löschschutz in der Oberfläche', () => {
  beforeEach(() => resetTestStores());
  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it.each(['versendet', 'vorbereitet'] as const)(
    'A1-UI-1: Beleg einer %s Rechnung bietet kein Löschen an und erklärt es',
    async (status) => {
      seed(status);
      const document = archiveInvoice();
      const mount = await mountDetail(document.id);

      expect(byTestId(mount, 'document-detail-delete-trigger')).toBeNull();
      expect(byTestId(mount, 'document-detail-delete-confirm')).toBeNull();
      expect(byTestId(mount, 'document-detail-delete-protected')?.textContent).toBe(
        'Dieses Dokument ist der archivierte Beleg einer festgeschriebenen Rechnung und kann nicht gelöscht werden.',
      );
      // Bearbeiten und die übrigen Aktionen bleiben.
      expect(mount.container.textContent).toContain('Rechnung öffnen');

      unmount(mount);
    },
  );

  it('A1-UI-2: ein normales Dokument behält den Löschweg', async () => {
    seed();
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
    const mount = await mountDetail(foreign.document.id);

    expect(byTestId(mount, 'document-detail-delete-trigger')).not.toBeNull();
    expect(byTestId(mount, 'document-detail-delete-protected')).toBeNull();

    unmount(mount);
  });
});

describe('BROWSER-ACCEPTANCE-FIX 01 / A3 — eigene Rechnung statt Eingangsanalyse', () => {
  beforeEach(() => resetTestStores());
  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('A3-1: Vorbedingung — die Fremdpost-Heuristik allein würde hier zweifeln', () => {
    seed();
    const document = archiveInvoice();
    const intake = buildDocumentMeaningView({ text: document.recognizedText, sender: document.issuer });
    /*
     * Dieselbe Rechnung als unbekannte Eingangspost gelesen: Das ist der alte
     * Weg der Seite. Der Test hält fest, warum A3 nötig war — nicht, dass es so
     * bleiben muss.
     */
    expect(intake.actionNeed === 'unclear' || intake.uncertainties.length > 0 || intake.customerCandidates.length !== 1).toBe(true);
  });

  it('A3-2: Verknüpfung gewinnt — ein Kunde, ein Auftrag, keine Auswahl, keine Unsicherheit', async () => {
    seed();
    const document = archiveInvoice();
    const mount = await mountDetail(document.id);

    const panel = byTestId(mount, 'document-meaning-panel');
    expect(panel).not.toBeNull();
    const panelText = panel!.textContent ?? '';

    // Keine widersprüchlichen Handlungsaussagen.
    expect(byTestId(mount, 'document-meaning-action')?.textContent).toBe('Ja – Zahlungseingang überwachen.');
    expect(mount.container.textContent).not.toContain('Nicht sicher erkannt');
    // Kein alternativer Kunde, keine Auswahlaufforderung, keine Intake-Unsicherheit.
    const customers = byTestId(mount, 'document-meaning-customer-candidates');
    const customerNames = [...(customers?.querySelectorAll('.document-meaning__candidate-name') ?? [])].map(
      (node) => node.textContent,
    );
    expect(customerNames).toEqual([CUSTOMER]);
    expect(panelText).not.toContain('Testbau Nord GmbH');
    expect(panelText).not.toContain('Wahrscheinlicher Kunde');
    expect(panelText).not.toContain('Wahrscheinlicher Auftrag');
    expect(mount.container.textContent).not.toContain('Bitte wählen Sie selbst aus');
    // Kein „Bitte prüfen“ an der Zuordnung (der allgemeine Hinweis am Ende bleibt).
    expect(panel!.querySelectorAll('.document-meaning__candidate .document-meaning__hint').length).toBe(0);
    expect(byTestId(mount, 'document-meaning-uncertain')).toBeNull();
    expect(panelText).not.toContain('Kunde und Auftrag konnten nicht zugeordnet werden');
    // Die autoritative Zuordnung ist als solche erkennbar.
    expect(panelText).toContain('Aus der Rechnung übernommen');
    const vorgaenge = byTestId(mount, 'document-meaning-vorgang-candidates');
    expect(vorgaenge?.textContent).toContain('Fassade Testbau');
    // Nächster Schritt aus dem Rechnungsstatus, nicht „Zuordnung bestätigen".
    expect(byTestId(mount, 'document-meaning-next-step')?.textContent).toBe(
      'Zahlungseingang prüfen und Zahlung in der Rechnung erfassen.',
    );
    expect(mount.container.textContent).not.toContain('Zuordnung bestätigen');
    // Die Erklärung darunter sagt dasselbe.
    expect(mount.container.textContent).toContain('Ja – Zahlungseingang überwachen.');
    // Keine Buchungsaufforderung für die eigene Einnahme.
    expect(byTestId(mount, 'document-meaning-accounting')?.textContent).toBe('Eigene Rechnung – bereits erfasst');

    unmount(mount);
  });

  it('A3-3: die Analyse wird nicht versteckt — Rechnungsinhalt bleibt sichtbar', async () => {
    seed();
    const document = archiveInvoice();
    const mount = await mountDetail(document.id);

    expect(byTestId(mount, 'document-meaning-panel')).not.toBeNull();
    expect(byTestId(mount, 'document-meaning-action')).not.toBeNull();
    expect(mount.container.textContent).toContain('2026-0018');
    expect(mount.container.textContent).toContain('Muss ich etwas tun?');

    unmount(mount);
  });

  it('A3-4: bezahlte Rechnung — dieselbe Antwort oben und in der Erklärung', async () => {
    seed();
    hydrateVorgangStore([
      {
        ...createTestVorgang({
          id: VORGANG_ID,
          status: 'beauftragt',
          customer: CUSTOMER,
          title: 'Fassade Testbau',
          orderPositions: [
            createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 100 }),
          ],
        }),
        invoices: [
          {
            ...buildInvoice('versendet'),
            paymentStatus: 'bezahlt',
            payments: [{ id: 'p-1', amount: 1190, date: '2026-09-25', createdAt: '2026-09-25T10:00:00.000Z' }],
          } as VorgangInvoice,
        ],
      } as Vorgang,
    ]);
    const document = archiveInvoice();
    const mount = await mountDetail(document.id);

    expect(byTestId(mount, 'document-meaning-action')?.textContent).toBe('Nein – Rechnung ist bezahlt.');
    expect(mount.container.textContent).not.toContain('Ja – Zahlungseingang überwachen.');

    unmount(mount);
  });

  it('A3-5: eingehende Post behält Kandidaten, Auswahl und Unsicherheit', async () => {
    seed();
    const foreign = addDocument({
      title: 'Schreiben Testbau',
      category: 'sonstiges',
      issuer: 'Unbekannt',
      recognizedText:
        'Sehr geehrte Damen und Herren,\nwir beziehen uns auf das Projekt mit Resume Testbau GmbH und Testbau Nord GmbH.\nMit freundlichen Grüßen',
      issueDate: '2026-08-01',
      classifiedKind: 'sonstiges',
      archived: true,
    });
    if (!foreign.success) throw new Error('Fremddokument nicht angelegt');
    const mount = await mountDetail(foreign.document.id);
    const panelText = byTestId(mount, 'document-meaning-panel')?.textContent ?? '';

    expect(panelText).not.toContain('Aus der Rechnung übernommen');
    expect(panelText).not.toContain('Eigene Rechnung – bereits erfasst');
    // Die Fremdpost-Sprache bleibt: Vorschläge sind Vorschläge.
    if (byTestId(mount, 'document-meaning-customer-candidates')) {
      expect(panelText).toContain('Wahrscheinlicher Kunde');
    }
    expect(['Ja', 'Nein', 'Nicht sicher erkannt']).toContain(
      byTestId(mount, 'document-meaning-action')?.textContent,
    );

    unmount(mount);
  });
});
