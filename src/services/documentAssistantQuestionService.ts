import type { TranslationKey } from '../i18n';
import type { InboxDocumentAssistant } from './documentAssistantService';
import { getDocumentDisplayLabelKey } from './documentDisplayLabelService';
import { buildDocumentUnderstandingSummary } from './documentIntakeUnderstandingService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import type { InboxItem, ClassifiedDocumentKind } from '../types/models';

export interface DocumentQuestionSuggestion {
  id: string;
  labelKey: TranslationKey;
}

export interface DocumentQuestionAnswer {
  answerKey: TranslationKey;
  params?: Record<string, string | number>;
  uncertain?: boolean;
  followUpKey?: TranslationKey;
}

export const DOCUMENT_QUESTION_SUGGESTIONS: DocumentQuestionSuggestion[] = [
  { id: 'pay', labelKey: 'docAssistant.question.pay' },
  { id: 'why', labelKey: 'docAssistant.question.why' },
  { id: 'deadline', labelKey: 'docAssistant.question.deadline' },
  { id: 'ignore', labelKey: 'docAssistant.question.ignore' },
  { id: 'tax', labelKey: 'docAssistant.question.tax' },
  { id: 'file', labelKey: 'docAssistant.question.file' },
  { id: 'dispose', labelKey: 'docAssistant.question.dispose' },
];

const QUESTION_PATTERNS = {
  pay: [
    'bezahlen',
    'zahlung',
    'muss ich das bezahlen',
    'ödeme',
    'odemem',
    'плащам',
    'плащане',
    'трябва ли да плащам',
    'трябва ли да го платя',
  ],
  why: ['warum', 'weshalb', 'why', 'neden', 'niçin', 'защо', 'защо получих'],
  deadline: [
    'bis wann',
    'frist',
    'deadline',
    'ne zaman',
    'son tarih',
    'до кога',
    'срок',
    'краен срок',
    'кога трябва',
  ],
  ignore: [
    'nichts mache',
    'nichts tun',
    'ignore',
    'yapmazsam',
    'yapmaz',
    'ако не направя',
    'нищо не направя',
    'какво става',
  ],
  tax: ['steuerberater', 'tax advisor', 'mali müşavir', 'steuer', 'данъчен консултант'],
  file: [
    'abheften',
    'ablage',
    'ordner',
    'file',
    'klasör',
    'nereye',
    'архивирам',
    'къде да',
    'папка',
    'абхефтен',
  ],
  dispose: ['wegwerfen', 'entsorgen', 'dispose', 'at', 'throw', 'изхвърля', 'махна', 'изхвърли'],
  draftReply: [
    'antwort schreib',
    'schreib eine antwort',
    'schreib mir eine antwort',
    'write a reply',
    'cevap yaz',
    'yanıt yaz',
    'напиши отговор',
    'напишете отговор',
  ],
} as const;

function normalizeQuestion(question: string): string {
  return question.trim().toLowerCase();
}

function matches(question: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => question.includes(pattern));
}

export function isDraftReplyQuestion(question: string): boolean {
  return matches(normalizeQuestion(question), QUESTION_PATTERNS.draftReply);
}

export function answerInboxDocumentQuestion(
  item: InboxItem,
  assistant: InboxDocumentAssistant,
  question: string,
): DocumentQuestionAnswer {
  const normalized = normalizeQuestion(question);
  const summary = buildDocumentUnderstandingSummary(item, {
    recognizedText: getInboxExtractedDocumentText(item),
  });
  const kind = (item.classifiedKind ?? summary.documentType) as ClassifiedDocumentKind;
  const typeLabelKey = getDocumentDisplayLabelKey(kind, item.documentType);

  if (matches(normalized, QUESTION_PATTERNS.pay)) {
    if (summary.amount && (kind === 'mahnung' || kind === 'zahlungserinnerung' || kind === 'eingangsrechnung')) {
      return {
        answerKey: 'docAssistant.answer.payYesCheck',
        params: { amount: summary.amount, deadline: summary.deadline ?? item.deadline ?? '—' },
      };
    }
    if (summary.amount) {
      return {
        answerKey: 'docAssistant.answer.payCheckAmount',
        params: { amount: summary.amount },
        uncertain: true,
      };
    }
    return {
      answerKey: 'docAssistant.answer.payUncertain',
      uncertain: true,
      followUpKey: 'docAssistant.answer.payFollowUp',
    };
  }

  if (matches(normalized, QUESTION_PATTERNS.why)) {
    return {
      answerKey: 'docAssistant.answer.whyReceived',
      params: {
        sender: assistant.sender ?? item.sender ?? '—',
        typeKey: typeLabelKey,
      },
    };
  }

  if (matches(normalized, QUESTION_PATTERNS.deadline)) {
    if (summary.deadline || item.deadline) {
      return {
        answerKey: 'docAssistant.answer.deadlineKnown',
        params: { deadline: summary.deadline ?? item.deadline ?? '—' },
      };
    }
    return {
      answerKey: 'docAssistant.answer.deadlineUnknown',
      uncertain: true,
      followUpKey: 'docAssistant.answer.deadlineFollowUp',
    };
  }

  if (matches(normalized, QUESTION_PATTERNS.ignore)) {
    if (assistant.inactionConsequence) {
      return { answerKey: assistant.inactionConsequence.key, params: assistant.inactionConsequence.params };
    }
    return { answerKey: 'docAssistant.answer.ignoreNoRisk' };
  }

  if (matches(normalized, QUESTION_PATTERNS.tax)) {
    return {
      answerKey: assistant.steuerberaterReasonKey,
      params: { status: assistant.steuerberaterStatus },
    };
  }

  if (matches(normalized, QUESTION_PATTERNS.file)) {
    return {
      answerKey: 'docAssistant.answer.filing',
      params: {
        digital: assistant.digitalPath,
        paper: assistant.paperFolderLabel,
      },
    };
  }

  if (matches(normalized, QUESTION_PATTERNS.dispose)) {
    const guidanceKey =
      assistant.originalGuidance === 'keep_until_tax'
        ? 'docAssistant.answer.disposeKeepTax'
        : assistant.originalGuidance === 'keep'
          ? 'docAssistant.answer.disposeKeep'
          : assistant.originalGuidance === 'dispose_after_digital'
            ? 'docAssistant.answer.disposeOk'
            : 'docAssistant.answer.disposeUncertain';
    return {
      answerKey: guidanceKey,
      uncertain: assistant.originalGuidance === 'uncertain',
    };
  }

  return {
    answerKey: 'docAssistant.answer.genericUncertain',
    uncertain: true,
    followUpKey: 'docAssistant.answer.genericFollowUp',
  };
}

export function answerInboxDocumentQuestionById(
  item: InboxItem,
  assistant: InboxDocumentAssistant,
  suggestionId: string,
): DocumentQuestionAnswer {
  const suggestion = DOCUMENT_QUESTION_SUGGESTIONS.find((entry) => entry.id === suggestionId);
  if (!suggestion) {
    return answerInboxDocumentQuestion(item, assistant, suggestionId);
  }
  return answerInboxDocumentQuestion(item, assistant, suggestion.id);
}
