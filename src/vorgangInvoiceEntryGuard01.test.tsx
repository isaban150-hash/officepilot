/**
 * OFFICEPILOT-FINAL-INVOICE-SECOND-DRAFT-UX-01 — kein Einstieg ins Leere.
 *
 * Nach einer finalisierten Schlussrechnung bot der Vorgang weiterhin
 * „Rechnung vorbereiten" an. Der Nutzer landete in einem Editor, dessen offene
 * Mengen sämtlich 0 waren, und erfuhr erst beim Freigabeversuch, dass nichts
 * geht. Der Einstieg für **Schlussrechnungen** prüfte das längst — der
 * allgemeine nicht.
 *
 * Ausdrücklich **keine** Prüfung auf offene Mengen: Solange keine
 * Schlussrechnung existiert, bleibt ein pauschaler Abschlag über 0 € ein
 * legitimer Weg, auch wenn mengenbasiert nichts mehr offen ist.
 *
 * Neutrale Beispieldaten.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { VorgangDetailPage } from './pages/VorgangDetailPage';
import { t, type TranslationKey } from './i18n';
import { hydrateVorgangStore } from './services/vorgangService';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { Vorgang, VorgangInvoice } from './types/models';

const VORGANG_ID = 'v-entry-guard';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-entry-1',
    number: '2026-0003',
    invoiceSequenceNumber: 3,
    type: 'schluss',
    positions: [],
    subtotal: 10000,
    taxStatus: 'null_13b',
    amount: 10000,
    status: 'vorbereitet',
    date: '2026-08-27',
    createdAt: '2026-08-27T10:00:00.000Z',
    issueDate: '2026-08-27',
    paymentDueDate: '2099-12-31',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  } as VorgangInvoice;
}

function seed(invoices: VorgangInvoice[], plannedQuantity = 10): void {
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG_ID,
        status: 'beauftragt',
        orderPositions: [
          createOrderPosition({ id: 'op-1', unit: 'Stunden', plannedQuantity, unitPrice: 65 }),
        ],
      }),
      invoices,
    } as Vorgang,
  ]);
}

function renderPage(container: HTMLDivElement): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/vorgaenge/${VORGANG_ID}`] },
        createElement(
          AppProvider,
          { initialSetup: DEFAULT_SETUP },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/vorgaenge/:id',
              element: createElement(VorgangDetailPage),
            }),
          ),
        ),
      ),
    );
  });
  return root;
}

function openInvoicesSection(container: HTMLDivElement): HTMLElement {
  act(() => {
    (
      container.querySelector('[data-testid="vorgang-section-tab-invoices"]') as HTMLButtonElement
    ).click();
  });
  return container.querySelector('[data-testid="vorgang-invoices-section"]') as HTMLElement;
}

describe('OFFICEPILOT-FINAL-INVOICE-SECOND-DRAFT-UX-01', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetTestStores();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container.remove();
    resetTestStores();
  });

  it('M: ohne Rechnungen bleibt der Einstieg sichtbar', () => {
    seed([]);
    root = renderPage(container);
    const section = openInvoicesSection(container);

    expect(section.querySelector('[data-testid="vorgang-prepare-invoice"]')).not.toBeNull();
    expect(section.textContent).not.toContain(translate('vorgang.invoicesClosedBySchluss'));
  });

  it('N: mit einer Abschlagsrechnung bleibt der Einstieg sichtbar', () => {
    seed([invoice({ id: 'inv-abschlag-1', type: 'abschlag', number: '2026-0001' })]);
    root = renderPage(container);
    const section = openInvoicesSection(container);

    expect(section.querySelector('[data-testid="vorgang-prepare-invoice"]')).not.toBeNull();
  });

  it('O: nach einer vorbereiteten Schlussrechnung verschwindet der Einstieg', () => {
    seed([invoice()]);
    root = renderPage(container);
    const section = openInvoicesSection(container);

    expect(section.querySelector('[data-testid="vorgang-prepare-invoice"]')).toBeNull();
    expect(section.querySelector('[data-testid="vorgang-invoices-closed"]')).not.toBeNull();
    expect(section.textContent).toContain(translate('vorgang.invoicesClosedBySchluss'));
  });

  it('P: dasselbe gilt für eine versendete Schlussrechnung', () => {
    seed([invoice({ status: 'versendet' })]);
    root = renderPage(container);
    const section = openInvoicesSection(container);

    expect(section.querySelector('[data-testid="vorgang-prepare-invoice"]')).toBeNull();
    expect(section.textContent).toContain(translate('vorgang.invoicesClosedBySchluss'));
  });

  it('Q: eine stornierte Schlussrechnung zählt weiterhin als vorhanden', () => {
    /*
     * `cancelledAt` verändert den Status nicht. Client und Server bleiben in
     * diesem Sprint konsistent; eine Wiederabrechenbarkeit nach Storno ist ein
     * eigener Fachpunkt.
     */
    seed([invoice({ cancelledAt: '2026-08-28T08:00:00.000Z' })]);
    root = renderPage(container);
    const section = openInvoicesSection(container);

    expect(section.querySelector('[data-testid="vorgang-prepare-invoice"]')).toBeNull();
  });

  it('R: ohne Schlussrechnung bleibt der Einstieg auch ohne offene Menge sichtbar', () => {
    /*
     * Der Abschlag hat die gesamte Menge verbraucht. Mengenbasiert ist nichts
     * mehr möglich — ein **pauschaler** Abschlag über 0 € sehr wohl. Deshalb
     * hängt der Guard ausschliesslich an der Schlussrechnung.
     */
    seed([
      invoice({
        id: 'inv-abschlag-1',
        type: 'abschlag',
        number: '2026-0001',
        positions: [
          {
            id: 'line-1',
            orderPositionId: 'op-1',
            description: 'Montage',
            quantity: 10,
            unit: 'Stunden',
            unitPrice: 65,
            lineTotal: 650,
          },
        ],
      }),
    ]);
    root = renderPage(container);
    const section = openInvoicesSection(container);

    expect(section.querySelector('[data-testid="vorgang-prepare-invoice"]')).not.toBeNull();
  });
});
