/**
 * Read-only Smart-Intake gates shared by executeSmartIntake and shadow plan preview.
 * Behavior must stay identical to the previous private helpers in intakeExecutionService.
 */
import type {
  ContractExtractedFields,
  InboxItem,
  WorkflowResult,
} from '../types/models';

export type SmartIntakeVorgangGateItem = {
  vorgangId?: InboxItem['vorgangId'];
  documentType?: InboxItem['documentType'];
};

/** Same gate previously private as canCreateVorgang in intakeExecutionService. */
export function canCreateVorgangFromSmartIntakeGates(
  workflow: Pick<WorkflowResult, 'companyRelevant' | 'contractAnalysis' | 'classification'>,
  item: SmartIntakeVorgangGateItem,
): boolean {
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

/** Same field presence check previously private as hasContractFields. */
export function hasApplyableContractFields(
  fields: ContractExtractedFields | null | undefined,
): boolean {
  if (!fields) return false;
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

/**
 * True when executeSmartIntake would run apply_contract_fields successfully
 * (contract analysis + fields + a vorgang id after the vorgang step).
 */
export function wouldApplyContractFieldsOnSmartIntake(
  workflow: Pick<
    WorkflowResult,
    'companyRelevant' | 'contractAnalysis' | 'classification' | 'suggestedVorgang'
  >,
  item: SmartIntakeVorgangGateItem,
): boolean {
  if (!workflow.contractAnalysis?.isContract) return false;
  if (!hasApplyableContractFields(workflow.contractAnalysis.fields)) return false;

  const willHaveVorgang =
    Boolean(item.vorgangId) ||
    Boolean(workflow.suggestedVorgang) ||
    canCreateVorgangFromSmartIntakeGates(workflow, item);

  return willHaveVorgang;
}

export function wouldLinkVorgangOnSmartIntake(
  workflow: Pick<WorkflowResult, 'companyRelevant' | 'suggestedVorgang'>,
  item: Pick<InboxItem, 'vorgangId'>,
): boolean {
  return (
    workflow.companyRelevant &&
    !item.vorgangId &&
    Boolean(workflow.suggestedVorgang)
  );
}

export function wouldArchiveOnSmartIntake(
  workflow: Pick<WorkflowResult, 'companyRelevant'>,
  item: Pick<InboxItem, 'importedToArchive' | 'filingDecision'>,
): boolean {
  return (
    workflow.companyRelevant &&
    !item.importedToArchive &&
    item.filingDecision?.status === 'confirmed'
  );
}

export function wouldAcceptTasksOnSmartIntake(
  workflow: Pick<WorkflowResult, 'companyRelevant' | 'suggestedTasks'>,
): boolean {
  return workflow.companyRelevant && workflow.suggestedTasks.length > 0;
}

export function wouldFinalizeInboxOnSmartIntake(
  workflow: Pick<WorkflowResult, 'companyRelevant'>,
): boolean {
  // Primary CTA is disabled without company relevance; finalize on that path is not user-reachable.
  return workflow.companyRelevant;
}
