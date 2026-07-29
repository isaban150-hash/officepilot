import { analyzeContractFromInbox } from '../contractAnalysisService';
import { getLetterExplanation } from '../letterExplanationService';
import { MAX_RECOGNIZED_TEXT_LENGTH } from '../communicationConstants';
import { sanitizeAiText, containsSensitiveFactKey } from '../ai/aiTextSanitizer';
import { t, type TranslationKey } from '../../i18n';
import { formatMessage } from '../../i18n/formatMessage';
import { getCachedSetup } from '../persistenceService';
import type { ExplanationTextBlock } from '../../i18n/types';
import type { DocumentFieldFillConfirmRow } from '../../types/documentFieldFillConfirm';
import type { AppLanguage, CompanyDocument, InboxItem, WorkflowResult } from '../../types/models';
import type { DocumentAiContext } from '../../types/areaAi';
import type { DocumentWorkTruthView } from '../../types/documentWorkTruth';
import { buildDocumentWorkTruthAssistContextLines } from '../documentWorkResultResolveService';
import {
  buildDocumentWorkTruthViewForInboxItem,
  resolveDocumentWorkTruthViewForCompanyDocument,
} from '../documentWorkResultTruthOrchestration';
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

/** Confirmed/corrected and not in unresolvedConflicts — suppress competing structured hints. */
function slotIsUserOwned(truth: DocumentWorkTruthView, slotId: string): boolean {
  const conflicted = truth.unresolvedConflicts.some((c) => c.slotId === slotId);
  if (conflicted) return false;
  const slot = truth.slots.find((entry) => entry.slotId === slotId);
  return slot?.provenance === 'user_confirmed' || slot?.provenance === 'user_corrected';
}

function slotIsDiscarded(truth: DocumentWorkTruthView, slotId: string): boolean {
  return truth.slots.find((entry) => entry.slotId === slotId)?.provenance === 'discarded';
}

type DocumentAiTruthPromptFields = {
  documentWorkTruthFactLines?: string[];
  documentWorkTruthConflictLines?: string[];
  confirmedUserFactLines?: string[];
  suppressAmountHint: boolean;
  suppressStructuredDeadline: boolean;
  suppressIssuerHint: boolean;
};

/**
 * Shared TruthView → DocumentAiContext prompt fields (inbox + archive).
 * Confirmed/corrected drive suppress flags; discarded never appears in fact lines (mapper).
 */
function buildDocumentAiTruthPromptFields(
  truth: DocumentWorkTruthView | null,
): DocumentAiTruthPromptFields {
  if (!truth) {
    return {
      suppressAmountHint: false,
      suppressStructuredDeadline: false,
      suppressIssuerHint: false,
    };
  }
  const truthLines = buildDocumentWorkTruthAssistContextLines(truth);
  const confirmedUserFactLines = truthLines.factLines.filter(
    (line) => line.includes('[Nutzerbestätigung]') || line.includes('[Nutzerkorrektur]'),
  );
  return {
    documentWorkTruthFactLines: truthLines.factLines,
    documentWorkTruthConflictLines: truthLines.conflictLines,
    confirmedUserFactLines,
    suppressAmountHint: slotIsUserOwned(truth, 'facts.money.0'),
    suppressStructuredDeadline: slotIsUserOwned(truth, 'facts.timeline.deadline'),
    suppressIssuerHint: slotIsUserOwned(truth, 'facts.parties.counterparty'),
  };
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
  flags?: {
    suppressAmountHint?: boolean;
    suppressStructuredDeadline?: boolean;
    suppressIssuerHint?: boolean;
  },
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
  if (
    !flags?.suppressStructuredDeadline &&
    !item.deadline &&
    !item.recognizedData.Frist
  ) {
    missingFieldNotes.push(note('document.freeQuestion.note.noDeadline', lang));
  }
  if (!flags?.suppressIssuerHint && !item.sender?.trim()) {
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
  if (!flags?.suppressAmountHint && pickAmountHint(item.recognizedData)) {
    uncertainFieldNotes.push(note('document.freeQuestion.note.amountNeedsReview', lang));
  }

  return { uncertainFieldNotes, missingFieldNotes };
}

function collectDocumentQualityNotes(
  document: CompanyDocument,
  lang: AppLanguage,
  flags?: {
    suppressStructuredDeadline?: boolean;
    suppressIssuerHint?: boolean;
    /** Discarded counterparty — do not demand a sender as "missing". */
    issuerDiscarded?: boolean;
    deadlineDiscarded?: boolean;
  },
): { uncertainFieldNotes: string[]; missingFieldNotes: string[] } {
  const uncertainFieldNotes: string[] = [];
  const missingFieldNotes: string[] = [];

  if (!document.recognizedText?.trim()) {
    missingFieldNotes.push(note('document.freeQuestion.note.noRecognizedText', lang));
  }
  // issueDate / documentDate alone are not deadline evidence.
  if (
    !flags?.suppressStructuredDeadline &&
    !flags?.deadlineDiscarded &&
    !document.validUntil
  ) {
    missingFieldNotes.push(note('document.freeQuestion.note.noDeadline', lang));
  }
  if (
    !flags?.suppressIssuerHint &&
    !flags?.issuerDiscarded &&
    !document.issuer?.trim()
  ) {
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

function buildLegacyDocumentAiContextFromDocument(
  document: CompanyDocument,
  lang: AppLanguage,
): DocumentAiContext {
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

/**
 * DOCUMENT-ARCHIVE-TRUTH-03A3 — archive free-question context with shared TruthView when usable.
 * Fallback: previous CompanyDocument / OCR context when adapter returns no truthView.
 */
export function buildDocumentAiContextFromDocument(document: CompanyDocument): DocumentAiContext {
  const lang = getCachedSetup()?.language ?? 'de';
  const { truthView: truth } = resolveDocumentWorkTruthViewForCompanyDocument({ document });
  if (!truth) {
    return buildLegacyDocumentAiContextFromDocument(document, lang);
  }

  const truthFields = buildDocumentAiTruthPromptFields(truth);
  const bi = truth.businessInterpretation;
  const issuerDiscarded = slotIsDiscarded(truth, 'facts.parties.counterparty');
  const deadlineDiscarded = slotIsDiscarded(truth, 'facts.timeline.deadline');

  const quality = collectDocumentQualityNotes(document, lang, {
    suppressStructuredDeadline: truthFields.suppressStructuredDeadline,
    suppressIssuerHint: truthFields.suppressIssuerHint,
    issuerDiscarded,
    deadlineDiscarded,
  });
  const confirmedLink = Boolean(document.linkedVorgang?.vorgangId);
  const recognizedText = document.recognizedText
    ? sanitizeAiText(truncateText(document.recognizedText))
    : undefined;
  const documentNature = detectDocumentNature({
    title: document.title,
    recognizedText: document.recognizedText,
  });

  // Confirmed/corrected: same suppress as inbox. Discarded: clear structured hints without
  // setting suppress flags (avoids prompt text "siehe bestätigte Nutzerdaten").
  let issuerOrSender = document.issuer;
  if (truthFields.suppressIssuerHint) {
    issuerOrSender = bi?.facts.parties.counterparty?.name?.trim() || document.issuer;
  } else if (issuerDiscarded) {
    issuerOrSender = '';
  }

  let validUntil = document.validUntil;
  let deadline: string | undefined;
  if (truthFields.suppressStructuredDeadline) {
    deadline = bi?.facts.timeline.deadline?.value?.trim() || undefined;
    validUntil = null;
  } else if (deadlineDiscarded) {
    validUntil = null;
  }

  return {
    sourceType: 'document',
    title: document.title,
    issuerOrSender,
    category: document.category,
    classifiedKind: document.classifiedKind ?? null,
    issueDate: document.issueDate,
    validUntil,
    deadline,
    // No structured archive amountHint — avoids re-injecting discarded/confirmed OCR amounts.
    amountHint: null,
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
    documentWorkTruthFactLines: truthFields.documentWorkTruthFactLines,
    documentWorkTruthConflictLines: truthFields.documentWorkTruthConflictLines,
    confirmedUserFactLines: truthFields.confirmedUserFactLines,
    suppressAmountHint: truthFields.suppressAmountHint,
    suppressStructuredDeadline: truthFields.suppressStructuredDeadline,
    suppressIssuerHint: truthFields.suppressIssuerHint,
  };
}

export function buildDocumentAiContextFromInbox(
  item: InboxItem,
  options?: {
    liveWorkflow?: WorkflowResult | null;
    sessionFillConfirmRows?: readonly DocumentFieldFillConfirmRow[] | null;
  },
): DocumentAiContext {
  const lang = getCachedSetup()?.language ?? 'de';
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
    sessionFillConfirmRows: options?.sessionFillConfirmRows ?? null,
  });
  const truthFields = buildDocumentAiTruthPromptFields(truth);

  const quality = collectInboxQualityNotes(item, lang, {
    suppressAmountHint: truthFields.suppressAmountHint,
    suppressStructuredDeadline: truthFields.suppressStructuredDeadline,
    suppressIssuerHint: truthFields.suppressIssuerHint,
  });

  const bi = truth?.businessInterpretation;
  const issuerOrSender = truthFields.suppressIssuerHint
    ? bi?.facts.parties.counterparty?.name?.trim() || item.sender
    : item.sender;
  const deadline = truthFields.suppressStructuredDeadline
    ? bi?.facts.timeline.deadline?.value?.trim() || undefined
    : item.deadline ?? item.recognizedData.Frist ?? undefined;
  const amountHint = truthFields.suppressAmountHint ? null : pickAmountHint(item.recognizedData);

  const recognizedDataForLines = { ...item.recognizedData };
  if (truthFields.suppressIssuerHint) {
    delete recognizedDataForLines.Absender;
    delete recognizedDataForLines.Kunde;
    delete recognizedDataForLines.Lieferant;
  }
  if (truthFields.suppressStructuredDeadline) {
    delete recognizedDataForLines.Frist;
  }
  if (truthFields.suppressAmountHint) {
    delete recognizedDataForLines.Betrag;
    delete recognizedDataForLines.Gesamtbetrag;
    delete recognizedDataForLines.Brutto;
    delete recognizedDataForLines.Netto;
    delete recognizedDataForLines.Amount;
    delete recognizedDataForLines.Summe;
  }

  let letterSummary = explanation
    ? {
        about: sanitizeAiText(blockToPlainText(explanation.about)),
        deadline: sanitizeAiText(blockToPlainText(explanation.deadline)),
        nextSteps: sanitizeAiText(blockToPlainText(explanation.nextSteps)),
      }
    : undefined;
  if (letterSummary && truthFields.suppressStructuredDeadline) {
    letterSummary = {
      ...letterSummary,
      deadline: '(durch Nutzer bestätigt — siehe bestätigte Fakten)',
    };
  }

  return {
    sourceType: 'inbox',
    title: item.title,
    issuerOrSender,
    category: item.documentType,
    classifiedKind: item.classifiedKind ?? null,
    deadline,
    amountHint,
    documentNature,
    recognizedText: sanitizeAiText(recognizedText),
    recognizedDataLines: buildRecognizedDataLines(recognizedDataForLines),
    linkedVorgangId: confirmedLink ? item.vorgangId : null,
    linkedVorgangTitle: confirmedLink ? item.vorgangTitle : undefined,
    digitalFolderPath: item.digitalFolder?.path,
    paperFolderLabel: item.paperFiling?.label,
    letterSummary,
    missingDocuments: contract.isContract
      ? contract.requiredDocuments.map((doc) => doc.reason || doc.type.replace(/_/g, ' '))
      : [],
    tags: [],
    uncertainFieldNotes: withTestNatureNote(quality.uncertainFieldNotes, documentNature, lang),
    missingFieldNotes: quality.missingFieldNotes,
    documentWorkTruthFactLines: truthFields.documentWorkTruthFactLines,
    documentWorkTruthConflictLines: truthFields.documentWorkTruthConflictLines,
    confirmedUserFactLines: truthFields.confirmedUserFactLines,
    suppressAmountHint: truthFields.suppressAmountHint,
    suppressStructuredDeadline: truthFields.suppressStructuredDeadline,
    suppressIssuerHint: truthFields.suppressIssuerHint,
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
    ...(context.confirmedUserFactLines ?? []),
    ...(context.documentWorkTruthFactLines ?? []),
    ...(context.documentWorkTruthConflictLines ?? []),
    hasStructuredDeadlineEvidence(context) ? 'structured_deadline_evidence' : '',
  ].join('\n');
}
