/**
 * OPERATIONAL-EXECUTION-RUNNER-01A — plan-driven orchestration over shared intake atoms.
 * Productive side effects only from allowlisted `ready` steps.
 * Narrow archive already_archived skip: idempotent no-op for Legacy result parity only.
 */
import type {
  InboxItem,
  WorkflowExecutionFailure,
  WorkflowExecutionStepId,
  WorkflowResult,
  WorkflowResultExecution,
  WorkflowWarning,
} from '../types/models';
import {
  computeSmartIntakeCompleted,
  executeAcceptTasksAtom,
  executeArchiveAtom,
  executeFinalizeInboxAtom,
  executeRefreshPendingAtom,
  markIntakeFailure,
  pushIntakeWarning,
  type SmartIntakeAtomOptions,
} from './intakeExecutionAtoms';
import type {
  OperationalExecutionPlan,
  OperationalExecutionStepId,
} from './operationalExecutionTypes';

/** Temporary migration allowlist — not a classification. */
export const EXPENSE_RUNNER_ALLOWED_READY_STEPS = new Set<OperationalExecutionStepId>([
  'archive_document',
  'accept_tasks',
  'finalize_inbox',
]);

export type RunOperationalExecutionPlanInput = {
  plan: OperationalExecutionPlan;
  workflow: WorkflowResult;
  inboxItem: InboxItem;
  options?: SmartIntakeAtomOptions;
};

const inFlightInboxIds = new Set<string>();

export function isOperationalExecutionRunnerInFlight(inboxItemId: string): boolean {
  return inFlightInboxIds.has(inboxItemId);
}

/**
 * Single allowlist gate for expense runner: every `ready` step must be allowlisted.
 * Non-ready statuses are ignored here (handled in the execution loop).
 */
export function findDisallowedExpenseRunnerReadySteps(
  plan: OperationalExecutionPlan,
): OperationalExecutionStepId[] {
  const disallowed: OperationalExecutionStepId[] = [];
  for (const step of plan.steps) {
    if (step.status !== 'ready') continue;
    if (!EXPENSE_RUNNER_ALLOWED_READY_STEPS.has(step.id)) {
      disallowed.push(step.id);
    }
  }
  return disallowed;
}

function emptyExecutionShell(
  workflow: WorkflowResult,
  item: InboxItem,
  failedSteps: WorkflowExecutionFailure[],
): WorkflowResultExecution {
  return {
    completed: false,
    successSteps: [],
    failedSteps,
    warnings: [...workflow.warnings],
    inboxItem: item,
    vorgangId: item.vorgangId,
    archiveDocumentId: item.archiveDocumentId,
    tasksCreated: 0,
    positionsAdded: 0,
    pendingSummary: workflow.pendingSummary,
  };
}

/**
 * Executes allowlisted ready plan steps for the expense cutover scope.
 * Does not call legacy orchestration. Never executes needs_extra_confirm.
 */
export function runOperationalExecutionPlan(
  input: RunOperationalExecutionPlanInput,
): WorkflowResultExecution {
  const { plan, workflow, options = {} } = input;
  const successSteps: WorkflowExecutionStepId[] = [];
  const failedSteps: WorkflowExecutionFailure[] = [];
  const warnings: WorkflowWarning[] = [...workflow.warnings];

  let item = input.inboxItem;
  let archiveDocumentId = item.archiveDocumentId;
  let vorgangId = item.vorgangId;
  let tasksCreated = 0;
  let positionsAdded = 0;
  let pendingSummary = workflow.pendingSummary;
  let pendingRefreshDone = false;

  const lockId = item.id;
  if (inFlightInboxIds.has(lockId)) {
    return emptyExecutionShell(workflow, item, [
      {
        step: 'finalize_inbox',
        message: 'Übernahme läuft bereits für dieses Dokument.',
      },
    ]);
  }

  // Allowlist + playbook gates before lock and before any productive atom.
  if (plan.playbookId !== 'expense') {
    return emptyExecutionShell(workflow, item, [
      {
        step: 'finalize_inbox',
        message: `Runner-Scope unterstützt Playbook „${plan.playbookId}“ in diesem Sprint nicht.`,
      },
    ]);
  }

  const disallowedReady = findDisallowedExpenseRunnerReadySteps(plan);
  if (disallowedReady.length > 0) {
    const first = disallowedReady[0];
    return emptyExecutionShell(workflow, item, [
      {
        step: mapOperationalStepToExecutionId(first),
        message: `Plan enthält nicht freigegebene ready-Steps („${first}“) und wurde nicht ausgeführt.`,
      },
    ]);
  }

  inFlightInboxIds.add(lockId);

  try {
    for (const step of plan.steps) {
      // Confirm-first / blocked: never execute.
      if (step.status === 'needs_extra_confirm' || step.status === 'blocked') {
        continue;
      }

      // Narrow Legacy-parity no-op only: already-archived archive may mark success without re-import.
      // Other skip statuses are ignored and never run productive atoms.
      if (step.status === 'skip') {
        if (step.id === 'archive_document' && step.reasonCode === 'already_archived') {
          const archiveOutcome = executeArchiveAtom(
            item,
            options,
            successSteps,
            failedSteps,
            warnings,
          );
          item = archiveOutcome.item;
          archiveDocumentId = archiveOutcome.archiveDocumentId ?? archiveDocumentId;
        }
        continue;
      }

      if (step.status !== 'ready') {
        continue;
      }

      // Prevalidated: only allowlisted ready steps reach here.
      if (step.id === 'archive_document') {
        const archiveOutcome = executeArchiveAtom(
          item,
          options,
          successSteps,
          failedSteps,
          warnings,
        );
        item = archiveOutcome.item;
        archiveDocumentId = archiveOutcome.archiveDocumentId ?? archiveDocumentId;
        continue;
      }

      if (step.id === 'accept_tasks') {
        tasksCreated = executeAcceptTasksAtom(workflow, successSteps, failedSteps);
        continue;
      }

      if (step.id === 'finalize_inbox') {
        // Legacy order: pending refresh immediately before finalize.
        if (!pendingRefreshDone) {
          pendingSummary = executeRefreshPendingAtom(options, successSteps);
          pendingRefreshDone = true;
        }
        item = executeFinalizeInboxAtom(item, successSteps, failedSteps);
        continue;
      }
    }

    // If finalize was not ready / not in plan but company path expected pending+finalize,
    // do not invent finalize — only refresh if we executed at least one atom and never finalized.
    // Expense plans always include finalize_inbox as ready when companyRelevant.
    if (!pendingRefreshDone && successSteps.length > 0 && !successSteps.includes('finalize_inbox')) {
      pendingSummary = executeRefreshPendingAtom(options, successSteps);
      pendingRefreshDone = true;
    }

    // Confirm-first: never import positions (expense should not have them; warn if present).
    if (workflow.suggestedOrderPositions.length > 0) {
      pushIntakeWarning(
        warnings,
        'positions_need_confirmation',
        'Erkannte Leistungspositionen warten auf Ihre Bestätigung und wurden noch nicht übernommen.',
      );
      positionsAdded = 0;
    }

    return buildResult();
  } catch (error) {
    markIntakeFailure(
      failedSteps,
      'finalize_inbox',
      error instanceof Error ? error.message : 'Unbekannter Fehler bei der Übernahme.',
    );
    return buildResult();
  } finally {
    inFlightInboxIds.delete(lockId);
  }

  function buildResult(): WorkflowResultExecution {
    return {
      completed: computeSmartIntakeCompleted(workflow, successSteps, failedSteps),
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
}

function mapOperationalStepToExecutionId(
  stepId: OperationalExecutionStepId | string,
): WorkflowExecutionStepId {
  switch (stepId) {
    case 'archive_document':
    case 'link_vorgang':
    case 'create_vorgang':
    case 'apply_contract_fields':
    case 'accept_tasks':
    case 'finalize_inbox':
    case 'import_positions':
      return stepId;
    case 'reply_handoff':
    case 'review_document':
    case 'open_invoice_workflow':
    default:
      return 'finalize_inbox';
  }
}
