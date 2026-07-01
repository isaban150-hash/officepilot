import { getAllDocuments } from '../documentService';
import { calculatePaymentSummary } from '../invoicePaymentService';
import { getNotesForVorgang } from '../vorgangNoteService';
import { getVorgangById } from '../vorgangService';
import { getAllTasksFromStore } from '../taskStore';
import { isTaskOpen } from '../taskNormalize';
import { MAX_VORGANG_NOTES_IN_CONTEXT } from '../communicationConstants';
import { sanitizeAiText } from '../ai/aiTextSanitizer';
import type { VorgangAiContext } from '../../types/areaAi';

const MAX_LINKED_DOCUMENTS = 10;

export function buildVorgangAiContext(vorgangId: string): VorgangAiContext | null {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return null;

  const notes = getNotesForVorgang(vorgangId)
    .slice(0, MAX_VORGANG_NOTES_IN_CONTEXT)
    .map((note) => ({
      body: sanitizeAiText(note.body),
      occurredAt: note.occurredAt,
    }));

  const openTasks = getAllTasksFromStore()
    .filter(isTaskOpen)
    .filter((task) => task.linkedVorgangId === vorgangId || task.vorgangId === vorgangId)
    .slice(0, 15)
    .map((task) => ({
      title: sanitizeAiText(task.title),
      dueDate: task.dueDate,
    }));

  const invoices = (vorgang.invoices ?? []).map((invoice) => {
    const paymentSummary = calculatePaymentSummary(invoice);
    return {
      number: invoice.number,
      openAmount: paymentSummary.openAmount,
      paymentStatus: paymentSummary.status,
      dueDate: invoice.paymentDueDate,
    };
  });

  const openInvoiceTotal = invoices.reduce((sum, invoice) => sum + invoice.openAmount, 0);

  const linkedDocuments = getAllDocuments()
    .filter((doc) => doc.linkedVorgang?.vorgangId === vorgangId)
    .slice(0, MAX_LINKED_DOCUMENTS)
    .map((doc) => ({
      title: sanitizeAiText(doc.title),
      category: doc.category,
    }));

  return {
    id: vorgang.id,
    title: sanitizeAiText(vorgang.title),
    customer: sanitizeAiText(vorgang.customer),
    baustelle: sanitizeAiText(vorgang.baustelle),
    status: vorgang.status,
    notes,
    openTasks,
    invoices,
    linkedDocuments,
    openInvoiceTotal,
  };
}

export function buildVorgangAiAllowedSourceText(context: VorgangAiContext): string {
  return [
    context.title,
    context.customer,
    context.baustelle,
    context.status,
    ...context.notes.map((note) => `${note.occurredAt} ${note.body}`),
    ...context.openTasks.map((task) => `${task.title} ${task.dueDate ?? ''}`),
    ...context.invoices.map(
      (invoice) =>
        `${invoice.number} ${invoice.openAmount} ${invoice.paymentStatus} ${invoice.dueDate ?? ''}`,
    ),
    ...context.linkedDocuments.map((doc) => `${doc.title} ${doc.category}`),
    String(context.openInvoiceTotal),
  ].join('\n');
}
