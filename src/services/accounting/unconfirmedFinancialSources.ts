/**
 * FINANZ-CORE-01A (Bericht 20, END19-R1/R2) — ein Vertrag für alle Finanzaktionen, die einen Monatsabschluss
 * beeinflussen: „ungeklärte Finanzwirkung bis zum autoritativen Abgleich“.
 *
 * Gemeinsame Ursache von END19-R1 und END19-R2: Die Abschlusssperre leitete die Zugehörigkeit zum Monat aus der
 * bereits gefilterten Monatsmappe ab (ein lokaler Grabstein, ein Entwurf oder eine nie angenommene Zahlung
 * verschwand dort, bevor geprüft wurde) und nahm Rechteabweisungen ausdrücklich aus. Hier gilt stattdessen:
 *
 *  1. **Ungefilterte Daten**: alle Ausgaben samt Grabsteinen, Entwürfen und Stornos, alle Mitarbeiterzahlungen,
 *     Kontierungen und Rechnungszahlungen des Geräts — nicht die Auswahl der Monatsmappe.
 *  2. **Monatszugehörigkeit aus Fakten und Aufträgen**: Belegdatum, Zahlungs- und Stornodaten und die Monate, die
 *     ein Auftrag beim Einreihen berührte (`affectedMonths`, z. B. das alte Belegdatum einer Datumsänderung).
 *     Ausgaben und Rechnungszahlungen wirken außerdem auf die offenen Posten jedes späteren Monatsendes (sie stehen
 *     im Übergabepaket), daher „ab dem ersten berührten Monat“; Mitarbeiterzahlungen und Kontierungen genau in ihren
 *     Monaten. Monate davor bleiben abschließbar — keine pauschale Sperre.
 *  3. **Ungeklärt** ist, was der Server nicht bestätigt hat: ein ausstehender, wiederholbarer oder blockierter
 *     Auftrag; eine endgültige Abweisung (fachlich ODER Rechte), die noch kein vollständiger Abzug geklärt hat;
 *     eine abgewiesene Neuanlage ohne Serverfassung; eine lokal gebuchte, nicht gesicherte Rechnungszahlung.
 *     Eine Rechteabweisung beweist nicht, ob ein früherer Schritt angenommen wurde — sie wird weder entfernt noch
 *     als bestätigt abgeschlossen; auch nach Rechtewiederkehr bleibt sie ungeklärt, bis der Abgleich sie belegt
 *     oder eine neue bewusste Aktion sie ablöst.
 *
 * Abschluss (`closeAccountingPeriod`) und Übergabepaket (`evaluateAccountingExportReadiness` → Exportlauf) lesen
 * diese Sperre beide über `getAccountingPeriodState` — es gibt keinen weiteren Abschlussweg.
 */
import type { SyncOutboxEntry } from '../../types/sync';
import type { Expense } from '../../types/expense';
import type { EmployeePayment } from '../../types/employee';
import type { AccountingAssignment } from '../../types/accounting';
import type { VorgangInvoice } from '../../types/models';
import { collectUnreconciledExpenseRejections, parseExpensePaymentEntityId } from '../expense/expenseCloudSyncService';
import {
  monthKeyOf,
  resolveExpenseStornoDatum,
  resolveInvoiceBelegDatum,
  resolveInvoiceStornoDatum,
} from '../steuerberater/monatsmappeModelService';
import { toBusinessDay } from '../businessDateService';
import { isFinalizedInvoice } from '../invoiceArchiveService';

export type UnconfirmedFinancialSourceType = 'expense' | 'employee_payment' | 'accounting_assignment' | 'invoice_payment';

export type UnconfirmedFinancialReason =
  /** Auftrag `pending` (noch nicht gesendet oder ohne Antwort). */
  | 'ausstehend'
  /** Auftrag `error` (Netz, wiederholbar). */
  | 'wiederholbar'
  /** Auftrag `blocked` (Versionskonflikt, Entscheidung nötig). */
  | 'konflikt'
  /** Endgültige Abweisung (fachlich oder Rechte), noch nicht durch einen vollständigen Abzug geklärt. */
  | 'abgewiesen_ungeklaert'
  /** Abgewiesene Neuanlage ohne Serverfassung (Beleg nur lokal). */
  | 'neuanlage_abgewiesen'
  /** Lokal gebuchte Rechnungszahlung ohne Serverbestätigung. */
  | 'nicht_gesichert';

export interface UnconfirmedFinancialSource {
  sourceType: UnconfirmedFinancialSourceType;
  sourceId: string;
  reason: UnconfirmedFinancialReason;
  /** Der Auftrag, falls einer der Grund ist. */
  outboxId?: string;
  /** Zahlungskennung bei Zahlungsaufträgen. */
  paymentId?: string;
}

export interface UnconfirmedSourceInputs {
  outbox: readonly SyncOutboxEntry[];
  /** Alle Ausgaben des Geräts, ungefiltert (auch Grabsteine, Entwürfe, Stornos). */
  expenses: readonly Expense[];
  employeePayments: readonly EmployeePayment[];
  assignments: readonly AccountingAssignment[];
  invoices: readonly VorgangInvoice[];
  /** `invoiceId#paymentId` lokal gebuchter, nicht bestätigter Rechnungszahlungen. */
  unconfirmedInvoicePayments: ReadonlySet<string>;
  /**
   * Systemische Gesamtnacharbeit (SYS-02 / D4) — Betrieb mit Cloud: Eine Rechnungszahlung gilt nur mit positiver
   * Serverbestätigung (`payment.cloudBestaetigt`) als bestätigt. Ohne Angabe nur der Vermerk (Betrieb ohne Cloud).
   */
  cloudMode?: boolean;
}

const OFFENE_STATUS: Record<string, UnconfirmedFinancialReason> = {
  pending: 'ausstehend',
  error: 'wiederholbar',
  blocked: 'konflikt',
};

const MONAT = /^\d{4}-(0[1-9]|1[0-2])$/;
const gueltig = (monat: string | null | undefined): monat is string => typeof monat === 'string' && MONAT.test(monat);

function fruehester(monate: readonly (string | null | undefined)[]): string | null {
  const g = monate.filter(gueltig).sort();
  return g.length > 0 ? g[0] : null;
}

/** Ab diesem Monat (einschließlich) wirkt die Quelle; `null` = nicht bestimmbar. */
function ab(start: string | null, monthKey: string): boolean {
  return start !== null && start <= monthKey;
}

function eintragsMonate(entry: SyncOutboxEntry): string[] {
  return (entry.affectedMonths ?? []).filter(gueltig);
}

/* ------------------------------------------------------------------ */
/* Ausgaben                                                            */
/* ------------------------------------------------------------------ */

function ausgabenMonate(expense: Expense): string[] {
  const storno = resolveExpenseStornoDatum(expense);
  return [
    monthKeyOf(expense.issueDate),
    ...(expense.payments ?? []).map((payment) => monthKeyOf(payment.date)),
    ...(expense.rejectedPayments ?? []).map((payment) => monthKeyOf(payment.date)),
    ...(storno ? [monthKeyOf(storno)] : []),
  ].filter(gueltig);
}

function zahlungsMonat(expense: Expense, paymentId: string | undefined): string | null {
  if (!paymentId) return null;
  const zahlung =
    (expense.payments ?? []).find((payment) => payment.id === paymentId) ??
    (expense.rejectedPayments ?? []).find((payment) => payment.id === paymentId);
  return zahlung ? monthKeyOf(zahlung.date) : null;
}

function ausgabeAuftragsStart(expense: Expense, entry: SyncOutboxEntry, alleEintraege: readonly SyncOutboxEntry[]): string | null {
  if (entry.entityType === 'expense_payment') {
    const parsed = parseExpensePaymentEntityId(entry.entityId);
    return fruehester([zahlungsMonat(expense, parsed?.paymentId), ...eintragsMonate(entry)]) ?? fruehester([...ausgabenMonate(expense)]);
  }
  // Belegauftrag: alle Monate des Belegs, auch die, die frühere Aufträge derselben Ausgabe berührten.
  const auftragsMonate = alleEintraege.flatMap(eintragsMonate);
  return fruehester([...ausgabenMonate(expense), ...auftragsMonate]);
}

function sammleAusgaben(monthKey: string, inputs: UnconfirmedSourceInputs, ergebnis: UnconfirmedFinancialSource[]): void {
  const eintraegeJeAusgabe = new Map<string, SyncOutboxEntry[]>();
  for (const entry of inputs.outbox) {
    const expenseId =
      entry.entityType === 'expense'
        ? entry.entityId
        : entry.entityType === 'expense_payment'
          ? (parseExpensePaymentEntityId(entry.entityId)?.expenseId ?? null)
          : null;
    if (!expenseId) continue;
    const liste = eintraegeJeAusgabe.get(expenseId) ?? [];
    liste.push(entry);
    eintraegeJeAusgabe.set(expenseId, liste);
  }

  for (const expense of inputs.expenses) {
    const eintraege = eintraegeJeAusgabe.get(expense.id) ?? [];
    const gefunden = new Set<string>();
    const melde = (quelle: UnconfirmedFinancialSource) => {
      const k = `${quelle.reason}:${quelle.outboxId ?? ''}`;
      if (gefunden.has(k)) return;
      gefunden.add(k);
      ergebnis.push(quelle);
    };

    for (const entry of eintraege) {
      const reason = OFFENE_STATUS[entry.status];
      if (!reason) continue;
      if (!ab(ausgabeAuftragsStart(expense, entry, eintraege), monthKey)) continue;
      const paymentId = entry.entityType === 'expense_payment' ? parseExpensePaymentEntityId(entry.entityId)?.paymentId : undefined;
      melde({ sourceType: 'expense', sourceId: expense.id, reason, outboxId: entry.id, ...(paymentId ? { paymentId } : {}) });
    }

    // Ohne eigenen Auftrag gibt es keine Abweisung dieser Ausgabe (spart den Durchlauf je Ausgabe).
    const offeneAbweisungen = eintraege.length > 0 ? collectUnreconciledExpenseRejections(expense, eintraege) : [];
    for (const offen of offeneAbweisungen) {
      const entry = eintraege.find((item) => item.id === offen.outboxId);
      const start =
        offen.kind === 'change'
          ? fruehester([...ausgabenMonate(expense), ...eintraege.flatMap(eintragsMonate)])
          : (fruehester([zahlungsMonat(expense, offen.paymentId), ...(entry ? eintragsMonate(entry) : [])]) ??
            fruehester(ausgabenMonate(expense)));
      if (!ab(start, monthKey)) continue;
      melde({
        sourceType: 'expense',
        sourceId: expense.id,
        reason: 'abgewiesen_ungeklaert',
        outboxId: offen.outboxId,
        ...(offen.paymentId ? { paymentId: offen.paymentId } : {}),
      });
    }

    const abgewieseneNeuanlage = (expense.rejectedChanges ?? []).some((change) => change.kind === 'create');
    if (abgewieseneNeuanlage && !((expense.sync?.version ?? 0) > 0) && ab(fruehester(ausgabenMonate(expense)), monthKey)) {
      melde({ sourceType: 'expense', sourceId: expense.id, reason: 'neuanlage_abgewiesen' });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Mitarbeiterzahlungen, Kontierungen, Rechnungszahlungen              */
/* ------------------------------------------------------------------ */

/** Jeder nicht abgeschlossene Auftrag ist ungeklärt; ohne eigenen Abgleich endet das erst mit einer neuen Aktion. */
function grundFuer(entry: SyncOutboxEntry): UnconfirmedFinancialReason | null {
  if (entry.status === 'completed') return null;
  return OFFENE_STATUS[entry.status] ?? 'abgewiesen_ungeklaert';
}

function sammleMitarbeiterzahlungen(monthKey: string, inputs: UnconfirmedSourceInputs, ergebnis: UnconfirmedFinancialSource[]): void {
  const zahlungen = new Map(inputs.employeePayments.map((payment) => [payment.id, payment]));
  for (const entry of inputs.outbox) {
    if (entry.entityType !== 'employee_payment') continue;
    const reason = grundFuer(entry);
    if (!reason) continue;
    const zahlung = zahlungen.get(entry.entityId);
    const monate = [
      ...(zahlung ? [monthKeyOf(zahlung.paymentDate)] : []),
      ...(zahlung?.reversedAt ? [monthKeyOf(toBusinessDay(zahlung.reversedAt))] : []),
      ...eintragsMonate(entry),
    ].filter(gueltig);
    if (!monate.includes(monthKey)) continue;
    ergebnis.push({ sourceType: 'employee_payment', sourceId: entry.entityId, reason, outboxId: entry.id });
  }
}

function sammleKontierungen(monthKey: string, inputs: UnconfirmedSourceInputs, ergebnis: UnconfirmedFinancialSource[]): void {
  const kontierungen = new Map(inputs.assignments.map((assignment) => [assignment.id, assignment]));
  const ausgaben = new Map(inputs.expenses.map((expense) => [expense.id, expense]));
  const rechnungen = new Map(inputs.invoices.map((invoice) => [invoice.id, invoice]));
  for (const entry of inputs.outbox) {
    if (entry.entityType !== 'accounting_assignment') continue;
    const reason = grundFuer(entry);
    if (!reason) continue;
    const kontierung = kontierungen.get(entry.entityId);
    if (!kontierung) continue;
    let monate: string[] = [];
    if (kontierung.sourceType === 'expense') {
      const expense = ausgaben.get(kontierung.sourceId);
      const storno = expense ? resolveExpenseStornoDatum(expense) : null;
      monate = expense ? [monthKeyOf(expense.issueDate), ...(storno ? [monthKeyOf(storno)] : [])] : [];
    } else {
      const invoice = rechnungen.get(kontierung.sourceId);
      const storno = invoice ? resolveInvoiceStornoDatum(invoice) : null;
      monate = invoice ? [monthKeyOf(resolveInvoiceBelegDatum(invoice)), ...(storno ? [monthKeyOf(storno)] : [])] : [];
    }
    if (![...monate, ...eintragsMonate(entry)].filter(gueltig).includes(monthKey)) continue;
    ergebnis.push({ sourceType: 'accounting_assignment', sourceId: kontierung.sourceId, reason, outboxId: entry.id });
  }
}

function sammleRechnungszahlungen(monthKey: string, inputs: UnconfirmedSourceInputs, ergebnis: UnconfirmedFinancialSource[]): void {
  if (inputs.unconfirmedInvoicePayments.size === 0 && !inputs.cloudMode) return;
  for (const invoice of inputs.invoices) {
    // Wie die Monatsmappe (`invoicePaymentsOfMonth`): Zahlungen stornierter Rechnungen stehen dort nicht.
    if (!isFinalizedInvoice(invoice) || invoice.cancelledAt) continue;
    for (const payment of invoice.payments ?? []) {
      // D4 — im Cloudbetrieb zählt nur positive Evidenz; ein fehlender oder unlesbarer Vermerk bestätigt nichts.
      const unbestaetigt =
        inputs.unconfirmedInvoicePayments.has(`${invoice.id}#${payment.id}`) ||
        (inputs.cloudMode === true && payment.cloudBestaetigt !== true);
      if (!unbestaetigt) continue;
      // Wirkt im Zahlungsmonat und auf die offenen Posten jedes späteren Monatsendes.
      if (!ab(monthKeyOf(payment.date), monthKey)) continue;
      ergebnis.push({ sourceType: 'invoice_payment', sourceId: invoice.id, reason: 'nicht_gesichert', paymentId: payment.id });
    }
  }
}

/** Alle Quellen mit ungeklärter Finanzwirkung im Monat `monthKey` (Format `YYYY-MM`). */
export function collectUnconfirmedFinancialSources(monthKey: string, inputs: UnconfirmedSourceInputs): UnconfirmedFinancialSource[] {
  const ergebnis: UnconfirmedFinancialSource[] = [];
  if (!gueltig(monthKey)) return ergebnis;
  sammleAusgaben(monthKey, inputs, ergebnis);
  sammleMitarbeiterzahlungen(monthKey, inputs, ergebnis);
  sammleKontierungen(monthKey, inputs, ergebnis);
  sammleRechnungszahlungen(monthKey, inputs, ergebnis);
  return ergebnis;
}
