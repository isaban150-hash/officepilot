import { getCachedSetup } from '../persistenceService';
import { runAiRequest } from '../ai/aiRequestRunner';
import {
  buildVorgangAiAllowedSourceText,
  buildVorgangAiContext,
} from './vorgangAiContextService';
import { buildVorgangAiPrompt } from './vorgangAiPromptBuilder';
import { AREA_AI_DISCLAIMER, type AreaAiAnswer } from '../../types/areaAi';

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

export async function askVorgangAi(input: {
  vorgangId: string;
  question: string;
}): Promise<AreaAiAnswer> {
  const trimmedQuestion = input.question.trim();
  if (!trimmedQuestion) {
    return unavailableAnswer('', 'Bitte geben Sie eine Frage ein.', 'invalid_prompt');
  }

  const context = buildVorgangAiContext(input.vorgangId);
  if (!context) {
    return unavailableAnswer(trimmedQuestion, 'Vorgang nicht gefunden.', 'not_found');
  }

  const lang = getCachedSetup().language;
  const prompt = buildVorgangAiPrompt(trimmedQuestion, context, lang);
  const allowedSourceText = buildVorgangAiAllowedSourceText(context);

  const result = await runAiRequest({
    operation: 'vorgang_question',
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

export { buildVorgangAiContext, buildVorgangAiPrompt };
