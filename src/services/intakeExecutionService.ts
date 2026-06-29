import {
  importInboxDocument,
  isDuplicateDocument,
  updateDocumentFromInbox,
} from './documentService';
import {
  finalizeInboxIntake,
  getInboxItemById,
  markInboxImportedToArchive,
} from './inboxService';
import {
  acceptSuggestedTasks,
  importSuggestedPositionsToVorgang,
  linkWorkflowVorgang,
} from './intakeWorkflowService';
import { scanPendingItems } from './pendingEngineService';
import { getCachedSetup } from './persistenceService';
import {
  applyContractFieldsToVorgang,
  buildVorgangDraftFromInbox,
  createVorgangFromInbox,
  isInboxLinkedToVorgang,
} from './vorgangService';
import type {
  ContractAnalysisResult,
  ContractExtractedFields,
  InboxItem,
  MaterialStandard,
  VorgangDraft,
  WorkflowExecutionFailure,
  WorkflowExecutionStepId,
  WorkflowResult,
  WorkflowResultExecution,
  WorkflowWarning,
} from '../types/models';

export interface SmartIntakeExecutionOptions {
  companyName?: string;
  materialStandard?: MaterialStandard;
  duplicateMode?: 'create' | 'update' | 'skip';
  today?: Date | string;
  skipArchive?: boolean;
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

function canCreateVorgang(workflow: WorkflowResult, item: InboxItem): boolean {
  return (
    !item.vorgangId &&
    workflow.companyRelevant &&
    Boolean(
      workflow.contractAnalysis?.isContract ||
        workflow.classification?.processType === 'create_vorgang' ||
        item.documentType === 'kundenauftrag',
    )
  );
}

function pushWarning(
  warnings: WorkflowWarning[],
  id: string,
  message: string,
): void {
  if (warnings.some((warning) => warning.id === id)) return;
  warnings.push({ id, message });
}

function markSuccess(
  successSteps: WorkflowExecutionStepId[],
  step: WorkflowExecutionStepId,
): void {
  if (!successSteps.includes(step)) successSteps.push(step);
}

function markFailure(
  failedSteps: WorkflowExecutionFailure[],
  step: WorkflowExecutionStepId,
  message: string,
): void {
  failedSteps.push({ step, message });
}

function executeArchiveStep(
  item: InboxItem,
  options: SmartIntakeExecutionOptions,
  successSteps: WorkflowExecutionStepId[],
  failedSteps: WorkflowExecutionFailure[],
  warnings: WorkflowWarning[],
): { item: InboxItem; archiveDocumentId?: string } {
  if (options.skipArchive || item.importedToArchive) {
    markSuccess(successSteps, 'archive_document');
    return { item, archiveDocumentId: item.archiveDocumentId };
  }

  if (!options.companyName) {
    markFailure(failedSteps, 'archive_document', 'Firmenname fehlt für Archivimport.');
    return { item };
  }

  const duplicate = isDuplicateDocument(item, options.companyName);
  if (duplicate && options.duplicateMode === 'skip') {
    pushWarning(warnings, 'archive_duplicate_skipped', 'Archiv-Duplikat erkannt – Import übersprungen.');
    markSuccess(successSteps, 'archive_document');
    return { item };
  }

  const archiveResult = duplicate
    ? updateDocumentFromInbox(duplicate.id, item, options.companyName)
    : importInboxDocument(item, options.companyName);

  if (!archiveResult.success) {
    markFailure(failedSteps, 'archive_document', archiveResult.errorKey);
    return { item };
  }

  const marked = markInboxImportedToArchive(item.id, archiveResult.document.id);
  if (!marked?.item) {
    markFailure(failedSteps, 'archive_document', 'Inbox-Status nach Archivimport nicht aktualisiert.');
    return { item, archiveDocumentId: archiveResult.document.id };
  }

  markSuccess(successSteps, 'archive_document');
  return { item: marked.item, archiveDocumentId: archiveResult.document.id };
}

function executeVorgangStep(
  item: InboxItem,
  workflow: WorkflowResult,
  options: SmartIntakeExecutionOptions,
  successSteps: WorkflowExecutionStepId[],
  failedSteps: WorkflowExecutionFailure[],
): { item: InboxItem; vorgangId?: string } {
  if (isInboxLinkedToVorgang(item)) {
    markSuccess(successSteps, workflow.suggestedVorgang ? 'link_vorgang' : 'create_vorgang');
    return { item, vorgangId: item.vorgangId };
  }

  const contractDraft = buildContractDraft(workflow.contractAnalysis);

  if (workflow.suggestedVorgang) {
    const linked = linkWorkflowVorgang(item, workflow.suggestedVorgang.vorgangId);
    if (!linked) {
      markFailure(failedSteps, 'link_vorgang', 'Vorgang konnte nicht verknüpft werden.');
      return { item };
    }
    markSuccess(successSteps, 'link_vorgang');
    return { item: linked.inbox, vorgangId: linked.vorgang.id };
  }

  if (canCreateVorgang(workflow, item)) {
    const materialDefault = options.materialStandard ?? getCachedSetup().materialStandard;
    const created = createVorgangFromInbox(
      item,
      {
        ...buildVorgangDraftFromInbox(item, materialDefault),
        ...contractDraft,
      },
      materialDefault,
    );
    if (!created) {
      markFailure(failedSteps, 'create_vorgang', 'Neuer Vorgang konnte nicht angelegt werden.');
      return { item };
    }

    markSuccess(successSteps, 'create_vorgang');
    return { item: created.inbox, vorgangId: created.vorgang.id };
  }

  return { item };
}

function executeContractFieldsStep(
  vorgangId: string | undefined,
  workflow: WorkflowResult,
  successSteps: WorkflowExecutionStepId[],
  failedSteps: WorkflowExecutionFailure[],
): void {
  if (!vorgangId || !workflow.contractAnalysis?.isContract) return;

  const fields = workflow.contractAnalysis.fields;
  if (!hasContractFields(fields)) return;

  const result = applyContractFieldsToVorgang(vorgangId, fields);
  if (!result.success) {
    markFailure(failedSteps, 'apply_contract_fields', result.errorKey);
    return;
  }
  markSuccess(successSteps, 'apply_contract_fields');
}

function hasContractFields(fields: ContractExtractedFields): boolean {
  return Boolean(
    fields.bauvorhaben ||
      fields.projektname ||
      fields.baustellenadresse ||
      fields.auftraggeber ||
      fields.ansprechpartner ||
      fields.telefon ||
      fields.email,
  );
}

export function executeSmartIntake(
  workflow: WorkflowResult,
  options: SmartIntakeExecutionOptions = {},
): WorkflowResultExecution {
  const successSteps: WorkflowExecutionStepId[] = [];
  const failedSteps: WorkflowExecutionFailure[] = [];
  const warnings: WorkflowWarning[] = [...workflow.warnings];

  let item = getInboxItemById(workflow.inboxItemId);
  if (!item) {
    return {
      completed: false,
      successSteps,
      failedSteps: [{ step: 'finalize_inbox', message: 'Inbox-Dokument nicht gefunden.' }],
      warnings,
      inboxItem: null,
      tasksCreated: 0,
      positionsAdded: 0,
      pendingSummary: null,
    };
  }

  let vorgangId = item.vorgangId;
  let archiveDocumentId = item.archiveDocumentId;
  let tasksCreated = 0;
  let positionsAdded = 0;
  let pendingSummary = workflow.pendingSummary;

  if (!workflow.companyRelevant) {
    markFailure(failedSteps, 'archive_document', 'Kein Firmenbezug – Smart Intake eingeschränkt.');
    const finalized = finalizeInboxIntake(item.id);
    if (finalized) {
      item = finalized;
      markSuccess(successSteps, 'finalize_inbox');
    }
    return {
      completed: failedSteps.length === 0,
      successSteps,
      failedSteps,
      warnings,
      inboxItem: item,
      vorgangId,
      archiveDocumentId,
      tasksCreated,
      positionsAdded,
      pendingSummary,
    };
  }

  try {
    const archiveOutcome = executeArchiveStep(
      item,
      options,
      successSteps,
      failedSteps,
      warnings,
    );
    item = archiveOutcome.item;
    archiveDocumentId = archiveOutcome.archiveDocumentId ?? archiveDocumentId;

    const vorgangOutcome = executeVorgangStep(
      item,
      workflow,
      options,
      successSteps,
      failedSteps,
    );
    item = vorgangOutcome.item;
    vorgangId = vorgangOutcome.vorgangId ?? item.vorgangId;

    if (workflow.suggestedOrderPositions.length > 0) {
      if (!vorgangId) {
        markFailure(
          failedSteps,
          'import_positions',
          'Kein Vorgang für Positionsimport vorhanden.',
        );
      } else {
        const positionResult = importSuggestedPositionsToVorgang(
          vorgangId,
          workflow.suggestedOrderPositions,
        );
        positionsAdded = positionResult.added;
        if (positionResult.added > 0 || positionResult.skipped > 0) {
          markSuccess(successSteps, 'import_positions');
        } else {
          markFailure(failedSteps, 'import_positions', 'Positionen konnten nicht übernommen werden.');
        }
      }
    }

    executeContractFieldsStep(vorgangId, workflow, successSteps, failedSteps);

    if (workflow.suggestedTasks.length > 0) {
      const createdTasks = acceptSuggestedTasks(workflow.suggestedTasks);
      tasksCreated = createdTasks.length;
      if (tasksCreated > 0) {
        markSuccess(successSteps, 'accept_tasks');
      } else {
        markFailure(failedSteps, 'accept_tasks', 'Aufgaben konnten nicht erzeugt werden.');
      }
    }

    pendingSummary = scanPendingItems(options.today).summary;
    markSuccess(successSteps, 'refresh_pending');

    const finalized = finalizeInboxIntake(item.id);
    if (finalized) {
      item = finalized;
      markSuccess(successSteps, 'finalize_inbox');
    } else {
      markFailure(failedSteps, 'finalize_inbox', 'Inbox-Status konnte nicht aktualisiert werden.');
    }
  } catch (error) {
    markFailure(
      failedSteps,
      'finalize_inbox',
      error instanceof Error ? error.message : 'Unbekannter Fehler beim Smart Intake.',
    );
  }

  const completed =
    failedSteps.length === 0 &&
    successSteps.includes('finalize_inbox') &&
    (workflow.companyRelevant ? successSteps.length > 1 : true);

  return {
    completed,
    successSteps,
    failedSteps,
    warnings,
    inboxItem: item,
    vorgangId,
    archiveDocumentId,
    tasksCreated,
    positionsAdded,
    pendingSummary,
  };
}
