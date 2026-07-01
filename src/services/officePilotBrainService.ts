import { runAiRequest, setAiGenerateTextForTests } from './ai/aiRequestRunner';

import { buildBrainPrompt } from './brain/brainPromptBuilder';

import { buildBrainSnapshot } from './brain/brainSnapshotService';

import { BRAIN_ANSWER_DISCLAIMER, type BrainAnswer } from '../types/brain';



export function setBrainGenerateTextForTests(

  fn: Parameters<typeof setAiGenerateTextForTests>[0],

): void {

  setAiGenerateTextForTests(fn);

}



function unavailableAnswer(question: string, text: string, errorCode?: string): BrainAnswer {

  return {

    question,

    text,

    source: 'unavailable',

    disclaimer: BRAIN_ANSWER_DISCLAIMER,

    generatedAt: new Date().toISOString(),

    errorCode,

  };

}



export async function askOfficePilotBrain(question: string): Promise<BrainAnswer> {

  const trimmedQuestion = question.trim();

  if (!trimmedQuestion) {

    return unavailableAnswer('', 'Bitte geben Sie eine Frage ein.', 'invalid_prompt');

  }



  const snapshot = buildBrainSnapshot();

  const prompt = buildBrainPrompt(trimmedQuestion, snapshot);

  const result = await runAiRequest({ prompt, skipGuard: true });



  if (result.source === 'unavailable') {

    return unavailableAnswer(

      trimmedQuestion,

      result.message ?? 'Ausführliche Antwort ist derzeit nicht verfügbar.',

      result.errorCode,

    );

  }



  if (!result.success || !result.text) {

    return unavailableAnswer(trimmedQuestion, result.message ?? 'KI-Antwort fehlgeschlagen.', result.errorCode);

  }



  return {

    question: trimmedQuestion,

    text: result.text,

    source: 'ai',

    disclaimer: BRAIN_ANSWER_DISCLAIMER,

    generatedAt: new Date().toISOString(),

  };

}



export { buildBrainSnapshot, buildBrainPrompt };


