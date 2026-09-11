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
import {
  applyInvoiceCancellationFromCloud,
  getVorgangById,
  hydrateVorgangStore,
} from './services/vorgangService';
import { hasSchlussrechnung } from './services/orderBillingRules';
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

  /*
   * INVOICE-CANCELLED-FINAL-GUARD-01B — ein Storno gibt den Weg wieder frei.
   *
   * Hier stand die Erwartung, eine stornierte Schlussrechnung zähle „weiterhin
   * als vorhanden", mit dem Zusatz, die Wiederabrechenbarkeit sei „ein eigener
   * Fachpunkt". Genau dieser Fachpunkt ist seither umgesetzt: `9018d9a` liest
   * `cancelledAt` erstmals in `isBillingEffective`, und `hasSchlussrechnung`
   * zählt seitdem nur noch abrechnungswirksame Belege.
   *
   * Beide Hälften der Regel gehören zusammen und werden deshalb in einem Test
   * geprüft: Solange die Schlussrechnung wirkt, blockiert sie eine zweite;
   * sobald sie storniert ist, darf ersetzt werden. Storniert heisst dabei
   * nicht gelöscht — der Beleg bleibt im Vorgang stehen.
   */
  it('Q: eine wirksame Schlussrechnung blockiert, eine stornierte gibt wieder frei', () => {
    seed([invoice()]);
    root = renderPage(container);
    const blocked = openInvoicesSection(container);

    // 1. Die aktive Schlussrechnung sperrt den Einstieg — kein zweiter Abschluss.
    expect(
      blocked.querySelector('[data-testid="vorgang-prepare-invoice"]'),
      'Eine aktive Schlussrechnung lässt eine zweite zu',
    ).toBeNull();
    expect(hasSchlussrechnung(getVorgangById(VORGANG_ID)!)).toBe(true);

    /*
     * 2. Storno über den Weg, den auch die Cloud-Antwort nimmt: Der Dienst
     * `applyInvoiceCancellationFromCloud` setzt genau zwei Felder und lässt
     * Status, Nummer und Beträge unangetastet. Ein von Hand kombinierter
     * Zustand würde eine Lage behaupten, die produktiv nie entsteht.
     */
    const cancelled = applyInvoiceCancellationFromCloud(VORGANG_ID, 'inv-entry-1', {
      cancelledAt: '2026-08-28T08:00:00.000Z',
      cancelReason: 'Falscher Leistungszeitraum',
    });
    expect(cancelled.ok, 'Das Storno wurde nicht übernommen').toBe(true);

    const afterCancel = getVorgangById(VORGANG_ID)!;
    // Der Beleg bleibt stehen, nur seine Abrechnungswirkung entfällt.
    expect(afterCancel.invoices).toHaveLength(1);
    expect(afterCancel.invoices[0]!.status, 'Das Storno hat den Status verändert').toBe(
      'vorbereitet',
    );
    expect(
      hasSchlussrechnung(afterCancel),
      'Die stornierte Schlussrechnung zählt weiterhin als wirksam',
    ).toBe(false);

    // 3. Damit ist der Einstieg für eine Ersatz-Schlussrechnung wieder offen.
    act(() => root!.unmount());
    root = renderPage(container);
    const freed = openInvoicesSection(container);
    expect(
      freed.querySelector('[data-testid="vorgang-prepare-invoice"]'),
      'Nach dem Storno bleibt der Einstieg gesperrt',
    ).not.toBeNull();
  });

  /*
   * Der zweite produktive Stornozustand: `paymentStatus: 'storniert'`.
   * `isBillingEffective` kennt beide Wege, und der Guard muss beiden folgen —
   * sonst hinge die Wiederabrechnung davon ab, über welchen Weg storniert wurde.
   */
  it('Q2: auch ein storniertes Zahlungskennzeichen gibt den Einstieg frei', () => {
    seed([invoice({ paymentStatus: 'storniert' })]);
    root = renderPage(container);
    const section = openInvoicesSection(container);

    expect(hasSchlussrechnung(getVorgangById(VORGANG_ID)!)).toBe(false);
    expect(section.querySelector('[data-testid="vorgang-prepare-invoice"]')).not.toBeNull();
  });

  /*
   * Abgrenzung: Ein Storno auf einer **Abschlagsrechnung** darf den
   * Schlussrechnungs-Guard nicht bewegen — er hängt ausschliesslich an der
   * Schlussrechnung.
   */
  it('Q3: ein storniertes Abschlags-Storno verschiebt den Schlussrechnungs-Guard nicht', () => {
    seed([
      invoice({ id: 'inv-abschlag', type: 'abschlag', cancelledAt: '2026-08-28T08:00:00.000Z' }),
      invoice(),
    ]);
    root = renderPage(container);
    const section = openInvoicesSection(container);

    expect(hasSchlussrechnung(getVorgangById(VORGANG_ID)!)).toBe(true);
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
