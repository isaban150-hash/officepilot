/**
 * FINANZCORE-05B-FIX1 — der Steuerstatus gehört dem Beleg, nicht dem Betrieb.
 *
 * Realbefund der unabhängigen 05B-Abnahme: Eine manuell erfasste Ausgabe über
 * 100 / 19 / 119 — fachlich völlig in Ordnung — wurde abgelehnt mit „Bei
 * diesem Steuerstatus fällt keine Umsatzsteuer an". Im Formular gab es keinen
 * Steuerstatus zu sehen.
 *
 * Ursache: `buildExpenseFromInput` übernahm den Steuerstatus aus dem
 * Firmenprofil, also aus der **eigenen Fakturierung**. Bei einem Betrieb mit
 * Nullsteuer-Status war damit jede Lieferantenrechnung mit ausgewiesener
 * Umsatzsteuer unbuchbar.
 *
 * Zweiter Befund: Bei 100 / 19 / 200 lagen zwei Widersprüche gleichzeitig vor,
 * und gemeldet wurde der über den Steuerstatus — während das eigentliche
 * Problem war, dass 100 + 19 nicht 200 ergibt.
 *
 * Geprüft wird beides an den echten Diensten und am echten Formular.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpenseForm } from '../../components/expenses/ExpenseForm';
import {
  EXPENSE_TAX_STATUS_OPTIONS,
  MANUAL_EXPENSE_DEFAULT_TAX_STATUS,
} from './expenseTaxStatusOptions';
import { checkExpenseMoneyIntegrity } from './expenseMoneyIntegrity';
import { addExpense, getExpenseById, updateExpense } from '../expenseService';
import { buildExpenseInputFromInbox } from '../officeActionService';
import { getExpenseFromStoreById, setExpenseStoreForTests } from '../expenseStore';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../companyProfileService';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { resetTestStores } from '../../test/resetStores';
import type { ExpenseInput } from '../../types/expense';
import type { InboxItem, TaxStatus } from '../../types/models';

/* ------------------------------------------------------------------ */

function input(overrides: Partial<ExpenseInput> = {}): ExpenseInput {
  return {
    title: 'Material Baumarkt',
    category: 'material',
    supplierName: 'Baumarkt Nord GmbH',
    invoiceNumber: `RE-${Math.random().toString(36).slice(2, 10)}`,
    issueDate: '2026-06-01',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    ...overrides,
  };
}

/** Ein Betrieb, der selbst ohne Umsatzsteuer abrechnet — der Fall der Abnahme. */
function setNullsteuerBetrieb(): void {
  hydrateCompanyProfileStore({ ...getCompanyProfile(), defaultTaxStatus: 'reverse_charge_13b' });
}

beforeEach(() => {
  resetTestStores();
  setExpenseStoreForTests([]);
});

afterEach(() => {
  resetTestStores();
  vi.restoreAllMocks();
});

/* ================================================================== */

describe('A — der Steuerstatus kommt nicht mehr aus dem Firmenprofil', () => {
  /*
   * T5 — der Kern des Fehlers. Der Betrieb rechnet selbst nach §13b ab; die
   * Lieferantenrechnung weist trotzdem 19 % aus. Beides muss nebeneinander
   * möglich sein.
   */
  it('T5/T6: eine 19-%-Lieferantenrechnung lässt sich auch bei §13b-Betrieb buchen', () => {
    setNullsteuerBetrieb();

    const result = addExpense(input({ taxStatus: 'standard_19' }));
    expect(result.success, result.success ? '' : JSON.stringify(result)).toBe(true);
    if (!result.success) return;

    expect(result.expense.taxStatus).toBe('standard_19');
    expect(result.expense.netAmount).toBe(100);
    expect(result.expense.taxAmount).toBe(19);
    expect(result.expense.grossAmount).toBe(119);
  });

  /*
   * Und ohne ausdrücklichen Status übernimmt der Dienst **nicht** mehr den
   * Firmenstatus. `unclear` ist die ehrliche Antwort: unbekannt, bitte prüfen.
   */
  it('T5b: ohne ausdrücklichen Status entsteht unclear, nicht der Firmenstatus', () => {
    setNullsteuerBetrieb();

    const result = addExpense(input({ taxStatus: undefined, netAmount: undefined, taxAmount: undefined }));
    expect(result.success, result.success ? '' : JSON.stringify(result)).toBe(true);
    if (!result.success) return;

    expect(result.expense.taxStatus).toBe('unclear');
    expect(result.expense.taxStatus).not.toBe('reverse_charge_13b');
  });

  // T7 — der gespeicherte Beleg behält Status und Beträge.
  it('T7: nach dem Neuladen stehen Steuerstatus und Beträge unverändert', () => {
    const created = addExpense(input({ taxStatus: 'standard_19', invoiceNumber: 'RELOAD-1' }));
    if (!created.success) throw new Error('Vorbereitung');

    setExpenseStoreForTests([created.expense]);
    const wieder = getExpenseFromStoreById(created.expense.id)!;
    expect(wieder.taxStatus).toBe('standard_19');
    expect(wieder.netAmount).toBe(100);
    expect(wieder.taxAmount).toBe(19);
    expect(wieder.grossAmount).toBe(119);
  });
});

describe('B — die Meldung nennt den richtigen Fehler zuerst', () => {
  /*
   * T8/T9 — der zweite Befund der Abnahme. Bei 100 / 19 / 200 liegt ein
   * unmittelbar nachrechenbarer Widerspruch vor; der gehört gemeldet, nicht
   * eine Nebenbedingung über den Steuerstatus.
   */
  it('T8/T9: 100 / 19 / 200 meldet den Betragswiderspruch', () => {
    const result = addExpense(input({ taxStatus: 'standard_19', grossAmount: 200 }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('expense.amountsInconsistent');
  });

  /*
   * Auch dann, wenn zusätzlich der Steuerstatus keine Steuer erlaubt — genau
   * die Lage, in der die Abnahme die irreführende Meldung sah.
   */
  it('T9b: bei zwei gleichzeitigen Widersprüchen gewinnt der Betrag', () => {
    const result = addExpense(
      input({ taxStatus: 'reverse_charge_13b', netAmount: 100, taxAmount: 19, grossAmount: 200 }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('expense.amountsInconsistent');
    expect(result.errorKey).not.toBe('expense.taxAmountNotAllowedForStatus');
  });

  // T10/T11 — stimmen die Beträge, bleibt die Nullsteuer-Regel bestehen.
  it.each([
    ['T10: Reverse Charge', 'reverse_charge_13b'],
    ['T11: steuerfrei', 'tax_free'],
    ['Kleinunternehmer', 'kleinunternehmer_19'],
  ])('%s mit ausgewiesener Steuer bleibt abgelehnt', (_label, taxStatus) => {
    const result = addExpense(
      input({ taxStatus: taxStatus as TaxStatus, netAmount: 100, taxAmount: 19, grossAmount: 119 }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('expense.taxAmountNotAllowedForStatus');
  });
});

describe('C — die übrigen Steuerfälle', () => {
  // T13 — 7 % wird nicht als 19 % behandelt.
  it('T13: 100 / 7 / 107 bei standard_7 ist speicherbar', () => {
    const result = addExpense(
      input({ taxStatus: 'standard_7', netAmount: 100, taxAmount: 7, grossAmount: 107 }),
    );
    expect(result.success, result.success ? '' : JSON.stringify(result)).toBe(true);
    if (!result.success) return;
    expect(result.expense.taxStatus).toBe('standard_7');
    expect(result.expense.taxAmount).toBe(7);
  });

  // T12 — unclear bleibt uninterpretiert.
  it('T12: unclear wird weder als Nullsteuer noch als 19 % gelesen', () => {
    const mitSteuer = addExpense(
      input({ taxStatus: 'unclear', invoiceNumber: 'UNCL-1', netAmount: 100, taxAmount: 19, grossAmount: 119 }),
    );
    expect(mitSteuer.success).toBe(true);

    const ohneSteuer = addExpense(
      input({ taxStatus: 'unclear', invoiceNumber: 'UNCL-2', netAmount: 100, taxAmount: 0, grossAmount: 100 }),
    );
    expect(ohneSteuer.success).toBe(true);
  });

  // T14 — die Gutschrift aus 05B bleibt unangetastet.
  it('T14: -100 / -19 / -119 bleibt als Gutschrift zulässig', () => {
    const result = addExpense(
      input({
        taxStatus: 'standard_19',
        category: 'gutschrift',
        invoiceNumber: 'GS-FIX1',
        netAmount: -100,
        taxAmount: -19,
        grossAmount: -119,
      }),
    );
    expect(result.success, result.success ? '' : JSON.stringify(result)).toBe(true);
    if (!result.success) return;
    expect(result.expense.isCreditNote).toBe(true);
    expect(checkExpenseMoneyIntegrity(result.expense)).toEqual({ ok: true });
  });
});

describe('D — der Weg aus dem Eingangsdokument', () => {
  function inboxItem(): InboxItem {
    return {
      id: 'inbox-1',
      title: 'Lieferantenrechnung',
      sender: 'Baustoff Süd GmbH',
      recognizedData: { Betrag: '119,00', Datum: '2026-06-01' },
      digitalFolder: { id: 'dig-1', name: 'Ausgaben', path: '/x/' },
    } as unknown as InboxItem;
  }

  /*
   * T15 — kein pauschales 19 %. Ein eingescannter Beleg gibt den Steuerstatus
   * nicht her; ihn zu raten wäre eine erfundene Steuerbehandlung. Der Weg
   * setzt deshalb gar keinen Status, und der Dienst vergibt `unclear`.
   */
  it('T15: der Eingangsweg setzt keinen Steuerstatz und bekommt keinen 19-%-Default', () => {
    setNullsteuerBetrieb();
    const ocrInput = buildExpenseInputFromInbox(inboxItem());

    expect(ocrInput.taxStatus, 'der OCR-Weg behauptet keinen Steuerstatus').toBeUndefined();

    const created = addExpense({ ...ocrInput, invoiceNumber: 'OCR-FIX1' });
    expect(created.success, created.success ? '' : JSON.stringify(created)).toBe(true);
    if (!created.success) return;

    expect(created.expense.taxStatus).toBe('unclear');
    expect(created.expense.taxStatus).not.toBe('standard_19');
    expect(created.expense.taxStatus).not.toBe('reverse_charge_13b');
  });
});

describe('E — Altbestand', () => {
  // T-Legacy — kein Backfill, kein Überschreiben beim Öffnen.
  it('eine gespeicherte Ausgabe behält ihren Steuerstatus', () => {
    const created = addExpense(input({ taxStatus: 'standard_7', invoiceNumber: 'LEG-1' }));
    if (!created.success) throw new Error('Vorbereitung');
    // Der Betrieb stellt danach auf §13b um.
    setNullsteuerBetrieb();

    const geladen = getExpenseById(created.expense.id)!;
    expect(geladen.taxStatus, 'der Beleg folgt nicht dem neuen Firmenstatus').toBe('standard_7');
  });

  it('eine Änderung ohne Statusangabe behält den gespeicherten Status', () => {
    const created = addExpense(input({ taxStatus: 'standard_19', invoiceNumber: 'LEG-2' }));
    if (!created.success) throw new Error('Vorbereitung');
    setNullsteuerBetrieb();

    const updated = updateExpense(created.expense.id, { title: 'Neuer Titel' });
    expect(updated.success, updated.success ? '' : JSON.stringify(updated)).toBe(true);
    if (!updated.success) return;
    expect(updated.expense.taxStatus).toBe('standard_19');
    expect(updated.expense.taxAmount).toBe(19);
  });
});

describe('F — das Formular zeigt den Steuerstatus', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function zeige(): Promise<void> {
    await act(async () => {
      root.render(
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <ExpenseForm mode="add" onSaved={() => {}} onCancel={() => {}} />
        </AppProvider>,
      );
    });
  }

  const select = () =>
    container.querySelector('[data-testid="expense-tax-status-select"]') as HTMLSelectElement | null;

  // T1 — die Auswahl ist überhaupt da.
  it('T1: das Formular zeigt eine Auswahl für den Steuerstatus', async () => {
    await zeige();
    expect(select(), 'die Auswahl fehlt').not.toBeNull();
  });

  // T2/T3/T4 — alle Werte des Modells stehen zur Wahl, in verständlicher Sprache.
  it('T2/T3/T4: alle Steuerfälle sind wählbar und lesbar beschriftet', async () => {
    await zeige();
    const optionen = Array.from(select()!.options);

    expect(optionen.map((option) => option.value)).toEqual([...EXPENSE_TAX_STATUS_OPTIONS]);
    expect(optionen.map((option) => option.value)).toContain('standard_19');
    expect(optionen.map((option) => option.value)).toContain('standard_7');
    expect(optionen.map((option) => option.value)).toContain('reverse_charge_13b');
    expect(optionen.map((option) => option.value)).toContain('tax_free');
    expect(optionen.map((option) => option.value)).toContain('kleinunternehmer_19');
    expect(optionen.map((option) => option.value)).toContain('unclear');

    const texte = optionen.map((option) => option.textContent ?? '');
    expect(texte).toContain('19 % Umsatzsteuer');
    expect(texte).toContain('7 % Umsatzsteuer');
    // Keine technischen Bezeichner in der Anzeige.
    for (const text of texte) {
      expect(text).not.toMatch(/standard_19|standard_7|reverse_charge_13b|tax_free|kleinunternehmer_19/);
    }
  });

  /*
   * T5 (Oberfläche) — der Vorschlag ist der Regelsatz, nicht der Firmenstatus.
   * Genau daran scheiterte die Abnahme.
   */
  it('T5c: der Vorschlag ist 19 %, auch wenn der Betrieb selbst ohne USt abrechnet', async () => {
    setNullsteuerBetrieb();
    await zeige();

    expect(select()!.value).toBe(MANUAL_EXPENSE_DEFAULT_TAX_STATUS);
    expect(select()!.value).toBe('standard_19');
    expect(select()!.value).not.toBe('reverse_charge_13b');
  });
});
