import type {
  CommunicationChannel,
  CommunicationContextRef,
  CommunicationIntent,
} from './communication';

export type CommunicationEventType =
  | 'document_question'
  | 'document_answer'
  | 'draft_created'
  | 'draft_copied'
  | 'draft_channel_switched';

export type CommunicationEventStatus = 'complete' | 'needs_info' | 'blocked';

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
}

export type CommunicationEventInput = Omit<CommunicationEvent, 'id' | 'timestamp'>;

export const COMMUNICATION_EXCERPT_MAX_LENGTH = 120;
