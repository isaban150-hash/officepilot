/**
 * Smart Intake execution entry — LEGACY + optional expense plan runner (01A).
 * UI must only call executeSmartIntake; never the runner directly.
 */
import { getInboxItemById, finalizeInboxIntake } from './inboxService';
import {
  getOperationalExecutionRunnerEnabled,
  isOperationalExecutionRunnerPlaybook,
} from '../config/operationalExecutionConfig';
import {
  computeSmartIntakeCompleted,
  executeAcceptTasksAtom,
  executeArchiveAtom,
  executeContractFieldsAtom,
  executeFinalizeInboxAtom,
  executeRefreshPendingAtom,
  executeVorgangAtom,
  markIntakeFailure,
  markIntakeSuccess,
  pushIntakeWarning,
  type SmartIntakeAtomOptions,
} from './intakeExecutionAtoms';
import { wouldLinkVorgangOnSmartIntake } from './intakeExecutionGates';
import { buildOperationalExecutionPlan } from './operationalExecutionPlanService';
import { runOperationalExecutionPlan } from './operationalExecutionRunner';
import type {
  InboxItem,
  WorkflowExecutionFailure,
  WorkflowExecutionStepId,
  WorkflowResult,
  WorkflowResultExecution,
  WorkflowWarning,
} from '../types/models';

export type SmartIntakeExecutionOptions = SmartIntakeAtomOptions;

/**
 * Unchanged legacy orchestration (shared atoms). Exactly one orchestrator per Primary call.
 */
export function executeLegacySmartIntakeSequence(
  workflow: WorkflowResult,
  item: NonNullable<ReturnType<typeof getInboxItemById>>,
  options: SmartIntakeExecutionOptions = {},
): WorkflowResultExecution {
  const successSteps: WorkflowExecutionStepId[] = [];
  const failedSteps: WorkflowExecutionFailure[] = [];
  const warnings: WorkflowWarning[] = [...workflow.warnings];

  let current = item;
  let vorgangId = current.vorgangId;
  let archiveDocumentId = current.archiveDocumentId;
  let tasksCreated = 0;
  let positionsAdded = 0;
  let pendingSummary = workflow.pendingSummary;

  if (!workflow.companyRelevant) {
    markIntakeFailure(failedSteps, 'archive_document', 'Kein Firmenbezug – Übernahme eingeschränkt.');
    const finalized = finalizeInboxIntake(current.id);
    if (finalized) {
      current = finalized;
      markIntakeSuccess(successSteps, 'finalize_inbox');
    }
    return {
      completed: computeSmartIntakeCompleted(workflow, successSteps, failedSteps),
      successSteps,
      failedSteps,
      warnings,
      inboxItem: current,
      vorgangId,
      archiveDocumentId,
      tasksCreated,
      positionsAdded,
      pendingSummary,
    };
  }

  try {
    const archiveOutcome = executeArchiveAtom(
      current,
      options,
      successSteps,
      failedSteps,
      warnings,
    );
    current = archiveOutcome.item;
    archiveDocumentId = archiveOutcome.archiveDocumentId ?? archiveDocumentId;

    const vorgangOutcome = executeVorgangAtom(
      current,
      workflow,
      options,
      successSteps,
      failedSteps,
    );
    current = vorgangOutcome.item;
    vorgangId = vorgangOutcome.vorgangId ?? current.vorgangId;

    // Confirm-first: never silently persist suggestedOrderPositions.
    if (workflow.suggestedOrderPositions.length > 0) {
      pushIntakeWarning(
        warnings,
        'positions_need_confirmation',
        'Erkannte Leistungspositionen warten auf Ihre Bestätigung und wurden noch nicht übernommen.',
      );
      positionsAdded = 0;
    }

    executeContractFieldsAtom(vorgangId, workflow, successSteps, failedSteps);

    tasksCreated = executeAcceptTasksAtom(workflow, successSteps, failedSteps);

    pendingSummary = executeRefreshPendingAtom(options, successSteps);

    current = executeFinalizeInboxAtom(current, successSteps, failedSteps);
  } catch (error) {
    markIntakeFailure(
      failedSteps,
      'finalize_inbox',
      error instanceof Error ? error.message : 'Unbekannter Fehler bei der Übernahme.',
    );
  }

  return {
    completed: computeSmartIntakeCompleted(workflow, successSteps, failedSteps),
    successSteps,
    failedSteps,
    warnings,
    inboxItem: current,
    vorgangId,
    archiveDocumentId,
    tasksCreated,
    positionsAdded,
    pendingSummary,
  };
}

/**
 * Central expense-runner eligibility (adapter only).
 * Same suggestedVorgang truthiness as executeVorgangAtom / wouldLinkVorgangOnSmartIntake:
 * if Legacy would attempt a link, stay on Legacy — runner has no link_vorgang scope.
 */
function shouldUseExpensePlanRunner(
  workflow: WorkflowResult,
  playbookId: string | undefined,
  item: InboxItem,
): boolean {
  if (!getOperationalExecutionRunnerEnabled()) return false;
  if (!workflow.companyRelevant) return false;
  if (!playbookId) return false;
  if (!(isOperationalExecutionRunnerPlaybook(playbookId) && playbookId === 'expense')) {
    return false;
  }
  // Expense + linkable suggested Vorgang → full Legacy (preserve link parity).
  if (wouldLinkVorgangOnSmartIntake(workflow, item)) return false;
  return true;
}

/**
 * Sole productive entry for Primary confirm.
 * Chooses runner OR legacy before any side effects — never both in one call.
 */
export function executeSmartIntake(
  workflow: WorkflowResult,
  options: SmartIntakeExecutionOptions = {},
): WorkflowResultExecution {
  const item = getInboxItemById(workflow.inboxItemId);
  if (!item) {
    return {
      completed: false,
      successSteps: [],
      failedSteps: [{ step: 'finalize_inbox', message: 'Inbox-Dokument nicht gefunden.' }],
      warnings: [...workflow.warnings],
      inboxItem: null,
      tasksCreated: 0,
      positionsAdded: 0,
      pendingSummary: null,
    };
  }

  const plan = buildOperationalExecutionPlan(workflow, { inboxItem: item });

  // Decide path before side effects — never start runner then fall back to legacy.
  if (shouldUseExpensePlanRunner(workflow, plan?.playbookId, item) && plan) {
    return runOperationalExecutionPlan({
      plan,
      workflow,
      inboxItem: item,
      options,
    });
  }

  return executeLegacySmartIntakeSequence(workflow, item, options);
}
