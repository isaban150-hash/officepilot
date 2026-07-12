import type { TranslationKey } from '../i18n';
import { isDatevRelevantKind } from './brain/financeIntelligenceService';
import {
  formatDigitalFolderBreadcrumb,
  formatPaperFolderLabel,
  getDocumentDisplayLabelKey,
} from './documentDisplayLabelService';
import { buildDocumentUnderstandingSummary } from './documentIntakeUnderstandingService';
import { getLetterExplanation } from './letterExplanationService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import { resolvePaperFiling } from './paperFolderService';
import type { ClassifiedDocumentKind, InboxItem, WorkflowResult } from '../types/models';

export type SteuerberaterRelevanceStatus = 'mark' | 'not_relevant' | 'check';

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
  briefLines: AssistantTextBlock[];
  actionSteps: AssistantTextBlock[];
  inactionConsequence?: AssistantTextBlock;
  digitalPath: string;
  paperFolderLabel: string;
  originalGuidance: OriginalGuidanceStatus;
  steuerberaterStatus: SteuerberaterRelevanceStatus;
  steuerberaterReasonKey: TranslationKey;
  confidentFields: Array<{ labelKey: TranslationKey; value: string }>;
  uncertainFields: Array<{ labelKey: TranslationKey; noteKey: TranslationKey }>;
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

function resolveSteuerberater(
  kind: ClassifiedDocumentKind,
): { status: SteuerberaterRelevanceStatus; reasonKey: TranslationKey } {
  if (
    isDatevRelevantKind(kind) ||
    kind === 'freistellungsbescheinigung' ||
    kind === 'lohnabrechnung' ||
    kind === 'lohnunterlagen' ||
    kind === 'kontoauszug' ||
    kind === 'steuerbescheid' ||
    kind === 'umsatzsteuerbescheid'
  ) {
    return {
      status: 'mark',
      reasonKey: 'docAssistant.steuerberater.markReason',
    };
  }
  if (
    kind === 'aok' ||
    kind === 'barmer' ||
    kind === 'tk' ||
    kind === 'dak' ||
    kind === 'ikk' ||
    kind === 'krankenkasse' ||
    kind === 'knappschaft' ||
    kind === 'pflegekasse'
  ) {
    return {
      status: 'check',
      reasonKey: 'docAssistant.steuerberater.checkReason',
    };
  }
  if (kind === 'werkvertrag' || kind === 'auftrag' || kind === 'lieferschein') {
    return {
      status: 'check',
      reasonKey: 'docAssistant.steuerberater.checkReason',
    };
  }
  return {
    status: 'not_relevant',
    reasonKey: 'docAssistant.steuerberater.notReason',
  };
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
  } else if (kind === 'werkvertrag' || kind === 'auftrag') {
    pushUnique(lines, { key: 'docAssistant.brief.orderDocument' });
  } else {
    pushUnique(lines, { key: 'docAssistant.brief.generalDocument' });
  }

  return lines.slice(0, 6);
}

function buildActionSteps(
  item: InboxItem,
  summary: ReturnType<typeof buildDocumentUnderstandingSummary>,
  kind: ClassifiedDocumentKind,
): AssistantTextBlock[] {
  const steps: AssistantTextBlock[] = [];

  if (item.isAdvertisement) {
    return [{ key: 'docAssistant.action.disposeAdvertisement' }];
  }
  if (kind === 'mahnung' || kind === 'zahlungserinnerung') {
    if (summary.amount && (summary.deadline || item.deadline)) {
      pushUnique(steps, {
        key: 'docAssistant.action.payByDeadline',
        params: {
          amount: summary.amount,
          deadline: summary.deadline ?? item.deadline ?? '—',
        },
      });
    } else if (summary.amount) {
      pushUnique(steps, {
        key: 'docAssistant.action.checkAmount',
        params: { amount: summary.amount },
      });
    } else {
      pushUnique(steps, { key: 'docAssistant.action.checkPayment' });
    }
  } else if (summary.deadline || item.deadline) {
    pushUnique(steps, {
      key: 'docAssistant.action.monitorDeadline',
      params: { deadline: summary.deadline ?? item.deadline ?? '—' },
    });
  }

  if (isDatevRelevantKind(kind)) {
    pushUnique(steps, { key: 'docAssistant.action.prepareForTaxAdvisor' });
  }

  if (steps.length === 0) {
    pushUnique(steps, { key: 'docAssistant.action.reviewAndFile' });
  }

  return steps.slice(0, 5);
}

function buildInactionConsequence(
  item: InboxItem,
  kind: ClassifiedDocumentKind,
): AssistantTextBlock | undefined {
  if (item.isAdvertisement) return undefined;
  if (kind === 'mahnung') {
    return { key: 'docAssistant.inaction.mahnung' };
  }
  if (kind === 'zahlungserinnerung') {
    return { key: 'docAssistant.inaction.paymentReminder' };
  }
  if (item.deadline || kind === 'finanzamt' || kind === 'steuerbescheid') {
    return { key: 'docAssistant.inaction.deadlineRisk' };
  }
  return undefined;
}

export function buildInboxDocumentAssistant(
  item: InboxItem,
  workflow?: WorkflowResult | null,
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
    : formatPaperFolderLabel(
        paperResolution.rule?.register ?? '',
        paperResolution.rule?.label ?? 'Sonstiges',
      );

  const confidentFields: InboxDocumentAssistant['confidentFields'] = [];
  const uncertainFields: InboxDocumentAssistant['uncertainFields'] = [];

  if (item.sender && item.sender !== 'Unbekannter Absender') {
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

  const steuer = resolveSteuerberater(kind);

  return {
    documentTypeLabelKey: getDocumentDisplayLabelKey(kind, item.documentType),
    sender: summary.sender ?? item.sender,
    briefLines: buildBriefLines(item, summary, kind),
    actionSteps: buildActionSteps(item, summary, kind),
    inactionConsequence: buildInactionConsequence(item, kind),
    digitalPath: formatDigitalFolderBreadcrumb(item),
    paperFolderLabel,
    originalGuidance: resolveOriginalGuidance(item, kind),
    steuerberaterStatus: steuer.status,
    steuerberaterReasonKey: steuer.reasonKey,
    confidentFields,
    uncertainFields,
  };
}
