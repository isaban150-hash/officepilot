/**
 * ER-01 — Incoming-invoice Journey Runner.
 * Document-Case → Stable-Pipeline → Archiv → Ausgabe (Expense).
 */
import { confirmFilingDecisionForTests, importInboxDocumentForTests } from '../../confirmFilingDecisionForTests';
import { assertDocumentCase } from '../../document-cases/_lib/assertCase';
import { getDocumentCase } from '../../document-cases/_lib/loadCases';
import {
  runStablePipeline,
  testProfile,
  type StablePipelineObservation } from '../../document-cases/_lib/runStablePipeline';
import { getDocumentById, hydrateDocumentStore } from '../../../services/documentService';
import { addExpense, getAllExpenses } from '../../../services/expenseService';
import { hydrateExpenseStore } from '../../../services/expenseStore';
import { getInboxItemById, hydrateInboxStore, markInboxImportedToArchive } from '../../../services/inboxService';
import { buildExpenseInputFromInbox } from '../../../services/officeActionService';
import { hydrateVorgangStore } from '../../../services/vorgangService';
import type { Expense } from '../../../types/expense';
import type { InboxItem } from '../../../types/models';
import type { IncomingInvoiceReferenceCase } from './types';

export interface InvoiceJourneyObservation {
  reference: IncomingInvoiceReferenceCase;
  pipeline: StablePipelineObservation;
  inbox: InboxItem;
  archiveDocumentId: string;
  expense: Expense;
}

function seedEmptyStores(): void {
  hydrateDocumentStore([]);
  hydrateVorgangStore([]);
  hydrateExpenseStore([]);
  hydrateInboxStore([]);
}

/**
 * Ebene 1 + Invoice-Journey: erkennen → archivieren → Ausgabe anlegen (Produktpfad).
 */
export function runInvoiceJourney(
  reference: IncomingInvoiceReferenceCase,
): InvoiceJourneyObservation {
  if (reference.kind !== 'incoming-invoice') {
    throw new Error(`runInvoiceJourney erwartet kind=incoming-invoice, got ${reference.kind}`);
  }

  seedEmptyStores();

  const docCase = getDocumentCase(reference.documentCaseId);
  const pipeline = runStablePipeline(docCase);

  if (reference.layers.includes('stable-pipeline')) {
    assertDocumentCase(docCase.expected, pipeline);
  }

  // Stable-Pipeline gibt ggf. stale item zurück — immer frisch aus dem Store lesen.
  let inbox = getInboxItemById(pipeline.item.id);
  if (!inbox) {
    throw new Error(`[${reference.caseId}] Inbox nach Pipeline fehlt`);
  }

  const companyName =
    reference.invoiceJourney.companyName.trim() || testProfile.companyName;

  confirmFilingDecisionForTests(inbox.id);
  inbox = getInboxItemById(inbox.id)!;

  const imported = importInboxDocumentForTests(inbox, companyName);
  if (!imported.success) {
    throw new Error(
      `[${reference.caseId}] Archivierung fehlgeschlagen: ${imported.errorKey}`,
    );
  }

  markInboxImportedToArchive(inbox.id, imported.document.id);
  inbox = getInboxItemById(inbox.id)!;

  if (!inbox.archiveDocumentId || !getDocumentById(inbox.archiveDocumentId)) {
    throw new Error(`[${reference.caseId}] Archivdokument nach Import fehlt`);
  }

  const expenseInput = buildExpenseInputFromInbox(inbox);
  const created = addExpense({
    ...expenseInput,
    archiveDocumentId: inbox.archiveDocumentId });
  if (!created.success) {
    throw new Error(`[${reference.caseId}] Ausgabe anlegen fehlgeschlagen: ${created.errorKey}`);
  }

  const expense =
    getAllExpenses().find((entry) => entry.id === created.expense.id) ?? created.expense;

  return {
    reference,
    pipeline: {
      ...pipeline,
      item: inbox },
    inbox,
    archiveDocumentId: inbox.archiveDocumentId,
    expense };
}
