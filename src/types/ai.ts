/**
 * SECURITY-GEMINI-KEY-01B — die fünf produktiven KI-Fachketten.
 *
 * Der Server erlaubt Operationen, nicht beliebige Gemini-Aufrufe. Deshalb muss
 * jede Kette sich benennen; der Server leitet daraus Modell, Größengrenze und
 * Zählklasse ab.
 */
export type AiOperation =
  | 'document_question'
  | 'document_facts'
  | 'communication_draft'
  | 'assistant'
  | 'vorgang_question';

export type AiProviderErrorCode =
  | 'missing_api_key'
  | 'invalid_prompt'
  | 'api_error'
  | 'empty_response'
  | 'guard_rejected'
  /* Ab 01B: Codes des OfficePilot-KI-Endpunkts. */
  | 'unauthenticated'
  | 'forbidden'
  | 'license_inactive'
  | 'workspace_forbidden'
  | 'rate_limited'
  | 'payload_too_large'
  | 'ai_timeout'
  | 'server_misconfigured';

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
  /** Welche Fachkette fragt — der Server erlaubt nur diese fünf. */
  operation: AiOperation;
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
