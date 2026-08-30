import { generateText, isAiProviderConfigured } from '../aiProviderService';
import { validateAiOutput } from './aiOutputGuardService';
import type { AiRequestInput, AiResult, GenerateTextResult } from '../../types/ai';

type GenerateTextFn = (prompt: string) => Promise<GenerateTextResult>;


let generateTextOverride: GenerateTextFn | null = null;

export function setAiGenerateTextForTests(fn: GenerateTextFn | null): void {
  generateTextOverride = fn;
}

async function runGenerateText(
  operation: AiRequestInput['operation'],
  prompt: string,
): Promise<GenerateTextResult> {
  if (generateTextOverride) {
    return generateTextOverride(prompt);
  }
  return generateText(operation, prompt);
}

export async function runAiRequest(input: AiRequestInput): Promise<AiResult> {
  const trimmedPrompt = input.prompt.trim();
  if (!trimmedPrompt) {
    return {
      success: false,
      source: 'unavailable',
      message: 'Prompt darf nicht leer sein.',
      errorCode: 'invalid_prompt',
    };
  }

  if (!isAiProviderConfigured()) {
    return {
      success: false,
      source: 'unavailable',
      message: 'Ausführliche Antwort ist derzeit nicht verfügbar.',
      errorCode: 'missing_api_key',
    };
  }

  const generation = await runGenerateText(input.operation, trimmedPrompt);
  if (!generation.success) {
    return {
      success: false,
      source: 'rule_fallback',
      message: generation.message,
      errorCode: generation.errorCode,
      warnings: [generation.errorCode],
    };
  }

  const text = generation.text.trim();
  if (input.skipGuard || !input.guardProfile) {
    return {
      success: true,
      source: 'ai',
      text,
    };
  }

  const guard = validateAiOutput(text, input.guardProfile, input.guardContext ?? {});
  if (!guard.valid) {
    return {
      success: false,
      source: 'rule_fallback',
      text,
      message: 'KI-Antwort verworfen – bitte Originaldaten prüfen.',
      errorCode: 'guard_rejected',
      warnings: guard.warnings,
    };
  }

  return {
    success: true,
    source: 'ai',
    text,
  };
}

export { isAiProviderConfigured };
