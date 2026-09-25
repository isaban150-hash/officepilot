/**
 * FINANZCORE-05C — die Zahlungsregeln, die Rechnung und Ausgabe teilen.
 *
 * Bis hierher standen dieselben Regeln zweimal da: einmal in
 * `invoicePaymentService`, einmal in `expensePaymentCalculations`. Sie waren
 * nie ganz gleich, und die Unterschiede waren keine Absicht, sondern
 * Geschichte — eine Seite kannte eine Überzahlungsbestätigung, die andere
 * nicht; eine Seite bot nach vollständiger Zahlung weiter „Zahlung erfassen"
 * an, die andere auch. Auseinanderlaufen konnten sie unbemerkt.
 *
 * Hier steht deshalb nur das, was für **jeden positiven Beleg** gilt, und zwar
 * auf nackten Zahlen: keine Rechnung, keine Ausgabe, kein Speicher. Was die
 * beiden Seiten unterscheidet, bleibt bewusst draussen:
 *
 *   - **Skonto** ist Rechnungssache. Es verändert den offenen Betrag nach
 *     eigenen Regeln (`resolveSkontoSettledAmount`), und die gehören nicht
 *     hierher. Deshalb nimmt dieses Modul `openAmount` entgegen, statt ihn
 *     auszurechnen.
 *   - **Gutschrift** ist Ausgabensache (05B-FIX2). Ein negativer Beleg kommt
 *     hier gar nicht erst an; die Ausgabenseite fängt ihn vorher ab.
 *   - **Storno** und **Überfälligkeit** hängen an Feldern, die beide Seiten
 *     unterschiedlich benennen. Sie werden als fertige Angaben hereingereicht.
 *
 * Das ist keine neue Buchhaltungsschicht, sondern eine gemeinsame Rechenregel.
 */

/**
 * Der gemeinsame Zustand eines positiven Belegs — ohne Storno, ohne
 * Gutschrift. Beide Fachtypen (`InvoicePaymentStatus`, `ExpensePaymentStatus`)
 * enthalten diese Werte; sie ergänzen nur ihre eigenen Sonderfälle.
 */
export type SettlementStatus =
  | 'offen'
  | 'teilbezahlt'
  | 'bezahlt'
  | 'ueberfaellig'
  | 'ueberbezahlt';

export interface SettlementInput {
  /** Summe der tatsächlich vorhandenen, wirksamen Zahlungen. */
  readonly paidAmount: number;
  /** Was noch aussteht. Die aufrufende Seite rechnet ihn — Skonto zählt mit. */
  readonly openAmount: number;
  /** Was über den Belegbetrag hinaus gezahlt wurde. */
  readonly overpaidAmount: number;
  /** Ist der Beleg am Betrachtungstag überfällig? */
  readonly overdue: boolean;
}

/**
 * Was über den Belegbetrag hinaus geflossen ist.
 *
 * Bewusst aus **tatsächlich gezahltem Geld** gerechnet und nicht aus einem
 * Vorzeichen: Genau diese Verwechslung liess 05B-FIX2 eine Gutschrift als
 * „Überzahlung 119,00 €" erscheinen, ohne dass je jemand etwas gezahlt hätte.
 * Die aufrufende Seite entscheidet, ob die Frage überhaupt gestellt wird.
 */
export function calculateOverpaidAmount(totalDue: number, paidAmount: number): number {
  if (!Number.isFinite(totalDue) || !Number.isFinite(paidAmount)) return 0;
  return Math.max(0, paidAmount - totalDue);
}

/**
 * Der Zustand eines positiven Belegs.
 *
 * Die Reihenfolge ist die Aussage:
 *
 *   1. **Überbezahlt zuerst.** Bis 05C fiel dieser Fall durch `openAmount <= 0`
 *      auf „bezahlt" — die Überzahlung stand zwar in der Zusammenfassung, der
 *      Status verschwieg sie aber, und Abzeichen, Filter und Sortierung sahen
 *      einen ganz gewöhnlich beglichenen Beleg. „Überbezahlt" ist kein
 *      Sonderfall von „bezahlt": Es liegt Geld zu viel da, und das ist eine
 *      eigene Tatsache.
 *   2. **Bezahlt**, wenn nichts mehr offen und nichts zu viel ist.
 *   3. Sonst entscheidet, ob schon Geld geflossen ist und ob die Frist abgelaufen ist.
 *
 * Überfälligkeit steht hinter der Überzahlung, weil ein überbezahlter Beleg
 * keinen offenen Betrag mehr hat — überfällig sein kann nur, was aussteht.
 * Beide Seiten liefern `overdue` ohnehin bereits so.
 */
export function resolveSettlementStatus(input: SettlementInput): SettlementStatus {
  if (input.overpaidAmount > 0) return 'ueberbezahlt';
  if (input.openAmount <= 0) return 'bezahlt';
  if (input.paidAmount > 0) return input.overdue ? 'ueberfaellig' : 'teilbezahlt';
  return input.overdue ? 'ueberfaellig' : 'offen';
}

/**
 * Wieviel eine **neue** Zahlung über den offenen Betrag hinausginge.
 *
 * Unterscheidet sich von `calculateOverpaidAmount`: Dort geht es um den
 * bereits erreichten Zustand, hier um die Folge eines noch nicht gebuchten
 * Betrags.
 */
export function getPaymentOverpayAmount(openAmount: number, paymentAmount: number): number {
  if (!Number.isFinite(paymentAmount) || !Number.isFinite(openAmount)) return 0;
  return Math.max(0, paymentAmount - openAmount);
}

/**
 * Muss der Nutzer diese Zahlung ausdrücklich bestätigen?
 *
 * Nur wenn sie **grösser** ist als der offene Betrag. Eine Teilzahlung und
 * eine punktgenaue Vollzahlung sind normale Vorgänge und bekommen keine
 * Rückfrage — eine Bestätigung, die immer erscheint, wird weggeklickt und
 * schützt dann vor nichts mehr.
 */
export function requiresOverpaymentConfirmation(
  openAmount: number,
  paymentAmount: number,
): boolean {
  return getPaymentOverpayAmount(openAmount, paymentAmount) > 0;
}

/**
 * Ist der Beleg abgegolten — also weder offen noch teilbezahlt?
 *
 * Grundlage dafür, dass die normale Aktion „Zahlung erfassen" verschwindet.
 * Eine spätere Korrektur läuft über die Zahlungsliste (Zahlung zurücknehmen),
 * nicht über beliebig viele weitere Zahlungen auf einen Beleg, der nichts mehr
 * fordert. Sonst entstünde die Mehrfachüberzahlung genau über den Hauptknopf,
 * vor dem die Bestätigung schützen soll.
 */
export function isSettledPaymentStatus(status: string): boolean {
  return status === 'bezahlt' || status === 'ueberbezahlt';
}
