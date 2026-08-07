import type { TranslationKey } from '../i18n';
import { t } from '../i18n';
import { isDatevRelevantKind } from './brain/financeIntelligenceService';
import { buildPrioritizedDocumentGuidance } from './documentGuidanceService';
import {
  formatDigitalFolderBreadcrumb,
  getDocumentDisplayLabelKey,
} from './documentDisplayLabelService';
import { buildDocumentUnderstandingSummary } from './documentIntakeUnderstandingService';
import {
  buildPresentationContext,
  getBriefLineKeyForKind,
  recognitionStatusKey,
  requiresCustomerAssignment,
  resolvePresentationCustomer,
  resolveRecognitionStatus,
  resolveSteuerberaterPresentation,
  type RecognitionStatus,
  type SteuerberaterRelevanceStatus,
} from './documentResultPresentationService';
import { getLetterExplanation } from './letterExplanationService';
import { buildDocumentNarrative } from './documentNarrativeService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import { resolvePaperFiling } from './paperFolderService';
import { formatPaperFilingInstruction } from './paperFolderDisplayService';
import { getCachedSetup } from './persistenceService';
import type { DocumentFieldFillConfirmRow } from '../types/documentFieldFillConfirm';
import type { AppLanguage, ClassifiedDocumentKind, InboxItem, WorkflowResult } from '../types/models';
import {
  buildDocumentWorkTruthAssistContextLines,
} from './documentWorkResultResolveService';
import { buildDocumentWorkTruthViewForInboxItem } from './documentWorkResultTruthOrchestration';

export type { SteuerberaterRelevanceStatus } from './documentResultPresentationService';

export type OriginalGuidanceStatus =
  | 'keep'
  | 'keep_until_tax'
  | 'dispose_after_digital'
  | 'uncertain';

export interface AssistantTextBlock {
  key: TranslationKey;
  params?: Record<string, string | number>;
}

export interface InboxDocumentAssistant {
  documentTypeLabelKey: TranslationKey;
  sender?: string;
  narrative?: string;
  briefLines: AssistantTextBlock[];
  actionSteps: AssistantTextBlock[];
  missingItems: string[];
  inactionConsequence?: AssistantTextBlock;
  digitalPath: string;
  paperFolderLabel: string;
  originalGuidance: OriginalGuidanceStatus;
  steuerberaterStatus: SteuerberaterRelevanceStatus;
  steuerberaterReasonKey: TranslationKey;
  recognitionStatus: RecognitionStatus;
  recognitionStatusKey: TranslationKey;
  confidentFields: Array<{ labelKey: TranslationKey; value: string }>;
  uncertainFields: Array<{ labelKey: TranslationKey; noteKey: TranslationKey }>;
  /** DOCUMENT-WORK-RESULT-01B compact truth facts for display/tests (not actions). */
  documentWorkTruthFactLines?: string[];
  documentWorkTruthConflictLines?: string[];
}

function pushUnique(blocks: AssistantTextBlock[], block: AssistantTextBlock): void {
  const exists = blocks.some((entry) => entry.key === block.key);
  if (!exists) blocks.push(block);
}

function resolveOriginalGuidance(
  item: InboxItem,
  kind: ClassifiedDocumentKind,
): OriginalGuidanceStatus {
  if (item.isAdvertisement) return 'dispose_after_digital';
  if (
    isDatevRelevantKind(kind) ||
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

function buildBriefLines(
  item: InboxItem,
  summary: ReturnType<typeof buildDocumentUnderstandingSummary>,
  kind: ClassifiedDocumentKind,
): AssistantTextBlock[] {
  const lines: AssistantTextBlock[] = [];
  const letter = getLetterExplanation(item);

  if (letter) {
    pushUnique(lines, {
      key: 'docAssistant.brief.fromSender',
      params: { sender: item.sender || summary.sender || '—' },
    });
    pushUnique(lines, { key: 'docAssistant.brief.letterReceived' });
    if (summary.amount) {
      pushUnique(lines, {
        key: 'docAssistant.brief.amountMentioned',
        params: { amount: summary.amount },
      });
    }
    if (summary.deadline || item.deadline) {
      pushUnique(lines, {
        key: 'docAssistant.brief.deadlineMentioned',
        params: { deadline: summary.deadline ?? item.deadline ?? '—' },
      });
    }
    if (kind === 'mahnung' || kind === 'zahlungserinnerung') {
      pushUnique(lines, { key: 'docAssistant.brief.paymentActionNeeded' });
    } else if (item.deadline || summary.deadline) {
      pushUnique(lines, { key: 'docAssistant.brief.reviewDeadline' });
    } else {
      pushUnique(lines, { key: 'docAssistant.brief.noUrgentAction' });
    }
    return lines.slice(0, 6);
  }

  pushUnique(lines, {
    key: 'docAssistant.brief.documentFrom',
    params: { sender: item.sender || summary.sender || '—' },
  });

  if (summary.amount) {
    pushUnique(lines, {
      key: 'docAssistant.brief.amountMentioned',
      params: { amount: summary.amount },
    });
  }
  if (summary.deadline || item.deadline) {
    pushUnique(lines, {
      key: 'docAssistant.brief.deadlineMentioned',
      params: { deadline: summary.deadline ?? item.deadline ?? '—' },
    });
  }
  if (kind === 'eingangsrechnung' || kind === 'rechnung') {
    pushUnique(lines, { key: 'docAssistant.brief.invoiceReceived' });
  } else {
    const briefKey = getBriefLineKeyForKind(kind);
    pushUnique(lines, { key: briefKey ?? 'docAssistant.brief.generalDocument' });
  }

  return lines.slice(0, 6);
}

function buildActionSteps(
  prioritized: ReturnType<typeof buildPrioritizedDocumentGuidance>,
  item: InboxItem,
  summary: ReturnType<typeof buildDocumentUnderstandingSummary>,
  kind: ClassifiedDocumentKind,
): AssistantTextBlock[] {
  if (prioritized.now.length > 0) {
    return prioritized.now.slice(0, 5).map((line) => ({
      key: line.text as TranslationKey,
    }));
  }
  return [];
}

function buildInactionConsequence(
  prioritized: ReturnType<typeof buildPrioritizedDocumentGuidance>,
  item: InboxItem,
  kind: ClassifiedDocumentKind,
): AssistantTextBlock | undefined {
  if (prioritized.inaction[0]?.text) {
    return { key: prioritized.inaction[0].text as TranslationKey };
  }
  return undefined;
}

export function buildInboxDocumentAssistant(
  item: InboxItem,
  workflow?: WorkflowResult | null,
  lang: AppLanguage = getCachedSetup()?.language ?? 'de',
  options?: { sessionFillConfirmRows?: readonly DocumentFieldFillConfirmRow[] | null },
): InboxDocumentAssistant {
  const recognizedText = getInboxExtractedDocumentText(item);
  const summary = buildDocumentUnderstandingSummary(item, {
    recognizedText,
    classification: workflow?.classification ?? undefined,
  });
  const kind = (item.classifiedKind ??
    workflow?.classifiedKind ??
    summary.documentType) as ClassifiedDocumentKind;

  const paperResolution = resolvePaperFiling({
    classifiedKind: kind,
    documentType: item.documentType,
    issuer: item.sender,
    sender: item.sender,
    isAdvertisement: item.isAdvertisement,
    linkedVorgangId: item.vorgangId,
  });

  const paperFolderLabel = paperResolution.skipPhysicalFiling
    ? '—'
    : paperResolution.rule
      ? formatPaperFilingInstruction(paperResolution.rule, lang)
      : t('common.misc', lang);

  const presentationContext = buildPresentationContext(item, summary, kind);
  const customer = resolvePresentationCustomer(summary, item.recognizedData);
  const confidentFields: InboxDocumentAssistant['confidentFields'] = [];
  const uncertainFields: InboxDocumentAssistant['uncertainFields'] = [];

  if (
    item.sender &&
    item.sender !== 'Absender nicht eindeutig erkannt.' &&
    item.sender !== 'Unbekannter Absender'
  ) {
    confidentFields.push({ labelKey: 'docAssistant.check.sender', value: item.sender });
  } else {
    uncertainFields.push({
      labelKey: 'docAssistant.check.sender',
      noteKey: 'docAssistant.check.missing',
    });
  }

  confidentFields.push({
    labelKey: 'docAssistant.check.documentType',
    value: kind,
  });

  if (requiresCustomerAssignment(kind)) {
    if (customer) {
      confidentFields.push({ labelKey: 'docAssistant.check.customer', value: customer });
    } else {
      uncertainFields.push({
        labelKey: 'docAssistant.check.customer',
        noteKey: 'docAssistant.check.missing',
      });
    }
  }

  if (summary.amount) {
    confidentFields.push({ labelKey: 'docAssistant.check.amount', value: summary.amount });
  } else {
    uncertainFields.push({
      labelKey: 'docAssistant.check.amount',
      noteKey: 'docAssistant.check.missing',
    });
  }

  if (summary.deadline || item.deadline) {
    confidentFields.push({
      labelKey: 'docAssistant.check.deadline',
      value: summary.deadline ?? item.deadline ?? '—',
    });
  } else {
    uncertainFields.push({
      labelKey: 'docAssistant.check.deadline',
      noteKey: 'docAssistant.check.missing',
    });
  }

  const recognitionStatus = resolveRecognitionStatus(presentationContext, uncertainFields.length);
  const steuer = resolveSteuerberaterPresentation(kind);

  const truth = buildDocumentWorkTruthViewForInboxItem({
    item,
    liveWorkflow: workflow ?? null,
    sessionFillConfirmRows: options?.sessionFillConfirmRows ?? null,
  });
  const prioritized = buildPrioritizedDocumentGuidance(item, workflow, lang, options);
  const truthLines = truth ? buildDocumentWorkTruthAssistContextLines(truth) : null;
  const narrative = buildDocumentNarrative({
    item,
    workflow,
    truthBusinessInterpretation: truth?.businessInterpretation ?? null,
  });

  // Prefer resolved counterparty / money / deadline in confident fields when present.
  if (truth?.businessInterpretation) {
    const bi = truth.businessInterpretation;
    const counterparty = bi.facts.parties.counterparty?.name?.trim();
    if (counterparty) {
      const existing = confidentFields.findIndex((f) => f.labelKey === 'docAssistant.check.sender');
      if (existing >= 0) {
        confidentFields[existing] = {
          labelKey: 'docAssistant.check.sender',
          value: counterparty,
        };
      } else {
        confidentFields.unshift({
          labelKey: 'docAssistant.check.sender',
          value: counterparty,
        });
      }
    }
    const money = bi.facts.money[0];
    const moneyLabel =
      money?.amountFormatted ??
      (money?.amount != null ? `${money.amount} ${money.currency ?? 'EUR'}` : undefined);
    if (moneyLabel) {
      const amountIdx = confidentFields.findIndex((f) => f.labelKey === 'docAssistant.check.amount');
      if (amountIdx >= 0) {
        confidentFields[amountIdx] = {
          labelKey: 'docAssistant.check.amount',
          value: moneyLabel,
        };
      } else {
        confidentFields.push({ labelKey: 'docAssistant.check.amount', value: moneyLabel });
      }
    }
    const deadline = bi.facts.timeline.deadline?.value?.trim();
    if (deadline) {
      const deadlineIdx = confidentFields.findIndex(
        (f) => f.labelKey === 'docAssistant.check.deadline',
      );
      if (deadlineIdx >= 0) {
        confidentFields[deadlineIdx] = {
          labelKey: 'docAssistant.check.deadline',
          value: deadline,
        };
      } else {
        confidentFields.push({ labelKey: 'docAssistant.check.deadline', value: deadline });
      }
    }
  }

  return {
    documentTypeLabelKey: getDocumentDisplayLabelKey(kind, item.documentType),
    sender:
      truth?.businessInterpretation?.facts.parties.counterparty?.name ??
      summary.sender ??
      item.sender,
    narrative: narrative || undefined,
    briefLines: buildBriefLines(item, summary, kind),
    actionSteps: buildActionSteps(prioritized, item, summary, kind),
    missingItems: prioritized.missing.slice(0, 5).map((line) => line.text),
    inactionConsequence: buildInactionConsequence(prioritized, item, kind),
    digitalPath: formatDigitalFolderBreadcrumb(item),
    paperFolderLabel,
    originalGuidance: resolveOriginalGuidance(item, kind),
    steuerberaterStatus: steuer.status,
    steuerberaterReasonKey: steuer.reasonKey,
    recognitionStatus,
    recognitionStatusKey: recognitionStatusKey(recognitionStatus),
    confidentFields,
    uncertainFields,
    documentWorkTruthFactLines: truthLines?.factLines,
    documentWorkTruthConflictLines: truthLines?.conflictLines,
  };
}
