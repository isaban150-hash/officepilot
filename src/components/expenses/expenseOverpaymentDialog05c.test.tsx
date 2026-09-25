/**
 * FINANZCORE-05C — der Bestätigungsschritt vor einer Überzahlung.
 *
 * Geprüft wird das sichtbare Verhalten beider Dialoge: Wann kommt die
 * Rückfrage, was steht darin, und was passiert beim Abbrechen. Die
 * Rechenregeln dahinter stehen in `paymentOverpayment05c.test.ts`.
 *
 * Kein `window.confirm`: Beide Dialoge benutzen das vorhandene Muster des
 * Projekts — eine zweite Phase im selben Formular mit „bestätigen" und
 * „zurück". Dass es wirklich diese Phase ist und kein Browserfenster, prüft
 * T-Q1 ausdrücklich.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpensePaymentForm } from './ExpensePaymentForm';
import { InvoicePaymentForm } from '../invoice/InvoicePaymentForm';
import { normalizeExpense } from '../../services/expenseNormalize';
import { getExpenseFromStoreById, setExpenseStoreForTests } from '../../services/expenseStore';
import { calculateExpensePaymentSummary } from '../../services/expensePaymentService';
import { calculatePaymentSummary } from '../../services/invoicePaymentService';
import { hydrateVorgangStore, getVorgangById } from '../../services/vorgangService';
import { createTestVorgang } from '../../test/fixtures';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { resetTestStores } from '../../test/resetStores';
import type { Expense, ExpensePayment } from '../../types/expense';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

/* ------------------------------------------------------------------ */

/** Die Schlüssel genügen — geprüft wird Verhalten, nicht Übersetzung. */
const translate = (key: TranslationKey): string => key;

const VORGANG_ID = 'v-test-1';
const INVOICE_ID = 'inv-05c';

function payment(amount: number, id: string): ExpensePayment {
  return { id, date: '2026-06-05', amount, createdAt: '2026-06-05T08:00:00.000Z' };
}

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-05c',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-05C',
    title: '05C TEST',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    ...overrides,
  } as Expense);
}

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0500',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Leistung',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 100,
        lineTotal: 100,
      },
    ],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
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
    payments: [{ id: 'p1', date: '2026-06-05', amount: 70, createdAt: '2026-06-05T08:00:00.000Z' }],
    ...overrides,
  };
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
/* Ausgabe — der Dialog, der bisher gar nicht nachfragte              */
/* ================================================================== */

describe('U — Ausgabendialog', () => {
  async function oeffne(
    value: Expense = ausgabe({ payments: [payment(70, 'p1')] }),
    onSaved: (e: Expense) => void = () => {},
  ): Promise<void> {
    setExpenseStoreForTests([value]);
    await act(async () => {
      root.render(
        <ExpensePaymentForm
          expense={value}
          open
          onClose={() => {}}
          onSaved={onSaved}
          translate={translate}
        />,
      );
    });
  }

  /* U8 — Zahlung unter dem offenen Betrag: keine Rückfrage. */
  it('U8: 20 auf 49 offen wird ohne Zwischenschritt gebucht', async () => {
    await oeffne();
    await setzeBetrag('20');
    expect(q('expense-payment-overpay-warning')).toBeNull();

    await absenden();
    expect(q('expense-payment-confirm')).toBeNull();
    expect(getExpenseFromStoreById('exp-05c')!.payments).toHaveLength(2);
    expect(calculateExpensePaymentSummary(getExpenseFromStoreById('exp-05c')!).status).toBe(
      'teilbezahlt',
    );
  });

  /* U7 — Zahlung genau auf den offenen Betrag: keine Rückfrage. */
  it('U7: 49 auf 49 offen wird ohne Zwischenschritt gebucht', async () => {
    await oeffne();
    // Der Vorschlag ist bereits der offene Betrag (05B-FIX3).
    expect(amountInput().value).toBe('49.00');
    expect(q('expense-payment-overpay-warning')).toBeNull();

    await absenden();
    expect(q('expense-payment-confirm')).toBeNull();
    expect(calculateExpensePaymentSummary(getExpenseFromStoreById('exp-05c')!).status).toBe(
      'bezahlt',
    );
  });

  /* U6 — Zahlung über dem offenen Betrag: Rückfrage statt Buchung. */
  it('U6: 60 auf 49 offen führt zuerst in den Bestätigungsschritt', async () => {
    await oeffne();
    await setzeBetrag('60');
    expect(q('expense-payment-overpay-warning')).not.toBeNull();

    await absenden();
    expect(q('expense-payment-confirm'), 'der Bestätigungsschritt fehlt').not.toBeNull();
    // Noch nichts gebucht.
    expect(getExpenseFromStoreById('exp-05c')!.payments).toHaveLength(1);
  });

  /* Q — die drei Zahlen im Bestätigungsschritt. */
  it('Q: der Bestätigungsschritt nennt offen, Zahlung und Überzahlung', async () => {
    await oeffne();
    await setzeBetrag('60');
    await absenden();

    expect(q('expense-payment-confirm-open')!.textContent).toContain('49,00');
    expect(q('expense-payment-confirm-amount')!.textContent).toContain('60,00');
    expect(q('expense-payment-confirm-overpaid')!.textContent).toContain('11,00');
  });

  /*
   * T-Q1 — kein Browserdialog. `window.confirm` wird überwacht; würde der
   * Dialog ihn benutzen, fiele dieser Test um.
   */
  it('Q1: es wird kein window.confirm benutzt', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await oeffne();
    await setzeBetrag('60');
    await absenden();
    expect(spy).not.toHaveBeenCalled();
  });

  /* U9 — nach ausdrücklicher Bestätigung wird gebucht. */
  it('U9: „bestätigen" speichert die Überzahlung', async () => {
    let gespeichert: Expense | undefined;
    await oeffne(ausgabe({ payments: [payment(70, 'p1')] }), (e) => {
      gespeichert = e;
    });
    await setzeBetrag('60');
    await absenden();

    await act(async () => {
      (q('expense-payment-confirm-submit') as HTMLButtonElement).click();
    });

    expect(gespeichert, 'die Zahlung wurde nicht gespeichert').toBeDefined();
    const nachher = getExpenseFromStoreById('exp-05c')!;
    expect(nachher.payments).toHaveLength(2);
    const s = calculateExpensePaymentSummary(nachher);
    expect(s.paidAmount).toBe(130);
    expect(s.overpaidAmount).toBe(11);
    expect(s.status).toBe('ueberbezahlt');
  });

  /* U10 — Abbrechen speichert nichts. */
  it('U10: „zurück" bucht nichts und führt ins Formular zurück', async () => {
    await oeffne();
    await setzeBetrag('60');
    await absenden();

    await act(async () => {
      (q('expense-payment-confirm-back') as HTMLButtonElement).click();
    });

    expect(q('expense-payment-confirm')).toBeNull();
    expect(q('expense-payment-save'), 'zurück im Formular').not.toBeNull();
    expect(getExpenseFromStoreById('exp-05c')!.payments).toHaveLength(1);
    expect(calculateExpensePaymentSummary(getExpenseFromStoreById('exp-05c')!).status).toBe(
      'teilbezahlt',
    );
  });

  /* 05B-FIX2 bleibt: auf eine Gutschrift wird nichts gebucht. */
  it('U14: bei einer Gutschrift bleibt das Betragsfeld gesperrt', async () => {
    await oeffne(
      ausgabe({ id: 'exp-credit', netAmount: -100, taxAmount: -19, grossAmount: -119, payments: [] }),
    );
    expect(amountInput().disabled).toBe(true);
  });
});

/* ================================================================== */
/* Rechnung — die Rückfrage gab es schon, die drei Zahlen nicht       */
/* ================================================================== */

describe('T — Rechnungsdialog', () => {
  beforeEach(() => {
    hydrateVorgangStore([createTestVorgang({ invoices: [rechnung()] })]);
  });

  async function oeffne(invoice: VorgangInvoice = rechnung()): Promise<void> {
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

  const geladen = (): VorgangInvoice =>
    getVorgangById(VORGANG_ID)!.invoices.find((i) => i.id === INVOICE_ID)!;

  it('T8: eine Zahlung unter dem offenen Betrag wird ohne Rückfrage gebucht', async () => {
    await oeffne();
    await setzeBetrag('20');
    await absenden();
    expect(q('payment-confirm')).toBeNull();
    expect(calculatePaymentSummary(geladen()).paidAmount).toBe(90);
  });

  it('T7: eine Zahlung genau in Höhe des offenen Betrags wird ohne Rückfrage gebucht', async () => {
    await oeffne();
    await setzeBetrag('49');
    await absenden();
    expect(q('payment-confirm')).toBeNull();
    expect(calculatePaymentSummary(geladen()).status).toBe('bezahlt');
  });

  it('T6: eine Zahlung über dem offenen Betrag führt in den Bestätigungsschritt', async () => {
    await oeffne();
    await setzeBetrag('60');
    expect(q('payment-overpay-warning')).not.toBeNull();
    await absenden();
    expect(q('payment-confirm')).not.toBeNull();
    expect(calculatePaymentSummary(geladen()).paidAmount).toBe(70);
  });

  it('Q: der Bestätigungsschritt nennt offen, Zahlung und Überzahlung', async () => {
    await oeffne();
    await setzeBetrag('60');
    await absenden();
    expect(q('payment-confirm-open')!.textContent).toContain('49,00');
    expect(q('payment-confirm-amount')!.textContent).toContain('60,00');
    expect(q('payment-confirm-overpaid')!.textContent).toContain('11,00');
  });

  it('T9: „bestätigen" speichert die Überzahlung', async () => {
    await oeffne();
    await setzeBetrag('60');
    await absenden();
    await act(async () => {
      (q('payment-confirm-submit') as HTMLButtonElement).click();
    });

    const s = calculatePaymentSummary(geladen());
    expect(s.paidAmount).toBe(130);
    expect(s.overpaidAmount).toBe(11);
    expect(s.status).toBe('ueberbezahlt');
  });

  it('T10: „zurück" bucht nichts', async () => {
    await oeffne();
    await setzeBetrag('60');
    await absenden();
    await act(async () => {
      (q('payment-confirm-back') as HTMLButtonElement).click();
    });

    expect(q('payment-confirm')).toBeNull();
    expect(calculatePaymentSummary(geladen()).paidAmount).toBe(70);
    expect(calculatePaymentSummary(geladen()).status).toBe('teilbezahlt');
  });
});
