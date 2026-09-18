import { fromCents, sumCents, toCents } from '../invoiceMoney';
import { isBillingEffective } from '../orderBillingRules';
import { getAllExpensesFromStore } from '../expenseStore';
import { isEntitySyncActive } from '../sync/syncMetaService';
import { getVorgangById } from '../vorgangService';
import type { Expense, ExpenseAllocation } from '../../types/expense';
import type { Vorgang, VorgangInvoice } from '../../types/models';

/**
 * ORDER-COST-ALLOCATION-01B — „Was hat der Auftrag gekostet?"
 *
 * Eine Auswertung, keine zweite Wahrheit: Der abgerechnete Wert kommt aus den
 * vorhandenen Rechnungen des Vorgangs über die kanonische Regel
 * `isBillingEffective` (nur `vorbereitet`/`versendet`, nie storniert), die
 * Kosten aus den Zuordnungen der Ausgaben (`Expense.allocations`). Nichts
 * davon verändert Steuerbeträge, Kategorien, Zahlungen oder die Monatsmappe.
 *
 * Alles rechnet in Cent; Euro entstehen erst am Rand (`fromCents`).
 */

/**
 * Netto einer einzelnen Rechnung **für die Auftragssumme**.
 *
 * Eine Schlussrechnung trägt in `subtotal` den vollen Auftragsnetto und führt
 * die bereits abgerechneten Abschläge als `previousAbschlagDeductions`
 * (dort ist `subtotal` der Netto-Anteil des Abschlags, `amount` sein Brutto).
 * Der Beitrag dieser Rechnung ist deshalb `subtotal − Σ Abzugs-Netto`:
 *
 *   Abschlag 1 (1.000) + Abschlag 2 (2.000) + Schluss (5.000 − 3.000 = 2.000)
 *   = 5.000 — jeder Euro genau einmal.
 *
 * Für eine normale Rechnung ohne Abzüge ist es schlicht ihr Netto.
 */
export function invoiceBilledNetCents(invoice: VorgangInvoice): number {
  const subtotalCents = toCents(invoice.subtotal ?? 0);
  if (!Number.isFinite(subtotalCents)) return 0;
  const deductionCents = sumCents(
    (invoice.previousAbschlagDeductions ?? [])
      .map((deduction) => toCents(deduction.subtotal ?? 0))
      .filter((cents) => Number.isFinite(cents)),
  );
  return subtotalCents - (Number.isFinite(deductionCents) ? deductionCents : 0);
}

/**
 * Abgerechneter Nettowert eines Auftrags in Cent.
 *
 * Basis ist der Rechnungswert, **nicht** der Zahlungseingang: Eine bezahlte
 * und eine offene Rechnung sind gleich viel abgerechnet. Entwürfe und
 * stornierte Rechnungen zählen über `isBillingEffective` nicht mit.
 */
export function getBilledNetCentsForVorgang(vorgang: Pick<Vorgang, 'invoices'>): number {
  return sumCents(
    (vorgang.invoices ?? []).filter(isBillingEffective).map(invoiceBilledNetCents),
  );
}

export function getBilledNetForVorgang(vorgang: Pick<Vorgang, 'invoices'>): number {
  return fromCents(getBilledNetCentsForVorgang(vorgang));
}

/** Zuordnungen einer Ausgabe auf genau diesen Auftrag (normalerweise höchstens eine). */
export function allocationsForVorgang(expense: Expense, vorgangId: string): ExpenseAllocation[] {
  return (expense.allocations ?? []).filter((allocation) => allocation.vorgangId === vorgangId);
}

export function allocatedCentsForVorgang(expense: Expense, vorgangId: string): number {
  return sumCents(
    allocationsForVorgang(expense, vorgangId)
      .map((allocation) => toCents(allocation.amount))
      .filter((cents) => Number.isFinite(cents)),
  );
}

/** Zählt eine Ausgabe heute zu den Auftragskosten? Entwürfe und Stornos nie. */
export function countsAsActiveCost(expense: Expense): boolean {
  return isEntitySyncActive(expense) && expense.status === 'gebucht';
}

export interface OrderCostEntry {
  expenseId: string;
  title: string;
  supplierName: string;
  category: Expense['category'];
  issueDate: string;
  /** Der diesem Auftrag zugeordnete Nettobetrag — nicht der volle Beleg. */
  allocatedNet: number;
  /** Nettobetrag des gesamten Belegs (für „davon zugeordnet"-Anzeigen). */
  expenseNet: number;
  status: Expense['status'];
  /** Storniert: bleibt als Historie sichtbar, zählt nicht in der Summe. */
  cancelled: boolean;
}

export interface OrderCostSummary {
  vorgangId: string;
  /** Abgerechneter Nettowert der wirksamen Rechnungen. */
  billedNet: number;
  /** Summe der zugeordneten Nettokosten aktiver (gebuchter) Ausgaben. */
  allocatedCostNet: number;
  /** billedNet − allocatedCostNet. Ohne Arbeitszeit/Löhne — kein Deckungsbeitrag. */
  remainingNet: number;
  /** Aktive zugeordnete Belege, neueste zuerst. */
  entries: OrderCostEntry[];
  /** Stornierte zugeordnete Belege — Historie, nie in der Summe. */
  cancelledEntries: OrderCostEntry[];
}

function toEntry(expense: Expense, vorgangId: string): OrderCostEntry {
  return {
    expenseId: expense.id,
    title: expense.title,
    supplierName: expense.supplierName,
    category: expense.category,
    issueDate: expense.issueDate,
    allocatedNet: fromCents(allocatedCentsForVorgang(expense, vorgangId)),
    expenseNet: expense.netAmount,
    status: expense.status,
    cancelled: expense.status === 'storniert',
  };
}

/** Alle Ausgaben mit einer Zuordnung auf diesen Auftrag — aktive und stornierte. */
export function getExpensesAllocatedToVorgang(vorgangId: string): Expense[] {
  return getAllExpensesFromStore().filter(
    (expense) =>
      isEntitySyncActive(expense) && allocationsForVorgang(expense, vorgangId).length > 0,
  );
}

export function getAllocatedCostNetCentsForVorgang(vorgangId: string): number {
  return sumCents(
    getExpensesAllocatedToVorgang(vorgangId)
      .filter(countsAsActiveCost)
      .map((expense) => allocatedCentsForVorgang(expense, vorgangId)),
  );
}

/**
 * Die Auswertung eines Auftrags. `undefined`, wenn es den Auftrag nicht (mehr)
 * gibt — die Oberfläche erfindet dann nichts.
 */
export function getOrderCostSummary(vorgangId: string): OrderCostSummary | undefined {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return undefined;

  const allocated = getExpensesAllocatedToVorgang(vorgangId)
    .map((expense) => toEntry(expense, vorgangId))
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || a.title.localeCompare(b.title));

  const billedCents = getBilledNetCentsForVorgang(vorgang);
  const costCents = getAllocatedCostNetCentsForVorgang(vorgangId);

  return {
    vorgangId,
    billedNet: fromCents(billedCents),
    allocatedCostNet: fromCents(costCents),
    remainingNet: fromCents(billedCents - costCents),
    entries: allocated.filter((entry) => !entry.cancelled),
    cancelledEntries: allocated.filter((entry) => entry.cancelled),
  };
}
