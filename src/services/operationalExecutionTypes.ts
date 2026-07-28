/**
 * OPERATIONAL-EXECUTION-PLAN-01 — read-only plan types (no execution).
 */
import type {
  BusinessDeadlineType,
  BusinessMeaningKind,
  BusinessPrimaryCase,
} from '../types/businessInterpretation';
import type { ClassifiedDocumentKind } from '../types/models';

export type OperationalPlaybookId =
  | 'contract'
  | 'invoice'
  | 'authority'
  | 'communication'
  | 'expense'
  | 'general_document';

export type OperationalExecutionStepId =
  | 'archive_document'
  | 'link_vorgang'
  | 'create_vorgang'
  | 'apply_contract_fields'
  | 'accept_tasks'
  | 'finalize_inbox'
  | 'import_positions'
  | 'reply_handoff'
  | 'review_document'
  | 'open_invoice_workflow';

export type OperationalExecutionStepStatus =
  | 'ready'
  | 'needs_extra_confirm'
  | 'blocked'
  | 'skip';

export type OperationalForbiddenActionId =
  | 'auto_send'
  | 'auto_payment'
  | 'auto_customer_create'
  | 'auto_invoice_finalize'
  | 'auto_position_import';

export type OperationalExecutionStep = {
  id: OperationalExecutionStepId;
  status: OperationalExecutionStepStatus;
  reasonCode?: string;
  confirmRequirement?: string;
  source?: 'playbook' | 'workflow_gate' | 'confirm_first';
};

export type OperationalExecutionPlan = {
  playbookId: OperationalPlaybookId;
  primaryCase: BusinessPrimaryCase;
  steps: OperationalExecutionStep[];
  forbiddenActions: OperationalForbiddenActionId[];
  warnings: string[];
};

export type OperationalExecutionContext = {
  primaryCase: BusinessPrimaryCase;
  meanings: BusinessMeaningKind[];
  deadlineType?: BusinessDeadlineType;
  companyRelevant: boolean;
  alreadyArchived: boolean;
  hasVorgangLink: boolean;
  hasSuggestedVorgang: boolean;
  hasSuggestedTasks: boolean;
  hasContractAnalysis: boolean;
  /** True when contractAnalysis has non-empty fields (legacy apply gate). */
  hasApplyableContractFields: boolean;
  hasContractOrderProposal: boolean;
  hasSuggestedPositions: boolean;
  /** Existing ContractProposal panel or intake positions confirm UI. */
  hasPositionsConfirmUi: boolean;
  /** Mirrors canCreateVorgangFromSmartIntakeGates. */
  canCreateVorgang: boolean;
  /** Mirrors wouldApplyContractFieldsOnSmartIntake. */
  wouldApplyContractFields: boolean;
  hasMoney: boolean;
  recognitionUncertain: boolean;
  missingInformationCount: number;
  conflictCount: number;
  requiredConfirmationIds: string[];
  classifiedKind: ClassifiedDocumentKind;
  /** Existing classification processType when present — not re-derived. */
  processType?: string;
  documentType?: string;
};
