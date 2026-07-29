/**
 * INGRESS-OPERATIONAL-OVERVIEW-01 — compact operational reading for ingress.
 * Read-only view over Business Interpretation; no execution / persistence.
 */
import type { TranslationKey } from '../i18n';
import type {
  BusinessDeadlineType,
  BusinessInterpretationResult,
  BusinessMeaningKind,
  BusinessPrimaryCase,
  BusinessSignatureStatus,
  BusinessStructuredCondition,
  BusinessStructuredPosition,
} from '../types/businessInterpretation';
import type { ClassifiedDocumentKind, InboxItem, WorkflowResult } from '../types/models';
import { buildOperationalExecutionContext } from './operationalExecutionContext';
import {
  buildOperationalExecutionPlanFromContext,
  buildOperationalExecutionPreview,
  resolveOperationalExecutionPreviewSurface,
  type OperationalExecutionPlanPreviewRow,
} from './operationalExecutionPlanService';

export type OperationalOverviewDetailRow = {
  id: string;
  labelKey: TranslationKey;
  /** Plain display value when already human-readable. */
  value?: string;
  /** i18n key for enum-like values (e.g. signature status). */
  valueKey?: TranslationKey;
  testId: string;
};

export type OperationalOverviewPositionRow = {
  id: string;
  description: string;
  quantityLabel?: string;
};

export type OperationalOverviewView = {
  present: boolean;
  titleKey: TranslationKey;
  documentKindLabelKey: TranslationKey;
  primaryCaseLabelKey: TranslationKey;
  primaryCaseId: BusinessPrimaryCase;
  meaningLabelKeys: TranslationKey[];
  sender?: string;
  counterparty?: string;
  ownCompany?: string;
  moneyLabel?: string;
  deadlineTypeLabelKey?: TranslationKey;
  deadlineDate?: string;
  nextStep?: string;
  confirmRequirement?: string;
  uncertaintyLines: string[];
  recognitionUncertain: boolean;
  detailRows: OperationalOverviewDetailRow[];
  positions: OperationalOverviewPositionRow[];
  hasDetails: boolean;
  /** Shadow plan preview — read-only; does not execute. */
  planPreviewTitleKey: TranslationKey;
  planPreviewHintKey?: TranslationKey;
  planPreviewRows: OperationalExecutionPlanPreviewRow[];
};

function classifiedKindKey(kind: ClassifiedDocumentKind): TranslationKey {
  return `classifiedKind.${kind}` as TranslationKey;
}

function primaryCaseLabelKey(primary: BusinessPrimaryCase): TranslationKey {
  return `operationalOverview.primaryCase.${primary}` as TranslationKey;
}

function meaningLabelKey(meaning: BusinessMeaningKind): TranslationKey {
  return `operationalOverview.meaning.${meaning}` as TranslationKey;
}

function deadlineTypeLabelKey(deadline: BusinessDeadlineType): TranslationKey {
  return `operationalOverview.deadlineType.${deadline}` as TranslationKey;
}

function formatMoney(bi: BusinessInterpretationResult): string | undefined {
  const entry = bi.facts.money.find((m) => m.amountFormatted || m.amount != null);
  if (!entry) return undefined;
  if (entry.amountFormatted) return entry.amountFormatted;
  if (entry.amount != null) {
    const currency = entry.currency ?? 'EUR';
    return `${entry.amount.toLocaleString('de-DE')} ${currency}`;
  }
  return entry.label;
}

function pickSender(bi: BusinessInterpretationResult, fallbackSender?: string): string | undefined {
  const fromFacts =
    bi.facts.parties.counterparty?.relation === 'counterparty'
      ? bi.facts.parties.counterparty.name
      : undefined;
  const fromParties = bi.parties.find((p) => p.role === 'counterparty' || p.role === 'unknown')?.name;
  return fromFacts || fromParties || fallbackSender || undefined;
}

function pickCounterparty(bi: BusinessInterpretationResult): string | undefined {
  return bi.facts.parties.counterparty?.name;
}

function pickOwnCompany(bi: BusinessInterpretationResult): string | undefined {
  return bi.facts.parties.ownCompany?.name;
}

function conditionLabelKey(type: BusinessStructuredCondition['type']): TranslationKey {
  return `operationalOverview.condition.${type}` as TranslationKey;
}

function signatureStatusLabelKey(status: BusinessSignatureStatus): TranslationKey {
  return `operationalOverview.signatureStatus.${status}` as TranslationKey;
}

/** Reject technical/enum-like hints so they never leak into the UI. */
function isHumanReadablePartyHint(hint: string | undefined): hint is string {
  const trimmed = hint?.trim() ?? '';
  if (!trimmed) return false;
  if (/^(unclear|detected|partial|not_detected)$/i.test(trimmed)) return false;
  if (/^[a-z][a-z0-9_]*$/i.test(trimmed) && !/\s/.test(trimmed) && trimmed.length < 24) {
    // Short snake/camel tokens without spaces are not user-facing copy.
    return false;
  }
  return true;
}

function buildDetailRows(bi: BusinessInterpretationResult): OperationalOverviewDetailRow[] {
  const rows: OperationalOverviewDetailRow[] = [];
  const { subject, timeline, conditions, signatures } = bi.facts;

  const push = (id: string, labelKey: TranslationKey, value?: string) => {
    if (!value?.trim()) return;
    rows.push({
      id,
      labelKey,
      value: value.trim(),
      testId: `operational-overview-detail-${id}`,
    });
  };

  push('site', 'operationalOverview.detail.site', subject.site?.value);
  push('project', 'operationalOverview.detail.project', subject.project?.value);
  push('object', 'operationalOverview.detail.object', subject.object?.value);
  push('subject', 'operationalOverview.detail.subject', subject.subject?.value);
  push('start', 'operationalOverview.detail.start', timeline.start?.value);
  push('end', 'operationalOverview.detail.end', timeline.end?.value);
  push('duration', 'operationalOverview.detail.duration', timeline.duration?.value);
  push('contractDate', 'operationalOverview.detail.contractDate', timeline.contractDate?.value);

  for (const condition of conditions.slice(0, 8)) {
    push(
      `condition-${condition.type}-${rows.length}`,
      conditionLabelKey(condition.type),
      condition.summary,
    );
  }

  // Always map statuses in i18n; only surface when recognition found something or a human hint exists.
  if (signatures.status !== 'not_detected' || isHumanReadablePartyHint(signatures.partyHint)) {
    rows.push({
      id: 'signatures',
      labelKey: 'operationalOverview.detail.signatures',
      valueKey: signatureStatusLabelKey(signatures.status),
      value: isHumanReadablePartyHint(signatures.partyHint)
        ? signatures.partyHint.trim()
        : undefined,
      testId: 'operational-overview-detail-signatures',
    });
  }

  return rows;
}

function buildPositions(positions: BusinessStructuredPosition[]): OperationalOverviewPositionRow[] {
  return positions.slice(0, 8).map((position, index) => {
    const qtyParts: string[] = [];
    if (position.quantity != null) qtyParts.push(String(position.quantity));
    if (position.unit) qtyParts.push(position.unit);
    return {
      id: position.id || `pos-${index}`,
      description: position.description,
      quantityLabel: qtyParts.length > 0 ? qtyParts.join(' ') : undefined,
    };
  });
}

function buildUncertainty(bi: BusinessInterpretationResult): string[] {
  const lines: string[] = [];
  for (const gap of bi.missingInformation.slice(0, 3)) {
    lines.push(gap.summary);
  }
  for (const conflict of bi.conflicts.slice(0, 2)) {
    lines.push(conflict.summary);
  }
  return lines;
}

export function buildOperationalOverviewView(
  workflow: WorkflowResult,
  options?: {
    senderFallback?: string;
    inboxItem?: Pick<
      InboxItem,
      'vorgangId' | 'importedToArchive' | 'documentType' | 'classifiedKind'
    > | null;
    /**
     * Resolved BI for display (overlay applied). When omitted, uses workflow.BI.
     * Must never be forwarded to execute/confirm paths.
     */
    displayBusinessInterpretation?: BusinessInterpretationResult | null;
    /** Extra uncertainty lines (e.g. overlay review conflicts). */
    unresolvedConflictLines?: string[];
    /**
     * Plan preview / execution context — live WorkflowResult only.
     * Default true. Set false for snapshot-only display.
     */
    includePlanPreview?: boolean;
  },
): OperationalOverviewView {
  const bi = options?.displayBusinessInterpretation ?? workflow.businessInterpretation;
  if (!bi) {
    return {
      present: false,
      titleKey: 'operationalOverview.title',
      documentKindLabelKey: classifiedKindKey(workflow.classifiedKind),
      primaryCaseLabelKey: 'operationalOverview.primaryCase.review_required',
      primaryCaseId: 'review_required',
      meaningLabelKeys: [],
      uncertaintyLines: [],
      recognitionUncertain: false,
      detailRows: [],
      positions: [],
      hasDetails: false,
      planPreviewTitleKey: 'operationalExecution.preview.title',
      planPreviewRows: [],
    };
  }

  const detailRows = buildDetailRows(bi);
  const positions = buildPositions(bi.facts.positions);
  const deadlineDate = bi.facts.timeline.deadline?.value;
  const includePlanPreview = options?.includePlanPreview !== false;
  const context = includePlanPreview
    ? buildOperationalExecutionContext(workflow, {
        inboxItem: options?.inboxItem,
      })
    : null;
  const shadowPlan = context ? buildOperationalExecutionPlanFromContext(context) : null;
  const preview =
    includePlanPreview && shadowPlan && context
      ? buildOperationalExecutionPreview(
          shadowPlan,
          context,
          resolveOperationalExecutionPreviewSurface(workflow, options?.inboxItem),
        )
      : null;

  const uncertaintyLines = [
    ...(options?.unresolvedConflictLines ?? []),
    ...buildUncertainty(bi),
  ];

  return {
    present: true,
    titleKey: 'operationalOverview.title',
    documentKindLabelKey: classifiedKindKey(bi.sourceDocument.classifiedKind),
    primaryCaseLabelKey: primaryCaseLabelKey(bi.operational.primaryCase),
    primaryCaseId: bi.operational.primaryCase,
    meaningLabelKeys: bi.operational.meanings.map(meaningLabelKey),
    sender: pickSender(bi, options?.senderFallback),
    counterparty: pickCounterparty(bi),
    ownCompany: pickOwnCompany(bi),
    moneyLabel: formatMoney(bi),
    deadlineTypeLabelKey: bi.operational.deadlineType
      ? deadlineTypeLabelKey(bi.operational.deadlineType)
      : undefined,
    deadlineDate,
    nextStep: bi.operational.nextStep?.trim() || undefined,
    confirmRequirement: bi.operational.confirmRequirement?.trim() || undefined,
    uncertaintyLines,
    recognitionUncertain: bi.sourceDocument.recognitionUncertain,
    detailRows,
    positions,
    hasDetails: detailRows.length > 0 || positions.length > 0,
    planPreviewTitleKey: preview?.titleKey ?? 'operationalExecution.preview.title',
    planPreviewHintKey: preview?.hintKey,
    planPreviewRows: preview?.rows ?? [],
  };
}

/**
 * Snapshot / TruthView-only overview (no live plan preview).
 * Display and assist only — never pass result into execute paths.
 */
export function buildOperationalOverviewViewFromTruth(
  truth: {
    businessInterpretation: BusinessInterpretationResult | null;
    unresolvedConflictLines?: string[];
  },
  options?: {
    senderFallback?: string;
    classifiedKindFallback?: ClassifiedDocumentKind;
    inboxItem?: Pick<
      InboxItem,
      'vorgangId' | 'importedToArchive' | 'documentType' | 'classifiedKind'
    > | null;
  },
): OperationalOverviewView {
  const classifiedKind =
    truth.businessInterpretation?.sourceDocument.classifiedKind ??
    options?.classifiedKindFallback ??
    options?.inboxItem?.classifiedKind ??
    'sonstiges';

  const shellWorkflow: WorkflowResult = {
    inboxItemId: truth.businessInterpretation?.sourceDocument.sourceDocumentId ?? '',
    companyRelevant: Boolean(truth.businessInterpretation?.derivedFrom.companyRelevant),
    companyRelevance: {
      isRelevant: Boolean(truth.businessInterpretation?.derivedFrom.companyRelevant),
      reasons: [],
      matchedHints: [],
    },
    classifiedKind,
    classificationConfidence: 'low',
    classification: null,
    documentExplanation: null,
    documentUnderstanding: null,
    documentAiActions: [],
    contractAnalysis: null,
    contractIntelligence: null,
    contractOrderProposal: null,
    suggestedVorgang: null,
    similarVorgaenge: [],
    suggestedOrderPositions: [],
    suggestedTasks: [],
    suggestedArchiveFolder: {
      id: 'snapshot-display',
      name: 'Sonstiges',
      path: 'Sonstiges',
    },
    requiredDocuments: [],
    pendingSummary: null,
    warnings: [],
    nextActions: [],
    businessInterpretation: truth.businessInterpretation,
  };

  return buildOperationalOverviewView(shellWorkflow, {
    senderFallback: options?.senderFallback,
    inboxItem: options?.inboxItem,
    displayBusinessInterpretation: truth.businessInterpretation,
    unresolvedConflictLines: truth.unresolvedConflictLines,
    includePlanPreview: false,
  });
}
