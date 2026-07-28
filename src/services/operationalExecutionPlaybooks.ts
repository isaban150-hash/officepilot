/**
 * OPERATIONAL-EXECUTION-PLAN-01 — declarative playbook policies (data only).
 * No business conditionals; no functions with fachliche if-logic.
 */
import type {
  OperationalExecutionStepId,
  OperationalForbiddenActionId,
  OperationalPlaybookId,
} from './operationalExecutionTypes';

export type OperationalPlaybookDefinition = {
  id: OperationalPlaybookId;
  /** Declared step order for this playbook. */
  stepOrder: OperationalExecutionStepId[];
  /** Steps this playbook may ever consider (subset / equal to stepOrder). */
  allowedSteps: OperationalExecutionStepId[];
  /** Always forbidden for this playbook (unioned with global forbids). */
  forbiddenActions: OperationalForbiddenActionId[];
};

const GLOBAL_FORBIDDEN: OperationalForbiddenActionId[] = [
  'auto_send',
  'auto_payment',
  'auto_customer_create',
  'auto_invoice_finalize',
  'auto_position_import',
];

export const OPERATIONAL_PLAYBOOKS: Record<OperationalPlaybookId, OperationalPlaybookDefinition> =
  {
    contract: {
      id: 'contract',
      stepOrder: [
        'archive_document',
        'link_vorgang',
        'create_vorgang',
        'apply_contract_fields',
        'accept_tasks',
        'finalize_inbox',
        'import_positions',
      ],
      allowedSteps: [
        'archive_document',
        'link_vorgang',
        'create_vorgang',
        'apply_contract_fields',
        'accept_tasks',
        'finalize_inbox',
        'import_positions',
      ],
      forbiddenActions: [...GLOBAL_FORBIDDEN],
    },
    invoice: {
      id: 'invoice',
      stepOrder: [
        'archive_document',
        'link_vorgang',
        'accept_tasks',
        'finalize_inbox',
        'open_invoice_workflow',
      ],
      allowedSteps: [
        'archive_document',
        'link_vorgang',
        'accept_tasks',
        'finalize_inbox',
        'open_invoice_workflow',
      ],
      forbiddenActions: [...GLOBAL_FORBIDDEN],
    },
    authority: {
      id: 'authority',
      stepOrder: [
        'archive_document',
        'accept_tasks',
        'finalize_inbox',
        'reply_handoff',
      ],
      allowedSteps: [
        'archive_document',
        'accept_tasks',
        'finalize_inbox',
        'reply_handoff',
      ],
      forbiddenActions: [...GLOBAL_FORBIDDEN],
    },
    communication: {
      id: 'communication',
      stepOrder: [
        'archive_document',
        'link_vorgang',
        'accept_tasks',
        'finalize_inbox',
        'reply_handoff',
      ],
      allowedSteps: [
        'archive_document',
        'link_vorgang',
        'accept_tasks',
        'finalize_inbox',
        'reply_handoff',
      ],
      forbiddenActions: [...GLOBAL_FORBIDDEN],
    },
    expense: {
      id: 'expense',
      stepOrder: ['archive_document', 'accept_tasks', 'finalize_inbox'],
      allowedSteps: ['archive_document', 'accept_tasks', 'finalize_inbox'],
      forbiddenActions: [...GLOBAL_FORBIDDEN],
    },
    general_document: {
      id: 'general_document',
      stepOrder: [
        'review_document',
        'archive_document',
        'accept_tasks',
        'finalize_inbox',
      ],
      allowedSteps: [
        'review_document',
        'archive_document',
        'accept_tasks',
        'finalize_inbox',
      ],
      forbiddenActions: [...GLOBAL_FORBIDDEN],
    },
  };
