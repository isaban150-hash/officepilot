import type {
  CommunicationChannel,
  CommunicationContextRef,
  CommunicationIntent,
} from './communication';
import type { SyncMeta } from './sync';

export type CommunicationEventType =
  | 'document_question'
  | 'document_answer'
  | 'draft_created'
  | 'draft_copied'
  | 'draft_channel_switched'
  | 'marked_answered'
  | 'marked_no_reply_needed'
  | 'marked_remind_later';

export type CommunicationReplyStatus =
  | 'needs_reply'
  | 'draft_ready'
  | 'copied'
  | 'answered'
  | 'no_reply_needed';

export type CommunicationEventStatus = 'complete' | 'needs_info' | 'blocked';

/**
 * P1 EINGANGSSCHREIBEN — worauf ein „beantwortet" verweist: der erzeugte Brief
 * oder die gesendete E-Mail. Nur Nachweis; der Antwortstatus ist das Ereignis
 * selbst, nicht diese Referenz.
 */
export interface CommunicationAnswerRef {
  kind: 'letter' | 'email';
  id: string;
}

export interface CommunicationEvent {
  id: string;
  timestamp: string;
  type: CommunicationEventType;
  intent?: CommunicationIntent;
  channel?: CommunicationChannel;
  contextRef: CommunicationContextRef;
  status: CommunicationEventStatus;
  userInputExcerpt?: string;
  resultExcerpt?: string;
  disclaimerShown: boolean;
  /** P1 — nur bei „beantwortet": die Antwort, mit der das Schreiben erledigt wurde. */
  answerRef?: CommunicationAnswerRef;
  sync?: SyncMeta;
}

export type CommunicationEventInput = Omit<CommunicationEvent, 'id' | 'timestamp'>;

export const COMMUNICATION_EXCERPT_MAX_LENGTH = 120;
