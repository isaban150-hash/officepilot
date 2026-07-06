import type { GeminiGenerateContentResponse, GenerateTextResult } from '../../types/ai';
import { DEFAULT_GEMINI_MODEL } from './aiEnv';

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
  fetchFn?: typeof fetch;
}

function extractTextFromResponse(data: GeminiGenerateContentResponse): string {
  return (
    data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('\n')
      .trim() ?? ''
  );
}

export async function geminiGenerateText(
  prompt: string,
  options: GeminiProviderOptions,
): Promise<GenerateTextResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const apiKey = options.apiKey.trim();

  const response = await fetchFn(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    },
  );

  let data: GeminiGenerateContentResponse;
  try {
    data = (await response.json()) as GeminiGenerateContentResponse;
  } catch {
    return {
      success: false,
      errorCode: 'api_error',
      message: 'Die Antwort konnte nicht gelesen werden. Bitte versuchen Sie es erneut.',
    };
  }

  if (!response.ok) {
    return {
      success: false,
      errorCode: 'api_error',
      message: 'Der KI-Dienst ist gerade nicht erreichbar. Bitte versuchen Sie es später erneut.',
    };
  }

  const text = extractTextFromResponse(data);
  if (!text) {
    return {
      success: false,
      errorCode: 'empty_response',
      message: 'Es wurde keine Antwort erhalten. Bitte versuchen Sie es erneut.',
    };
  }

  return { success: true, text };
}
