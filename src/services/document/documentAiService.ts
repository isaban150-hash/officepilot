import { getCachedSetup } from '../persistenceService';
import { runAiRequest } from '../ai/aiRequestRunner';
import {
  buildDocumentAiAllowedSourceText as buildAllowedFromContext,
  buildDocumentAiContextFromDocument,
  buildDocumentAiContextFromInbox,
} from './documentAiContextService';
import { buildDocumentAiPrompt } from './documentAiPromptBuilder';
import { parseDocumentAiAnswer } from './documentAiAnswerParser';
import { filterUncertaintyNotesForQuestion } from './documentAiQuestionIntent';
import { t } from '../../i18n';
import { AREA_AI_DISCLAIMER, type AreaAiAnswer, type DocumentAiContext } from '../../types/areaAi';
import type { AppLanguage, CompanyDocument, InboxItem } from '../../types/models';

export type DocumentAiSource =
  | { type: 'document'; document: CompanyDocument }
  | { type: 'inbox'; item: InboxItem };

function unavailableAnswer(
  question: string,
  text: string,
  errorCode?: string,
  uncertaintyNotes: string[] = [],
  warnings?: string[],
): AreaAiAnswer {
  const notes = uncertaintyNotes.length > 0 ? uncertaintyNotes : undefined;
  const parsed = parseDocumentAiAnswer(text);
  return {
    question,
    text: parsed.text || text,
    directAnswer: parsed.directAnswer || text,
    explanation: parsed.explanation || undefined,
    source: 'unavailable',
    disclaimer: AREA_AI_DISCLAIMER,
    generatedAt: new Date().toISOString(),
    errorCode,
    warnings,
    uncertain: true,
    uncertaintyNotes: notes,
  };
}

function buildContext(source: DocumentAiSource): DocumentAiContext {
  if (source.type === 'document') {
    return buildDocumentAiContextFromDocument(source.document);
  }
  return buildDocumentAiContextFromInbox(source.item);
}

function collectAnswerUncertainty(
  question: string,
  context: DocumentAiContext,
  warnings: string[] | undefined,
  lang: AppLanguage,
): string[] {
  const notes = [
    ...context.missingFieldNotes,
    ...context.uncertainFieldNotes,
    ...(warnings ?? []),
  ];
  if (!context.recognizedText?.trim()) {
    notes.push(t('document.freeQuestion.note.cannotAnswerFromDocument', lang));
  }
  const deduped = Array.from(new Set(notes.filter(Boolean)));
  return filterUncertaintyNotesForQuestion(question, deduped, lang);
}

export async function askDocumentAi(input: {
  source: DocumentAiSource;
  question: string;
}): Promise<AreaAiAnswer> {
  const lang = getCachedSetup().language;
  const trimmedQuestion = input.question.trim();
  if (!trimmedQuestion) {
    return unavailableAnswer(
      '',
      t('document.freeQuestion.error.empty', lang),
      'invalid_prompt',
    );
  }

  const context = buildContext(input.source);
  const prompt = buildDocumentAiPrompt(trimmedQuestion, context, lang);
  const allowedSourceText = buildAllowedFromContext(context);

  const result = await runAiRequest({
    prompt,
    guardProfile: 'qa',
    guardContext: { allowedSourceText },
  });

  const uncertaintyNotes = collectAnswerUncertainty(
    trimmedQuestion,
    context,
    result.warnings,
    lang,
  );

  if (result.source === 'unavailable') {
    return unavailableAnswer(
      trimmedQuestion,
      result.message ?? t('document.freeQuestion.error.unavailable', lang),
      result.errorCode,
      uncertaintyNotes,
    );
  }

  if (result.source === 'rule_fallback' || !result.text) {
    return unavailableAnswer(
      trimmedQuestion,
      result.message ?? t('document.freeQuestion.error.failed', lang),
      result.errorCode,
      uncertaintyNotes,
      result.warnings,
    );
  }

  const parsed = parseDocumentAiAnswer(result.text);

  return {
    question: trimmedQuestion,
    text: parsed.text,
    directAnswer: parsed.directAnswer,
    explanation: parsed.explanation || undefined,
    source: 'ai',
    disclaimer: AREA_AI_DISCLAIMER,
    generatedAt: new Date().toISOString(),
    warnings: result.warnings,
    uncertain: uncertaintyNotes.length > 0,
    uncertaintyNotes: uncertaintyNotes.length > 0 ? uncertaintyNotes : undefined,
  };
}

export {
  buildDocumentAiContextFromDocument,
  buildDocumentAiContextFromInbox,
  buildDocumentAiPrompt,
  filterUncertaintyNotesForQuestion,
  parseDocumentAiAnswer,
};
