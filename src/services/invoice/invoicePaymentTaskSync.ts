/**
 * P0/P1-INTEGRITAET 01B / P1 — erledigte Forderung schliesst ihre
 * Überfälligkeitsaufgabe.
 *
 * `syncOverdueInvoiceTasks` legt für jede überfällige Ausgangsrechnung eine
 * automatische Aufgabe „Zahlung prüfen: Rechnung …“ an (`taskKind:
 * 'payment_overdue'`, Dedupe `invoice:<id>:payment_overdue`). Geschlossen wurde
 * sie bisher nur von Hand — eine bezahlte Rechnung hinterliess deshalb einen
 * falschen Handlungsbedarf auf Heute und im Assistenten.
 *
 * Diese Funktion schliesst genau diese Aufgaben, sobald die Forderung
 * vollständig erledigt ist: bezahlt (auch per Skonto oder als Restzahlung),
 * überzahlt oder storniert. Eine Teilzahlung mit offenem Rest lässt sie offen.
 * Manuelle Aufgaben und andere Aufgabenarten werden nie angefasst.
 *
 * Aufgerufen nur nach Aktionen bzw. nach einem angewendeten Cloud-Abgleich —
 * nie während eines Renders. Nach einer Zahlungsrücknahme legt der bestehende
 * Dedupe eine neue offene Episode an; die erledigte Aufgabe bleibt Historie
 * (serverseitig erlaubt: `workspace_tasks_active_auto_dedupe_idx` erfasst nur
 * offene Aufgaben).
 */
import type { InvoicePaymentStatus, Task } from '../../types/models';
import { calculatePaymentSummary } from '../invoicePaymentService';
import {
  completeTask,
  createTasksFromProposals,
  proposeTasksFromOverdueInvoices,
} from '../taskEngineService';
import { buildDedupeKey, isTaskOpen } from '../taskNormalize';
import { getAllTasksFromStore, replaceTaskInStore } from '../taskStore';
import { findInvoiceById } from './invoiceRegistryService';

const SETTLED_STATUSES: ReadonlySet<InvoicePaymentStatus> = new Set(['bezahlt', 'ueberbezahlt', 'storniert']);

function isInvoicePaymentOverdueTask(task: Task): string | null {
  if (!isTaskOpen(task) || task.sync?.deleted) return null;
  if (!task.autoCreated || task.taskKind !== 'payment_overdue' || task.sourceType !== 'invoice') return null;
  const invoiceId = task.sourceId?.trim() || task.linkedInvoiceId?.trim();
  if (!invoiceId) return null;
  // Nur die bestehende Identität — eine abweichende Aufgabe bleibt unberührt.
  const expectedKey = buildDedupeKey({ sourceType: 'invoice', sourceId: invoiceId, taskKind: 'payment_overdue' });
  return task.dedupeKey === expectedKey ? invoiceId : null;
}

/**
 * Schliesst offene automatische `payment_overdue`-Aufgaben erledigter
 * Forderungen — für eine Rechnung (`invoiceId`) oder für alle.
 */
export function completeSettledInvoicePaymentTasks(invoiceId?: string): Task[] {
  const completed: Task[] = [];
  for (const task of getAllTasksFromStore()) {
    const taskInvoiceId = isInvoicePaymentOverdueTask(task);
    if (!taskInvoiceId || (invoiceId && taskInvoiceId !== invoiceId)) continue;
    const invoice = findInvoiceById(taskInvoiceId);
    if (!invoice) continue; // unbekannt → nichts behaupten
    if (!SETTLED_STATUSES.has(calculatePaymentSummary(invoice).status)) continue;
    const done = completeTask(task.id);
    if (done) completed.push(done);
  }
  return completed;
}

export interface InvoicePaymentTaskReconcileResult {
  completed: Task[];
  created: Task[];
  updated: Task[];
}

/**
 * 02B — der vollständige Abgleich der Überfälligkeitsaufgaben mit dem
 * Forderungsstand, über die bestehende Task-Logik:
 *
 *   1. erledigte Forderungen → Aufgabe erledigt (siehe oben),
 *   2. überfällige Forderung ohne offene Aufgabe → neue Episode (bestehender
 *      Dedupe; nach einer Zahlungsrücknahme also sofort, nicht irgendwann),
 *   3. offene Auto-Aufgabe nach Teilzahlung → Beschreibung (offener Betrag)
 *      und Priorität auf den aktuellen Stand; offen bleibt sie.
 *
 * Manuelle Aufgaben und Wiedervorlagen werden nie angefasst.
 *
 * Aufgerufen nach Aktionen (Zahlung, Rücknahme, Storno), nach einem
 * angewendeten Cloud-Abgleich und einmal täglich beim App-Start — nie beim
 * Rendern einer Seite. Mit `invoiceId` nur für diese Rechnung.
 */
export function reconcileInvoicePaymentTasks(
  options: { invoiceId?: string; today?: Date | string } = {},
): InvoicePaymentTaskReconcileResult {
  const { invoiceId, today } = options;
  const completed = completeSettledInvoicePaymentTasks(invoiceId);

  const proposals = proposeTasksFromOverdueInvoices(today).filter(
    (proposal) => !invoiceId || proposal.sourceId === invoiceId,
  );
  const before = new Set(getAllTasksFromStore().map((task) => task.id));
  const created = createTasksFromProposals(proposals).filter((task) => !before.has(task.id));

  const byInvoice = new Map(proposals.map((proposal) => [proposal.sourceId, proposal]));
  const updated: Task[] = [];
  for (const task of getAllTasksFromStore()) {
    const taskInvoiceId = isInvoicePaymentOverdueTask(task);
    if (!taskInvoiceId) continue;
    const proposal = byInvoice.get(taskInvoiceId);
    if (!proposal) continue;
    if (task.description === proposal.description && task.priority === proposal.priority) continue;
    const next = replaceTaskInStore(task.id, (current) => ({
      ...current,
      description: proposal.description ?? current.description,
      priority: proposal.priority ?? current.priority,
    }));
    if (next) updated.push(next);
  }

  return { completed, created, updated };
}

let lastDailyReconcileDay: string | null = null;

/**
 * 02B — einmal je Kalendertag beim App-Start: Neue Überfälligkeiten entstehen
 * durch Zeitablauf, nicht durch eine Aktion. Auch ohne Cloud-Abgleich (lokaler
 * Modus) soll die Aufgabe deshalb entstehen — aber nicht bei jedem Rendern.
 */
export function runDailyInvoicePaymentTaskReconcile(today: Date = new Date()): boolean {
  const day = today.toISOString().slice(0, 10);
  if (lastDailyReconcileDay === day) return false;
  lastDailyReconcileDay = day;
  reconcileInvoicePaymentTasks({ today: day });
  return true;
}

export function resetDailyInvoicePaymentTaskReconcileForTests(): void {
  lastDailyReconcileDay = null;
}
