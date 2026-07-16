import { t, type TranslationKey } from '../../i18n';
import type { AppLanguage } from '../../types/models';

export type DocumentQuestionIntent =
  | 'payment'
  | 'deadline'
  | 'sender'
  | 'required_documents'
  | 'filing'
  | 'customer_or_order'
  | 'general';

type NoteRelevance = 'always' | DocumentQuestionIntent;

const NOTE_KEYS = [
  'document.freeQuestion.note.noRecognizedText',
  'document.freeQuestion.note.noDeadline',
  'document.freeQuestion.note.noSender',
  'document.freeQuestion.note.customerUncertain',
  'document.freeQuestion.note.documentTypeUncertain',
  'document.freeQuestion.note.amountNeedsReview',
  'document.freeQuestion.note.cannotAnswerFromDocument',
  'document.freeQuestion.note.testOrSample',
] as const satisfies readonly TranslationKey[];

type QualityNoteKey = (typeof NOTE_KEYS)[number];

/** Which question intents make a quality note relevant. */
const NOTE_RELEVANCE: Record<QualityNoteKey, NoteRelevance[]> = {
  'document.freeQuestion.note.noRecognizedText': ['always'],
  'document.freeQuestion.note.cannotAnswerFromDocument': ['always'],
  'document.freeQuestion.note.testOrSample': ['payment', 'deadline'],
  'document.freeQuestion.note.noDeadline': ['deadline'],
  'document.freeQuestion.note.noSender': ['sender'],
  'document.freeQuestion.note.customerUncertain': ['customer_or_order'],
  'document.freeQuestion.note.documentTypeUncertain': [
    'payment',
    'required_documents',
    'filing',
  ],
  'document.freeQuestion.note.amountNeedsReview': ['payment'],
};

/** Leading boundary that works for Latin and Cyrillic (JS `\b` does not). */
const WB = '(?:^|[^\\p{L}\\p{N}_])';

const INTENT_PATTERNS: Array<{ intent: Exclude<DocumentQuestionIntent, 'general'>; pattern: RegExp }> =
  [
    {
      intent: 'payment',
      pattern: new RegExp(
        `${WB}(?:zahl(?:en|ung|ungs)?|bezahl|überweis|betrag|rechnung|forderung|offen(?:er)?\\s+betrag|kosten|preis|ödem|tutar|fatura|bor[cç]|плат(?:я|и|а)|сума|сметк|фактур)`,
        'iu',
      ),
    },
    {
      intent: 'deadline',
      pattern: new RegExp(
        `${WB}(?:frist|termin|fällig|deadline|gültig(?:keit)?|bis\\s+wann|süre|son\\s*tarih|vade|bitiş|срок|краен\\s*срок|валидн|до\\s*кога)`,
        'iu',
      ),
    },
    {
      intent: 'sender',
      pattern: new RegExp(
        `${WB}(?:absender|sender|absenderin|von\\s+wem|wer\\s+hat|wer\\s+schick|gönderen|kimden|kim\\s+gönder|подател|от\\s+кого|изпращач)`,
        'iu',
      ),
    },
    {
      intent: 'required_documents',
      pattern: new RegExp(
        `${WB}(?:unterlagen|anlage(?:n)?|anhang|belege|fehlende\\s+dokument|welche\\s+dokumente|ek(?:ler)?|belgeler|eksik\\s+belge|приложен|документи|липсващ)`,
        'iu',
      ),
    },
    {
      intent: 'filing',
      pattern: new RegExp(
        `${WB}(?:ablage|ordner|akte|archiv(?:ieren)?|wo\\s+ablegen|klasör|dosya|arşiv|архив|папк|къде\\s+да\\s+сложа)`,
        'iu',
      ),
    },
    {
      intent: 'customer_or_order',
      pattern: new RegExp(
        `${WB}(?:kunde|auftrag|vorgang|projekt|kundenakte|müşteri|iş(?:emri)?|sipariş|proje|клиент|поръчк|проект|поръчка)`,
        'iu',
      ),
    },
  ];

const ALL_LANGS: AppLanguage[] = ['de', 'tr', 'bg'];

export function detectDocumentQuestionIntents(question: string): Set<DocumentQuestionIntent> {
  const intents = new Set<DocumentQuestionIntent>();
  const trimmed = question.trim();
  if (!trimmed) {
    intents.add('general');
    return intents;
  }

  for (const { intent, pattern } of INTENT_PATTERNS) {
    if (pattern.test(trimmed)) {
      intents.add(intent);
    }
  }

  if (intents.size === 0) {
    intents.add('general');
  }
  return intents;
}

function resolveNoteKey(note: string): QualityNoteKey | null {
  const trimmed = note.trim();
  if (!trimmed) return null;

  for (const key of NOTE_KEYS) {
    for (const lang of ALL_LANGS) {
      if (t(key, lang) === trimmed) {
        return key;
      }
    }
  }
  return null;
}

function isNoteRelevantForIntents(
  key: QualityNoteKey | null,
  intents: Set<DocumentQuestionIntent>,
  question: string,
): boolean {
  // Guard / unknown notes: keep — they reflect answer safety, not document metadata noise.
  if (!key) return true;

  const relevance = NOTE_RELEVANCE[key];
  if (relevance.includes('always')) return true;

  // Filing questions only surface customer/order uncertainty when the question
  // also asks about customer/order filing.
  if (key === 'document.freeQuestion.note.customerUncertain' && intents.has('filing')) {
    return intents.has('customer_or_order') || INTENT_PATTERNS.find((p) => p.intent === 'customer_or_order')!.pattern.test(question);
  }

  if (intents.has('general') && intents.size === 1) {
    return false;
  }

  return relevance.some((r) => r !== 'always' && intents.has(r));
}

/**
 * Keeps only uncertainty notes that matter for the concrete user question.
 * Quality notes remain available upstream; this only filters the question-scoped set.
 */
export function filterUncertaintyNotesForQuestion(
  question: string,
  notes: string[],
  _locale: AppLanguage = 'de',
): string[] {
  const intents = detectDocumentQuestionIntents(question);
  return notes.filter((note) => {
    const key = resolveNoteKey(note);
    return isNoteRelevantForIntents(key, intents, question);
  });
}

export function applyQuestionScopedQualityNotes(
  question: string,
  context: {
    missingFieldNotes: string[];
    uncertainFieldNotes: string[];
  },
  locale: AppLanguage,
): { missingFieldNotes: string[]; uncertainFieldNotes: string[] } {
  return {
    missingFieldNotes: filterUncertaintyNotesForQuestion(
      question,
      context.missingFieldNotes,
      locale,
    ),
    uncertainFieldNotes: filterUncertaintyNotesForQuestion(
      question,
      context.uncertainFieldNotes,
      locale,
    ),
  };
}
