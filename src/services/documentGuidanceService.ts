import type { TranslationKey } from '../i18n';
import {
  t,
} from '../i18n';
import type { OriginalGuidanceStatus } from './documentAssistantService';
import { getDocumentDisplayLabelKey } from './documentDisplayLabelService';
import { buildDocumentAiActions, buildDocumentUnderstandingSummary } from './documentIntakeUnderstandingService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import {
  getLetterExplanation,
  letterExplanationFromWorkflow,
  type LetterExplanation,
} from './letterExplanationService';
import { getCachedSetup } from './persistenceService';
import { formatPaperFilingInstruction, resolvePaperFilingFromInbox } from './paperFolderService';
import { getStorageRecommendationLevelKey } from './storageRecommendationPresentationService';
import { requiresCustomerAssignment } from './documentResultPresentationService';
import { buildDocumentWorkTruthConflictDisplayLines } from './documentWorkResultResolveService';
import { buildDocumentWorkTruthViewForInboxItem } from './documentWorkResultTruthOrchestration';
import { getTaskProposals } from './workflowDecisionUtils';
import type { DocumentFieldFillConfirmRow } from '../types/documentFieldFillConfirm';
import type { StorageRecommendationLevel } from '../types/storageRecommendation';
import type {
  AppLanguage,
  ClassifiedDocumentKind,
  DocumentAiAction,
  InboxItem,
  WorkflowResult,
} from '../types/models';

export interface GuidanceTextBlock {
  key: TranslationKey;
  params?: Record<string, string | number>;
}

export interface DocumentGuidanceAction {
  id: string;
  labelKey: TranslationKey;
}

export interface DocumentGuidanceLine {
  id: string;
  text: string;
}

export interface PrioritizedDocumentGuidance {
  now: DocumentGuidanceLine[];
  missing: DocumentGuidanceLine[];
  inaction: DocumentGuidanceLine[];
  actions: DocumentGuidanceAction[];
  usedWorkflow: boolean;
}

export interface DocumentGuidanceSources {
  assistant: boolean;
  letter: boolean;
  understanding: boolean;
  paper: boolean;
  workflowActions: boolean;
  storage: boolean;
}

/** Single unified guidance composed from existing document services. */
export interface DocumentGuidance {
  what: GuidanceTextBlock;
  whyReceived: GuidanceTextBlock;
  mustAct: GuidanceTextBlock;
  deadline: GuidanceTextBlock;
  mustReply: GuidanceTextBlock;
  retain: GuidanceTextBlock;
  paperFolder: GuidanceTextBlock;
  actions: DocumentGuidanceAction[];
  disclaimerKey: TranslationKey;
  sources: DocumentGuidanceSources;
}

const ORIGINAL_TO_RETAIN: Record<OriginalGuidanceStatus, TranslationKey> = {
  keep: 'docAssistant.original.keep',
  keep_until_tax: 'docAssistant.original.keepUntilTax',
  dispose_after_digital: 'docAssistant.original.disposeAfterDigital',
  uncertain: 'docAssistant.original.uncertain',
};

const ORIGINAL_TO_STORAGE_LEVEL: Record<OriginalGuidanceStatus, StorageRecommendationLevel> = {
  keep: 'archive_recommended',
  keep_until_tax: 'archive_required',
  dispose_after_digital: 'discard_recommended',
  uncertain: 'review_required',
};

const CONTRACT_KINDS = new Set<ClassifiedDocumentKind>([
  'werkvertrag',
  'subunternehmervertrag',
  'nachunternehmervertrag',
]);

const INVOICE_KINDS = new Set<ClassifiedDocumentKind>([
  'eingangsrechnung',
  'rechnung',
  'ausgangsrechnung',
]);

const REPLY_LIKELY_KINDS = new Set<ClassifiedDocumentKind>([
  'mahnung',
  'zahlungserinnerung',
  'finanzamt',
  'steuerbescheid',
  'bg_bau',
  'soka_bau',
]);

function resolveOriginalGuidance(
  item: InboxItem,
  kind: ClassifiedDocumentKind,
): OriginalGuidanceStatus {
  if (item.isAdvertisement) return 'dispose_after_digital';
  if (
    kind === 'freistellungsbescheinigung' ||
    kind === 'lohnabrechnung' ||
    kind === 'kontoauszug'
  ) {
    return 'keep_until_tax';
  }
  if (kind === 'mahnung' || kind === 'zahlungserinnerung' || item.deadline) {
    return 'keep';
  }
  if (item.status === 'abgelegt' || item.importedToArchive) {
    return 'dispose_after_digital';
  }
  return 'uncertain';
}

function resolveKind(item: InboxItem, workflow?: WorkflowResult | null): ClassifiedDocumentKind {
  return (item.classifiedKind ?? workflow?.classifiedKind ?? 'sonstiges') as ClassifiedDocumentKind;
}

function resolveLetter(
  item: InboxItem,
  workflow?: WorkflowResult | null,
): LetterExplanation | null {
  return letterExplanationFromWorkflow(workflow?.documentExplanation) ?? getLetterExplanation(item);
}

function hasDeadlineSignal(
  item: InboxItem,
  understandingDeadline?: string,
  letter?: LetterExplanation | null,
): boolean {
  if (item.deadline || understandingDeadline) return true;
  if (!letter) return false;
  return letter.deadline.key !== 'letter.explain.deadline.none';
}

function buildWhat(
  assistantLabelKey: TranslationKey,
  sender: string,
  letter: LetterExplanation | null,
): GuidanceTextBlock {
  if (letter) {
    return {
      key: 'docGuidance.what.letter',
      params: {
        typeKey: assistantLabelKey,
        sender: sender || '—',
      },
    };
  }
  return {
    key: 'docGuidance.what.typed',
    params: {
      typeKey: assistantLabelKey,
      sender: sender || '—',
    },
  };
}

function buildWhy(
  item: InboxItem,
  kind: ClassifiedDocumentKind,
  letter: LetterExplanation | null,
): GuidanceTextBlock {
  if (item.isAdvertisement) {
    return { key: 'docGuidance.why.advertisement' };
  }
  if (INVOICE_KINDS.has(kind)) {
    return { key: 'docGuidance.why.invoice' };
  }
  if (CONTRACT_KINDS.has(kind) || kind === 'auftrag' || kind === 'angebot') {
    return { key: 'docGuidance.why.contract' };
  }
  if (kind === 'finanzamt' || kind === 'steuerbescheid' || kind === 'bg_bau' || kind === 'soka_bau') {
    return { key: 'docGuidance.why.authority' };
  }
  if (letter) {
    return { key: letter.about.key as TranslationKey, params: letter.about.params };
  }
  return { key: 'docGuidance.why.general' };
}

function buildMustAct(
  item: InboxItem,
  kind: ClassifiedDocumentKind,
  hasDeadline: boolean,
): GuidanceTextBlock {
  if (item.isAdvertisement) {
    return { key: 'docGuidance.act.probablyNot' };
  }
  if (REPLY_LIKELY_KINDS.has(kind) || hasDeadline) {
    return { key: 'docGuidance.act.likely' };
  }
  if (CONTRACT_KINDS.has(kind) || INVOICE_KINDS.has(kind) || kind === 'auftrag') {
    return { key: 'docGuidance.act.likely' };
  }
  return { key: 'docGuidance.act.uncertain' };
}

function buildDeadline(
  item: InboxItem,
  understandingDeadline: string | undefined,
  letter: LetterExplanation | null,
): GuidanceTextBlock {
  const deadline = understandingDeadline ?? item.deadline ?? undefined;
  if (deadline) {
    return {
      key: 'docGuidance.deadline.known',
      params: { deadline },
    };
  }
  if (letter) {
    return { key: letter.deadline.key as TranslationKey, params: letter.deadline.params };
  }
  return { key: 'docGuidance.deadline.unknown' };
}

function buildMustReply(
  item: InboxItem,
  kind: ClassifiedDocumentKind,
  hasDeadline: boolean,
): GuidanceTextBlock {
  if (item.isAdvertisement) {
    return { key: 'docGuidance.reply.probablyNot' };
  }
  if (REPLY_LIKELY_KINDS.has(kind) || hasDeadline) {
    return { key: 'docGuidance.reply.likely' };
  }
  if (CONTRACT_KINDS.has(kind) || INVOICE_KINDS.has(kind)) {
    return { key: 'docGuidance.reply.uncertain' };
  }
  return { key: 'docGuidance.reply.uncertain' };
}

function buildRetain(originalGuidance: OriginalGuidanceStatus): GuidanceTextBlock {
  return {
    key: 'docGuidance.retain.combined',
    params: {
      originalKey: ORIGINAL_TO_RETAIN[originalGuidance],
      storageKey: getStorageRecommendationLevelKey(ORIGINAL_TO_STORAGE_LEVEL[originalGuidance]),
    },
  };
}

function buildPaperFolder(
  skipPhysicalFiling: boolean,
  paperFolderLabel: string,
): GuidanceTextBlock {
  if (skipPhysicalFiling) {
    return { key: 'docGuidance.paper.skip' };
  }
  return {
    key: 'docGuidance.paper.recommended',
    params: { folder: paperFolderLabel || '—' },
  };
}

function asDynamicTextBlock(text: string | undefined, fallback: GuidanceTextBlock): GuidanceTextBlock {
  const trimmed = text?.trim();
  if (!trimmed) return fallback;
  return { key: trimmed as TranslationKey };
}

function pushUniqueLine(lines: DocumentGuidanceLine[], id: string, text: string | undefined): void {
  const normalized = text?.trim();
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (lines.some((line) => line.text.trim().toLowerCase() === key)) return;
  lines.push({ id, text: normalized });
}

function pushUniqueAction(
  actions: DocumentGuidanceAction[],
  seen: Set<string>,
  id: string,
  labelKey: TranslationKey,
): void {
  const seenKey = `${id}::${labelKey}`;
  if (seen.has(seenKey)) return;
  seen.add(seenKey);
  actions.push({ id, labelKey });
}

function translateLabel(labelKey: string | undefined, lang: AppLanguage): string | undefined {
  const trimmed = labelKey?.trim();
  if (!trimmed) return undefined;
  return t(trimmed as TranslationKey, lang);
}

function resolveAssistantSender(
  item: InboxItem,
  workflow: WorkflowResult | null | undefined,
  truthCounterparty?: string,
  understandingSender?: string,
): string {
  return truthCounterparty?.trim() || workflow?.documentUnderstanding?.sender?.trim() || item.sender || understandingSender || '—';
}

export function buildPrioritizedDocumentGuidance(
  item: InboxItem,
  workflow?: WorkflowResult | null,
  lang: AppLanguage = getCachedSetup()?.language ?? 'de',
  options?: { sessionFillConfirmRows?: readonly DocumentFieldFillConfirmRow[] | null },
): PrioritizedDocumentGuidance {
  const truth = buildDocumentWorkTruthViewForInboxItem({
    item,
    liveWorkflow: workflow ?? null,
    sessionFillConfirmRows: options?.sessionFillConfirmRows ?? null,
  });
  const businessInterpretation =
    truth?.businessInterpretation ?? workflow?.businessInterpretation ?? null;
  const workflowDecision = workflow?.workflowDecision ?? null;
  const now: DocumentGuidanceLine[] = [];
  const missing: DocumentGuidanceLine[] = [];
  const inaction: DocumentGuidanceLine[] = [];
  const actions: DocumentGuidanceAction[] = [];
  const seenActions = new Set<string>();
  const taskProposals = workflow ? getTaskProposals(workflow) : [];

  const hasActionSupport =
    (workflowDecision?.nextActions.some((action) => action.enabled && action.id !== 'cancel') ?? false) ||
    taskProposals.length > 0 ||
    (businessInterpretation?.requiredConfirmations.length ?? 0) > 0;

  if (hasActionSupport && businessInterpretation?.operational.nextStep) {
    pushUniqueLine(now, 'operational-next-step', businessInterpretation.operational.nextStep);
  }

  for (const action of workflowDecision?.nextActions ?? workflow?.nextActions ?? []) {
    if (!action.enabled || action.id === 'cancel') continue;
    const label = translateLabel(action.labelKey, lang);
    pushUniqueLine(now, `next-action-${action.id}`, label);
    pushUniqueAction(actions, seenActions, action.id, action.labelKey as TranslationKey);
  }

  for (const proposal of taskProposals) {
    pushUniqueLine(now, `task-${proposal.dedupeKey ?? proposal.title}`, proposal.title);
  }
  if (taskProposals.length > 0) {
    pushUniqueAction(actions, seenActions, 'accept-tasks', 'reviewWorkflow.recommend.acceptTasks');
  }

  for (const entry of businessInterpretation?.missingInformation ?? []) {
    pushUniqueLine(missing, `missing-${entry.id}`, entry.summary);
  }
  for (const entry of businessInterpretation?.requiredConfirmations ?? []) {
    pushUniqueLine(missing, `confirm-${entry.id}`, entry.summary);
  }
  for (const entry of workflow?.requiredDocuments ?? []) {
    pushUniqueLine(missing, `required-doc-${entry.type}`, entry.reason);
  }
  for (const entry of businessInterpretation?.conflicts ?? []) {
    pushUniqueLine(missing, `conflict-${entry.id}`, entry.summary);
  }
  for (const conflictLine of truth ? buildDocumentWorkTruthConflictDisplayLines(truth) : []) {
    pushUniqueLine(missing, `truth-conflict-${conflictLine}`, conflictLine);
  }

  for (const risk of workflowDecision?.risks ?? []) {
    pushUniqueLine(
      inaction,
      `risk-${risk.id}`,
      t(risk.messageKey as TranslationKey, lang, risk.params),
    );
  }

  return {
    now: now.slice(0, 6),
    missing: missing.slice(0, 6),
    inaction: inaction.slice(0, 3),
    actions: actions.slice(0, 6),
    usedWorkflow: Boolean(workflow),
  };
}

function mapAiActionLabel(
  action: DocumentAiAction,
  kind: ClassifiedDocumentKind,
): TranslationKey {
  if (action.id === 'create_order') {
    return CONTRACT_KINDS.has(kind)
      ? 'docGuidance.action.checkContract'
      : 'docGuidance.action.createVorgang';
  }
  if (action.id === 'write_invoice' || INVOICE_KINDS.has(kind)) {
    if (action.id === 'write_invoice') return 'docGuidance.action.checkInvoice';
  }
  if (action.id === 'archive_document') return 'docGuidance.action.archive';
  if (action.id === 'monitor_deadline') return 'reviewWorkflow.recommend.monitorDeadline';
  if (action.id === 'paper_folder') return 'reviewWorkflow.recommend.paperFolder';
  if (action.id === 'tax_advisor_relevant') return 'reviewWorkflow.recommend.taxAdvisor';
  return (action.labelKey as TranslationKey) || 'reviewWorkflow.recommend.reviewDocument';
}

function buildActions(
  item: InboxItem,
  kind: ClassifiedDocumentKind,
  workflow: WorkflowResult | null | undefined,
  understanding: ReturnType<typeof buildDocumentUnderstandingSummary>,
  lang: AppLanguage,
  options?: { sessionFillConfirmRows?: readonly DocumentFieldFillConfirmRow[] | null },
): { actions: DocumentGuidanceAction[]; usedWorkflow: boolean; prioritized: PrioritizedDocumentGuidance } {
  const prioritized = buildPrioritizedDocumentGuidance(item, workflow, lang, options);
  if (prioritized.actions.length > 0) {
    return { actions: prioritized.actions, usedWorkflow: prioritized.usedWorkflow, prioritized };
  }

  const actions: DocumentGuidanceAction[] = [];
  const seen = new Set<string>();
  let usedWorkflow = false;

  const push = (id: string, labelKey: TranslationKey) => {
    if (seen.has(id) || seen.has(labelKey)) return;
    seen.add(id);
    seen.add(labelKey);
    actions.push({ id, labelKey });
  };

  if (item.isAdvertisement) {
    push('dispose', 'reviewWorkflow.recommend.dispose');
    push('archive', 'docGuidance.action.archive');
    return { actions: actions.slice(0, 6), usedWorkflow: Boolean(workflow) };
  }

  if (workflow) {
    usedWorkflow = true;
    for (const action of workflow.documentAiActions) {
      push(action.id, mapAiActionLabel(action, kind));
    }
  } else {
    const aiActions = buildDocumentAiActions(kind, understanding);
    for (const action of aiActions) {
      push(action.id, mapAiActionLabel(action, kind));
    }
  }

  if (INVOICE_KINDS.has(kind)) {
    push('check-invoice', 'docGuidance.action.checkInvoice');
  }
  if (CONTRACT_KINDS.has(kind)) {
    push('check-contract', 'docGuidance.action.checkContract');
    push('negotiate', 'docGuidance.action.negotiatePrice');
  }
  if (
    !item.vorgangId &&
    (kind === 'auftrag' || kind === 'angebot' || CONTRACT_KINDS.has(kind)) &&
    !item.isAdvertisement
  ) {
    push('create-vorgang', 'docGuidance.action.createVorgang');
  }
  if (
    requiresCustomerAssignment(kind) &&
    !understanding.customer &&
    !item.isAdvertisement
  ) {
    push('create-customer', 'docGuidance.action.createCustomer');
  }

  if (actions.length === 0) {
    push('review', 'reviewWorkflow.recommend.reviewDocument');
  }

  return {
    actions: actions.slice(0, 6),
    usedWorkflow,
    prioritized,
  };
}

/**
 * Composes one unified document guidance from existing services.
 * Does not run OCR, classification, or new AI logic.
 */
export function buildDocumentGuidance(
  item: InboxItem,
  workflow?: WorkflowResult | null,
  lang: AppLanguage = getCachedSetup()?.language ?? 'de',
  options?: { sessionFillConfirmRows?: readonly DocumentFieldFillConfirmRow[] | null },
): DocumentGuidance {
  const letter = resolveLetter(item, workflow);
  const recognizedText = getInboxExtractedDocumentText(item);
  const understanding =
    workflow?.documentUnderstanding ??
    buildDocumentUnderstandingSummary(item, {
      recognizedText,
      classification: workflow?.classification ?? undefined,
    });
  const kind = resolveKind(item, workflow);
  const paper = resolvePaperFilingFromInbox(item);

  const truth = buildDocumentWorkTruthViewForInboxItem({
    item,
    liveWorkflow: workflow ?? null,
    sessionFillConfirmRows: options?.sessionFillConfirmRows ?? null,
  });
  const truthCounterparty = truth?.businessInterpretation?.facts.parties.counterparty?.name?.trim();
  const truthDeadline = truth?.businessInterpretation?.facts.timeline.deadline?.value?.trim();
  const understandingDeadline = truthDeadline || understanding.deadline;
  const paperFolderLabel =
    paper.skipPhysicalFiling
      ? '—'
      : paper.rule
        ? formatPaperFilingInstruction(paper.rule, lang)
        : '—';

  const hasDeadline = hasDeadlineSignal(item, understandingDeadline, letter);
  const { actions, usedWorkflow, prioritized } = buildActions(
    item,
    kind,
    workflow,
    understanding,
    lang,
    options,
  );

  return {
    what: buildWhat(
      getDocumentDisplayLabelKey(kind, item.documentType),
      resolveAssistantSender(item, workflow, truthCounterparty, understanding.sender),
      letter,
    ),
    whyReceived: buildWhy(item, kind, letter),
    mustAct: asDynamicTextBlock(
      prioritized.now[0]?.text,
      buildMustAct(item, kind, hasDeadline),
    ),
    deadline: buildDeadline(item, understandingDeadline, letter),
    mustReply: buildMustReply(item, kind, hasDeadline),
    retain: buildRetain(resolveOriginalGuidance(item, kind)),
    paperFolder: buildPaperFolder(paper.skipPhysicalFiling, paperFolderLabel),
    actions,
    disclaimerKey: letter?.legalDisclaimerKey ?? 'legal.disclaimer',
    sources: {
      assistant: true,
      letter: Boolean(letter),
      understanding: true,
      paper: true,
      workflowActions: usedWorkflow || Boolean(workflow?.documentAiActions?.length),
      storage: true,
    },
  };
}

/** Soft-language / consistency checks for tests and UI guardrails. */
export function guidanceHasSoftWording(translatedAnswers: string[]): boolean {
  const joined = translatedAnswers.join(' ').toLowerCase();
  const softMarkers = [
    'empfehlung',
    'wahrscheinlich',
    'bitte prüfen',
    'möglicherweise',
    'vermutlich',
    'optional',
    'kann',
  ];
  return softMarkers.some((marker) => joined.includes(marker));
}

export function guidanceIsInternallyConsistent(guidance: DocumentGuidance): boolean {
  if (guidance.mustAct.key === 'docGuidance.act.probablyNot') {
    if (guidance.mustReply.key === 'docGuidance.reply.likely') return false;
  }
  if (guidance.paperFolder.key === 'docGuidance.paper.skip') {
    if (guidance.retain.key === 'docGuidance.retain.combined') {
      const storageKey = guidance.retain.params?.storageKey;
      if (storageKey === 'storageRecommendation.level.archive_required') return false;
    }
  }
  return true;
}
