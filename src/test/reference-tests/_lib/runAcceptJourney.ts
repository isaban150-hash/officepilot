/**
 * Ebene 2 — Accept Journey Runner.
 * Wiederverwendet Document-Case OCR + Stable-Pipeline + Accept-Orchestrator.
 */
import { acceptContractOrderFromProposal } from '../../../services/contractOrderAcceptService';
import { buildContractOrderProposal } from '../../../services/contractIntelligenceService';
import { getDocumentById, hydrateDocumentStore } from '../../../services/documentService';
import { getInboxItemById, hydrateInboxStore } from '../../../services/inboxService';
import {
  hydrateMemory,
  resetMemory } from '../../../services/officePilotMemoryService';
import { getVorgangById, hydrateVorgangStore } from '../../../services/vorgangService';
import { assertDocumentCase } from '../../document-cases/_lib/assertCase';
import { getDocumentCase } from '../../document-cases/_lib/loadCases';
import {
  runStablePipeline,
  type StablePipelineObservation } from '../../document-cases/_lib/runStablePipeline';
import type { ContractOrderProposal } from '../../../types/documentIntelligence';
import type { InboxItem, Vorgang } from '../../../types/models';
import type { AcceptJourneyExpected, ContractAcceptReferenceCase } from './types';

export interface AcceptJourneyObservation {
  reference: ContractAcceptReferenceCase;
  pipeline: StablePipelineObservation;
  proposal: ContractOrderProposal;
  accept: Extract<
    ReturnType<typeof acceptContractOrderFromProposal>,
    { success: true }
  >;
  vorgang: Vorgang;
  inbox: InboxItem;
  archiveDocumentId: string;
}

function seedEmptyStores(): void {
  resetMemory();
  hydrateMemory({
    documentMemories: [],
    proofMemories: [],
    relations: [],
    paperRegisterEntries: [] });
  hydrateDocumentStore([]);
  hydrateVorgangStore([]);
  hydrateInboxStore([]);
}

/**
 * Ebene 1 + 2: Document-Case-Soll, dann Accept → Vorgang/Archiv.
 */
export function runAcceptJourney(reference: ContractAcceptReferenceCase): AcceptJourneyObservation {
  if (reference.kind !== 'contract-accept') {
    throw new Error(`runAcceptJourney erwartet kind=contract-accept, got ${reference.kind}`);
  }
  seedEmptyStores();

  const docCase = getDocumentCase(reference.documentCaseId);
  const pipeline = runStablePipeline(docCase);

  // Ebene 1 — wiederverwendet bestehende Document-Case-Asserts (keine Doppel-Logik).
  if (reference.layers.includes('stable-pipeline')) {
    assertDocumentCase(docCase.expected, pipeline);
  }

  const item = getInboxItemById(pipeline.item.id) ?? pipeline.item;
  const proposal =
    pipeline.workflow.contractOrderProposal ??
    buildContractOrderProposal(item, pipeline.workflow.contractIntelligence ?? undefined);

  if (!proposal) {
    throw new Error(
      `[${reference.caseId}] Kein ContractOrderProposal — Accept-Journey nicht möglich.`,
    );
  }

  const expectJourney: AcceptJourneyExpected = reference.acceptJourney;
  const accept = acceptContractOrderFromProposal({
    item: getInboxItemById(item.id) ?? item,
    proposal,
    selectedPositions: proposal.positions,
    companyName: expectJourney.companyName,
    materialStandard: 'betrieb' });

  if (!accept.success) {
    throw new Error(
      `[${reference.caseId}] Accept fehlgeschlagen: ${accept.errorKey}`,
    );
  }

  const vorgang = getVorgangById(accept.vorgang.id);
  if (!vorgang) {
    throw new Error(`[${reference.caseId}] Vorgang nach Accept nicht gefunden.`);
  }

  const inbox = getInboxItemById(item.id);
  if (!inbox) {
    throw new Error(`[${reference.caseId}] Inbox nach Accept nicht gefunden.`);
  }

  const archiveDocumentId = accept.archiveDocumentId ?? inbox.archiveDocumentId;
  if (!archiveDocumentId || !getDocumentById(archiveDocumentId)) {
    throw new Error(`[${reference.caseId}] Archivdokument nach Accept fehlt.`);
  }

  return {
    reference,
    pipeline,
    proposal,
    accept,
    vorgang,
    inbox,
    archiveDocumentId };
}
