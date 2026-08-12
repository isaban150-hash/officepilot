/**
 * Read-only Smart-Intake gates shared by executeSmartIntake and shadow plan preview.
 * Behavior must stay identical to the previous private helpers in intakeExecutionService.
 */
import type {
  ContractExtractedFields,
  InboxItem,
  WorkflowResult,
} from '../types/models';
import {
  resolvePrimaryTargetObjectForDocumentType,
  resolvePrimaryTargetObjectForKind,
} from './documentPrimaryTargetService';
import { isInboxLinkedToVorgang } from './vorgangService';

function hasResolverAction(
  workflow: { nextActions?: WorkflowResult['nextActions'] },
  actionId: 'link_vorgang' | 'select_vorgang' | 'create_vorgang',
): boolean {
  const actions = workflow.nextActions ?? [];
  return actions.some((action) => action.id === actionId && action.enabled);
}

export type SmartIntakeVorgangGateItem = {
  vorgangId?: InboxItem['vorgangId'];
  documentType?: InboxItem['documentType'];
};

/** Same gate previously private as canCreateVorgang in intakeExecutionService. */
export function canCreateVorgangFromSmartIntakeGates(
  workflow: Pick<WorkflowResult, 'companyRelevant' | 'contractAnalysis' | 'classification'> & {
    nextActions?: WorkflowResult['nextActions'];
  },
  item: SmartIntakeVorgangGateItem,
): boolean {
  if (!hasResolverAction(workflow, 'create_vorgang')) return false;

  const primaryTarget = workflow.classification?.classifiedKind
    ? resolvePrimaryTargetObjectForKind(workflow.classification.classifiedKind)
    : item.documentType
      ? resolvePrimaryTargetObjectForDocumentType(item.documentType)
      : null;

  return (
    !item.vorgangId &&
    workflow.companyRelevant &&
    Boolean(
      workflow.contractAnalysis?.isContract ||
        primaryTarget === 'vorgang',
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
  workflow: Pick<WorkflowResult, 'companyRelevant' | 'contractAnalysis' | 'classification'> & {
    nextActions?: WorkflowResult['nextActions'];
  },
  item: SmartIntakeVorgangGateItem,
): boolean {
  if (!workflow.contractAnalysis?.isContract) return false;
  if (!hasApplyableContractFields(workflow.contractAnalysis.fields)) return false;

  const willHaveVorgang =
    Boolean(item.vorgangId) ||
    hasResolverAction(workflow, 'link_vorgang') ||
    canCreateVorgangFromSmartIntakeGates(workflow, item);

  return willHaveVorgang;
}

export function wouldLinkVorgangOnSmartIntake(
  workflow: Pick<WorkflowResult, 'companyRelevant'> & {
    nextActions?: WorkflowResult['nextActions'];
  },
  item: Pick<InboxItem, 'vorgangId' | 'vorgangLinkStatus'>,
): boolean {
  // buildNextActions already withholds link_vorgang for confirmed links; the item
  // check stays only as a guard and uses the authoritative confirmed-link rule, so
  // a legacy vorgangId without a valid status still reaches the link path.
  return (
    workflow.companyRelevant &&
    !isInboxLinkedToVorgang(item as InboxItem) &&
    hasResolverAction(workflow, 'link_vorgang')
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
  workflow: Pick<WorkflowResult, 'companyRelevant' | 'suggestedTasks' | 'workflowDecision'>,
): boolean {
  const taskProposals = workflow.workflowDecision?.taskProposals ?? workflow.suggestedTasks;
  return workflow.companyRelevant && taskProposals.length > 0;
}

export function wouldFinalizeInboxOnSmartIntake(
  workflow: Pick<WorkflowResult, 'companyRelevant'>,
): boolean {
  // Primary CTA is disabled without company relevance; finalize on that path is not user-reachable.
  return workflow.companyRelevant;
}
