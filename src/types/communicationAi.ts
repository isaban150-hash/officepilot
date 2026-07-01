import type {
  CommunicationChannel,
  CommunicationContext,
  CommunicationDraft,
  RewriteStyle,
} from './communication';

export type CommunicationAiEnhanceStyle = Extract<
  RewriteStyle,
  'polite' | 'professional' | 'shorter' | 'longer' | 'friendly' | 'assertive'
>;

export type CommunicationAiEnhanceSource = 'ai' | 'rule_fallback' | 'unavailable';

export interface CommunicationAiEnhanceInput {
  context: CommunicationContext;
  draft: CommunicationDraft;
  channel: CommunicationChannel;
  style: CommunicationAiEnhanceStyle;
}

export interface CommunicationAiEnhanceResult {
  success: boolean;
  source: CommunicationAiEnhanceSource;
  enhancedDraft?: CommunicationDraft;
  warnings?: string[];
  message?: string;
}
