/**
 * FINANZCORE-05C-FIX1 — drei sichtbare Nacharbeiten aus der 05C-Abnahme.
 *
 * Alle drei sind Anzeigefehler, keine Fachfehler. Der letzte Abschnitt hält
 * deshalb ausdrücklich fest, dass die Zahlungsregeln von 05C unberührt
 * bleiben — die eigentliche Absicherung dafür steht in
 * `paymentOverpayment05c.test.ts`.
 *
 *   1. In der Rechnungsübersicht stand `overview.filter.ueberbezahlt`
 *      statt „Überbezahlt".
 *   2. Der Rechnungsdialog schlug bei 11,90 € offen den Wert `11.9` vor,
 *      der Ausgabendialog daneben `49.00`.
 *   3. Im Bestätigungsschritt stand `2026-09-24` statt `24.09.2026`.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ExpensePaymentForm } from './ExpensePaymentForm';
import { InvoicePaymentForm } from '../invoice/InvoicePaymentForm';
import { OffeneRechnungenPage } from '../../pages/OffeneRechnungenPage';
import { OffeneAusgabenPage } from '../../pages/OffeneAusgabenPage';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { normalizeExpense } from '../../services/expenseNormalize';
import { setExpenseStoreForTests } from '../../services/expenseStore';
import { hydrateVorgangStore } from '../../services/vorgangService';
import { createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { formatDisplayDatePadded } from '../../utils/displayFormat';
import type { Expense } from '../../types/expense';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

/* ------------------------------------------------------------------ */

const translate = (key: TranslationKey): string => key;

const VORGANG_ID = 'v-test-1';
const INVOICE_ID = 'inv-fix1';

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0501',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Leistung',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 10,
        lineTotal: 10,
      },
    ],
    subtotal: 10,
    taxStatus: 'standard_19',
    amount: 11.9,
    status: 'versendet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
    customerSnapshot: {
      name: 'Test Kunde',
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

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-fix1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-FIX1',
    title: '05C-FIX1 TEST',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    ...overrides,
  } as Expense);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetTestStores();
  setExpenseStoreForTests([]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetTestStores();
  vi.restoreAllMocks();
});

const q = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
const amountInput = () => container.querySelector('input[type="number"]') as HTMLInputElement;
const text = () => container.textContent ?? '';

async function setzeBetrag(value: string): Promise<void> {
  const input = amountInput();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function absenden(): Promise<void> {
  const form = container.querySelector('form') as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/* ================================================================== */
/* 1 — der unübersetzte Filter                                        */
/* ================================================================== */

describe('1 — Filterbeschriftungen', () => {
  async function zeigeSeite(seite: 'rechnungen' | 'ausgaben'): Promise<void> {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[seite === 'rechnungen' ? '/rechnungen' : '/ausgaben/offen']}>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            {seite === 'rechnungen' ? <OffeneRechnungenPage /> : <OffeneAusgabenPage />}
          </AppProvider>
        </MemoryRouter>,
      );
    });
  }

  // T1 — der gemeldete Befund.
  it('T1: die Rechnungsübersicht zeigt „Überbezahlt“ als Filter', async () => {
    await zeigeSeite('rechnungen');
    expect(text()).toContain('Überbezahlt');
  });

  /*
   * T2 — der eigentliche Schutz. Die Seiten setzen ihren Schlüssel zusammen
   * und casten ihn mit `as TranslationKey`; der Compiler kann eine fehlende
   * Beschriftung deshalb nicht melden. Geprüft wird darum das Ergebnis:
   * Nirgends darf ein roher Schlüssel stehen bleiben.
   */
  it('T2: in keiner der beiden Übersichten steht ein technischer Schlüssel', async () => {
    for (const seite of ['rechnungen', 'ausgaben'] as const) {
      await zeigeSeite(seite);
      const sichtbar = text();
      expect(sichtbar, `${seite}: roher Filterschlüssel sichtbar`).not.toMatch(
        /(overview|expenseOverview)\.filter\./,
      );
      expect(sichtbar, `${seite}: roher Statusschlüssel sichtbar`).not.toMatch(
        /payment\.status\./,
      );
      expect(sichtbar, `${seite}: „ueberbezahlt“ technisch sichtbar`).not.toContain(
        'ueberbezahlt',
      );
    }
  });

  // T3 — die Ausgabenübersicht war genauso betroffen.
  it('T3: die Ausgabenübersicht zeigt „Überbezahlt“ als Filter', async () => {
    await zeigeSeite('ausgaben');
    expect(text()).toContain('Überbezahlt');
  });
});

/* ================================================================== */
/* 2 — der Vorschlagswert im Rechnungsdialog                          */
/* ================================================================== */

describe('2 — Vorschlagswert im Rechnungsdialog', () => {
  async function oeffne(invoice: VorgangInvoice): Promise<void> {
    hydrateVorgangStore([createTestVorgang({ invoices: [invoice] })]);
    await act(async () => {
      root.render(
        <InvoicePaymentForm
          vorgangId={VORGANG_ID}
          invoice={invoice}
          open
          onClose={() => {}}
          onSaved={() => {}}
          translate={translate}
        />,
      );
    });
  }

  // T4 — der gemeldete Befund: „11.9“ statt „11.90“.
  it('T4: bei 11,90 offen steht 11.90 im Feld', async () => {
    await oeffne(rechnung());
    expect(amountInput().value).toBe('11.90');
    expect(Number(amountInput().value)).toBe(11.9);
  });

  // T5 — Centbeträge bleiben centgenau.
  it('T5: bei 49,37 offen steht 49.37 im Feld', async () => {
    await oeffne(rechnung({ amount: 49.37 }));
    expect(amountInput().value).toBe('49.37');
  });

  /*
   * T5b — dieselbe Schreibweise wie im Ausgabendialog: Maschinenwert mit
   * Punkt, zwei Nachkommastellen, passend zu `step="0.01"`. Ein deutsches
   * Komma würde der Browser verwerfen und das Feld leer lassen (05B-FIX3).
   */
  it('T5b: der Wert ist ein gültiger HTML-Zahlenwert, nicht lokalisiert', async () => {
    for (const betrag of [11.9, 49.37, 119, 0.05]) {
      await oeffne(rechnung({ amount: betrag }));
      const value = amountInput().value;
      expect(value, `${betrag}: leer`).not.toBe('');
      expect(value, `${betrag}: nicht maschinenlesbar`).toMatch(/^\d+\.\d{2}$/);
      expect(Number(value)).toBeCloseTo(betrag, 2);
      // Ganzzahliges Vielfaches eines Cents — sonst lehnte ein echter Browser ab.
      expect(Math.round(Number(value) * 100) / 100).toBe(Number(value));
    }
  });

  // T6 — am Einlesen hat sich nichts geändert.
  it('T6: der Vorschlag lässt sich unverändert buchen', async () => {
    await oeffne(rechnung());
    await absenden();
    // Kein Bestätigungsschritt: der Vorschlag ist genau der offene Betrag.
    expect(q('payment-confirm')).toBeNull();
  });

  // Gegenprobe: der Ausgabendialog war schon richtig und bleibt es.
  it('T6b: der Ausgabendialog bleibt unverändert bei 49.00', async () => {
    const value = ausgabe({
      payments: [{ id: 'p1', date: '2026-06-05', amount: 70, createdAt: '2026-06-05T08:00:00.000Z' }],
    });
    setExpenseStoreForTests([value]);
    await act(async () => {
      root.render(
        <ExpensePaymentForm
          expense={value}
          open
          onClose={() => {}}
          onSaved={() => {}}
          translate={translate}
        />,
      );
    });
    expect(amountInput().value).toBe('49.00');
  });
});

/* ================================================================== */
/* 3 — das Datum im Bestätigungsschritt                               */
/* ================================================================== */

describe('3 — Datum im Bestätigungsschritt', () => {
  /*
   * Der Erwartungswert kommt aus demselben Helfer, den die Komponenten
   * benutzen. Dass es der gemeinsame ist und keine zweite Formatlogik, prüft
   * T9b an der konkreten Schreibweise.
   */
  const erwartet = formatDisplayDatePadded('2026-09-24');

  it('T9: der Rechnungsdialog zeigt das Datum deutsch', async () => {
    const invoice = rechnung({ amount: 119 });
    hydrateVorgangStore([createTestVorgang({ invoices: [invoice] })]);
    await act(async () => {
      root.render(
        <InvoicePaymentForm
          vorgangId={VORGANG_ID}
          invoice={invoice}
          open
          onClose={() => {}}
          onSaved={() => {}}
          translate={translate}
        />,
      );
    });

    const dateInput = container.querySelector('input[type="date"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      setter.call(dateInput, '2026-09-24');
      dateInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await setzeBetrag('200');
    await absenden();

    const zeile = q('payment-confirm-summary')!;
    expect(zeile.textContent).toContain(erwartet);
    expect(zeile.textContent, 'der Maschinenwert gehört nicht in den Satz').not.toContain(
      '2026-09-24',
    );
  });

  it('T9b: der Ausgabendialog zeigt dasselbe Format', async () => {
    const value = ausgabe();
    setExpenseStoreForTests([value]);
    await act(async () => {
      root.render(
        <ExpensePaymentForm
          expense={value}
          open
          onClose={() => {}}
          onSaved={() => {}}
          translate={translate}
        />,
      );
    });

    const dateInput = container.querySelector('input[type="date"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      setter.call(dateInput, '2026-09-24');
      dateInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await setzeBetrag('200');
    await absenden();

    const zeile = q('expense-payment-confirm-summary')!;
    expect(zeile.textContent).toContain(erwartet);
    expect(zeile.textContent).not.toContain('2026-09-24');
    // Deutsche Schreibweise, beide Dialoge gleich.
    expect(erwartet).toBe('24.09.2026');
  });
});

/* ================================================================== */
/* 4 — die Fachlogik bleibt unberührt                                 */
/* ================================================================== */

describe('4 — keine Fachlogik verändert', () => {
  /*
   * Der Kontrollfall aus dem Auftrag, an der Oberfläche: 11,90 offen, Zahlung
   * 20,00 → Bestätigung mit einer Überzahlung von 8,10. Hier geht es nur
   * darum, dass der Polish die Schwelle und die Beträge nicht verschoben hat.
   */
  it('T7: Rechnung 11,90 offen + Zahlung 20 ergibt Überzahlung 8,10', async () => {
    const invoice = rechnung();
    hydrateVorgangStore([createTestVorgang({ invoices: [invoice] })]);
    await act(async () => {
      root.render(
        <InvoicePaymentForm
          vorgangId={VORGANG_ID}
          invoice={invoice}
          open
          onClose={() => {}}
          onSaved={() => {}}
          translate={translate}
        />,
      );
    });

    await setzeBetrag('20');
    await absenden();

    expect(q('payment-confirm')).not.toBeNull();
    expect(q('payment-confirm-open')!.textContent).toContain('11,90');
    expect(q('payment-confirm-amount')!.textContent).toContain('20,00');
    expect(q('payment-confirm-overpaid')!.textContent).toContain('8,10');
  });

  it('T8: Ausgabe 49 offen + Zahlung 60 ergibt weiterhin Überzahlung 11,00', async () => {
    const value = ausgabe({
      payments: [{ id: 'p1', date: '2026-06-05', amount: 70, createdAt: '2026-06-05T08:00:00.000Z' }],
    });
    setExpenseStoreForTests([value]);
    await act(async () => {
      root.render(
        <ExpensePaymentForm
          expense={value}
          open
          onClose={() => {}}
          onSaved={() => {}}
          translate={translate}
        />,
      );
    });

    await setzeBetrag('60');
    await absenden();

    expect(q('expense-payment-confirm')).not.toBeNull();
    expect(q('expense-payment-confirm-open')!.textContent).toContain('49,00');
    expect(q('expense-payment-confirm-overpaid')!.textContent).toContain('11,00');
  });

  // T10 — die Schwelle ist unverschoben: unter und genau auf dem offenen Betrag keine Rückfrage.
  it('T10: payment < open und payment = open lösen weiterhin keine Bestätigung aus', async () => {
    const invoice = rechnung();
    hydrateVorgangStore([createTestVorgang({ invoices: [invoice] })]);
    await act(async () => {
      root.render(
        <InvoicePaymentForm
          vorgangId={VORGANG_ID}
          invoice={invoice}
          open
          onClose={() => {}}
          onSaved={() => {}}
          translate={translate}
        />,
      );
    });

    await setzeBetrag('5');
    expect(q('payment-overpay-warning')).toBeNull();
    await setzeBetrag('11.90');
    expect(q('payment-overpay-warning')).toBeNull();
    await setzeBetrag('11.91');
    expect(q('payment-overpay-warning')).not.toBeNull();
  });

  // T11 — die Gutschrift bleibt gesperrt.
  it('T11: bei einer Gutschrift bleibt das Betragsfeld gesperrt', async () => {
    const credit = ausgabe({
      id: 'exp-credit',
      netAmount: -100,
      taxAmount: -19,
      grossAmount: -119,
      payments: [],
    });
    setExpenseStoreForTests([credit]);
    await act(async () => {
      root.render(
        <ExpensePaymentForm
          expense={credit}
          open
          onClose={() => {}}
          onSaved={() => {}}
          translate={translate}
        />,
      );
    });
    expect(amountInput().disabled).toBe(true);
  });
});
