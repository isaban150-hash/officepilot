/**
 * OPERATIONAL-EXECUTION-PLAN-01 — deterministic read-only plan builder (shadow only).
 * Does not call executeSmartIntake or mutate stores.
 *
 * FIX-01: Visible preview is filtered to Legacy-primary parity + real extra-confirm UIs.
 */
import type { TranslationKey } from '../i18n';
import type { BusinessPrimaryCase } from '../types/businessInterpretation';
import type { InboxItem, WorkflowResult } from '../types/models';
import { isConfirmedReplyDraftSupported } from './documentConfirmedReplyDraftService';
import {
  buildOperationalExecutionContext,
  type OperationalExecutionContextOptions,
} from './operationalExecutionContext';
import { OPERATIONAL_PLAYBOOKS } from './operationalExecutionPlaybooks';
import type {
  OperationalExecutionContext,
  OperationalExecutionPlan,
  OperationalExecutionStep,
  OperationalExecutionStepId,
  OperationalForbiddenActionId,
  OperationalPlaybookId,
} from './operationalExecutionTypes';

const STEP_LABEL_KEYS: Record<OperationalExecutionStepId, TranslationKey> = {
  archive_document: 'operationalExecution.step.archive_document',
  link_vorgang: 'operationalExecution.step.link_vorgang',
  create_vorgang: 'operationalExecution.step.create_vorgang',
  apply_contract_fields: 'operationalExecution.step.apply_contract_fields',
  accept_tasks: 'operationalExecution.step.accept_tasks',
  finalize_inbox: 'operationalExecution.step.finalize_inbox',
  import_positions: 'operationalExecution.step.import_positions',
  reply_handoff: 'operationalExecution.step.reply_handoff',
  review_document: 'operationalExecution.step.review_document',
  open_invoice_workflow: 'operationalExecution.step.open_invoice_workflow',
};

const BASE_FORBIDDEN: OperationalForbiddenActionId[] = [
  'auto_send',
  'auto_payment',
  'auto_customer_create',
  'auto_invoice_finalize',
  'auto_position_import',
];

const CONTRACT_CASES = new Set<BusinessPrimaryCase>([
  'contract_proposed',
  'possible_new_order',
  'order_confirmed',
  'service_change_proposed',
  'business_case_update',
]);

const AUTHORITY_CASES = new Set<BusinessPrimaryCase>([
  'authority_documents_required',
  'authority_information',
  'authority_payment',
]);

const COMMUNICATION_CASES = new Set<BusinessPrimaryCase>([
  'communication_request',
  'communication_information',
  'communication_schedule_change',
]);

const EXPENSE_CASES = new Set<BusinessPrimaryCase>(['expense_hotel', 'expense_general']);

const INVOICE_CASES = new Set<BusinessPrimaryCase>([
  'invoice_received',
  'invoice_created',
  'payment_reminder_received',
]);

/**
 * PrimaryCase → playbook. Uses existing operational case only (no reclassification).
 */
export function selectOperationalPlaybook(
  context: OperationalExecutionContext,
): OperationalPlaybookId {
  const { primaryCase } = context;

  if (CONTRACT_CASES.has(primaryCase)) return 'contract';
  if (EXPENSE_CASES.has(primaryCase)) return 'expense';
  if (INVOICE_CASES.has(primaryCase)) return 'invoice';
  if (AUTHORITY_CASES.has(primaryCase)) return 'authority';
  if (COMMUNICATION_CASES.has(primaryCase)) return 'communication';

  return 'general_document';
}

function evaluateStep(
  stepId: OperationalExecutionStepId,
  playbookId: OperationalPlaybookId,
  context: OperationalExecutionContext,
): OperationalExecutionStep {
  switch (stepId) {
    case 'archive_document': {
      if (context.alreadyArchived) {
        return { id: stepId, status: 'skip', reasonCode: 'already_archived', source: 'workflow_gate' };
      }
      if (!context.companyRelevant) {
        return {
          id: stepId,
          status: 'blocked',
          reasonCode: 'company_not_relevant',
          source: 'workflow_gate',
        };
      }
      return { id: stepId, status: 'ready', source: 'playbook' };
    }
    case 'link_vorgang': {
      if (context.hasVorgangLink) {
        return { id: stepId, status: 'skip', reasonCode: 'already_linked', source: 'workflow_gate' };
      }
      if (context.hasSuggestedVorgang && context.companyRelevant) {
        return { id: stepId, status: 'ready', source: 'workflow_gate' };
      }
      return { id: stepId, status: 'skip', reasonCode: 'no_suggested_vorgang', source: 'workflow_gate' };
    }
    case 'create_vorgang': {
      if (playbookId !== 'contract') {
        return { id: stepId, status: 'skip', reasonCode: 'not_in_playbook_intent', source: 'playbook' };
      }
      if (context.hasVorgangLink) {
        return { id: stepId, status: 'skip', reasonCode: 'already_linked', source: 'workflow_gate' };
      }
      if (context.hasSuggestedVorgang) {
        return { id: stepId, status: 'skip', reasonCode: 'prefer_link', source: 'workflow_gate' };
      }
      // Legacy parity: same as canCreateVorgangFromSmartIntakeGates (no proposal-alone).
      if (context.canCreateVorgang) {
        return { id: stepId, status: 'ready', source: 'workflow_gate' };
      }
      return {
        id: stepId,
        status: 'blocked',
        reasonCode: 'vorgang_gates_unmet',
        source: 'workflow_gate',
      };
    }
    case 'apply_contract_fields': {
      if (playbookId !== 'contract') {
        return { id: stepId, status: 'skip', reasonCode: 'not_contract', source: 'playbook' };
      }
      // Legacy parity: contractAnalysis + fields + vorgang path — not proposal alone.
      if (context.wouldApplyContractFields) {
        return { id: stepId, status: 'ready', source: 'workflow_gate' };
      }
      return { id: stepId, status: 'skip', reasonCode: 'no_contract_fields', source: 'workflow_gate' };
    }
    case 'accept_tasks': {
      if (context.companyRelevant && context.hasSuggestedTasks) {
        return { id: stepId, status: 'ready', source: 'workflow_gate' };
      }
      return { id: stepId, status: 'skip', reasonCode: 'no_suggested_tasks', source: 'workflow_gate' };
    }
    case 'finalize_inbox': {
      // Primary CTA only when companyRelevant — match reachable Legacy path.
      if (!context.companyRelevant) {
        return {
          id: stepId,
          status: 'skip',
          reasonCode: 'company_not_relevant',
          source: 'workflow_gate',
        };
      }
      return { id: stepId, status: 'ready', source: 'playbook' };
    }
    case 'import_positions': {
      if (!context.hasSuggestedPositions) {
        return { id: stepId, status: 'skip', reasonCode: 'no_positions', source: 'workflow_gate' };
      }
      return {
        id: stepId,
        status: 'needs_extra_confirm',
        confirmRequirement: 'positions_selection',
        reasonCode: 'confirm_first_positions',
        source: 'confirm_first',
      };
    }
    case 'reply_handoff': {
      if (playbookId !== 'authority' && playbookId !== 'communication') {
        return { id: stepId, status: 'skip', reasonCode: 'not_reply_playbook', source: 'playbook' };
      }
      return {
        id: stepId,
        status: 'needs_extra_confirm',
        confirmRequirement: 'reply_draft',
        reasonCode: 'confirm_first_reply',
        source: 'confirm_first',
      };
    }
    case 'review_document': {
      // Future architecture only — not a productive execution step.
      if (playbookId !== 'general_document') {
        return { id: stepId, status: 'skip', reasonCode: 'not_general', source: 'playbook' };
      }
      return { id: stepId, status: 'ready', source: 'playbook' };
    }
    case 'open_invoice_workflow': {
      // Future architecture only — no primary UI bridge yet.
      if (playbookId !== 'invoice') {
        return { id: stepId, status: 'skip', reasonCode: 'not_invoice', source: 'playbook' };
      }
      return {
        id: stepId,
        status: 'needs_extra_confirm',
        confirmRequirement: 'invoice_workflow',
        reasonCode: 'confirm_first_invoice_ui',
        source: 'confirm_first',
      };
    }
    default: {
      const _exhaustive: never = stepId;
      return { id: _exhaustive, status: 'skip', reasonCode: 'unknown_step', source: 'playbook' };
    }
  }
}

function buildWarnings(context: OperationalExecutionContext): string[] {
  const warnings: string[] = [];
  if (context.recognitionUncertain) warnings.push('recognition_uncertain');
  if (context.missingInformationCount > 0) warnings.push('missing_information');
  if (context.conflictCount > 0) warnings.push('conflicts');
  return warnings;
}

export function buildOperationalExecutionPlanFromContext(
  context: OperationalExecutionContext,
): OperationalExecutionPlan {
  const playbookId = selectOperationalPlaybook(context);
  const playbook = OPERATIONAL_PLAYBOOKS[playbookId];
  const steps = playbook.stepOrder.map((stepId) => evaluateStep(stepId, playbookId, context));

  const forbiddenActions = Array.from(
    new Set<OperationalForbiddenActionId>([...BASE_FORBIDDEN, ...playbook.forbiddenActions]),
  );

  return {
    playbookId,
    primaryCase: context.primaryCase,
    steps,
    forbiddenActions,
    warnings: buildWarnings(context),
  };
}

/**
 * Shadow-safe plan from a workflow. No side effects.
 */
export function buildOperationalExecutionPlan(
  workflow: WorkflowResult,
  options?: OperationalExecutionContextOptions,
): OperationalExecutionPlan | null {
  const context = buildOperationalExecutionContext(workflow, options);
  if (!context) return null;
  return buildOperationalExecutionPlanFromContext(context);
}

export type OperationalExecutionPlanPreviewRow = {
  stepId: OperationalExecutionStepId;
  status: 'ready' | 'needs_extra_confirm' | 'blocked';
  labelKey: TranslationKey;
  hintKey?: TranslationKey;
};

export type OperationalExecutionPreviewSurface = {
  /** Existing Document Assist reply-draft support for this inbox item. */
  replyAssistAvailable: boolean;
  /** Contract proposal panel or intake positions confirm UI reachable. */
  positionsConfirmAvailable: boolean;
};

export type OperationalExecutionPreview = {
  titleKey: TranslationKey;
  hintKey?: TranslationKey;
  rows: OperationalExecutionPlanPreviewRow[];
};

const PRIMARY_READY_STEPS = new Set<OperationalExecutionStepId>([
  'archive_document',
  'link_vorgang',
  'create_vorgang',
  'apply_contract_fields',
  'accept_tasks',
  'finalize_inbox',
]);

/**
 * Defensive UI preview: only Legacy-primary-ready steps + real extra-confirm surfaces.
 * Category C (future / unbound) steps stay in the internal plan but are hidden here.
 */
export function buildOperationalExecutionPreview(
  plan: OperationalExecutionPlan,
  context: OperationalExecutionContext,
  surface: OperationalExecutionPreviewSurface,
): OperationalExecutionPreview {
  const rows: OperationalExecutionPlanPreviewRow[] = [];

  for (const step of plan.steps) {
    if (step.status === 'skip') continue;

    // Category C — never show in productive preview.
    if (step.id === 'review_document' || step.id === 'open_invoice_workflow') {
      continue;
    }

    if (step.status === 'blocked') {
      // Only surface the company-relevance blocker for archive (user-relevant).
      if (step.id === 'archive_document' && step.reasonCode === 'company_not_relevant') {
        rows.push({
          stepId: step.id,
          status: 'blocked',
          labelKey: STEP_LABEL_KEYS[step.id],
          hintKey: 'operationalExecution.hint.companyNotRelevant',
        });
      }
      continue;
    }

    if (step.status === 'needs_extra_confirm') {
      if (step.id === 'import_positions') {
        if (!surface.positionsConfirmAvailable || !context.hasPositionsConfirmUi) continue;
        rows.push({
          stepId: step.id,
          status: 'needs_extra_confirm',
          labelKey: STEP_LABEL_KEYS[step.id],
          hintKey: 'operationalExecution.hint.needsExtraConfirm',
        });
        continue;
      }
      if (step.id === 'reply_handoff') {
        if (!surface.replyAssistAvailable) continue;
        rows.push({
          stepId: step.id,
          status: 'needs_extra_confirm',
          labelKey: STEP_LABEL_KEYS[step.id],
          hintKey: 'operationalExecution.hint.needsExtraConfirm',
        });
        continue;
      }
      continue;
    }

    // ready — only steps the current primary Legacy path can execute.
    if (step.status === 'ready' && PRIMARY_READY_STEPS.has(step.id)) {
      rows.push({
        stepId: step.id,
        status: 'ready',
        labelKey: STEP_LABEL_KEYS[step.id],
      });
    }
  }

  const hasExtra = rows.some((row) => row.status === 'needs_extra_confirm');
  return {
    // Defensive title: list may mix primary-ready and separate confirms.
    titleKey: 'operationalExecution.preview.title',
    hintKey: hasExtra
      ? 'operationalExecution.preview.hintWithExtra'
      : 'operationalExecution.preview.hint',
    rows,
  };
}

/** @deprecated Prefer buildOperationalExecutionPreview. */
export function buildOperationalExecutionPlanPreviewRows(
  plan: OperationalExecutionPlan,
  context?: OperationalExecutionContext,
  surface?: OperationalExecutionPreviewSurface,
): OperationalExecutionPlanPreviewRow[] {
  if (!context || !surface) return [];
  return buildOperationalExecutionPreview(plan, context, surface).rows;
}

export function resolveOperationalExecutionPreviewSurface(
  workflow: WorkflowResult,
  inboxItem?: Pick<
    InboxItem,
    'vorgangId' | 'importedToArchive' | 'documentType' | 'classifiedKind'
  > | null,
): OperationalExecutionPreviewSurface {
  const replyAssistAvailable = inboxItem
    ? isConfirmedReplyDraftSupported({
        ...inboxItem,
        // Support check only reads classifiedKind / documentType.
      } as InboxItem)
    : false;
  const positionsConfirmAvailable =
    Boolean(workflow.contractOrderProposal) || workflow.suggestedOrderPositions.length > 0;
  return { replyAssistAvailable, positionsConfirmAvailable };
}

export function buildOperationalExecutionPlanForInbox(
  workflow: WorkflowResult,
  inboxItem: Pick<InboxItem, 'vorgangId' | 'importedToArchive' | 'documentType' | 'classifiedKind'>,
): OperationalExecutionPlan | null {
  return buildOperationalExecutionPlan(workflow, { inboxItem });
}
