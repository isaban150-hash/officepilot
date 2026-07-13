import { runAiRequest, setAiGenerateTextForTests } from '../ai/aiRequestRunner';
import { getCachedSetup } from '../persistenceService';

import type {

  CommunicationAiEnhanceInput,

  CommunicationAiEnhanceResult,

} from '../../types/communicationAi';

import {

  buildCommunicationAiAllowedSourceText,

  buildCommunicationAiPrompt,

} from './communicationAiPromptBuilder';



export function setCommunicationAiGenerateTextForTests(

  fn: Parameters<typeof setAiGenerateTextForTests>[0],

): void {

  setAiGenerateTextForTests(fn);

}



function unavailableResult(message: string): CommunicationAiEnhanceResult {

  return {

    success: false,

    source: 'unavailable',

    message,

  };

}



function fallbackResult(

  input: CommunicationAiEnhanceInput,

  message: string,

  warnings?: string[],

): CommunicationAiEnhanceResult {

  return {

    success: false,

    source: 'rule_fallback',

    enhancedDraft: input.draft,

    message,

    warnings,

  };

}



export async function enhanceCommunicationDraft(

  input: CommunicationAiEnhanceInput,

): Promise<CommunicationAiEnhanceResult> {

  const lang = getCachedSetup()?.language ?? 'de';
  const prompt = buildCommunicationAiPrompt(input, lang);

  const generation = await runAiRequest({

    prompt,

    guardProfile: 'enhance',

    guardContext: {

      originalText: input.draft.body,

      allowedSourceText: buildCommunicationAiAllowedSourceText(input),

    },

  });



  if (generation.source === 'unavailable') {

    return unavailableResult(

      generation.message ??

        'Ausführliche Formulierung ist derzeit nicht verfügbar.',

    );

  }



  if (generation.source === 'rule_fallback' || !generation.text) {

    return fallbackResult(

      input,

      generation.message ?? 'KI-Vorschlag verworfen – Original-Entwurf beibehalten.',

      generation.warnings ?? (generation.errorCode ? [generation.errorCode] : undefined),

    );

  }



  return {

    success: true,

    source: 'ai',

    enhancedDraft: {

      ...input.draft,

      body: generation.text,

    },

  };

}



export { buildCommunicationAiPrompt, buildCommunicationAiAllowedSourceText };


