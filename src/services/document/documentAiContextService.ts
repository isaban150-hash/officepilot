import { analyzeContractFromInbox } from '../contractAnalysisService';
import { getLetterExplanation } from '../letterExplanationService';
import { MAX_RECOGNIZED_TEXT_LENGTH } from '../communicationConstants';
import { sanitizeAiText, containsSensitiveFactKey } from '../ai/aiTextSanitizer';
import { t, type TranslationKey } from '../../i18n';
import { formatMessage } from '../../i18n/formatMessage';
import { getCachedSetup } from '../persistenceService';
import type { ExplanationTextBlock } from '../../i18n/types';
import type { AppLanguage, CompanyDocument, InboxItem, WorkflowResult } from '../../types/models';
import type { DocumentAiContext } from '../../types/areaAi';
import { buildDocumentWorkTruthAssistContextLines } from '../documentWorkResultResolveService';
import { buildDocumentWorkTruthViewForInboxItem } from '../documentWorkResultTruthOrchestration';
import { detectDocumentNature } from './documentAiDocumentNature';
import { hasStructuredDeadlineEvidence } from './documentAiEvidence';

function blockToPlainText(block: ExplanationTextBlock): string {
  const lang = getCachedSetup()?.language ?? 'de';
  return formatMessage((key) => t(key as TranslationKey, lang), block);
}

function truncateText(text: string, max = MAX_RECOGNIZED_TEXT_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function buildRecognizedDataLines(data: Record<string, string>): string[] {
  return Object.entries(data)
    .filter(([key]) => !containsSensitiveFactKey(key))
    .map(([key, value]) => `${key}: ${sanitizeAiText(value)}`);
}

function note(key: TranslationKey, lang: AppLanguage): string {
  return t(key, lang);
}

function pickAmountHint(data: Record<string, string> | undefined): string | null {
  if (!data) return null;
  const keys = ['Betrag', 'Gesamtbetrag', 'Brutto', 'Netto', 'Amount', 'Summe'];
  for (const key of keys) {
    const value = data[key]?.trim();
    if (value) return sanitizeAiText(value);
  }
  return null;
}

function withTestNatureNote(
  uncertainFieldNotes: string[],
  documentNature: 'test_or_sample' | 'unknown',
  lang: AppLanguage,
): string[] {
  if (documentNature !== 'test_or_sample') return uncertainFieldNotes;
  const testNote = note('document.freeQuestion.note.testOrSample', lang);
  if (uncertainFieldNotes.includes(testNote)) return uncertainFieldNotes;
  return [testNote, ...uncertainFieldNotes];
}

function collectInboxQualityNotes(
  item: InboxItem,
  lang: AppLanguage,
): { uncertainFieldNotes: string[]; missingFieldNotes: string[] } {
  const uncertainFieldNotes: string[] = [];
  const missingFieldNotes: string[] = [];
  const textBudget = [
    item.title,
    item.sender,
    ...Object.values(item.recognizedData ?? {}),
  ]
    .join(' ')
    .trim();

  if (!textBudget) {
    missingFieldNotes.push(note('document.freeQuestion.note.noRecognizedText', lang));
  }
  if (!item.deadline && !item.recognizedData.Frist) {
    missingFieldNotes.push(note('document.freeQuestion.note.noDeadline', lang));
  }
  if (!item.sender?.trim()) {
    missingFieldNotes.push(note('document.freeQuestion.note.noSender', lang));
  }
  if (!item.vorgangId && !item.vorgangTitle) {
    uncertainFieldNotes.push(note('document.freeQuestion.note.customerUncertain', lang));
  } else if (item.vorgangLinkStatus === 'none' || (!item.vorgangId && item.vorgangTitle)) {
    uncertainFieldNotes.push(note('document.freeQuestion.note.customerUncertain', lang));
  }
  if (item.classifiedKind === 'sonstiges' || !item.classifiedKind) {
    uncertainFieldNotes.push(note('document.freeQuestion.note.documentTypeUncertain', lang));
  }
  if (pickAmountHint(item.recognizedData)) {
    uncertainFieldNotes.push(note('document.freeQuestion.note.amountNeedsReview', lang));
  }

  return { uncertainFieldNotes, missingFieldNotes };
}

function collectDocumentQualityNotes(
  document: CompanyDocument,
  lang: AppLanguage,
): { uncertainFieldNotes: string[]; missingFieldNotes: string[] } {
  const uncertainFieldNotes: string[] = [];
  const missingFieldNotes: string[] = [];

  if (!document.recognizedText?.trim()) {
    missingFieldNotes.push(note('document.freeQuestion.note.noRecognizedText', lang));
  }
  // issueDate / documentDate alone are not deadline evidence.
  if (!document.validUntil) {
    missingFieldNotes.push(note('document.freeQuestion.note.noDeadline', lang));
  }
  if (!document.issuer?.trim()) {
    missingFieldNotes.push(note('document.freeQuestion.note.noSender', lang));
  }
  if (!document.linkedVorgang?.vorgangId) {
    uncertainFieldNotes.push(note('document.freeQuestion.note.customerUncertain', lang));
  }
  if (!document.classifiedKind || document.classifiedKind === 'sonstiges') {
    uncertainFieldNotes.push(note('document.freeQuestion.note.documentTypeUncertain', lang));
  }

  return { uncertainFieldNotes, missingFieldNotes };
}

export function buildDocumentAiContextFromDocument(document: CompanyDocument): DocumentAiContext {
  const lang = getCachedSetup()?.language ?? 'de';
  const quality = collectDocumentQualityNotes(document, lang);
  const confirmedLink = Boolean(document.linkedVorgang?.vorgangId);
  const recognizedText = document.recognizedText
    ? sanitizeAiText(truncateText(document.recognizedText))
    : undefined;
  const documentNature = detectDocumentNature({
    title: document.title,
    recognizedText: document.recognizedText,
  });

  return {
    sourceType: 'document',
    title: document.title,
    issuerOrSender: document.issuer,
    category: document.category,
    classifiedKind: document.classifiedKind ?? null,
    issueDate: document.issueDate,
    validUntil: document.validUntil,
    documentNature,
    recognizedText,
    recognizedDataLines: document.tags.map((tag) => `Tag: ${sanitizeAiText(tag)}`),
    linkedVorgangId: confirmedLink ? document.linkedVorgang!.vorgangId : null,
    linkedVorgangTitle: confirmedLink ? document.linkedVorgang!.vorgangTitle : undefined,
    digitalFolderPath: document.digitalFolder?.path,
    paperFolderLabel: document.paperFolder?.label,
    missingDocuments: [],
    tags: document.tags,
    uncertainFieldNotes: withTestNatureNote(quality.uncertainFieldNotes, documentNature, lang),
    missingFieldNotes: quality.missingFieldNotes,
  };
}

export function buildDocumentAiContextFromInbox(
  item: InboxItem,
  options?: { liveWorkflow?: WorkflowResult | null },
): DocumentAiContext {
  const lang = getCachedSetup()?.language ?? 'de';
  const quality = collectInboxQualityNotes(item, lang);
  const vertragstext =
    item.recognizedData._vertragstext ?? item.recognizedData.Vertragstext ?? '';
  const recognizedText = truncateText(
    [item.title, item.sender, item.officePilotSuggestion, vertragstext]
      .concat(
        Object.entries(item.recognizedData)
          .filter(([key]) => key !== '_vertragstext' && key !== 'Vertragstext')
          .map(([, value]) => value),
      )
      .filter(Boolean)
      .join('\n'),
  );

  const explanation = getLetterExplanation(item);
  const contract = analyzeContractFromInbox(item);
  const confirmedLink = Boolean(item.vorgangId);
  const documentNature = detectDocumentNature({
    title: item.title,
    recognizedText,
  });

  const truth = buildDocumentWorkTruthViewForInboxItem({
    item,
    liveWorkflow: options?.liveWorkflow ?? null,
  });
  const truthLines = truth ? buildDocumentWorkTruthAssistContextLines(truth) : null;

  return {
    sourceType: 'inbox',
    title: item.title,
    issuerOrSender: item.sender,
    category: item.documentType,
    classifiedKind: item.classifiedKind ?? null,
    deadline: item.deadline ?? item.recognizedData.Frist ?? undefined,
    amountHint: pickAmountHint(item.recognizedData),
    documentNature,
    recognizedText: sanitizeAiText(recognizedText),
    recognizedDataLines: buildRecognizedDataLines(item.recognizedData),
    linkedVorgangId: confirmedLink ? item.vorgangId : null,
    linkedVorgangTitle: confirmedLink ? item.vorgangTitle : undefined,
    digitalFolderPath: item.digitalFolder?.path,
    paperFolderLabel: item.paperFiling?.label,
    letterSummary: explanation
      ? {
          about: sanitizeAiText(blockToPlainText(explanation.about)),
          deadline: sanitizeAiText(blockToPlainText(explanation.deadline)),
          nextSteps: sanitizeAiText(blockToPlainText(explanation.nextSteps)),
        }
      : undefined,
    missingDocuments: contract.isContract
      ? contract.requiredDocuments.map((doc) => doc.reason || doc.type.replace(/_/g, ' '))
      : [],
    tags: [],
    uncertainFieldNotes: withTestNatureNote(quality.uncertainFieldNotes, documentNature, lang),
    missingFieldNotes: quality.missingFieldNotes,
    documentWorkTruthFactLines: truthLines?.factLines,
    documentWorkTruthConflictLines: truthLines?.conflictLines,
  };
}

export function buildDocumentAiAllowedSourceText(context: DocumentAiContext): string {
  return [
    context.title,
    context.issuerOrSender,
    context.category,
    context.classifiedKind ?? '',
    context.documentNature ?? '',
    context.deadline ?? '',
    context.validUntil ?? '',
    context.issueDate ?? '',
    context.amountHint ?? '',
    context.recognizedText ?? '',
    ...context.recognizedDataLines,
    context.linkedVorgangId ?? '',
    context.linkedVorgangTitle ?? '',
    context.digitalFolderPath ?? '',
    context.paperFolderLabel ?? '',
    context.letterSummary?.about ?? '',
    context.letterSummary?.deadline ?? '',
    context.letterSummary?.nextSteps ?? '',
    ...context.missingDocuments,
    ...context.tags,
    ...context.uncertainFieldNotes,
    ...context.missingFieldNotes,
    ...(context.documentWorkTruthFactLines ?? []),
    ...(context.documentWorkTruthConflictLines ?? []),
    hasStructuredDeadlineEvidence(context) ? 'structured_deadline_evidence' : '',
  ].join('\n');
}
