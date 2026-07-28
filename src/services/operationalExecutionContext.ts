/**
 * OPERATIONAL-EXECUTION-PLAN-01 — read-only execution context from existing workflow data.
 */
import type { InboxItem, WorkflowResult } from '../types/models';
import {
  canCreateVorgangFromSmartIntakeGates,
  hasApplyableContractFields,
  wouldApplyContractFieldsOnSmartIntake,
} from './intakeExecutionGates';
import type { OperationalExecutionContext } from './operationalExecutionTypes';

export type OperationalExecutionContextOptions = {
  inboxItem?: Pick<
    InboxItem,
    'vorgangId' | 'importedToArchive' | 'documentType' | 'classifiedKind'
  > | null;
};

/**
 * Pure merge of existing BI + workflow flags. No reclassification, no invention.
 */
export function buildOperationalExecutionContext(
  workflow: WorkflowResult,
  options?: OperationalExecutionContextOptions,
): OperationalExecutionContext | null {
  const bi = workflow.businessInterpretation;
  if (!bi) return null;

  const item = options?.inboxItem;
  const money = bi.facts.money.some((entry) => entry.amount != null || Boolean(entry.amountFormatted));
  const gateItem = {
    vorgangId: item?.vorgangId,
    documentType: item?.documentType,
  };
  const canCreate = canCreateVorgangFromSmartIntakeGates(workflow, gateItem);
  const applyableFields = hasApplyableContractFields(workflow.contractAnalysis?.fields);

  return {
    primaryCase: bi.operational.primaryCase,
    meanings: [...bi.operational.meanings],
    deadlineType: bi.operational.deadlineType,
    companyRelevant: workflow.companyRelevant,
    alreadyArchived: Boolean(item?.importedToArchive),
    hasVorgangLink: Boolean(item?.vorgangId),
    hasSuggestedVorgang: Boolean(workflow.suggestedVorgang),
    hasSuggestedTasks: workflow.suggestedTasks.length > 0,
    hasContractAnalysis: Boolean(workflow.contractAnalysis?.isContract),
    hasApplyableContractFields: applyableFields,
    hasContractOrderProposal: Boolean(workflow.contractOrderProposal),
    hasSuggestedPositions:
      workflow.suggestedOrderPositions.length > 0 ||
      Boolean(workflow.contractOrderProposal?.positions?.length),
    hasPositionsConfirmUi:
      Boolean(workflow.contractOrderProposal) || workflow.suggestedOrderPositions.length > 0,
    canCreateVorgang: canCreate,
    wouldApplyContractFields: wouldApplyContractFieldsOnSmartIntake(workflow, gateItem),
    hasMoney: money,
    recognitionUncertain: bi.sourceDocument.recognitionUncertain,
    missingInformationCount: bi.missingInformation.length,
    conflictCount: bi.conflicts.length,
    requiredConfirmationIds: bi.requiredConfirmations.map((entry) => entry.id),
    classifiedKind: bi.sourceDocument.classifiedKind,
    processType: workflow.classification?.processType,
    documentType: item?.documentType,
  };
}
