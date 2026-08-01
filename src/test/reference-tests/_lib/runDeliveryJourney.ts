/**
 * LS-01 — Delivery-note Journey Runner.
 * Document-Case → Stable-Pipeline → Archiv → Confirm-first Vorgangs-Zuordnung.
 * Keine Plan-/Mengen-/Rechnungsänderung.
 */
import { confirmFilingDecisionForTests, importInboxDocumentForTests } from '../../confirmFilingDecisionForTests';
import { assertDocumentCase } from '../../document-cases/_lib/assertCase';
import { getDocumentCase } from '../../document-cases/_lib/loadCases';
import {
  runStablePipeline,
  testProfile,
  type StablePipelineObservation } from '../../document-cases/_lib/runStablePipeline';
import { createOrderPosition, createTestVorgang } from '../../fixtures';
import { interpretBusinessFromWorkflow } from '../../../services/businessInterpretationService';
import { getDocumentById, hydrateDocumentStore } from '../../../services/documentService';
import { getAllExpenses } from '../../../services/expenseService';
import { hydrateExpenseStore } from '../../../services/expenseStore';
import {
  getInboxItemById,
  hydrateInboxStore,
  markInboxImportedToArchive,
  patchInboxItem } from '../../../services/inboxService';
import {
  getVorgangById,
  hydrateVorgangStore,
  linkInboxToExistingVorgang } from '../../../services/vorgangService';
import type { CompanyDocument, InboxItem, OrderPosition, Vorgang } from '../../../types/models';
import type { DeliveryNoteReferenceCase } from './types';

export interface DeliveryJourneyObservation {
  reference: DeliveryNoteReferenceCase;
  pipeline: StablePipelineObservation;
  inbox: InboxItem;
  vorgang: Vorgang;
  archiveDocument: CompanyDocument;
  archiveDocumentId: string;
  positionsBefore: Array<Pick<OrderPosition, 'id' | 'description' | 'plannedQuantity' | 'unitPrice'>>;
  positionsAfter: Array<Pick<OrderPosition, 'id' | 'description' | 'plannedQuantity' | 'unitPrice'>>;
  confirmationsBeforeLink: string[];
  expenseCount: number;
  amendmentDraftCount: number;
  confirmedAmendmentCount: number;
}

function snapshotPositions(vorgang: Vorgang) {
  return (vorgang.orderPositions ?? []).map((p) => ({
    id: p.id,
    description: p.description,
    plannedQuantity: p.plannedQuantity,
    unitPrice: p.unitPrice }));
}

/**
 * Productive BI only shows Mengenhinweis when recognizedData.Menge is set.
 * Lift first OCR "Menge:" line into recognizedData — test glue, not a new extractor service.
 */
function applyOcrQuantityHint(inboxId: string, ocrText: string): void {
  const match = ocrText.match(/Menge:\s*([^\n]+)/i);
  if (!match?.[1]?.trim()) return;
  const current = getInboxItemById(inboxId);
  if (!current) return;
  patchInboxItem(inboxId, {
    recognizedData: {
      ...current.recognizedData,
      Menge: match[1].trim() } });
}

function seedOrder(reference: DeliveryNoteReferenceCase): Vorgang {
  const exp = reference.deliveryJourney;
  const vorgang = createTestVorgang({
    id: exp.vorgangId,
    status: 'beauftragt',
    customer: 'Mustermann Sanitär GmbH',
    title: 'LS-01 Auftrag Hauptstr. 12',
    baustelle: 'Hauptstr. 12 Berlin',
    orderPositions: [
      createOrderPosition({
        id: exp.originalPositionId,
        description: 'Kupferrohr 15 mm',
        plannedQuantity: exp.originalPlannedQuantity,
        unit: 'Meter',
        unitPrice: 8.5,
        category: 'material',
        billable: false }),
    ],
    invoices: [] });
  hydrateVorgangStore([vorgang]);
  return getVorgangById(exp.vorgangId)!;
}

/**
 * Ebene 1 + Delivery-Journey: erkennen → archivieren → Auftrag zuordnen → Plan unverändert.
 */
export function runDeliveryJourney(
  reference: DeliveryNoteReferenceCase,
): DeliveryJourneyObservation {
  if (reference.kind !== 'delivery-note') {
    throw new Error(`runDeliveryJourney erwartet kind=delivery-note, got ${reference.kind}`);
  }
  hydrateDocumentStore([]);
  hydrateExpenseStore([]);
  hydrateInboxStore([]);

  const exp = reference.deliveryJourney;
  const seeded = seedOrder(reference);
  const positionsBefore = snapshotPositions(seeded);

  const docCase = getDocumentCase(reference.documentCaseId);
  const pipeline = runStablePipeline(docCase);

  if (reference.layers.includes('stable-pipeline')) {
    assertDocumentCase(docCase.expected, pipeline);
  }

  let inbox = getInboxItemById(pipeline.item.id);
  if (!inbox) {
    throw new Error(`[${reference.caseId}] Inbox nach Pipeline fehlt`);
  }

  applyOcrQuantityHint(inbox.id, docCase.ocrText);
  inbox = getInboxItemById(inbox.id)!;

  const confirmationsBeforeLink = (pipeline.bi?.requiredConfirmations ?? []).map((c) => c.id);

  const companyName = exp.companyName.trim() || testProfile.companyName;

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

  const linked = linkInboxToExistingVorgang(inbox, exp.vorgangId);
  if (!linked) {
    throw new Error(`[${reference.caseId}] Vorgangs-Zuordnung (Confirm-first) fehlgeschlagen`);
  }
  inbox = linked.inbox;

  const vorgang = getVorgangById(exp.vorgangId);
  if (!vorgang) {
    throw new Error(`[${reference.caseId}] Vorgang nach Link fehlt`);
  }

  const archiveDocument = getDocumentById(inbox.archiveDocumentId ?? imported.document.id);
  if (!archiveDocument || !inbox.archiveDocumentId) {
    throw new Error(`[${reference.caseId}] Archivdokument nach Import fehlt`);
  }

  // Refresh BI against linked inbox + quantity hint (same production interpreter).
  const refreshedBi = interpretBusinessFromWorkflow({
    item: inbox,
    workflow: pipeline.workflow,
    linkedVorgang: vorgang });

  return {
    reference,
    pipeline: {
      ...pipeline,
      item: inbox,
      bi: refreshedBi,
      workflow: {
        ...pipeline.workflow,
        businessInterpretation: refreshedBi } },
    inbox,
    vorgang,
    archiveDocument,
    archiveDocumentId: inbox.archiveDocumentId,
    positionsBefore,
    positionsAfter: snapshotPositions(vorgang),
    confirmationsBeforeLink,
    expenseCount: getAllExpenses().length,
    amendmentDraftCount: vorgang.orderAmendments?.length ?? 0,
    confirmedAmendmentCount: vorgang.confirmedOrderAmendments?.length ?? 0 };
}
