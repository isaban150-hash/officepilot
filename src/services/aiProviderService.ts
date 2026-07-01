import { geminiGenerateText } from './ai/geminiProvider';
import { getGeminiApiKey, getGeminiModel, isGeminiConfigured } from './ai/aiEnv';
import type { GenerateTextResult } from '../types/ai';

type FetchOverride = typeof fetch;

let fetchOverride: FetchOverride | null = null;

export function setAiProviderFetchForTests(fetchFn: FetchOverride | null): void {
  fetchOverride = fetchFn;
}

export function isAiProviderConfigured(): boolean {
  return isGeminiConfigured();
}

export async function generateText(prompt: string): Promise<GenerateTextResult> {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    return {
      success: false,
      errorCode: 'invalid_prompt',
      message: 'Prompt darf nicht leer sein.',
    };
  }

  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return {
      success: false,
      errorCode: 'missing_api_key',
      message: 'Verbindung für ausführliche Antworten ist nicht eingerichtet.',
    };
  }

  return geminiGenerateText(trimmedPrompt, {
    apiKey,
    model: getGeminiModel(),
    fetchFn: fetchOverride ?? undefined,
  });
}
