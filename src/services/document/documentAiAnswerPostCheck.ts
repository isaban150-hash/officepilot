import { t } from '../../i18n';
import type { DocumentAiContext } from '../../types/areaAi';
import type { AppLanguage } from '../../types/models';
import type { ParsedDocumentAiAnswer } from './documentAiAnswerParser';
import {
  canClaimDocumentDemandWithDate,
  collectMentionableDates,
  hasDemandEvidence,
  hasStructuredDeadlineEvidence,
} from './documentAiEvidence';
import { detectDocumentQuestionIntents } from './documentAiQuestionIntent';

export interface DocumentAiPostCheckResult extends ParsedDocumentAiAnswer {
  warnings: string[];
  softened: boolean;
}

const FORBIDDEN_USER_OBLIGATION =
  /(?:sie\s+müssen|müssen\s+sie|sie\s+sind\s+verpflichtet|zahlungspflicht(?:ig)?|rechts?\s*verbindlich|verbindliche\s+forderung|ödemek\s+zorundasınız|yükümlüsünüz|платете\s+задължително|трябва\s+да\s+платите|задължени\s+сте)/iu;

const CLAIMS_REAL_PAYMENT_DUTY =
  /(?:zahlungspflicht|müssen\s+(?:sie\s+)?(?:zahlen|überweisen|reagieren)|fordert\s+eine\s+zahlung|zahlungsfrist\s+ist|frist\s+für\s+die\s+überweisung|überweisung\s+des\s+rechnungsbetrags)/iu;

const QUOTE_PATTERN = /[„“”«»"]([^„“”«»"]{3,})[„“”«»"]/g;

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[„“”«»"']/g, '')
    .trim();
}

function combine(directAnswer: string, explanation: string): string {
  if (!explanation) return directAnswer;
  if (!directAnswer) return explanation;
  return `${directAnswer}\n\n${explanation}`;
}

function stripUnverifiedQuotes(text: string, recognizedText: string | undefined): string {
  const source = normalizeForMatch(recognizedText ?? '');
  return text
    .replace(QUOTE_PATTERN, (_full, inner: string) => {
      const normalizedInner = normalizeForMatch(inner);
      // Prefer no literal quotes: drop span unless it is a contiguous source substring.
      if (source && normalizedInner.length >= 8 && source.includes(normalizedInner)) {
        return inner.trim();
      }
      return '';
    })
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function mentionsTestNature(text: string): boolean {
  return /(?:test(?:dokument|rechnung)?|muster|demo|entwurf|beispiel|keine\s+echte\s+forderung|örnek|taslak|тестов|образец|демо|чернова)/iu.test(
    text,
  );
}

function buildStage1DateAnswer(context: DocumentAiContext, lang: AppLanguage): ParsedDocumentAiAnswer {
  const dates = collectMentionableDates(context);
  const date = dates[0];
  if (context.documentNature === 'test_or_sample') {
    const direct = date
      ? t('document.freeQuestion.direct.testDateMention', lang).replace('{date}', date)
      : t('document.freeQuestion.direct.testNoObligation', lang);
    return {
      directAnswer: direct,
      explanation: t('document.freeQuestion.explanation.testOrSample', lang),
      text: combine(direct, t('document.freeQuestion.explanation.testOrSample', lang)),
    };
  }
  if (date) {
    const direct = t('document.freeQuestion.direct.dateMentioned', lang).replace('{date}', date);
    const explanation = hasDemandEvidence(context)
      ? t('document.freeQuestion.explanation.dateWithoutBoundDeadline', lang)
      : t('document.freeQuestion.explanation.dateMentionOnly', lang);
    return { directAnswer: direct, explanation, text: combine(direct, explanation) };
  }
  const unclear = t('document.freeQuestion.direct.unclear', lang);
  return { directAnswer: unclear, explanation: '', text: unclear };
}

function buildSafeDemandAnswer(context: DocumentAiContext, lang: AppLanguage): ParsedDocumentAiAnswer {
  if (context.documentNature === 'test_or_sample') {
    return buildStage1DateAnswer(context, lang);
  }
  const date = context.deadline?.trim() || context.validUntil?.trim() || collectMentionableDates(context)[0];
  if (canClaimDocumentDemandWithDate(context) && date) {
    const direct = t('document.freeQuestion.direct.documentDemandsPayment', lang).replace(
      '{date}',
      date,
    );
    const explanation = t('document.freeQuestion.explanation.documentDemandOnly', lang);
    return { directAnswer: direct, explanation, text: combine(direct, explanation) };
  }
  return buildStage1DateAnswer(context, lang);
}

/**
 * Deterministic post-check: no user-obligation claims, honor test docs,
 * strip unverifiable quotes, and avoid treating issueDate as a due date.
 */
export function applyDocumentAiAnswerPostCheck(input: {
  question: string;
  parsed: ParsedDocumentAiAnswer;
  context: DocumentAiContext;
  lang: AppLanguage;
}): DocumentAiPostCheckResult {
  const { question, context, lang } = input;
  const warnings: string[] = [];
  let directAnswer = stripUnverifiedQuotes(input.parsed.directAnswer, context.recognizedText);
  let explanation = stripUnverifiedQuotes(input.parsed.explanation, context.recognizedText);
  let softened = false;

  if (directAnswer !== input.parsed.directAnswer || explanation !== input.parsed.explanation) {
    warnings.push('unverified_quote_removed');
    softened = true;
  }

  const combined = `${directAnswer}\n${explanation}`;
  const intents = detectDocumentQuestionIntents(question);
  const paymentOrDeadline = intents.has('payment') || intents.has('deadline');

  if (FORBIDDEN_USER_OBLIGATION.test(combined)) {
    warnings.push('forbidden_user_obligation');
    const safe = buildSafeDemandAnswer(context, lang);
    return { ...safe, warnings, softened: true };
  }

  if (
    context.documentNature === 'test_or_sample' &&
    paymentOrDeadline &&
    (CLAIMS_REAL_PAYMENT_DUTY.test(combined) || !mentionsTestNature(combined))
  ) {
    warnings.push('test_document_payment_claim');
    const safe = buildStage1DateAnswer(context, lang);
    return { ...safe, warnings, softened: true };
  }

  // Stage-2 demand wording without demand+deadline evidence → soften to stage 1.
  const claimsDemandWithDate =
    /(?:dokument\s+fordert|fordert\s+eine\s+zahlung|zahlungsfrist\s+ist|frist\s+für\s+die\s+überweisung|reaktionsfrist\s+ist)/iu.test(
      combined,
    );
  if (claimsDemandWithDate && !canClaimDocumentDemandWithDate(context)) {
    warnings.push('insufficient_deadline_demand_evidence');
    const safe = buildStage1DateAnswer(context, lang);
    return { ...safe, warnings, softened: true };
  }

  // Explicitly block treating issueDate-only as payment deadline when no structured deadline.
  if (
    paymentOrDeadline &&
    !hasStructuredDeadlineEvidence(context) &&
    /(?:zahlungsfrist|überweisung|fällig|frist\s+ist)/iu.test(combined) &&
    Boolean(context.issueDate?.trim())
  ) {
    warnings.push('issue_date_as_payment_deadline');
    const safe = buildStage1DateAnswer(context, lang);
    return { ...safe, warnings, softened: true };
  }

  if (!directAnswer.trim()) {
    const unclear = t('document.freeQuestion.direct.unclear', lang);
    return {
      directAnswer: unclear,
      explanation: explanation.trim(),
      text: combine(unclear, explanation.trim()),
      warnings: [...warnings, 'empty_direct_answer'],
      softened: true,
    };
  }

  return {
    directAnswer,
    explanation,
    text: combine(directAnswer, explanation),
    warnings,
    softened,
  };
}

export function ensureTestNatureNote(
  notes: string[],
  context: DocumentAiContext,
  lang: AppLanguage,
): string[] {
  if (context.documentNature !== 'test_or_sample') return notes;
  const note = t('document.freeQuestion.note.testOrSample', lang);
  if (notes.includes(note)) return notes;
  return [note, ...notes];
}
