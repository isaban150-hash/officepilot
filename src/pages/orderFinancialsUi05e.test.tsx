/**
 * FINANZCORE-05E — die Abrechnungssicht in der Auftragsdetailseite.
 *
 * Geöffnet wird jeweils der Rechnungsbereich (`?vtab=invoices`), damit geprüft
 * wird, was ein Nutzer dort tatsächlich sieht — und nicht nur, was im DOM
 * versteckt vorhanden ist.
 *
 * Fälligkeiten liegen weit in der Vergangenheit oder weit in der Zukunft: Die
 * Seite rechnet gegen die echte Uhr, und ein Test soll nicht am Kalender
 * hängen. Die genauen Schwellen prüft `orderFinancials05e.test.ts` gegen ein
 * festes Datum.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { VorgangDetailPage } from './VorgangDetailPage';
import { createTestVorgang } from '../test/fixtures';
import { hydrateVorgangStore, getVorgangById } from '../services/vorgangService';
import { recordPayment } from '../services/invoicePaymentService';
import { resetTestStores } from '../test/resetStores';
import type { AbschlagDeduction, OrderPosition, VorgangInvoice } from '../types/models';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };
const VORGANG_ID = 'v-test-1';

function position(net: number, id = 'op-1'): OrderPosition {
  return {
    id,
    description: 'Leistung',
    plannedQuantity: 1,
    unit: 'Pauschal',
    unitPrice: net,
  } as OrderPosition;
}

let nr = 0;

function rechnung(
  net: number,
  overrides: Partial<VorgangInvoice> = {},
  deductions: AbschlagDeduction[] = [],
): VorgangInvoice {
  nr += 1;
  const grossCents = Math.round(net * 1.19 * 100);
  const deductionCents = deductions.reduce((s, d) => s + Math.round(d.amount * 100), 0);
  return {
    id: `inv-05e-${nr}`,
    number: `2026-${String(4000 + nr)}`,
    type: 'rechnung',
    positions: [
      {
        id: `line-${nr}`,
        orderPositionId: 'op-1',
        description: 'Leistung',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: net,
        lineTotal: net,
      },
    ],
    subtotal: net,
    taxStatus: 'standard_19',
    amount: Math.max(0, grossCents - deductionCents) / 100,
    status: 'versendet',
    sentAt: '2026-06-01',
    sentVia: 'email',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
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
    previousAbschlagDeductions: deductions,
    ...overrides,
  };
}

function abzug(invoice: VorgangInvoice): AbschlagDeduction {
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    abschlagNumber: invoice.abschlagNumber,
    date: invoice.issueDate ?? invoice.date,
    subtotal: invoice.subtotal,
    amount: invoice.amount,
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<div />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetTestStores();
});

/** Betritt die Auftragsseite neu — wie ein Nutzer, nicht als bloßes Re-Render. */
async function zeigeAuftrag(): Promise<void> {
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/vorgaenge/${VORGANG_ID}?vtab=invoices`]}>
        <AppProvider initialSetup={completeSetup}>
          <Routes>
            <Route path="/vorgaenge/:id" element={<VorgangDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
}

async function mitAuftrag(
  positions: OrderPosition[],
  invoices: VorgangInvoice[],
): Promise<void> {
  hydrateVorgangStore([
    createTestVorgang({ id: VORGANG_ID, orderPositions: positions, invoices }),
  ]);
  await zeigeAuftrag();
}

const q = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
const wert = (testId: string) => q(testId)?.textContent ?? '';
const panelText = () => q('vorgang-financials')?.textContent ?? '';

/* ================================================================== */

describe('Z — Auftragsdetail, Abrechnung', () => {
  /* Z1–Z3 — der Abrechnungsblock. */
  it('Z1–Z3: Auftragswert, bereits abgerechnet und noch abzurechnen stehen da', async () => {
    const a1 = rechnung(3000, { type: 'abschlag', abschlagNumber: 1 });
    await mitAuftrag([position(10000)], [a1]);

    expect(q('vorgang-financials'), 'der Abrechnungsbereich fehlt').not.toBeNull();
    expect(wert('vorgang-financials-order-value')).toContain('10.000,00');
    expect(wert('vorgang-financials-invoiced')).toContain('3.000,00');
    expect(wert('vorgang-financials-invoiced')).toContain('30');
    expect(wert('vorgang-financials-remaining')).toContain('7.000,00');
  });

  /* Z4–Z7 — der Zahlungsblock. */
  it('Z4–Z7: bezahlt, offen, überfällig und Überzahlung stehen da', async () => {
    const offen = rechnung(1000, { paymentDueDate: '2020-01-15' });
    const ueber = rechnung(1000, { payments: [zahlung(1300, 'p1')] });
    await mitAuftrag([position(10000)], [offen, ueber]);

    expect(wert('vorgang-financials-paid')).toContain('1.300,00');
    expect(wert('vorgang-financials-open')).toContain('1.190,00');
    expect(wert('vorgang-financials-overdue')).toContain('1.190,00');
    expect(wert('vorgang-financials-overpaid')).toContain('110,00');
    expect(q('vorgang-financials-overpaid-hint'), 'der Hinweis zur Überzahlung fehlt').not.toBeNull();
  });

  /* Z8–Z11 — der Rechnungsverlauf mit lesbaren Bezeichnungen. */
  it('Z8–Z11: Abschlag, Teilrechnung und Schlussrechnung sind korrekt beschriftet', async () => {
    const a1 = rechnung(3000, { type: 'abschlag', abschlagNumber: 1 });
    const teil = rechnung(2000, { type: 'teilrechnung' });
    const schluss = rechnung(10000, { type: 'schluss' }, [abzug(a1)]);
    await mitAuftrag([position(10000)], [a1, teil, schluss]);

    expect(wert(`vorgang-financials-invoice-title-${a1.id}`)).toContain('Abschlagsrechnung 1');
    expect(wert(`vorgang-financials-invoice-title-${teil.id}`)).toContain('Teilrechnung');
    expect(wert(`vorgang-financials-invoice-title-${schluss.id}`)).toContain('Schlussrechnung');
    expect(panelText()).toContain('Schlussrechnung vorhanden');
  });

  /* Z12 — Storno bleibt sichtbar, zählt aber nicht. */
  it('Z12: eine stornierte Rechnung bleibt sichtbar, zählt aber nicht in der aktiven Summe', async () => {
    const aktiv = rechnung(3000, { type: 'abschlag', abschlagNumber: 1 });
    const storniert = rechnung(2000, {
      type: 'abschlag',
      abschlagNumber: 2,
      cancelledAt: '2026-07-01T10:00:00.000Z',
      paymentStatus: 'storniert',
    });
    await mitAuftrag([position(10000)], [aktiv, storniert]);

    // Sichtbar …
    expect(q(`vorgang-financials-invoice-title-${storniert.id}`)).not.toBeNull();
    expect(q(`vorgang-financials-cancelled-${storniert.id}`)).not.toBeNull();
    // … aber nicht in der Summe.
    expect(wert('vorgang-financials-invoiced')).toContain('3.000,00');
    expect(wert('vorgang-financials-remaining')).toContain('7.000,00');
  });

  /* Z13 — Leerzustand. */
  it('Z13: ein Auftrag ohne Rechnungen zeigt einen klaren Leerzustand', async () => {
    await mitAuftrag([position(10000)], []);

    expect(q('vorgang-financials-empty')).not.toBeNull();
    expect(panelText()).toContain('Noch keine Rechnungen für diesen Auftrag.');
    // Der Auftragswert bleibt trotzdem sichtbar.
    expect(wert('vorgang-financials-order-value')).toContain('10.000,00');
    expect(wert('vorgang-financials-remaining')).toContain('10.000,00');
  });

  it('Z13b: ohne feste Positionen steht statt einer Null ein Satz', async () => {
    await mitAuftrag([], [rechnung(4000)]);
    expect(wert('vorgang-financials-order-value')).toContain('Kein fester Auftragswert');
    expect(wert('vorgang-financials-remaining')).toContain('Kein fester Auftragswert');
  });

  /* Z14 — keine technischen Schlüssel oder Enum-Werte. */
  it('Z14: im Abrechnungsbereich steht kein technischer Schlüssel und kein Enum-Wert', async () => {
    const a1 = rechnung(3000, { type: 'abschlag', abschlagNumber: 1 });
    const schluss = rechnung(10000, { type: 'schluss' }, [abzug(a1)]);
    const storniert = rechnung(500, {
      type: 'teilrechnung',
      cancelledAt: '2026-07-01T10:00:00.000Z',
      paymentStatus: 'storniert',
    });
    await mitAuftrag([position(10000)], [a1, schluss, storniert]);

    const sichtbar = panelText();
    expect(sichtbar).not.toMatch(/order\.financials\./);
    expect(sichtbar).not.toMatch(/payment\.status\./);
    expect(sichtbar).not.toMatch(/\bteilrechnung\b/);
    expect(sichtbar).not.toMatch(/\bueberfaellig\b|\bueberbezahlt\b/);
    // Stattdessen die Produktsprache.
    expect(sichtbar).toContain('Abrechnungsfortschritt (netto)');
    expect(sichtbar).toContain('Zahlungsstand (brutto)');
    expect(sichtbar).toContain('Storniert');
  });

  /*
   * Z15 — der Zustand folgt den Zahlungen. Nichts ist gespeichert, also zeigt
   * ein erneutes Betreten der Seite den neuen Stand.
   */
  it('Z15: nach einer Zahlung zeigt die Seite den neuen Stand', async () => {
    const invoice = rechnung(1000, { id: 'inv-live' });
    await mitAuftrag([position(10000)], [invoice]);
    expect(wert('vorgang-financials-open')).toContain('1.190,00');
    expect(wert('vorgang-financials-paid')).toContain('0,00');

    await act(async () => {
      recordPayment(VORGANG_ID, 'inv-live', { date: '2026-06-08', amount: 500 }, {});
    });
    await zeigeAuftrag();
    expect(wert('vorgang-financials-paid')).toContain('500,00');
    expect(wert('vorgang-financials-open')).toContain('690,00');

    // Und nach erneutem Hydrieren derselbe Stand.
    const aktuell = getVorgangById(VORGANG_ID)!;
    hydrateVorgangStore([aktuell]);
    await zeigeAuftrag();
    expect(wert('vorgang-financials-open')).toContain('690,00');
  });

  /*
   * Die beiden Zustandsaussagen stehen nebeneinander und sagen Verschiedenes:
   * vollständig abgerechnet, aber unbezahlt.
   */
  it('vollständig abgerechnet und trotzdem offen wird beides genannt', async () => {
    await mitAuftrag([position(10000)], [rechnung(10000, { type: 'schluss' })]);
    const zustand = wert('vorgang-financials-state');
    expect(zustand).toContain('Vollständig abgerechnet');
    expect(zustand).toContain('Zahlungen noch offen');
  });

  it('mehr abgerechnet als beauftragt wird ausdrücklich benannt', async () => {
    await mitAuftrag([position(10000)], [rechnung(12000)]);
    expect(wert('vorgang-financials-remaining')).toContain('-2.000,00');
    expect(q('vorgang-financials-over-invoiced')).not.toBeNull();
    expect(panelText()).toContain('mehr abgerechnet als beauftragt');
  });
});

/* ================================================================== */
/* 01H — sichtbarer Abrechnungs- und Zahlungszustand                  */
/* ================================================================== */

describe('01H — Auftragsdetail, Zustandszeile', () => {
  it('Delbrück: ein Abschlag in Höhe des Auftragswerts zeigt nicht „Vollständig abgerechnet“', async () => {
    await mitAuftrag([position(10000)], [rechnung(10000, { type: 'abschlag', abschlagNumber: 1 })]);
    const zustand = wert('vorgang-financials-state');
    expect(zustand).not.toContain('Vollständig abgerechnet');
    expect(zustand).toContain('Schlussrechnung steht noch aus');
  });

  it('nur ein kleiner Abschlag: „Noch nicht vollständig abgerechnet“', async () => {
    await mitAuftrag([position(10000)], [rechnung(3000, { type: 'abschlag', abschlagNumber: 1 })]);
    expect(wert('vorgang-financials-state')).toContain('Noch nicht vollständig abgerechnet');
  });

  it('AU-2026-0006: nur Stornos zeigen „Keine aktive Forderung“', async () => {
    await mitAuftrag(
      [position(10000)],
      [rechnung(1000, { cancelledAt: '2026-07-01T10:00:00.000Z', paymentStatus: 'storniert' })],
    );
    const zustand = wert('vorgang-financials-state');
    expect(wert('vorgang-financials-open')).toContain('0,00');
    expect(zustand).toContain('Keine aktive Forderung');
    expect(zustand).not.toContain('Zahlungen noch offen');
    expect(zustand).not.toContain('Zahlungen ausgeglichen');
  });

  it('überbezahlt ohne offenen Rest zeigt nicht „Zahlungen noch offen“', async () => {
    await mitAuftrag([position(10000)], [rechnung(1000, { payments: [zahlung(1300, 'p1')] })]);
    const zustand = wert('vorgang-financials-state');
    expect(zustand).not.toContain('Zahlungen noch offen');
    expect(zustand).toContain('Überzahlung vorhanden');
  });

  it('bezahlt und vollständig abgerechnet zeigt beides', async () => {
    await mitAuftrag([position(10000)], [rechnung(10000, { payments: [zahlung(11900, 'p1')] })]);
    const zustand = wert('vorgang-financials-state');
    expect(zustand).toContain('Vollständig abgerechnet');
    expect(zustand).toContain('Zahlungen ausgeglichen');
  });
});
