/**
 * Shared Smart-Intake execution atoms used by legacy orchestration and the plan runner.
 * Behavior must stay identical to the former private helpers in intakeExecutionService.
 */
import {
  handoffInboxItemToArchive,
  isDuplicateDocument,
} from './documentService';
import { finalizeInboxIntake } from './inboxService';
import { resolveImportInboxDocumentOptionsFromIntakeCarry } from './documentFileIntakeTransformPlanCarryContextService';
import {
  acceptSuggestedTasks,
  createVorgangFromInboxWithContract,
  linkWorkflowVorgang,
} from './intakeWorkflowService';
import { getInboxItemById } from './inboxService';
import { scanPendingItems } from './pendingEngineService';
import { getCachedSetup } from './persistenceService';
import {
  applyContractFieldsToVorgang,
  buildVorgangDraftFromInbox,
  isInboxLinkedToVorgang,
} from './vorgangService';
import {
  isDocumentFilingDecisionConfirmed,
  FILING_DECISION_ARCHIVE_BLOCKED_MESSAGE,
} from './documentFilingDecisionService';
import {
  isContractProofSyncHardFailure,
  syncContractProofRequirementsAfterVorgangLink,
} from './contractProofSyncAfterVorgangLinkService';
import type {
  ContractAnalysisResult,
  InboxItem,
  MaterialStandard,
  PendingSummary,
  VorgangDraft,
  WorkflowExecutionFailure,
  WorkflowExecutionStepId,
  WorkflowResult,
  WorkflowWarning,
} from '../types/models';
import {
  canCreateVorgangFromSmartIntakeGates,
  hasApplyableContractFields,
} from './intakeExecutionGates';

export type SmartIntakeAtomOptions = {
  companyName?: string;
  materialStandard?: MaterialStandard;
  duplicateMode?: 'create' | 'update' | 'skip';
  today?: Date | string;
  skipArchive?: boolean;
};

export function pushIntakeWarning(
  warnings: WorkflowWarning[],
  id: string,
  message: string,
): void {
  if (warnings.some((warning) => warning.id === id)) return;
  warnings.push({ id, message });
}

export function markIntakeSuccess(
  successSteps: WorkflowExecutionStepId[],
  step: WorkflowExecutionStepId,
): void {
  if (!successSteps.includes(step)) successSteps.push(step);
}

export function markIntakeFailure(
  failedSteps: WorkflowExecutionFailure[],
  step: WorkflowExecutionStepId,
  message: string,
): void {
  failedSteps.push({ step, message });
}

function buildContractDraft(contractAnalysis: ContractAnalysisResult | null): Partial<VorgangDraft> {
  if (!contractAnalysis?.isContract) return {};
  const fields = contractAnalysis.fields;
  return {
    title: fields.bauvorhaben ?? fields.projektname,
    customer: fields.auftraggeber,
    baustelle: fields.baustellenadresse,
  };
}

export function executeArchiveAtom(
  item: InboxItem,
  options: SmartIntakeAtomOptions,
  successSteps: WorkflowExecutionStepId[],
  failedSteps: WorkflowExecutionFailure[],
  warnings: WorkflowWarning[],
): { item: InboxItem; archiveDocumentId?: string } {
  if (options.skipArchive || item.importedToArchive) {
    markIntakeSuccess(successSteps, 'archive_document');
    return { item, archiveDocumentId: item.archiveDocumentId };
  }

  if (!options.companyName) {
    markIntakeFailure(failedSteps, 'archive_document', 'Firmenname fehlt für Archivimport.');
    return { item };
  }

  // Confirm-first: never auto-confirm filing. Archive only after explicit user confirm.
  if (!isDocumentFilingDecisionConfirmed(item)) {
    markIntakeFailure(failedSteps, 'archive_document', FILING_DECISION_ARCHIVE_BLOCKED_MESSAGE);
    pushIntakeWarning(
      warnings,
      'filing_decision_unconfirmed',
      FILING_DECISION_ARCHIVE_BLOCKED_MESSAGE,
    );
    return { item };
  }

  const workingItem = item;

  const duplicate = isDuplicateDocument(workingItem, options.companyName);
  if (duplicate && options.duplicateMode === 'skip') {
    pushIntakeWarning(
      warnings,
      'archive_duplicate_skipped',
      'Archiv-Duplikat erkannt – Import übersprungen.',
    );
    markIntakeSuccess(successSteps, 'archive_document');
    return { item: workingItem };
  }

  // R02: one shared handoff — archive write plus inbox marking, reusing an existing
  // archive document for this inbox item instead of creating a duplicate.
  const archiveResult = handoffInboxItemToArchive(workingItem, options.companyName, {
    ...resolveImportInboxDocumentOptionsFromIntakeCarry(workingItem.id),
    ...(duplicate ? { existingDocumentId: duplicate.id } : {}),
  });

  if (!archiveResult.success) {
    markIntakeFailure(failedSteps, 'archive_document', archiveResult.errorKey);
    return archiveResult.document
      ? { item: workingItem, archiveDocumentId: archiveResult.document.id }
      : { item: workingItem };
  }

  markIntakeSuccess(successSteps, 'archive_document');
  return { item: archiveResult.item, archiveDocumentId: archiveResult.document.id };
}

function runProofSyncAfterVorgangLink(input: {
  vorgangId: string;
  inboxItem: InboxItem;
  step: 'create_vorgang' | 'link_vorgang';
  failedSteps: WorkflowExecutionFailure[];
  warnings?: WorkflowWarning[];
  /** From processUploadedDocument — avoids a second CI pass on Smart Intake. */
  precomputedIntelligence?: WorkflowResult['contractIntelligence'];
}): InboxItem {
  const fresh = getInboxItemById(input.inboxItem.id) ?? input.inboxItem;
  const syncResult = syncContractProofRequirementsAfterVorgangLink({
    vorgangId: input.vorgangId,
    inboxItem: fresh,
    precomputedIntelligence: input.precomputedIntelligence,
  });

  if (isContractProofSyncHardFailure(syncResult)) {
    markIntakeFailure(
      input.failedSteps,
      input.step,
      syncResult.message ?? 'Vertragsnachweise konnten nicht synchronisiert werden.',
    );
    if (input.warnings) {
      pushIntakeWarning(
        input.warnings,
        'contract_proof_sync_failed',
        syncResult.message ?? 'Vertragsnachweise konnten nicht synchronisiert werden.',
      );
    }
  }

  return fresh;
}

export function executeVorgangAtom(
  item: InboxItem,
  workflow: WorkflowResult,
  options: SmartIntakeAtomOptions,
  successSteps: WorkflowExecutionStepId[],
  failedSteps: WorkflowExecutionFailure[],
  warnings?: WorkflowWarning[],
): { item: InboxItem; vorgangId?: string } {
  const canLinkVorgang = workflow.nextActions.some(
    (action) => action.id === 'link_vorgang' && action.enabled,
  );
  const canCreateVorgang = workflow.nextActions.some(
    (action) => action.id === 'create_vorgang' && action.enabled,
  );

  if (isInboxLinkedToVorgang(item)) {
    markIntakeSuccess(successSteps, workflow.suggestedVorgang ? 'link_vorgang' : 'create_vorgang');
    return { item, vorgangId: item.vorgangId };
  }

  const contractDraft = buildContractDraft(workflow.contractAnalysis);

  if (workflow.suggestedVorgang && canLinkVorgang) {
    const linked = linkWorkflowVorgang(item, workflow.suggestedVorgang.vorgangId);
    if (!linked) {
      markIntakeFailure(failedSteps, 'link_vorgang', 'Vorgang konnte nicht verknüpft werden.');
      return { item };
    }
    markIntakeSuccess(successSteps, 'link_vorgang');
    const fresh = runProofSyncAfterVorgangLink({
      vorgangId: linked.vorgang.id,
      inboxItem: linked.inbox,
      step: 'link_vorgang',
      failedSteps,
      warnings,
      precomputedIntelligence: workflow.contractIntelligence,
    });
    return { item: fresh, vorgangId: linked.vorgang.id };
  }

  if (canCreateVorgang && canCreateVorgangFromSmartIntakeGates(workflow, item)) {
    const materialDefault = options.materialStandard ?? getCachedSetup().materialStandard;
    const created = createVorgangFromInboxWithContract(
      item,
      {
        ...buildVorgangDraftFromInbox(item, materialDefault),
        ...contractDraft,
      },
      materialDefault,
    );
    if (!created) {
      markIntakeFailure(failedSteps, 'create_vorgang', 'Neuer Vorgang konnte nicht angelegt werden.');
      return { item };
    }

    markIntakeSuccess(successSteps, 'create_vorgang');
    const fresh = runProofSyncAfterVorgangLink({
      vorgangId: created.vorgang.id,
      inboxItem: created.inbox,
      step: 'create_vorgang',
      failedSteps,
      warnings,
      precomputedIntelligence: workflow.contractIntelligence,
    });
    return { item: fresh, vorgangId: created.vorgang.id };
  }

  return { item };
}

export function executeContractFieldsAtom(
  vorgangId: string | undefined,
  workflow: WorkflowResult,
  successSteps: WorkflowExecutionStepId[],
  failedSteps: WorkflowExecutionFailure[],
): void {
  if (!vorgangId || !workflow.contractAnalysis?.isContract) return;

  const fields = workflow.contractAnalysis.fields;
  if (!hasApplyableContractFields(fields)) return;

  const result = applyContractFieldsToVorgang(vorgangId, fields);
  if (!result.success) {
    markIntakeFailure(failedSteps, 'apply_contract_fields', result.errorKey);
    return;
  }
  markIntakeSuccess(successSteps, 'apply_contract_fields');
}

export function executeAcceptTasksAtom(
  workflow: WorkflowResult,
  successSteps: WorkflowExecutionStepId[],
  failedSteps: WorkflowExecutionFailure[],
): number {
  const taskProposals = workflow.workflowDecision!.taskProposals;
  if (taskProposals.length === 0) return 0;
  const createdTasks = acceptSuggestedTasks(taskProposals);
  const tasksCreated = createdTasks.length;
  if (tasksCreated > 0) {
    markIntakeSuccess(successSteps, 'accept_tasks');
  } else {
    markIntakeFailure(failedSteps, 'accept_tasks', 'Aufgaben konnten nicht erzeugt werden.');
  }
  return tasksCreated;
}

export function executeRefreshPendingAtom(
  options: SmartIntakeAtomOptions,
  successSteps: WorkflowExecutionStepId[],
): PendingSummary {
  const pendingSummary = scanPendingItems(options.today).summary;
  markIntakeSuccess(successSteps, 'refresh_pending');
  return pendingSummary;
}

export function executeFinalizeInboxAtom(
  item: InboxItem,
  successSteps: WorkflowExecutionStepId[],
  failedSteps: WorkflowExecutionFailure[],
): InboxItem {
  const finalized = finalizeInboxIntake(item.id);
  if (finalized) {
    markIntakeSuccess(successSteps, 'finalize_inbox');
    return finalized;
  }
  markIntakeFailure(failedSteps, 'finalize_inbox', 'Inbox-Status konnte nicht aktualisiert werden.');
  return item;
}

export function computeSmartIntakeCompleted(
  workflow: WorkflowResult,
  successSteps: WorkflowExecutionStepId[],
  failedSteps: WorkflowExecutionFailure[],
): boolean {
  return (
    failedSteps.length === 0 &&
    successSteps.includes('finalize_inbox') &&
    (workflow.companyRelevant ? successSteps.length > 1 : true)
  );
}
