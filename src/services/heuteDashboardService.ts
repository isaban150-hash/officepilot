import { getAllInvoiceOverview, summarizeInvoiceOverview } from './invoiceOverviewService';
import { scanDocumentLifecyclePending } from './documentLifecycleService';
import { getTaskSummary } from './taskEngineService';
import { getAllTasksFromStore } from './taskStore';
import { getTodayIso, isTaskOpen } from './taskNormalize';
import { getDocumentStoreSnapshot } from './documentService';
import { getVorgangStoreSnapshot } from './vorgangService';
import { filterActiveItems, getInboxStoreSnapshot } from './inboxService';

export interface HeuteDashboardStats {
  openDocuments: number;
  openInvoices: number;
  deadlinesThisWeek: number;
  tasksToday: number;
}

function getWeekEndIso(todayIso: string): string {
  const date = new Date(`${todayIso.slice(0, 10)}T12:00:00`);
  const day = date.getDay();
  const daysUntilSunday = day === 0 ? 0 : 7 - day;
  date.setDate(date.getDate() + daysUntilSunday);
  return date.toISOString().slice(0, 10);
}

function countDeadlinesThisWeek(todayIso: string): number {
  const weekEnd = getWeekEndIso(todayIso);
  return getAllTasksFromStore().filter(
    (task) =>
      isTaskOpen(task) &&
      task.dueDate &&
      task.dueDate.slice(0, 10) >= todayIso.slice(0, 10) &&
      task.dueDate.slice(0, 10) <= weekEnd,
  ).length;
}

export function getHeuteDashboardStats(today: Date | string = new Date()): HeuteDashboardStats {
  const todayIso = getTodayIso(today);
  const invoiceTotals = summarizeInvoiceOverview(getAllInvoiceOverview(todayIso));
  const taskSummary = getTaskSummary(today);

  return {
    openDocuments: scanDocumentLifecyclePending(todayIso).length,
    openInvoices: invoiceTotals.openInvoiceCount,
    deadlinesThisWeek: countDeadlinesThisWeek(todayIso),
    tasksToday: taskSummary.today,
  };
}

export function isHeuteFirstRunState(): boolean {
  const stats = getHeuteDashboardStats();
  const hasActivity =
    stats.openDocuments > 0 ||
    stats.openInvoices > 0 ||
    stats.deadlinesThisWeek > 0 ||
    stats.tasksToday > 0;

  if (hasActivity) return false;
  if (scanDocumentLifecyclePending().length > 0) return false;

  const hasContent =
    getDocumentStoreSnapshot().length > 0 ||
    getVorgangStoreSnapshot().length > 0 ||
    filterActiveItems(getInboxStoreSnapshot()).length > 0;

  return !hasContent;
}
