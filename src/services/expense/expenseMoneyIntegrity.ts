/**
 * FINANZCORE-05B — die eine Geldprüfung für Ausgaben.
 *
 * ## Der Befund aus 05A
 *
 * `netAmount`, `taxAmount` und `grossAmount` waren drei voneinander unabhängige
 * Zahlen. Nichts verband sie, und `taxStatus` stand daneben, ohne je gegen den
 * Steuerbetrag gehalten zu werden. Ein Beleg mit 100 netto, 19 Steuer und 200
 * brutto war speicherbar — und landete so in der Cloud und in der Monatsmappe.
 *
 * Auf der Rechnungsseite gibt es diese Lücke nicht: Dort wird in Cent
 * gerechnet und serverseitig geprüft. Diese Datei zieht die Ausgabenseite nach,
 * und zwar an **einer** Stelle. Verstreute Einzelprüfungen wären genau der
 * Zustand, aus dem das Problem entstanden ist.
 *
 * ## Was hier hart geprüft wird — und warum nur das
 *
 * Drei Regeln, jede zwingend aus dem vorhandenen Modell ableitbar:
 *
 *  1. **Die Gleichung.** `netto + steuer = brutto`, auf den Cent. Sie gilt
 *     unabhängig von Steuersatz, Vorzeichen und Belegart. Wer sie verletzt,
 *     hat keinen Rundungsfehler, sondern einen Widerspruch.
 *  2. **Kein Steuerbetrag ohne Steuer.** Sagt der Status, dass keine
 *     Umsatzsteuer anfällt — Kleinunternehmer, §13b, steuerfrei —, dann ist ein
 *     Steuerbetrag ungleich null ein Widerspruch zum Status selbst.
 *  3. **Steuer folgt dem Netto im Vorzeichen.** Ein positiver Steuerbetrag auf
 *     einem negativen Netto ist keine Gutschrift, sondern ein Tippfehler.
 *
 * ## Was hier bewusst **nicht** hart geprüft wird
 *
 * Bei `standard_19` und `standard_7` wird der Steuerbetrag **nicht** erzwungen.
 * Das ist keine Nachlässigkeit, sondern folgt aus dem Datenmodell:
 *
 *  - Eine Ausgabe trägt **einen** Steuerstatus und **einen** Steuerbetrag.
 *    Gemischte Sätze — die Hotelrechnung mit 7 % Übernachtung und 19 %
 *    Frühstück, der Baumarktbon mit zwei Sätzen — sind darin gar nicht
 *    darstellbar. Eine Regel „Steuer = 19 % vom Netto" würde solche Belege
 *    unbuchbar machen, obwohl sie echt sind.
 *  - Die Eingabemaske sendet **keinen** Steuerstatus; er kommt aus dem
 *    Firmenprofil. Netto und Steuer sind dort optional. Wer nur den
 *    Bruttobetrag eintippt, erhält Netto = Brutto und Steuer = 0 — ein
 *    vollkommen zulässiger Zwischenstand, der an einer Satzregel scheitern
 *    würde.
 *
 * Eine Abweichung vom erwarteten Satz ist deshalb ein **Befund**, kein Fehler:
 * `describeExpenseTaxRateDeviation` macht sie sichtbar, ohne die Buchung zu
 * verhindern. `unclear` wird gar nicht interpretiert — ein unklarer Status
 * erlaubt keine Aussage über den richtigen Betrag, und eine zu erfinden wäre
 * schlimmer als keine.
 *
 * Rein: kein Zustand, keine Uhr, kein Netzwerk, keine Speicherzugriffe.
 */
import { isValidMoneyNumber, toCents } from '../invoiceMoney';
import { getTaxRateForStatus } from '../invoiceTaxService';
import type { TaxStatus } from '../../types/models';

/** Die Geldangaben eines Belegs — genau das, was geprüft werden kann. */
export interface ExpenseMoneyAmounts {
  readonly netAmount: number;
  readonly taxAmount: number;
  readonly grossAmount: number;
  readonly taxStatus: TaxStatus;
}

export type ExpenseMoneyIssueCode =
  /** Mindestens ein Betrag ist keine verwertbare Zahl. */
  | 'amount_not_finite'
  /** `netto + steuer` ergibt nicht `brutto` — auf den Cent gerechnet. */
  | 'equation_mismatch'
  /** Der Status schliesst Umsatzsteuer aus, es steht trotzdem ein Betrag da. */
  | 'tax_on_zero_rate_status'
  /** Steuer und Netto zeigen in entgegengesetzte Richtungen. */
  | 'tax_sign_mismatch';

export interface ExpenseMoneyIssue {
  readonly code: ExpenseMoneyIssueCode;
  /** Maschinenlesbare Einzelheiten — für Protokoll und Bestandsprüfung. */
  readonly detail: string;
}

export type ExpenseMoneyIntegrityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ExpenseMoneyIssue[] };

/**
 * Die Steuerstatus, bei denen nach vorhandener Produktsemantik **keine**
 * Umsatzsteuer anfällt.
 *
 * Abgeleitet aus `getTaxRateForStatus`, nicht danebengeschrieben: Kommt ein
 * neuer Status mit Satz 0 hinzu, gilt diese Regel automatisch auch für ihn.
 * `unclear` fällt bewusst heraus — es hat zwar den Satz 0, sagt aber nicht
 * „keine Steuer", sondern „unbekannt". Aus Unwissen einen Nullbetrag zu
 * erzwingen wäre eine erfundene Steuerbehandlung.
 */
export function isZeroRateTaxStatus(taxStatus: TaxStatus): boolean {
  if (taxStatus === 'unclear') return false;
  return getTaxRateForStatus(taxStatus) === 0;
}

/**
 * Prüft die Geldangaben eines Belegs.
 *
 * Gedacht für **neue und geänderte** Daten. Für Altbestand liefert dieselbe
 * Funktion die Befunde der Bestandsprüfung — sie ändert nichts und liest nichts
 * nach.
 */
export function checkExpenseMoneyIntegrity(
  amounts: ExpenseMoneyAmounts,
): ExpenseMoneyIntegrityResult {
  const issues: ExpenseMoneyIssue[] = [];

  const { netAmount, taxAmount, grossAmount, taxStatus } = amounts;

  if (
    !isValidMoneyNumber(netAmount) ||
    !isValidMoneyNumber(taxAmount) ||
    !isValidMoneyNumber(grossAmount)
  ) {
    return {
      ok: false,
      issues: [
        {
          code: 'amount_not_finite',
          detail: `net=${netAmount} tax=${taxAmount} gross=${grossAmount}`,
        },
      ],
    };
  }

  /*
   * In Cent, nicht in Euro. `0.1 + 0.2 !== 0.3` — ein Gleitkommavergleich
   * hätte entweder echte Widersprüche durchgelassen oder korrekte Belege
   * abgelehnt, je nachdem, wie gross man das Epsilon wählt. Der Cent ist die
   * kleinste Einheit, in der ein Beleg überhaupt etwas behauptet; darunter
   * gibt es nichts zu vergleichen. `toCents` ist derselbe Helfer, mit dem die
   * Rechnungsseite rechnet.
   */
  const netCents = toCents(netAmount);
  const taxCents = toCents(taxAmount);
  const grossCents = toCents(grossAmount);

  if (netCents + taxCents !== grossCents) {
    issues.push({
      code: 'equation_mismatch',
      detail: `${netCents} + ${taxCents} = ${netCents + taxCents}, erwartet ${grossCents}`,
    });
  }

  if (taxCents !== 0 && isZeroRateTaxStatus(taxStatus)) {
    issues.push({
      code: 'tax_on_zero_rate_status',
      detail: `${taxStatus} schliesst Umsatzsteuer aus, Steuerbetrag ${taxCents} Cent`,
    });
  }

  if ((netCents > 0 && taxCents < 0) || (netCents < 0 && taxCents > 0)) {
    issues.push({
      code: 'tax_sign_mismatch',
      detail: `net=${netCents} tax=${taxCents}`,
    });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/* ------------------------------------------------------------------ */
/* Befund ohne Ablehnung: Abweichung vom erwarteten Steuersatz         */
/* ------------------------------------------------------------------ */

export interface ExpenseTaxRateDeviation {
  readonly taxStatus: TaxStatus;
  readonly ratePercent: number;
  readonly expectedTaxCents: number;
  readonly actualTaxCents: number;
}

/**
 * Weicht der Steuerbetrag von dem ab, was der Satz erwarten liesse?
 *
 * Nur für Belege mit einem echten Satz (19 % / 7 %) und nur als **Hinweis** —
 * siehe Modulkopf: Mischsätze sind im Modell nicht darstellbar, und die Maske
 * lässt den Steuerbetrag offen. Gerundet wird mit `taxCentsFromNet`, also
 * genau so, wie die Rechnungsseite rundet.
 *
 * `null` heisst: Es gibt keine Abweichung, oder der Status erlaubt keine
 * Aussage.
 */
export function describeExpenseTaxRateDeviation(
  amounts: ExpenseMoneyAmounts,
): ExpenseTaxRateDeviation | null {
  const { netAmount, taxAmount, taxStatus } = amounts;
  if (!isValidMoneyNumber(netAmount) || !isValidMoneyNumber(taxAmount)) return null;

  const ratePercent = getTaxRateForStatus(taxStatus);
  if (ratePercent <= 0) return null;

  const netCents = toCents(netAmount);
  const actualTaxCents = toCents(taxAmount);
  /*
   * Bei einer Gutschrift ist das Netto negativ. `taxCentsFromNet` rechnet mit
   * dem Betrag und erhält das Vorzeichen — sonst wäre jede Gutschrift eine
   * Abweichung.
   */
  const sign = netCents < 0 ? -1 : 1;
  const expectedTaxCents = sign * Math.round((Math.abs(netCents) * ratePercent) / 100);

  if (expectedTaxCents === actualTaxCents) return null;
  return { taxStatus, ratePercent, expectedTaxCents, actualTaxCents };
}

/* ------------------------------------------------------------------ */
/* Bestandsprüfung — ausschliesslich lesend                            */
/* ------------------------------------------------------------------ */

/**
 * Ein Beleg mit seinen Befunden.
 *
 * Bewusst nur Kennung, Nummer und Beträge: genug, um den Beleg zu finden, und
 * nichts, was in ein Protokoll gehörte, ohne dass jemand es gelesen hat.
 */
export interface ExpenseMoneyAuditEntry {
  readonly id: string;
  readonly supplierName: string;
  readonly invoiceNumber: string;
  readonly issueDate: string;
  readonly netAmount: number;
  readonly taxAmount: number;
  readonly grossAmount: number;
  readonly taxStatus: TaxStatus;
  readonly issues: readonly ExpenseMoneyIssue[];
}

export interface ExpenseMoneyAudit {
  readonly total: number;
  /** Belege, die die harte Invariante verletzen. */
  readonly invalid: readonly ExpenseMoneyAuditEntry[];
  /** Belege mit abweichendem Steuerbetrag bei 19 % / 7 % — Hinweis, kein Fehler. */
  readonly rateDeviations: readonly (ExpenseMoneyAuditEntry & {
    readonly deviation: ExpenseTaxRateDeviation;
  })[];
  /** Wie oft welcher Befund auftrat — für eine Zeile im Bericht. */
  readonly byIssue: Readonly<Record<ExpenseMoneyIssueCode, number>>;
}

/** Das Mindeste, was ein Beleg für die Bestandsprüfung mitbringen muss. */
export interface AuditableExpense extends ExpenseMoneyAmounts {
  readonly id: string;
  readonly supplierName?: string;
  readonly invoiceNumber?: string;
  readonly issueDate?: string;
}

/**
 * Zählt, welche gespeicherten Ausgaben die Geldinvariante verletzen.
 *
 * **Ändert nichts.** Keine Korrektur, kein Überschreiben, keine Neuberechnung,
 * kein Cloud-Zugriff. Ein Altbeleg, der hier auftaucht, bleibt danach genau so
 * lesbar wie vorher — er ist nur nicht mehr unsichtbar.
 */
export function auditExpenseMoneyIntegrity(
  expenses: readonly AuditableExpense[],
): ExpenseMoneyAudit {
  const invalid: ExpenseMoneyAuditEntry[] = [];
  const rateDeviations: (ExpenseMoneyAuditEntry & { deviation: ExpenseTaxRateDeviation })[] = [];
  const byIssue: Record<ExpenseMoneyIssueCode, number> = {
    amount_not_finite: 0,
    equation_mismatch: 0,
    tax_on_zero_rate_status: 0,
    tax_sign_mismatch: 0,
  };

  for (const expense of expenses) {
    const entry = (issues: readonly ExpenseMoneyIssue[]): ExpenseMoneyAuditEntry => ({
      id: expense.id,
      supplierName: expense.supplierName ?? '',
      invoiceNumber: expense.invoiceNumber ?? '',
      issueDate: expense.issueDate ?? '',
      netAmount: expense.netAmount,
      taxAmount: expense.taxAmount,
      grossAmount: expense.grossAmount,
      taxStatus: expense.taxStatus,
      issues,
    });

    const result = checkExpenseMoneyIntegrity(expense);
    if (!result.ok) {
      invalid.push(entry(result.issues));
      for (const issue of result.issues) byIssue[issue.code] += 1;
      // Bei einem harten Widerspruch sagt die Satzabweichung nichts mehr aus.
      continue;
    }

    const deviation = describeExpenseTaxRateDeviation(expense);
    if (deviation) rateDeviations.push({ ...entry([]), deviation });
  }

  return { total: expenses.length, invalid, rateDeviations, byIssue };
}
