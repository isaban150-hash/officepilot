import { runAiRequest } from '../ai/aiRequestRunner';
import {
  buildDocumentAiAllowedSourceText as buildAllowedFromContext,
  buildDocumentAiContextFromDocument,
  buildDocumentAiContextFromInbox,
} from './documentAiContextService';
import { buildDocumentAiPrompt } from './documentAiPromptBuilder';
import { AREA_AI_DISCLAIMER, type AreaAiAnswer, type DocumentAiContext } from '../../types/areaAi';
import type { CompanyDocument, InboxItem } from '../../types/models';

export type DocumentAiSource =
  | { type: 'document'; document: CompanyDocument }
  | { type: 'inbox'; item: InboxItem };

function unavailableAnswer(
  question: string,
  text: string,
  errorCode?: string,
  warnings?: string[],
): AreaAiAnswer {
  return {
    question,
    text,
    source: 'unavailable',
    disclaimer: AREA_AI_DISCLAIMER,
    generatedAt: new Date().toISOString(),
    errorCode,
    warnings,
  };
}

function buildContext(source: DocumentAiSource): DocumentAiContext {
  if (source.type === 'document') {
    return buildDocumentAiContextFromDocument(source.document);
  }
  return buildDocumentAiContextFromInbox(source.item);
}

export async function askDocumentAi(input: {
  source: DocumentAiSource;
  question: string;
}): Promise<AreaAiAnswer> {
  const trimmedQuestion = input.question.trim();
  if (!trimmedQuestion) {
    return unavailableAnswer('', 'Bitte geben Sie eine Frage ein.', 'invalid_prompt');
  }

  const context = buildContext(input.source);
  const prompt = buildDocumentAiPrompt(trimmedQuestion, context);
  const allowedSourceText = buildAllowedFromContext(context);

  const result = await runAiRequest({
    prompt,
    guardProfile: 'qa',
    guardContext: { allowedSourceText },
  });

  if (result.source === 'unavailable') {
    return unavailableAnswer(trimmedQuestion, result.message ?? 'KI nicht verfügbar.', result.errorCode);
  }

  if (result.source === 'rule_fallback' || !result.text) {
    return unavailableAnswer(
      trimmedQuestion,
      result.message ?? 'KI-Antwort konnte nicht erstellt werden.',
      result.errorCode,
      result.warnings,
    );
  }

  return {
    question: trimmedQuestion,
    text: result.text,
    source: 'ai',
    disclaimer: AREA_AI_DISCLAIMER,
    generatedAt: new Date().toISOString(),
    warnings: result.warnings,
  };
}

export { buildDocumentAiContextFromDocument, buildDocumentAiContextFromInbox, buildDocumentAiPrompt };
