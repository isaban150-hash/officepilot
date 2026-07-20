import type { CommunicationContextRef } from './communication';
import type { DocumentConfirmedReplyDraftFact } from './documentConfirmedReplyDraft';

export const DOCUMENT_REPLY_DRAFT_HANDOFF_SCHEMA_VERSION = 1 as const;

export const DOCUMENT_REPLY_DRAFT_HANDOFF_STATE_KEY = 'documentReplyDraftHandoff' as const;

/**
 * One-time navigation/session handoff from inbox reply draft → Kommunikation.
 * Not persisted beyond the navigation state; consumed on first apply.
 */
export interface DocumentReplyDraftHandoffPayload {
  readonly schemaVersion: typeof DOCUMENT_REPLY_DRAFT_HANDOFF_SCHEMA_VERSION;
  readonly contextRef: CommunicationContextRef;
  /** Same as contextRef.id for inbox documents. */
  readonly documentId: string;
  readonly draftText: string;
  readonly coreMessage: string;
  readonly considered: readonly DocumentConfirmedReplyDraftFact[];
  readonly notIncluded: readonly string[];
  readonly subject?: string;
  readonly sender?: string;
}

export type DocumentReplyDraftHandoffLocationState = {
  readonly [DOCUMENT_REPLY_DRAFT_HANDOFF_STATE_KEY]?: DocumentReplyDraftHandoffPayload;
};
