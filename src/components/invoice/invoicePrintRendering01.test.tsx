/**
 * INVOICE-MOBILE-PRINT-RENDERING-01B
 *
 * Auf dem iPhone druckte „Drucken" die OfficePilot-Oberfläche statt der
 * Rechnung: Cloud-Banner, Suche, App-Shell — und keinen Beleg.
 *
 * Zwei Ursachen, beide hier festgehalten:
 *
 *   1. Die Rechnung stand bei eingeklapptem „Mehr anzeigen" gar nicht im DOM.
 *      Print-CSS kann nichts einblenden, was nicht gerendert ist.
 *   2. Selbst aufgeklappt lag sie unter `.invoice-detail__toolbar.no-print`,
 *      das im Druck `display:none` bekommt. Ein Nachfahre eines
 *      ausgeblendeten Vorfahren ist nicht rettbar.
 *
 * Dazu kam eine veraltete Positivliste: Jede nach ihr entstandene
 * Chrome-Komponente — Cloud-Banner, globale Suche, Beta-Banner — wurde
 * mitgedruckt.
 *
 * **Was diese Tests beweisen können und was nicht:** JSDOM druckt nicht.
 * Geprüft werden DOM-Struktur, Klassen und der Text der Print-Regeln. Ob
 * Safari die Seite tatsächlich so ausgibt, entscheidet erst das Realgerät.
 * Hier wird keine Rendering-Garantie behauptet.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgang } from '../../test/fixtures';
import { hydrateVorgangStore } from '../../services/vorgangService';
import { buildInvoicePrintModelFromInvoice } from '../../services/invoicePrintModel';
import * as invoicePrintService from '../../services/invoicePrintService';
import { InvoiceDetailPage } from '../../pages/InvoiceDetailPage';
import { InvoicePrintActions } from './InvoicePrintActions';
import type { TranslationKey } from '../../i18n';
import type { VorgangInvoice } from '../../types/models';

const VORGANG_ID = 'v-print-01b';
const INVOICE_ID = 'inv-print-01b';

function translate(key: TranslationKey): string {
  return key;
}

/** Die Realgerät-Rechnung: 2026-0011, 20 Stunden, 2.000 netto. */
function finalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0011',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-test-1',
        description: 'Montage- und Anpassungsarbeiten',
        quantity: 20,
        unit: 'Stunden',
        unitPrice: 100,
        lineTotal: 2000,
      },
    ],
    subtotal: 2000,
    taxStatus: 'standard_19',
    amount: 2380,
    status: 'vorbereitet',
    date: '2026-09-06',
    createdAt: '2026-09-06T10:00:00.000Z',
    issueDate: '2026-09-06',
    servicePeriodFrom: '2026-09-01',
    servicePeriodTo: '2026-09-05',
    servicePeriodConfirmed: true,
    paymentDueDate: '2099-09-20',
    paymentTermsText: 'Zahlbar in 14 Tagen',
    skontoText: '',
    customerSnapshot: {
      name: 'M5 Testbau GmbH',
      contactPerson: '',
      street: 'Musterweg 1',
      zip: '12345',
      city: 'Beispielstadt',
      email: '',
      phone: '',
    },
    companySnapshot: {
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Beispiel Betrieb GmbH',
      street: 'Werkstraße 2',
      zip: '54321',
      city: 'Beispielstadt',
      iban: 'DE00 0000 0000 0000 0000 00',
    },
    legalNotices: [],
    previousAbschlagDeductions: [],
    baustelle: 'Teststraße 1',
    vorgangTitle: 'Testvorgang',
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  };
}

function renderDetailPage(invoice: VorgangInvoice, search = ''): string {
  hydrateVorgangStore([
    createTestVorgang({
      id: VORGANG_ID,
      title: 'Testvorgang',
      customer: 'M5 Testbau GmbH',
      invoices: [invoice],
    }),
  ]);

  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [`/vorgaenge/${VORGANG_ID}/rechnungen/${invoice.id}${search}`] },
      createElement(
        AppProvider,
        { initialSetup: DEFAULT_SETUP },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/vorgaenge/:id/rechnungen/:invoiceId',
            element: createElement(InvoiceDetailPage),
          }),
        ),
      ),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* DOM — die Rechnung muss da sein, ohne dass jemand etwas aufklappt           */
/* -------------------------------------------------------------------------- */

describe('PRINT-RENDERING-01B — Rechnungsdokument im DOM', () => {
  it('P3/P4: das Rechnungsdokument steht auch bei eingeklapptem „Mehr anzeigen" im DOM', () => {
    const html = renderDetailPage(finalizedInvoice());

    // Der Ausgangszustand der Seite: nichts aufgeklappt.
    expect(html).not.toContain('data-testid="show-more-content"');
    expect(html).toContain('invoice-print-document');
  });

  it('P5: die Rechnungsnummer steht im Dokument', () => {
    expect(renderDetailPage(finalizedInvoice())).toContain('2026-0011');
  });

  it('P6: der Leistungszeitraum steht im Dokument', () => {
    const html = renderDetailPage(finalizedInvoice());
    /*
     * Die bestehende Darstellung von `formatInvoiceDate` (`de-DE`, ohne
     * führende Nullen) — ausdrücklich nicht neu formatiert, damit Druck und
     * PDF nicht auseinanderlaufen.
     */
    expect(html).toContain('1.9.2026');
    expect(html).toContain('5.9.2026');
  });

  it('P7: Position und Summen stehen im Dokument', () => {
    const html = renderDetailPage(finalizedInvoice());
    expect(html).toContain('Montage- und Anpassungsarbeiten');
    expect(html).toContain('2.000');
    expect(html).toContain('2.380');
  });

  it('P17/P18: es entsteht kein zweites Rechnungsdokument', () => {
    /*
     * Ein sichtbares Exemplar für „Mehr anzeigen" **und** ein verstecktes für
     * den Druck wären zwei Wahrheiten, die auseinanderlaufen können. Es bleibt
     * bei einem Knoten, gespeist aus demselben `InvoicePrintModel` wie das PDF.
     */
    const html = renderDetailPage(finalizedInvoice());
    expect(html.split('data-testid="invoice-print-document"').length - 1).toBe(1);
    expect(html.split('invoice-document__sheet').length - 1).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* DOM — kein ausgeblendeter Vorfahre                                          */
/* -------------------------------------------------------------------------- */

describe('PRINT-RENDERING-01B — kein no-print-Vorfahre', () => {
  it('P8: das Rechnungsdokument liegt nicht innerhalb der Werkzeugleiste', () => {
    const html = renderDetailPage(finalizedInvoice());

    const toolbarStart = html.indexOf('invoice-detail__toolbar');
    const documentStart = html.indexOf('invoice-print-document');
    expect(toolbarStart).toBeGreaterThanOrEqual(0);
    expect(documentStart).toBeGreaterThanOrEqual(0);

    /*
     * Die Werkzeugleiste wird im Druck ausgeblendet. Läge das Dokument darin,
     * wäre es unrettbar — ein `display:none` am Vorfahren lässt sich von keiner
     * Nachfahren-Regel zurücknehmen. Deshalb muss es **danach** kommen, als
     * Geschwister, nicht als Kind.
     */
    expect(documentStart).toBeGreaterThan(toolbarStart);

    const toolbarSlice = html.slice(toolbarStart, documentStart);
    const opened = toolbarSlice.split('<div').length - 1;
    const closed = toolbarSlice.split('</div>').length - 1;
    // Die Werkzeugleiste ist geschlossen, bevor das Dokument beginnt.
    expect(closed).toBeGreaterThanOrEqual(opened);
  });
});

/* -------------------------------------------------------------------------- */
/* CSS — Isolation statt wachsender Ausschlussliste                            */
/* -------------------------------------------------------------------------- */

describe('PRINT-RENDERING-01B — Print-CSS isoliert das Dokument', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
  const printBlock = (() => {
    const start = css.indexOf('@media print');
    expect(start).toBeGreaterThanOrEqual(0);
    // Bis zum Ende der Datei reicht: danach folgt kein zweiter Print-Block.
    return css.slice(start);
  })();

  it('P9: der Rechnungscontainer wird ausdrücklich sichtbar gehalten', () => {
    expect(printBlock).toContain('.invoice-print-document');
    expect(printBlock).toMatch(/\.invoice-print-document[^}]*\{[^}]*display:\s*block\s*!important/s);
  });

  it('P10/P29: die App-Shell wird pauschal ausgeblendet, nicht Komponente für Komponente', () => {
    /*
     * Der Kern der Umstellung: eine Isolationsregel statt einer Positivliste.
     * Eine neue Banner-Komponente darf nicht erst durch einen Nachtrag in die
     * Ausschlussliste aus dem Druck verschwinden — sie muss von vornherein
     * draussen sein.
     */
    expect(printBlock).toMatch(/body\.invoice-print-active\s+\.app-shell\s*>\s*\*/);
    expect(printBlock).toMatch(/body\.invoice-print-active\s+\.app-shell__body\s*>\s*\*/);
    expect(printBlock).toMatch(/body\.invoice-print-active\s+\.page--invoice-detail\s*>\s*\*/);
  });

  it('P11-P16: die namentlich bekannten Chrome-Bereiche bleiben zusätzlich abgedeckt', () => {
    for (const selector of [
      '.app-shell__top',
      '.app-shell__search',
      '.bottom-nav',
      '.sidebar-nav',
      '.persistence-failure-banner',
      '.invoice-print-actions',
      '.invoice-detail__toolbar',
    ]) {
      expect(printBlock, selector).toContain(selector);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Gate — unverändert                                                          */
/* -------------------------------------------------------------------------- */

describe('PRINT-RENDERING-01B — der Gate bleibt', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.restoreAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function render(invoice: VorgangInvoice): void {
    const model = buildInvoicePrintModelFromInvoice(invoice);
    act(() => {
      root.render(createElement(InvoicePrintActions, { invoice, model, translate }));
    });
  }

  it('P1: eine unbestätigte Rechnung erreicht window.print nicht', () => {
    const spy = vi.spyOn(invoicePrintService, 'printInvoice').mockImplementation(() => {});
    render(finalizedInvoice({ servicePeriodConfirmed: undefined }));
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="invoice-print"]')!.click();
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('P2: eine freigegebene Rechnung druckt', () => {
    const spy = vi.spyOn(invoicePrintService, 'printInvoice').mockImplementation(() => {});
    render(finalizedInvoice());
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="invoice-print"]')!.click();
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* auto=print                                                                  */
/* -------------------------------------------------------------------------- */

describe('PRINT-RENDERING-01B — auto=print', () => {
  it('P21: auch im Auto-Print-Aufruf steht das Dokument unabhängig von showDetails im DOM', () => {
    const html = renderDetailPage(finalizedInvoice(), '?auto=print');
    expect(html).toContain('invoice-print-document');
    expect(html).not.toContain('data-testid="show-more-content"');
  });
});
