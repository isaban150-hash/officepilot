import { getCompanyProfile } from '../companyProfileService';
import { getCommunicationEvents } from '../communicationHistoryService';
import { getAllDocuments } from '../documentService';
import {
  getAllExpenseOverview,
  summarizeExpenseOverview,
} from '../expenseOverviewService';
import { filterActiveItems, getInboxItems } from '../inboxService';
import {
  getAllInvoiceOverview,
  getOpenInvoices,
  summarizeInvoiceOverview,
} from '../invoiceOverviewService';
import { getKnowledgeFacts } from '../knowledgeService';
import { getTasksFiltered } from '../taskEngineService';
import { getAllTasksFromStore } from '../taskStore';
import { isTaskOpen } from '../taskNormalize';
import { getTodayIso } from '../taskNormalize';
import { getAllVorgaenge } from '../vorgangService';
import { getVorgangNoteStoreSnapshot } from '../vorgangNoteService';
import type { BrainSnapshot } from '../../types/brain';

const MAX_ITEMS = 15;
const MAX_HISTORY = 10;

function limit<T>(items: T[], max = MAX_ITEMS): T[] {
  return items.slice(0, max);
}

export function buildBrainSnapshot(referenceDate: string = getTodayIso()): BrainSnapshot {
  const profile = getCompanyProfile();
  const vorgaenge = getAllVorgaenge();
  const invoiceOverview = getAllInvoiceOverview(referenceDate);
  const invoiceTotals = summarizeInvoiceOverview(invoiceOverview);
  const openInvoices = limit(
    getOpenInvoices(referenceDate).map((item) => ({
      number: item.invoice.number,
      vorgangTitle: item.vorgangTitle,
      customer: item.customer,
      openAmount: item.paymentSummary.openAmount,
      paymentStatus: item.paymentSummary.status,
    })),
  );
  const expenseOverview = getAllExpenseOverview(referenceDate);
  const expenseTotals = summarizeExpenseOverview(expenseOverview);
  const openExpenses = limit(
    expenseOverview
      .filter((item) => item.paymentSummary.openAmount > 0)
      .map((item) => ({
        id: item.expense.id,
        title: item.expense.title,
        supplierName: item.expense.supplierName,
        openAmount: item.paymentSummary.openAmount,
        paymentStatus: item.paymentSummary.status,
      })),
  );
  const openTasks = limit(
    getAllTasksFromStore()
      .filter(isTaskOpen)
      .map((task) => ({
        id: task.id,
        title: task.title,
        dueDate: task.dueDate,
        done: task.done ?? false,
      })),
  );
  const todayTasks = limit(
    getTasksFiltered('heute', referenceDate).map((task) => ({
      id: task.id,
      title: task.title,
      dueDate: task.dueDate,
      done: task.done ?? false,
    })),
  );

  return {
    generatedAt: new Date().toISOString(),
    referenceDate,
    company: {
      companyName: profile.companyName,
      contactPerson: profile.contactPerson,
      street: profile.street,
      zip: profile.zip,
      city: profile.city,
      email: profile.email,
      taxNumber: profile.taxNumber,
      vatId: profile.vatId,
    },
    vorgaenge: limit(
      vorgaenge.map((vorgang) => ({
        id: vorgang.id,
        title: vorgang.title,
        customer: vorgang.customer,
        status: vorgang.status,
        baustelle: vorgang.baustelle,
        invoiceCount: vorgang.invoices?.length ?? 0,
      })),
    ),
    invoiceTotals: {
      openReceivables: invoiceTotals.openReceivables,
      overdueReceivables: invoiceTotals.overdueReceivables,
      openInvoiceCount: invoiceTotals.openInvoiceCount,
      overdueInvoiceCount: invoiceTotals.overdueInvoiceCount,
    },
    invoices: openInvoices,
    expenses: openExpenses,
    expenseOpenCount: expenseTotals.openExpenseCount,
    tasksOpen: openTasks,
    tasksToday: todayTasks,
    documents: limit(
      getAllDocuments().map((doc) => ({
        id: doc.id,
        title: doc.title,
        category: doc.category,
        issuer: doc.issuer,
      })),
    ),
    inbox: limit(
      filterActiveItems(getInboxItems()).map((item) => ({
        id: item.id,
        title: item.title,
        sender: item.sender,
        status: item.status,
        documentType: item.documentType,
      })),
    ),
    knowledge: limit(
      getKnowledgeFacts()
        .filter((fact) => fact.active)
        .map((fact) => ({
          scope: fact.scope,
          category: fact.category,
          displayText: fact.displayText,
        })),
    ),
    notes: limit(
      getVorgangNoteStoreSnapshot().map((note) => ({
        vorgangTitle: note.vorgangTitle,
        body: note.body,
        occurredAt: note.occurredAt,
      })),
    ),
    communicationHistory: limit(
      getCommunicationEvents().map((event) => ({
        type: event.type,
        excerpt: event.resultExcerpt ?? event.userInputExcerpt ?? '',
        timestamp: event.timestamp,
        channel: event.channel,
      })),
      MAX_HISTORY,
    ),
  };
}

export function buildBrainSnapshotCounts(snapshot: BrainSnapshot): Record<string, number> {
  return {
    vorgaenge: snapshot.vorgaenge.length,
    invoices: snapshot.invoices.length,
    expenses: snapshot.expenses.length,
    tasksOpen: snapshot.tasksOpen.length,
    tasksToday: snapshot.tasksToday.length,
    documents: snapshot.documents.length,
    inbox: snapshot.inbox.length,
    knowledge: snapshot.knowledge.length,
    notes: snapshot.notes.length,
    communicationHistory: snapshot.communicationHistory.length,
  };
}
