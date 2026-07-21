import type { ClassifiedDocumentKind } from './models';

export type CommunicationIntent =
  | 'price_adjustment'
  | 'cancel_order'
  | 'decline_offer'
  | 'appointment_change'
  | 'delay_notice'
  | 'additional_work'
  | 'payment_reminder'
  | 'dunning_notice'
  | 'invoice_followup'
  | 'document_reply'
  | 'document_question'
  | 'translate_message'
  | 'improve_text'
  | 'rewrite_message'
  | 'unknown';

export type CommunicationChannel = 'email' | 'whatsapp' | 'letter';

export type CommunicationMode = 'draft' | 'question' | 'explain' | 'rewrite';

export type RewriteStyle =
  | 'polite'
  | 'assertive'
  | 'professional'
  | 'shorter'
  | 'longer'
  | 'friendly';

export type DocumentQuestionType =
  | 'what_wanted'
  | 'deadline'
  | 'missing_docs'
  | 'next_step'
  | 'importance'
  | 'draft_reply'
  | 'custom';

export interface CommunicationContextRef {
  type: 'inbox' | 'document' | 'vorgang' | 'invoice' | 'expense' | 'mail' | 'none';
  id?: string;
  vorgangId?: string;
}

export interface CommunicationFact {
  key: string;
  value: string;
  source: 'user' | 'document' | 'system' | 'note' | 'knowledge';
}

export interface CommunicationLetterSummary {
  kind: string;
  about: string;
  importance: string;
  deadline: string;
  nextSteps: string;
}

export interface CommunicationVorgangSummary {
  id: string;
  title: string;
  customer: string;
  baustelle: string;
}

export interface CommunicationInvoiceSummary {
  id: string;
  number: string;
  amount: number;
  openAmount: number;
  dueDate?: string;
  vorgangTitle?: string;
}

export interface CommunicationExpenseSummary {
  id: string;
  supplierName: string;
  title: string;
  grossAmount: number;
  openAmount: number;
  dueDate?: string | null;
}

export interface CommunicationContext {
  ref: CommunicationContextRef;
  companyName: string;
  recipient?: { name: string; organization?: string };
  subject?: string;
  facts: CommunicationFact[];
  recognizedText?: string;
  recognizedData?: Record<string, string>;
  classifiedKind?: ClassifiedDocumentKind;
  letterExplanation?: CommunicationLetterSummary | null;
  contractRequiredDocuments?: string[];
  relevanceAllowed: boolean;
  relevanceBlockReason?: string;
  disclaimer: string;
  vorgangSummary?: CommunicationVorgangSummary;
  invoiceSummary?: CommunicationInvoiceSummary;
  expenseSummary?: CommunicationExpenseSummary;
}

export interface CommunicationRequest {
  userText: string;
  mode?: CommunicationMode;
  contextRef?: CommunicationContextRef;
  channel?: CommunicationChannel;
  userAnswers?: Record<string, string>;
  rewriteStyle?: RewriteStyle;
}

export interface MissingCommunicationInfo {
  fieldId: string;
  labelKey: string;
  promptKey: string;
  required: boolean;
  inputType: 'text' | 'number' | 'date' | 'select';
  options?: string[];
}

export interface CommunicationDraftCore {
  intent: CommunicationIntent;
  subject?: string;
  body: string;
  tone: 'formal' | 'neutral' | 'short';
  basedOnFacts: string[];
  notIncluded: string[];
}

export interface CommunicationDraft {
  intent: CommunicationIntent;
  channel: CommunicationChannel;
  subject?: string;
  greeting?: string;
  body: string;
  closing?: string;
  tone: 'formal' | 'neutral' | 'short';
  basedOnFacts: string[];
  notIncluded: string[];
}

export interface DocumentQuestionResult {
  questionType: DocumentQuestionType;
  answer: string;
  bullets: string[];
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
  uncertain: boolean;
}

export interface CommunicationResult {
  mode: CommunicationMode;
  intent: CommunicationIntent;
  status: 'complete' | 'needs_info' | 'blocked' | 'no_data';
  title: string;
  summary: string;
  missingInfo?: MissingCommunicationInfo[];
  documentQa?: DocumentQuestionResult;
  drafts?: Partial<Record<CommunicationChannel, CommunicationDraft>>;
  disclaimer: string;
}

export type VorgangNoteSource = 'user' | 'communication' | 'assistant';

import type { SyncMeta } from './sync';

export interface VorgangNote {
  id: string;
  vorgangId: string;
  vorgangTitle: string;
  body: string;
  tags?: string[];
  occurredAt: string;
  createdAt: string;
  updatedAt?: string;
  source: VorgangNoteSource;
  linkedCommunicationEventId?: string;
  linkedInboxId?: string;
  pinned?: boolean;
  sync?: SyncMeta;
}

export interface VorgangNoteInput {
  body: string;
  tags?: string[];
  occurredAt?: string;
  source?: VorgangNoteSource;
  linkedInboxId?: string;
}
