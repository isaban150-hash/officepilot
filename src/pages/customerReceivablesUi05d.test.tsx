/**
 * FINANZCORE-05D — die offenen Posten in der sichtbaren Kundenakte.
 *
 * Die Seite fragt den Saldo ohne Betrachtungsdatum ab und arbeitet damit gegen
 * die echte Uhr. Deshalb werden hier nur Fälligkeiten benutzt, die unabhängig
 * vom Testtag eindeutig sind: weit in der Vergangenheit (immer überfällig)
 * oder weit in der Zukunft (nie überfällig). Die genauen Schwellen der
 * Altersklassen prüft `customerReceivables05d.test.ts` gegen ein festes Datum.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { KundenDetailPage } from './KundenDetailPage';
import { createTestVorgang } from '../test/fixtures';
import { hydrateCustomerStore } from '../services/customerStoreService';
import { hydrateVorgangStore, getAllVorgaenge } from '../services/vorgangService';
import { recordPayment, removePayment } from '../services/invoicePaymentService';
import { resetTestStores } from '../test/resetStores';
import type { Customer, VorgangInvoice } from '../types/models';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };
const KUNDE = 'cust-05d';
const VORGANG_ID = 'v-05d';

function kunde(): Customer {
  return {
    id: KUNDE,
    name: 'AZ Testbau GmbH',
    street: 'Industriestrasse 12',
    zip: '33602',
    city: 'Bielefeld',
    createdAt: '2026-01-01T10:00:00.000Z',
  } as Customer;
}

let nr = 0;

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  nr += 1;
  const amount = overrides.amount ?? 119;
  return {
    id: `inv-05d-${nr}`,
    number: `2026-${String(2000 + nr)}`,
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Leistung',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: amount,
        lineTotal: amount,
      },
    ],
    subtotal: amount,
    taxStatus: 'standard_19',
    amount,
    status: 'versendet',
    sentAt: '2026-06-01',
    sentVia: 'email',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
    customerId: KUNDE,
    customerSnapshot: {
      name: 'AZ Testbau GmbH',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    },
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Muster GmbH' },
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  };
}

function zahlung(amount: number, id: string) {
  return { id, date: '2026-06-05', amount, createdAt: '2026-06-05T08:00:00.000Z' };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetTestStores();
  nr = 0;
  hydrateCustomerStore([kunde()]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // `zeigeAkte` haengt den Root ab und neu an; der erste Aufruf braucht einen gemounteten.
  act(() => root.render(<div />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetTestStores();
});

async function zeigeAkte(): Promise<void> {
  // Neu betreten statt neu rendern — siehe Kopfkommentar zu X10.
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/kunden/customer/${KUNDE}`]}>
        <AppProvider initialSetup={completeSetup}>
          <Routes>
            <Route path="/kunden/customer/:customerId" element={<KundenDetailPage kind="customer" />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
}

async function mitRechnungen(...invoices: VorgangInvoice[]): Promise<void> {
  hydrateVorgangStore([
    createTestVorgang({ id: VORGANG_ID, customerId: KUNDE, invoices }),
  ]);
  await zeigeAkte();
}

const q = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
const wert = (testId: string) => q(testId)?.textContent ?? '';
const text = () => container.textContent ?? '';

/* ================================================================== */

describe('X — Kundenakte, offene Posten', () => {
  /* X1–X4 — die vier Kennzahlen. */
  it('X1–X4: Offene Forderungen, Überfällig, Kundenguthaben und Saldo stehen da', async () => {
    await mitRechnungen(
      rechnung({ amount: 100 }),
      rechnung({ amount: 50, payments: [zahlung(70, 'p1')] }),
    );

    expect(q('kunden-receivables-section'), 'der Bereich fehlt').not.toBeNull();
    expect(wert('kunden-receivables-open')).toContain('100,00');
    expect(wert('kunden-receivables-overdue')).toContain('0,00');
    expect(wert('kunden-receivables-credit')).toContain('20,00');
    expect(wert('kunden-receivables-net')).toContain('80,00');
    expect(wert('kunden-receivables-open-count')).toBe('1');
  });

  it('X2b: eine überfällige Rechnung erscheint unter „Davon überfällig“', async () => {
    await mitRechnungen(rechnung({ amount: 300, paymentDueDate: '2020-01-15' }));
    expect(wert('kunden-receivables-open')).toContain('300,00');
    expect(wert('kunden-receivables-overdue')).toContain('300,00');
    expect(wert('kunden-receivables-overdue-count')).toBe('1');
    expect(wert('kunden-receivables-aging-over90')).toContain('300,00');
  });

  /* X5 — die offene Rechnung mit ihrem Restbetrag. */
  it('X5/X6: eine teilbezahlte Rechnung steht mit Restbetrag in der Liste', async () => {
    const invoice = rechnung({ amount: 119, payments: [zahlung(70, 'p1')] });
    await mitRechnungen(invoice);

    expect(wert(`kunden-receivable-open-${invoice.id}`)).toContain('49,00');
    const meta = wert(`kunden-receivable-meta-${invoice.id}`);
    expect(meta, 'Rechnungsbetrag fehlt').toContain('119,00');
    expect(meta, 'bezahlter Betrag fehlt').toContain('70,00');
    expect(meta, 'Fälligkeit fehlt').toContain('15.6.2099');
    expect(text()).toContain(invoice.number);
  });

  /* X7 — die Überzahlung steht getrennt. */
  it('X7: eine überbezahlte Rechnung steht im eigenen Guthaben-Abschnitt', async () => {
    const offen = rechnung({ amount: 100 });
    const ueber = rechnung({ amount: 119, payments: [zahlung(130, 'p1')] });
    await mitRechnungen(offen, ueber);

    expect(q(`kunden-credit-${ueber.id}`), 'der Guthabenabschnitt fehlt').not.toBeNull();
    expect(wert(`kunden-credit-amount-${ueber.id}`)).toContain('11,00');
    // Und sie taucht nicht zwischen den offenen Posten auf.
    expect(q(`kunden-receivable-${ueber.id}`)).toBeNull();
    expect(q(`kunden-receivable-${offen.id}`)).not.toBeNull();
    // Der Hinweis sagt, dass nichts automatisch verrechnet wird.
    expect(q('kunden-receivables-credit-hint')).not.toBeNull();
    expect(q('kunden-receivables-net-hint')).not.toBeNull();
  });

  /* X8 — keine technischen Schlüssel. */
  it('X8: in der Kundenakte steht kein technischer Schlüssel', async () => {
    await mitRechnungen(
      rechnung({ amount: 100, paymentDueDate: '2020-01-15' }),
      rechnung({ amount: 119, payments: [zahlung(130, 'p1')] }),
    );
    const sichtbar = text();
    expect(sichtbar).not.toMatch(/kunden\.receivables\./);
    expect(sichtbar).not.toMatch(/payment\.status\./);
    expect(sichtbar).not.toContain('ueberbezahlt');
    expect(sichtbar).not.toContain('ueberfaellig');
    expect(sichtbar).not.toMatch(/notDue|days1to30|over90/);
    // Die Begriffe stehen stattdessen auf Deutsch da.
    expect(sichtbar).toContain('Offene Forderungen');
    expect(sichtbar).toContain('Kundenguthaben');
    expect(sichtbar).toContain('Rechnerischer Saldo');
    /*
     * Das Abzeichen der offenen Rechnung. „Überbezahlt" steht hier
     * bewusst nicht: Die überbezahlte Rechnung liegt im Guthaben-
     * abschnitt, dessen Überschrift das bereits sagt — ein Statusabzeichen
     * daneben wäre dieselbe Aussage zweimal.
     */
    expect(sichtbar).toContain('Überfällig');
    expect(sichtbar).toContain('Kundenguthaben / Überzahlungen');
  });

  /* X9 — der Leerzustand. */
  it('X9: ein Kunde ohne offene Forderungen bekommt einen Satz, keine Nullenwand', async () => {
    await mitRechnungen(rechnung({ amount: 119, payments: [zahlung(119, 'p1')] }));

    expect(q('kunden-receivables-empty'), 'der Leerzustand fehlt').not.toBeNull();
    expect(text()).toContain('Keine offenen Forderungen.');
    expect(q('kunden-receivables-summary'), 'keine Kennzahlenwand im Leerzustand').toBeNull();
    expect(q('kunden-receivables-aging')).toBeNull();
  });

  it('X9b: ein Kunde ganz ohne Rechnungen ebenso', async () => {
    hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID, customerId: KUNDE, invoices: [] })]);
    await zeigeAkte();
    expect(q('kunden-receivables-empty')).not.toBeNull();
  });

  /*
   * P — ein Guthaben ohne offene Forderung ist kein Leerzustand. Es muss
   * sichtbar bleiben, sonst verschwindet Geld aus dem Blick.
   */
  it('X9c: ein Guthaben ohne offene Forderung bleibt sichtbar', async () => {
    const ueber = rechnung({ amount: 119, payments: [zahlung(130, 'p1')] });
    await mitRechnungen(ueber);

    expect(q('kunden-receivables-empty')).toBeNull();
    expect(wert('kunden-receivables-credit')).toContain('11,00');
    expect(wert('kunden-receivables-net')).toContain('-11,00');
    expect(wert(`kunden-credit-amount-${ueber.id}`)).toContain('11,00');
    // Keine Altersstruktur, wenn nichts offen ist.
    expect(q('kunden-receivables-aging')).toBeNull();
  });

  /* X10 — der Saldo folgt einer Zahlungsänderung. */
  it('X10: nach einer Zahlung zeigt die Akte den neuen Saldo', async () => {
    const invoice = rechnung({ amount: 119 });
    await mitRechnungen(invoice);
    expect(wert('kunden-receivables-open')).toContain('119,00');

    await act(async () => {
      recordPayment(VORGANG_ID, invoice.id, { date: '2026-06-08', amount: 70 }, {});
    });
    await zeigeAkte();
    expect(wert('kunden-receivables-open')).toContain('49,00');

    // Überzahlung — und danach die Rücknahme.
    await act(async () => {
      recordPayment(
        VORGANG_ID,
        invoice.id,
        { date: '2026-06-09', amount: 60 },
        { confirmOverpayment: true },
      );
    });
    await zeigeAkte();
    expect(wert('kunden-receivables-credit')).toContain('11,00');
    expect(wert('kunden-receivables-net')).toContain('-11,00');

    const zuViel = getAllVorgaenge()[0].invoices.find((i) => i.id === invoice.id)!
      .payments!.find((p) => p.amount === 60)!;
    await act(async () => {
      removePayment(VORGANG_ID, invoice.id, zuViel.id);
    });
    await zeigeAkte();
    expect(wert('kunden-receivables-open')).toContain('49,00');
    expect(wert('kunden-receivables-credit')).toContain('0,00');
  });

  /*
   * X11 — nichts wird gespeichert. Ein erneutes Befüllen des Speichers, wie es
   * ein Reload oder ein Workspace-Wechsel tut, ergibt denselben Zustand.
   */
  it('X11: nach erneutem Hydrieren steht derselbe Saldo', async () => {
    const invoice = rechnung({ amount: 119, payments: [zahlung(70, 'p1')] });
    await mitRechnungen(invoice);
    const vorher = wert('kunden-receivables-open');

    hydrateVorgangStore([
      createTestVorgang({ id: VORGANG_ID, customerId: KUNDE, invoices: [invoice] }),
    ]);
    await zeigeAkte();
    expect(wert('kunden-receivables-open')).toBe(vorher);
    expect(wert('kunden-receivables-open')).toContain('49,00');
  });

  /* S — eine Rechnung eines anderen Kunden gehört nicht in diese Akte. */
  it('S: die Akte zeigt nur Rechnungen dieses Kunden', async () => {
    const meine = rechnung({ amount: 100, customerId: KUNDE });
    const fremde = rechnung({ amount: 999, customerId: 'cust-fremd' });
    hydrateVorgangStore([
      createTestVorgang({ id: VORGANG_ID, customerId: KUNDE, invoices: [meine] }),
      createTestVorgang({ id: 'v-fremd', customerId: 'cust-fremd', invoices: [fremde] }),
    ]);
    await zeigeAkte();

    expect(wert('kunden-receivables-open')).toContain('100,00');
    expect(text()).not.toContain('999,00');
    expect(q(`kunden-receivable-${fremde.id}`)).toBeNull();
  });
});

/* ================================================================== */
/* 01H — unversendet ist nicht „Nicht fällig"                          */
/* ================================================================== */

describe('01H — Kundenakte, Aging bei unversendeter Rechnung', () => {
  it('eine unversendete Rechnung mit vergangenem Datum steht sichtbar unter „Noch nicht versendet“', async () => {
    const invoice = rechnung({
      amount: 300,
      paymentDueDate: '2020-01-15',
      status: 'vorbereitet',
      sentAt: undefined,
      sentVia: undefined,
    });
    await mitRechnungen(invoice);

    expect(wert('kunden-receivables-aging-notSent')).toContain('300,00');
    expect(wert('kunden-receivables-aging-notDue')).toContain('0,00');
    expect(wert('kunden-receivables-aging-over90')).toContain('0,00');
    expect(wert('kunden-receivables-overdue')).toContain('0,00');
    expect(q('kunden-receivables-aging')?.textContent).toContain('Noch nicht versendet');
    expect(wert(`kunden-receivable-meta-${invoice.id}`)).toContain('Noch nicht versendet');
    expect(text()).not.toMatch(/notSent|notDue/);
  });

  it('eine versendete Rechnung trägt keinen Versandhinweis', async () => {
    const invoice = rechnung({ amount: 100 });
    await mitRechnungen(invoice);
    expect(wert(`kunden-receivable-meta-${invoice.id}`)).not.toContain('Noch nicht versendet');
    expect(wert('kunden-receivables-aging-notDue')).toContain('100,00');
  });
});
