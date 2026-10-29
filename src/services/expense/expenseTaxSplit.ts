/**
 * P1-KORREKTURBLOCK A-04 — die Steueraufteilung eines Eingangsbelegs.
 *
 * ## Der Befund
 *
 * Eine Ausgabe mit 119,00 € brutto und Steuerstatus „19 %“, aber ohne Netto- und Steuerangabe, wurde mit
 * 119,00 € netto und 0,00 € Steuer gespeichert — als hätte der Beleg das so ausgewiesen — und so in
 * Detailanzeige, Datenexport und Steuerberater-Monatsmappe weitergegeben (`resolveExpenseAmounts`: fehlendes
 * Netto = Brutto, Steuer = Differenz). Unbekanntes wurde zu einer bestätigten Nullsteuer.
 *
 * ## Was jetzt gilt
 *
 * Fünf fachliche Zustände, sauber getrennt (`ExpenseTaxSplitState`):
 *
 *  - **belegt**   — Netto und Steuer stehen so auf dem Beleg (ein Steuersatz);
 *  - **gemischt** — Netto und Steuer stehen auf dem Beleg, als Summen über mehrere Steuersätze;
 *  - **steuerfrei** — echte Nullsteuer: Der Steuerstatus schliesst Umsatzsteuer aus (steuerfrei, Kleinunternehmer,
 *    §13b); Netto = Brutto, Steuer 0 ist dann belegt, nicht geschätzt;
 *  - **offen**    — die Aufteilung ist nicht belegt. Gespeichert werden Platzhalter (Netto = Brutto, Steuer 0),
 *    weil der Serververtrag drei stimmige Beträge verlangt; ausgewiesen, gebucht oder exportiert wird **nichts**
 *    davon — Netto und Steuer stehen leer, mit Hinweis, und der Monat lässt sich so nicht abschliessen;
 *  - **altbestand_pruefen** — vor A-04 gespeichert, Regel- oder unklarer Steuerstatus mit 0 € Steuer und
 *    Netto = Brutto. Nur **lesend** erkannt: Die Werte bleiben unverändert (auch in bestehenden Abschlüssen),
 *    Anzeige und Monatsmappe tragen einen Prüfhinweis.
 *
 * Dazu der Vorsteuerabzug zur belegten Steuer: voll (bisherige Annahme), teilweise (mit Betrag), keiner.
 *
 * Es wird nie geschätzt: Kein Betrag entsteht aus einem Steuersatz (keine Division durch 1,19). Gerechnet wird
 * nur die Differenz zweier **belegter** Zahlen (Netto = Brutto − Steuer bzw. Steuer = Brutto − Netto).
 *
 * Rein: kein Zustand, keine Uhr, kein Netzwerk, keine Speicherzugriffe.
 */
import { fromCents, isValidMoneyNumber, toCents } from '../invoiceMoney';
import { getTaxRateForStatus } from '../invoiceTaxService';
import { isZeroRateTaxStatus } from './expenseMoneyIntegrity';
import type { Expense, ExpenseInputTaxDeduction, ExpenseTaxSplit } from '../../types/expense';
import type { TaxStatus } from '../../types/models';

export type ExpenseTaxSplitState = 'belegt' | 'gemischt' | 'steuerfrei' | 'offen' | 'altbestand_pruefen';

/** Was die Zustandsbestimmung von einem Beleg braucht. */
export type ExpenseTaxSplitSource = Pick<Expense, 'taxStatus' | 'netAmount' | 'taxAmount' | 'grossAmount'> &
  Partial<Pick<Expense, 'taxSplit' | 'inputTaxDeduction' | 'deductibleTaxAmount'>>;

/** Netto = Brutto und Steuer 0 — der Platzhalter einer offenen Aufteilung (und das Bild des Altbefunds). */
export function isPlaceholderTaxSplit(amounts: { netAmount: number; taxAmount: number; grossAmount: number }): boolean {
  return toCents(amounts.taxAmount) === 0 && toCents(amounts.netAmount) === toCents(amounts.grossAmount);
}

/**
 * Der fachliche Zustand eines gespeicherten Belegs.
 *
 * `offen` gilt nur zusammen mit den Platzhaltern: Trägt ein Beleg das Kennzeichen, aber andere Beträge (etwa weil
 * ein älterer Client die Aufteilung nachgetragen hat, ohne das Kennzeichen zu kennen), sind die Beträge belegt.
 */
export function resolveExpenseTaxSplitState(expense: ExpenseTaxSplitSource): ExpenseTaxSplitState {
  if (isZeroRateTaxStatus(expense.taxStatus)) return 'steuerfrei';
  if (expense.taxSplit === 'offen') return isPlaceholderTaxSplit(expense) ? 'offen' : 'belegt';
  if (expense.taxSplit === 'gemischt') return 'gemischt';
  if (expense.taxSplit === 'belegt') return 'belegt';
  return isPlaceholderTaxSplit(expense) ? 'altbestand_pruefen' : 'belegt';
}

export function isExpenseTaxSplitOpen(expense: ExpenseTaxSplitSource): boolean {
  return resolveExpenseTaxSplitState(expense) === 'offen';
}

/**
 * P1 A-04 Produktregel A — „Bezahlt – Steuerprüfung offen“: Auf den Beleg ist tatsächlich Geld geflossen, seine
 * Steueraufteilung ist aber noch nicht belegt. Nur für die Anzeige; Kontierung und Monatsabschluss bleiben gesperrt.
 */
export function hasPaymentWithOpenTaxReview(
  expense: ExpenseTaxSplitSource & Pick<Expense, 'status'>,
  paidAmount: number,
): boolean {
  return expense.status !== 'storniert' && paidAmount > 0 && isExpenseTaxSplitOpen(expense);
}

/** Der Vorsteuerabzug, soweit es belegte Steuer gibt; sonst `undefined` (nichts abzuziehen bzw. unbekannt). */
export function resolveExpenseInputTaxDeduction(expense: ExpenseTaxSplitSource): ExpenseInputTaxDeduction | undefined {
  const state = resolveExpenseTaxSplitState(expense);
  if (state !== 'belegt' && state !== 'gemischt') return undefined;
  if (toCents(expense.taxAmount) === 0) return undefined;
  return expense.inputTaxDeduction ?? 'voll';
}

/** Netto und Steuer, wie Export, Monatsmappe und Buchung sie führen dürfen: bei offener Aufteilung leer. */
export function expenseBookingAmounts(expense: ExpenseTaxSplitSource): { netto: number | null; steuer: number | null } {
  return resolveExpenseTaxSplitState(expense) === 'offen'
    ? { netto: null, steuer: null }
    : { netto: expense.netAmount, steuer: expense.taxAmount };
}

/* ------------------------------------------------------------------ */
/* Texte für Steuerberater-Ausgaben (Monatsmappe, Buchungsdaten)       */
/* ------------------------------------------------------------------ */

/*
 * Die Steuerberater-Ausgaben sind ausdrücklich deutsch (wie die übrigen Hinweise der Monatsmappe); die Oberfläche
 * übersetzt ihre eigenen Texte über den Katalog.
 */
const STATUS_TEXT: Partial<Record<TaxStatus, string>> = {
  standard_19: '19 % Umsatzsteuer',
  standard_7: '7 % Umsatzsteuer',
  unclear: 'unklar',
};

function euro(value: number): string {
  return value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const TAX_SPLIT_OPEN_HINT =
  'Steueraufteilung offen: Netto und Vorsteuer sind nicht belegt – leer gelassen, nicht geschätzt; bitte vom Originalbeleg übernehmen';

export function legacyTaxSplitHint(taxStatus: TaxStatus): string {
  return `Bitte prüfen: Altbestand mit Steuerstatus „${STATUS_TEXT[taxStatus] ?? taxStatus}“, aber 0,00 € Steuer und Netto = Brutto – die Steueraufteilung ist möglicherweise nicht belegt; Werte unverändert übernommen`;
}

/** Der Hinweis zur Steueraufteilung und zum Vorsteuerabzug — `undefined`, wenn es nichts zu sagen gibt. */
export function describeExpenseTaxSplitHint(expense: ExpenseTaxSplitSource): string | undefined {
  const state = resolveExpenseTaxSplitState(expense);
  const teile: string[] = [];
  if (state === 'offen') teile.push(TAX_SPLIT_OPEN_HINT);
  if (state === 'altbestand_pruefen') teile.push(legacyTaxSplitHint(expense.taxStatus));
  if (state === 'gemischt') teile.push('Gemischte Steuersätze: Netto und Steuer sind Summen laut Beleg');
  const abzug = resolveExpenseInputTaxDeduction(expense);
  if (abzug === 'keiner') teile.push('Vorsteuer nicht abziehbar');
  if (abzug === 'teilweise' && typeof expense.deductibleTaxAmount === 'number') {
    teile.push(`Vorsteuer teilweise abziehbar: ${euro(expense.deductibleTaxAmount)} €`);
  }
  return teile.length > 0 ? teile.join(' · ') : undefined;
}

/**
 * Der Zusatz zur Steuerbehandlung in den Buchungsdaten (`buchungen.csv`, Spalte „Steuerstatus“) — damit eine
 * gemischte oder nicht voll abziehbare Steuer dort nicht als gewöhnliche Vorsteuer erscheint. Ohne Abweichung
 * vom Normalfall `undefined`: Bestehende Zeilen bleiben unverändert.
 */
export function describeExpenseBookingTaxNote(expense: ExpenseTaxSplitSource): string | undefined {
  const teile: string[] = [];
  /*
   * A04-WEISS-R1 — ein Altbestand mit Prüfbefund (0,00 Steuer bei Regel- oder unklarem Steuerstatus, Netto = Brutto,
   * ohne Kennzeichen) steht in den strukturierten Buchungsdaten nie vorbehaltlos als bestätigte Nullsteuer: Die Werte
   * bleiben unverändert, die Zeile trägt den Vorbehalt.
   */
  if (resolveExpenseTaxSplitState(expense) === 'altbestand_pruefen') {
    teile.push('UNGEPRÜFT: Altbestand mit 0,00 Steuer bei diesem Steuerstatus – Aufteilung möglicherweise nicht belegt, bitte am Originalbeleg prüfen');
  }
  if (resolveExpenseTaxSplitState(expense) === 'gemischt') teile.push('gemischte Steuersätze (Summen laut Beleg)');
  const abzug = resolveExpenseInputTaxDeduction(expense);
  if (abzug === 'keiner') teile.push('Vorsteuer nicht abziehbar');
  if (abzug === 'teilweise' && typeof expense.deductibleTaxAmount === 'number') {
    teile.push(`Vorsteuer teilweise abziehbar (${euro(expense.deductibleTaxAmount)})`);
  }
  return teile.length > 0 ? teile.join(', ') : undefined;
}

/* ------------------------------------------------------------------ */
/* Abschlussvertrag (Fassung 6) und Serververtrag                      */
/* ------------------------------------------------------------------ */

/**
 * A04-WEISS-R1 — Kennzeichen eines Schreibstands, der die Steueraufteilung kennt. Jeder Cloud-Auftrag dieses Clients
 * trägt es (`expenseCloudSyncService`). Fehlt es, behandelt der Server den Auftrag als Altclient: Er übernimmt die
 * gespeicherte Steueraufteilung, statt sie zu verlieren, und weist widersprüchliche Stände ab (Migration
 * `p1_a04_steueraufteilung_server`).
 */
export const EXPENSE_TAX_SPLIT_SCHEMA = 1;

/** A04-WEISS-R2 — die steuerlichen Merkmale eines Eingangsbelegs, die Abschlussfassung 6 bindet. */
export interface ExpenseTaxSplitClosureAttributes {
  readonly steueraufteilung: ExpenseTaxSplitState;
  /** Wirksamer Vorsteuerabzug; leer, wenn es keine belegte Steuer gibt. */
  readonly vorsteuerabzug: ExpenseInputTaxDeduction | '';
  /** Abziehbarer Betrag nur bei „teilweise“, sonst `null`. */
  readonly abziehbareVorsteuer: number | null;
}

/**
 * Was der Abschluss (Fassung 6) je Eingangsbeleg und Ausgabenstorno bindet — exakt so, wie der Server es aus der
 * gespeicherten Nutzlast bildet (`workspace_expense_steueraufteilung`, `…_vorsteuerabzug`, `…_abziehbar_cent`).
 * Eine spätere Änderung an Aufteilungsart, Abzugsart oder abziehbarem Betrag ändert damit den Fingerabdruck: Der
 * Monat gilt als „seit Abschluss geändert“, bis eine neue Revision entsteht — auch eine erneute
 * Kontierungsbestätigung macht die alte Revision nicht wieder gültig.
 */
export function expenseTaxSplitClosureAttributes(expense: ExpenseTaxSplitSource): ExpenseTaxSplitClosureAttributes {
  const abzug = resolveExpenseInputTaxDeduction(expense);
  return {
    steueraufteilung: resolveExpenseTaxSplitState(expense),
    vorsteuerabzug: abzug ?? '',
    abziehbareVorsteuer:
      abzug === 'teilweise' && typeof expense.deductibleTaxAmount === 'number' && Number.isFinite(expense.deductibleTaxAmount)
        ? expense.deductibleTaxAmount
        : null,
  };
}

/** Unterscheiden sich die gebundenen Merkmale zweier Stände? (Grundlage der Sperre für ältere Abschlussfassungen.) */
export function expenseTaxSplitClosureAttributesChanged(before: ExpenseTaxSplitSource, after: ExpenseTaxSplitSource): boolean {
  const a = expenseTaxSplitClosureAttributes(before);
  const b = expenseTaxSplitClosureAttributes(after);
  return (
    a.steueraufteilung !== b.steueraufteilung ||
    a.vorsteuerabzug !== b.vorsteuerabzug ||
    (a.abziehbareVorsteuer === null ? null : toCents(a.abziehbareVorsteuer)) !==
      (b.abziehbareVorsteuer === null ? null : toCents(b.abziehbareVorsteuer))
  );
}

/* ------------------------------------------------------------------ */
/* Schreiben: Auflösung einer Eingabe                                  */
/* ------------------------------------------------------------------ */

export interface ExpenseTaxSplitRequest {
  readonly grossAmount: number;
  readonly taxStatus: TaxStatus;
  /** Angegeben = vom Beleg. `undefined` = nicht angegeben. */
  readonly netAmount?: number;
  readonly taxAmount?: number;
  readonly taxSplit?: ExpenseTaxSplit;
  readonly inputTaxDeduction?: ExpenseInputTaxDeduction;
  readonly deductibleTaxAmount?: number;
}

export interface ExpenseTaxSplitResolution {
  readonly netAmount: number;
  readonly taxAmount: number;
  readonly taxSplit: ExpenseTaxSplit;
  readonly inputTaxDeduction?: ExpenseInputTaxDeduction;
  readonly deductibleTaxAmount?: number;
}

export type ExpenseTaxSplitPlan = ({ readonly ok: true } & ExpenseTaxSplitResolution) | { readonly ok: false; readonly errorKey: string };

function differenz(minuend: number, subtrahend: number): number {
  if (!isValidMoneyNumber(minuend) || !isValidMoneyNumber(subtrahend)) return Number.NaN;
  return fromCents(toCents(minuend) - toCents(subtrahend));
}

/**
 * Die eine Auflösung für `addExpense` und `updateExpense`.
 *
 *  1. Steuerstatus ohne Umsatzsteuer: echte Nullsteuer — Netto = Brutto, Steuer 0, sofern nichts anderes angegeben
 *     ist (ein Steuerbetrag ungleich 0 scheitert danach an der Geldprüfung).
 *  2. Ausdrücklich `offen`: Platzhalter; angegebene Beträge zählen nicht.
 *  3. Weder Netto noch Steuer angegeben: **offen** — nie 0 € Steuer. Wer „belegt“ oder „gemischt“ sagt, muss
 *     Beträge angeben.
 *  4. Beträge angegeben: der fehlende ist die Differenz zum Brutto. Eine Steuer von 0 € bei 19 %, 7 % oder „unklar“
 *     ist kein belegter Wert (dafür gibt es die Steuerstatus ohne Umsatzsteuer und „offen“; Produktregel B).
 *  5. Vorsteuerabzug nur bei belegter Steuer ungleich 0; „teilweise“ verlangt einen Betrag zwischen 0 und der Steuer.
 */
export function planExpenseTaxSplit(request: ExpenseTaxSplitRequest): ExpenseTaxSplitPlan {
  const { grossAmount, taxStatus } = request;
  const netGiven = request.netAmount !== undefined;
  const taxGiven = request.taxAmount !== undefined;

  if (isZeroRateTaxStatus(taxStatus)) {
    const netAmount = netGiven ? request.netAmount! : taxGiven ? differenz(grossAmount, request.taxAmount!) : grossAmount;
    const taxAmount = taxGiven ? request.taxAmount! : differenz(grossAmount, netAmount);
    return { ok: true, netAmount, taxAmount, taxSplit: 'belegt' };
  }

  if (request.taxSplit === 'offen') return { ok: true, netAmount: grossAmount, taxAmount: 0, taxSplit: 'offen' };

  if (!netGiven && !taxGiven) {
    if (request.taxSplit === 'belegt' || request.taxSplit === 'gemischt') {
      return { ok: false, errorKey: 'expense.taxSplit.amountsRequired' };
    }
    return { ok: true, netAmount: grossAmount, taxAmount: 0, taxSplit: 'offen' };
  }

  const netAmount = netGiven ? request.netAmount! : differenz(grossAmount, request.taxAmount!);
  const taxAmount = taxGiven ? request.taxAmount! : differenz(grossAmount, netAmount);
  const taxSplit: ExpenseTaxSplit = request.taxSplit === 'gemischt' ? 'gemischt' : 'belegt';
  const taxCents = toCents(taxAmount);
  // Unbrauchbare Zahlen meldet die Geldprüfung (`amount_not_finite`) — hier nichts erfinden.
  if (!Number.isFinite(taxCents)) return { ok: true, netAmount, taxAmount, taxSplit };

  if (taxCents === 0) {
    if (getTaxRateForStatus(taxStatus) > 0) return { ok: false, errorKey: 'expense.taxSplit.zeroTaxForTaxableStatus' };
    /*
     * P1 A-04 Produktregel B (Server: workspace_expense_steueraufteilung_pruefen) — 0 € Steuer ist nur mit einem
     * Steuerstatus ohne Umsatzsteuer begründet (oben, Fall 1). Beim Steuerstatus „unklar“ ist sie keine Klärung —
     * für Neuanlage und Bearbeitung gleich (bisher galt sie hier als „belegt“).
     */
    if (taxStatus === 'unclear') return { ok: false, errorKey: 'expense.taxSplit.zeroTaxUnclear' };
    return { ok: true, netAmount, taxAmount, taxSplit };
  }

  const abzug = request.inputTaxDeduction ?? 'voll';
  if (abzug === 'teilweise') {
    const betragCents = request.deductibleTaxAmount === undefined ? Number.NaN : toCents(request.deductibleTaxAmount);
    if (
      !Number.isFinite(betragCents) ||
      betragCents === 0 ||
      Math.sign(betragCents) !== Math.sign(taxCents) ||
      Math.abs(betragCents) >= Math.abs(taxCents)
    ) {
      return { ok: false, errorKey: 'expense.inputTaxDeduction.amountInvalid' };
    }
    return { ok: true, netAmount, taxAmount, taxSplit, inputTaxDeduction: 'teilweise', deductibleTaxAmount: fromCents(betragCents) };
  }
  return { ok: true, netAmount, taxAmount, taxSplit, ...(request.inputTaxDeduction ? { inputTaxDeduction: abzug } : {}) };
}

/** Berührt eine Änderung Beträge, Steuerstatus oder Steueraufteilung? Sonst bleibt der Stand unangetastet. */
export function touchesExpenseTaxSplit(
  current: Pick<Expense, 'grossAmount' | 'taxStatus'>,
  changes: Partial<Pick<Expense, 'grossAmount' | 'netAmount' | 'taxAmount' | 'taxStatus' | 'taxSplit' | 'inputTaxDeduction' | 'deductibleTaxAmount'>>,
): boolean {
  return (
    changes.taxSplit !== undefined ||
    changes.netAmount !== undefined ||
    changes.taxAmount !== undefined ||
    changes.inputTaxDeduction !== undefined ||
    changes.deductibleTaxAmount !== undefined ||
    (changes.grossAmount !== undefined && toCents(changes.grossAmount) !== toCents(current.grossAmount)) ||
    (changes.taxStatus !== undefined && changes.taxStatus !== current.taxStatus)
  );
}

/**
 * Die Anfrage für eine Änderung (`updateExpense`).
 *
 * Mit ausdrücklicher Angabe (`taxSplit`, so sendet das Formular) gilt genau sie samt der angegebenen Beträge.
 * Ohne Angabe (ältere Aufrufer): Eine offene Aufteilung bleibt offen, solange keine Beträge kommen — Platzhalter
 * folgen dem neuen Brutto; sonst gelten wie bisher die geänderten Beträge zusammen mit den gespeicherten.
 */
export function buildExpenseTaxSplitRequestForUpdate(
  current: ExpenseTaxSplitSource,
  changes: Partial<Pick<Expense, 'grossAmount' | 'netAmount' | 'taxAmount' | 'taxStatus' | 'taxSplit' | 'inputTaxDeduction' | 'deductibleTaxAmount'>>,
): ExpenseTaxSplitRequest {
  const grossAmount = changes.grossAmount ?? current.grossAmount;
  const taxStatus = changes.taxStatus ?? current.taxStatus;
  if (changes.taxSplit !== undefined) {
    return {
      grossAmount,
      taxStatus,
      netAmount: changes.netAmount,
      taxAmount: changes.taxAmount,
      taxSplit: changes.taxSplit,
      inputTaxDeduction: changes.inputTaxDeduction,
      deductibleTaxAmount: changes.deductibleTaxAmount,
    };
  }
  const amountsGiven = changes.netAmount !== undefined || changes.taxAmount !== undefined;
  if (resolveExpenseTaxSplitState(current) === 'offen') {
    return amountsGiven
      ? {
          grossAmount,
          taxStatus,
          netAmount: changes.netAmount,
          taxAmount: changes.taxAmount,
          inputTaxDeduction: changes.inputTaxDeduction,
          deductibleTaxAmount: changes.deductibleTaxAmount,
        }
      : { grossAmount, taxStatus, taxSplit: 'offen' };
  }
  return {
    grossAmount,
    taxStatus,
    netAmount: changes.netAmount ?? current.netAmount,
    taxAmount: changes.taxAmount ?? current.taxAmount,
    taxSplit: current.taxSplit === 'gemischt' ? 'gemischt' : undefined,
    inputTaxDeduction: changes.inputTaxDeduction ?? current.inputTaxDeduction,
    deductibleTaxAmount: changes.deductibleTaxAmount ?? current.deductibleTaxAmount,
  };
}

/* ------------------------------------------------------------------ */
/* Bestandsprüfung — ausschliesslich lesend                            */
/* ------------------------------------------------------------------ */

export interface ExpenseTaxSplitAuditEntry {
  readonly id: string;
  readonly supplierName: string;
  readonly invoiceNumber: string;
  readonly issueDate: string;
  readonly taxStatus: TaxStatus;
  readonly grossAmount: number;
  readonly status: Expense['status'];
  /** Mit gebuchter Zahlung sind Beträge gebunden: Korrektur nur über Zahlungsrücknahme oder Storno + Neuerfassung. */
  readonly hasPayments: boolean;
}

/**
 * Welche gespeicherten Ausgaben den Altbefund tragen (Regel- oder unklarer Steuerstatus, 0 € Steuer, Netto =
 * Brutto, ohne A-04-Kennzeichen). **Ändert nichts** — kein Umrechnen, kein Überschreiben, kein Cloud-Zugriff.
 */
export function auditLegacyExpenseTaxSplits(expenses: readonly Expense[]): ExpenseTaxSplitAuditEntry[] {
  return expenses
    .filter((expense) => resolveExpenseTaxSplitState(expense) === 'altbestand_pruefen')
    .map((expense) => ({
      id: expense.id,
      supplierName: expense.supplierName,
      invoiceNumber: expense.invoiceNumber,
      issueDate: expense.issueDate,
      taxStatus: expense.taxStatus,
      grossAmount: expense.grossAmount,
      status: expense.status,
      hasPayments: (expense.payments ?? []).length > 0,
    }));
}
