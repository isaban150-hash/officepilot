import { validateAiOutput } from '../ai/aiOutputGuardService';

export interface CommunicationAiGuardInput {
  originalText: string;
  enhancedText: string;
  allowedSourceText: string;
}

export interface CommunicationAiGuardResult {
  valid: boolean;
  warnings: string[];
}

export function validateEnhancedCommunicationText(
  input: CommunicationAiGuardInput,
): CommunicationAiGuardResult {
  return validateAiOutput(input.enhancedText, 'enhance', {
    originalText: input.originalText,
    allowedSourceText: input.allowedSourceText,
  });
}
