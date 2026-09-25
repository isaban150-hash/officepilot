/**
 * FINANZCORE-05B-FIX3 — der Betragsvorschlag im Zahlungsdialog.
 *
 * Realbefund des unabhängigen FIX2-Retests: Bei einer Ausgabe mit 49,00 € offen
 * öffnete sich „Zahlung erfassen" mit einem **leeren** Betragsfeld. Daneben
 * stand korrekt „Offen: 49,00 EUR".
 *
 * Ursache war meine eigene Änderung aus FIX2: Der Vorschlag wurde auf deutsche
 * Schreibweise umgestellt (`49,00`), das Feld ist aber ein
 * `input[type=number]`. Ein Komma ist dort kein gültiger Zahlenwert — der
 * Browser verwirft ihn stillschweigend, und das Feld bleibt leer. Aus einer
 * Kosmetikänderung wurde ein unbenutzbarer Dialog.
 *
 * Geprüft wird deshalb der **tatsächliche DOM-Wert** des Feldes, nicht nur der
 * Zustand der Komponente: Nur so fällt auf, wenn der Browser einen Wert
 * ablehnt.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpensePaymentForm } from './ExpensePaymentForm';
import { normalizeExpense } from '../../services/expenseNormalize';
import { getExpenseFromStoreById, setExpenseStoreForTests } from '../../services/expenseStore';
import { calculateExpensePaymentSummary } from '../../services/expensePaymentService';
import { resetTestStores } from '../../test/resetStores';
import type { Expense, ExpensePayment } from '../../types/expense';
import type { TranslationKey } from '../../i18n';

/* ------------------------------------------------------------------ */

/** Die Schlüssel genügen — geprüft wird Verhalten, nicht Übersetzung. */
const translate = (key: TranslationKey): string => key;

function payment(amount: number, id: string): ExpensePayment {
  return { id, date: '2026-06-05', amount, createdAt: '2026-06-05T08:00:00.000Z' };
}

function expense(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-valid',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-VALID',
    title: '05B TEST VALID',
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

const amountInput = () =>
  container.querySelector('input[type="number"]') as HTMLInputElement | null;

async function oeffne(value: Expense, onSaved: (e: Expense) => void = () => {}): Promise<void> {
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

/* ================================================================== */

describe('A — der Vorschlag ist gültig und nicht leer', () => {
  // T1/T2/T3 — der Befund des Retests.
  it('T1/T2/T3: bei 49,00 offen steht ein gültiger Wert im Feld', async () => {
    await oeffne(expense({ payments: [payment(70, 'p1')] }));

    const input = amountInput();
    expect(input, 'das Betragsfeld fehlt').not.toBeNull();
    expect(input!.value, 'das Feld darf nicht leer sein').not.toBe('');
    expect(input!.value).toBe('49.00');
    /*
     * Der Kern: Ein `input[type=number]` gibt einen ungültigen Wert als leeren
     * String zurück. Dass hier etwas steht, beweist zugleich die Gültigkeit.
     */
    expect(input!.value).not.toContain(',');
    expect(Number(input!.value)).toBe(49);
  });

  /*
   * T3b — der Wert hält die Schreibweise ein, die HTML für ein Zahlenfeld
   * verlangt: Ziffern, Punkt, zwei Nachkommastellen.
   *
   * Dass ein echter Browser „49,00" verwirft und das Feld leer lässt, liesse
   * sich hier **nicht** nachstellen: happy-dom bereinigt den Wert eines
   * `input[type=number]` nicht und speichert auch ein Komma wörtlich. Geprüft
   * wird deshalb, was in unserer Hand liegt — die erzeugte Zeichenfolge.
   */
  it('T3b: der Vorschlag entspricht der HTML-Schreibweise für Zahlenfelder', async () => {
    await oeffne(expense({ payments: [payment(70, 'p1')] }));
    expect(amountInput()!.value).toMatch(/^\d+\.\d{2}$/);
  });

  // T4 — Centbeträge, keine Ganzzahlannahme.
  it('T4: ein Centbetrag wird centgenau vorbelegt', async () => {
    await oeffne(
      expense({ grossAmount: 119.37, netAmount: 100.31, taxAmount: 19.06, payments: [payment(70, 'p1')] }),
    );
    expect(amountInput()!.value).toBe('49.37');
    expect(Number(amountInput()!.value)).toBe(49.37);
  });

  // T5 — der zweite Beleg aus der Abnahme.
  it('T5: 107,00 offen ergibt 107.00', async () => {
    await oeffne(
      expense({
        id: 'exp-7',
        invoiceNumber: 'RE-7',
        title: '05B TEST 7',
        taxStatus: 'standard_7',
        netAmount: 100,
        taxAmount: 7,
        grossAmount: 107,
      }),
    );
    expect(amountInput()!.value).toBe('107.00');
  });

  it('der Vorschlag passt zur Schrittweite des Feldes', async () => {
    await oeffne(
      expense({ grossAmount: 119.37, netAmount: 100.31, taxAmount: 19.06, payments: [payment(70, 'p1')] }),
    );
    const input = amountInput()!;
    expect(input.step).toBe('0.01');
    /*
     * Ein ganzzahliges Vielfaches eines Cents — sonst lehnte ein echter
     * Browser den Wert wegen `step="0.01"` ab. `validity.stepMismatch` selbst
     * ist hier nicht aussagekräftig: happy-dom berechnet es nicht.
     */
    expect(Math.round(Number(input.value) * 100) / 100).toBe(Number(input.value));
  });
});

describe('B — der Vorschlag lässt sich auch buchen', () => {
  // T6 — Speichern mit dem Vorschlag.
  it('T6: eine Zahlung mit dem vorgeschlagenen Betrag wird gebucht', async () => {
    let gespeichert: Expense | undefined;
    const value = expense({ payments: [payment(70, 'p1')] });
    await oeffne(value, (e) => {
      gespeichert = e;
    });

    const form = container.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(gespeichert, 'die Zahlung wurde nicht gespeichert').toBeDefined();
    const gespeicherteZahlungen = getExpenseFromStoreById('exp-valid')!.payments ?? [];
    expect(gespeicherteZahlungen).toHaveLength(2);
    // Genau der vorgeschlagene Restbetrag.
    expect(gespeicherteZahlungen[1].amount).toBe(49);
    expect(calculateExpensePaymentSummary(getExpenseFromStoreById('exp-valid')!).status).toBe(
      'bezahlt',
    );
  });

  // T7 — Abbrechen ändert nichts.
  it('T7: Schliessen ohne Absenden verändert nichts', async () => {
    const value = expense({ payments: [payment(70, 'p1')] });
    await oeffne(value);

    await act(async () => {
      root.render(
        <ExpensePaymentForm
          expense={value}
          open={false}
          onClose={() => {}}
          onSaved={() => {}}
          translate={translate}
        />,
      );
    });

    const unveraendert = getExpenseFromStoreById('exp-valid')!;
    expect(unveraendert.payments).toHaveLength(1);
    expect(calculateExpensePaymentSummary(unveraendert).openAmount).toBe(49);
    expect(calculateExpensePaymentSummary(unveraendert).status).toBe('teilbezahlt');
  });
});

describe('C — die Gutschrift bleibt gesperrt', () => {
  /*
   * T10/T11 — FIX2 darf durch diese Änderung nicht aufweichen. Der Dialog
   * würde bei einer Gutschrift gar nicht angeboten; wird er trotzdem
   * gerendert, bleibt das Feld gesperrt.
   */
  it('T10/T11: bei einer Gutschrift ist das Betragsfeld gesperrt', async () => {
    const credit = expense({
      id: 'exp-credit',
      invoiceNumber: 'GS-1',
      title: '05B TEST CREDIT',
      category: 'gutschrift',
      netAmount: -100,
      taxAmount: -19,
      grossAmount: -119,
      payments: [],
    });
    await oeffne(credit);

    expect(amountInput()!.disabled, 'auf eine Gutschrift wird nichts gebucht').toBe(true);
    const summary = calculateExpensePaymentSummary(credit);
    expect(summary.status).toBe('gutschrift');
    expect(summary.overpaidAmount).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe('D — der „nächste Schritt" auf der Detailseite', () => {
  /*
   * T9 — zweiter Befund des Retests: Über einer Gutschrift stand weiterhin
   * „Zahlung erfassen, sobald der Beleg bezahlt ist" — direkt über einem
   * Beleg, der weder eine Zahlung erwartet noch einen Knopf dafür anbietet.
   *
   * Geprüft an der echten Seite, nicht an nachgebauter Logik.
   */
  async function zeigeDetail(value: Expense): Promise<string> {
    setExpenseStoreForTests([value]);
    const { MemoryRouter, Route, Routes } = await import('react-router-dom');
    const { AppProvider } = await import('../../context/AppContext');
    const { DEFAULT_SETUP } = await import('../../data/mockData');
    const { AusgabeDetailPage } = await import('../../pages/AusgabeDetailPage');

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[`/ausgaben/${value.id}`]}>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <Routes>
              <Route path="/ausgaben/:id" element={<AusgabeDetailPage />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );
    });
    return container.textContent ?? '';
  }

  const nextAction = () => container.querySelector('[data-testid="ausgabe-next-action"]');
  const recordButton = () => container.querySelector('[data-testid="ausgabe-record-payment"]');

  it('T9/T10: eine Gutschrift zeigt keinen Zahlungshinweis und keinen Zahlungsknopf', async () => {
    await zeigeDetail(
      expense({
        id: 'exp-credit',
        invoiceNumber: 'GS-1',
        title: '05B TEST CREDIT',
        category: 'gutschrift',
        netAmount: -100,
        taxAmount: -19,
        grossAmount: -119,
        payments: [],
      }),
    );

    expect(nextAction(), 'kein „nächster Schritt" bei einer Gutschrift').toBeNull();
    expect(recordButton(), 'kein Zahlungsknopf bei einer Gutschrift').toBeNull();
    // Was die Gutschrift ist, steht weiterhin in der Zahlungsübersicht.
    expect(container.querySelector('[data-testid="ausgabe-credit-note-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ausgabe-credit-amount"]')).not.toBeNull();
  });

  // T8 — die positive Ausgabe behält Hinweis und Knopf.
  it('T8: eine teilbezahlte Ausgabe behält Hinweis und Zahlungsknopf', async () => {
    await zeigeDetail(expense({ payments: [payment(70, 'p1')] }));

    expect(nextAction(), 'der Hinweis gehört hierher').not.toBeNull();
    expect(recordButton()).not.toBeNull();
  });
});
