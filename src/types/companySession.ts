import type { CommunicationContextRef } from './communication';

export type CompanySessionAction =
  | 'view_inbox'
  | 'view_document'
  | 'view_vorgang'
  | 'view_invoice'
  | 'upload_document'
  | 'accept_contract'
  | 'ask_assistant';

export interface CompanySessionContext {
  updatedAt: string;
  currentInboxId?: string;
  currentDocumentId?: string;
  currentVorgangId?: string;
  currentVorgangTitle?: string;
  currentCustomer?: string;
  currentBaustelle?: string;
  currentDocumentKind?: string;
  currentDocumentTitle?: string;
  contractTotalNet?: string;
  contractPositionCount?: number;
  lastUploadInboxId?: string;
  lastUploadTitle?: string;
  lastInvoiceId?: string;
  lastInvoiceVorgangId?: string;
  lastAction?: CompanySessionAction;
  conversationTurns: string[];
}

export interface ProactiveHint {
  messageKey: string;
  params?: Record<string, string | number>;
}

export interface CompanyContextResolution {
  source: 'memory' | 'rules' | 'clarification';
  assistantAnswer?: {
    title: string;
    summary: string;
    bullets: string[];
    actions: [];
    linkedRoute?: string;
  };
  suggestedNextSteps?: import('./brainOrchestration').BrainSuggestedStep[];
  uncertaintyNote?: string;
  clarificationQuestion?: string;
  contextUsed: string[];
}

export type { CommunicationContextRef };
