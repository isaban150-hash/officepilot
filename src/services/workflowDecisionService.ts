import { analyzeInboxWorkflow, analyzeVorgangWorkflow } from './brain/workflowIntelligenceService';
import { filterAvailableDocumentActions } from './officeActionService';
import type { InboxItem, WorkflowResult } from '../types/models';
import type { WorkflowDecision } from '../types/workflowDecision';

function normalizeVorgangRef(
  vorgangRef: WorkflowDecision['vorgangRef'] | null | undefined,
): WorkflowDecision['vorgangRef'] {
  if (vorgangRef) return vorgangRef;
  return {
    status: 'none',
    suggested: null,
    linkedVorgangId: null,
    linkedVorgangTitle: null,
    similarCount: 0,
  };
}

export function buildWorkflowDecisionForInboxItem(
  item: InboxItem,
  workflow: WorkflowResult,
): WorkflowDecision {
  const workflowAnalysis = item.vorgangId
    ? analyzeVorgangWorkflow(item.vorgangId)
    : analyzeInboxWorkflow(item.id, workflow);

  const archiveAction = workflow.nextActions.find((action) => action.id === 'archive_document');
  const availableDocumentActions = filterAvailableDocumentActions(item);
  const linkedVorgangId = item.vorgangId ?? null;
  const linkedVorgangTitle = item.vorgangTitle ?? null;
  const confirmedFiling = item.filingDecision?.status === 'confirmed';

  return {
    inboxItemId: item.id,
    source: 'live',
    companyRelevant: workflow.companyRelevant,
    companyRelevance: workflow.companyRelevance,
    classifiedKind: workflow.classifiedKind,
    classificationConfidence: workflow.classificationConfidence,
    classification: workflow.classification,
    documentExplanation: workflow.documentExplanation,
    documentUnderstanding: workflow.documentUnderstanding,
    documentAiActions: workflow.documentAiActions,
    warnings: workflow.warnings,
    suggestedVorgang: workflow.suggestedVorgang,
    businessInterpretation: workflow.businessInterpretation,
    documentMeaning: workflow.businessInterpretation?.meaning ?? null,
    eventType: workflow.businessInterpretation?.meaning.eventType ?? null,
    primaryDecision: workflow.businessInterpretation?.operational.primaryCase ?? null,
    operationalNextStep: workflow.businessInterpretation?.operational.nextStep ?? '',
    nextActionCandidates: workflow.businessInterpretation?.nextActionCandidates ?? [],
    nextActions: workflow.nextActions,
    taskProposals: workflow.suggestedTasks,
    vorgangRef: normalizeVorgangRef(workflow.businessInterpretation?.vorgangRef),
    deadlines: workflow.businessInterpretation?.facts.timeline ?? {},
    confirmations: workflow.businessInterpretation?.requiredConfirmations ?? [],
    archiveDecision: {
      isArchived: item.importedToArchive,
      canArchive: !item.importedToArchive && workflow.companyRelevant,
      recommended: archiveAction !== undefined,
      enabled: archiveAction?.enabled ?? false,
    },
    officeActionContext: {
      availableDocumentActions,
    },
    executionStatus: {
      importedToArchive: item.importedToArchive,
      archiveDocumentId: item.archiveDocumentId ?? null,
      linkedVorgangId,
      linkedVorgangTitle,
      hasVorgang: Boolean(item.vorgangId),
      confirmedFiling,
    },
    risks: workflowAnalysis?.risks ?? [],
    workflowAnalysis,
  };
}

export function buildWorkflowAnalysisFromDecision(
  decision: WorkflowDecision,
): ReturnType<typeof analyzeInboxWorkflow> {
  if (decision.executionStatus.hasVorgang && decision.executionStatus.linkedVorgangId) {
    return analyzeVorgangWorkflow(decision.executionStatus.linkedVorgangId);
  }
  return analyzeInboxWorkflow(decision.inboxItemId);
}
