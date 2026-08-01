/**
 * FA-FRIST-01 — Authority-letter Journey Runner.
 * Document-Case → Stable-Pipeline → Archiv. Kein Auftrag / keine Ausgabe.
 */
import { confirmFilingDecisionForTests, importInboxDocumentForTests } from '../../confirmFilingDecisionForTests';
import { assertDocumentCase } from '../../document-cases/_lib/assertCase';
import { getDocumentCase } from '../../document-cases/_lib/loadCases';
import {
  runStablePipeline,
  testProfile,
  type StablePipelineObservation } from '../../document-cases/_lib/runStablePipeline';
import { getDocumentById, hydrateDocumentStore } from '../../../services/documentService';
import { getAllExpenses } from '../../../services/expenseService';
import { hydrateExpenseStore } from '../../../services/expenseStore';
import { getInboxItemById, hydrateInboxStore, markInboxImportedToArchive } from '../../../services/inboxService';
import { getVorgangStoreSnapshot, hydrateVorgangStore } from '../../../services/vorgangService';
import type { CompanyDocument, InboxItem } from '../../../types/models';
import type { AuthorityLetterReferenceCase } from './types';

export interface AuthorityJourneyObservation {
  reference: AuthorityLetterReferenceCase;
  pipeline: StablePipelineObservation;
  inbox: InboxItem;
  archiveDocument: CompanyDocument;
  archiveDocumentId: string;
  vorgangCount: number;
  expenseCount: number;
}

function seedEmptyStores(): void {
  hydrateDocumentStore([]);
  hydrateVorgangStore([]);
  hydrateExpenseStore([]);
  hydrateInboxStore([]);
}

/**
 * Ebene 1 + Authority-Journey: erkennen → archivieren → keine Nebenwirkungen.
 */
export function runAuthorityJourney(
  reference: AuthorityLetterReferenceCase,
): AuthorityJourneyObservation {
  if (reference.kind !== 'authority-letter') {
    throw new Error(`runAuthorityJourney erwartet kind=authority-letter, got ${reference.kind}`);
  }

  seedEmptyStores();

  const docCase = getDocumentCase(reference.documentCaseId);
  const pipeline = runStablePipeline(docCase);

  if (reference.layers.includes('stable-pipeline')) {
    assertDocumentCase(docCase.expected, pipeline);
  }

  let inbox = getInboxItemById(pipeline.item.id);
  if (!inbox) {
    throw new Error(`[${reference.caseId}] Inbox nach Pipeline fehlt`);
  }

  const companyName =
    reference.authorityJourney.companyName.trim() || testProfile.companyName;

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

  const archiveDocument = getDocumentById(imported.document.id);
  if (!archiveDocument || !inbox.archiveDocumentId) {
    throw new Error(`[${reference.caseId}] Archivdokument nach Import fehlt`);
  }

  return {
    reference,
    pipeline: { ...pipeline, item: inbox },
    inbox,
    archiveDocument,
    archiveDocumentId: inbox.archiveDocumentId,
    vorgangCount: getVorgangStoreSnapshot().length,
    expenseCount: getAllExpenses().length };
}
