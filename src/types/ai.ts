export type AiProviderErrorCode =
  | 'missing_api_key'
  | 'invalid_prompt'
  | 'api_error'
  | 'empty_response'
  | 'guard_rejected';

export type GenerateTextResult =
  | { success: true; text: string }
  | { success: false; errorCode: AiProviderErrorCode; message: string };

export type AiResultSource = 'ai' | 'unavailable' | 'rule_fallback';

export type AiGuardProfile = 'qa' | 'enhance';

export interface AiGuardContext {
  originalText?: string;
  allowedSourceText?: string;
}

export interface AiRequestInput {
  prompt: string;
  guardProfile?: AiGuardProfile;
  guardContext?: AiGuardContext;
  skipGuard?: boolean;
}

export interface AiResult {
  success: boolean;
  text?: string;
  source: AiResultSource;
  warnings?: string[];
  message?: string;
  errorCode?: string;
}

export interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: {
    message?: string;
    status?: string;
  };
}
