import { persistAll } from './persistenceService';
import {
  getCommunicationHistoryStoreEvents,
  getCommunicationHistoryStoreSnapshot,
  hydrateCommunicationHistoryStore,
  prependCommunicationEventToStore,
  resetCommunicationHistoryStore,
} from './communicationHistoryStore';
import type {
  CommunicationChannel,
  CommunicationContextRef,
  CommunicationResult,
} from '../types/communication';
import type {
  CommunicationEvent,
  CommunicationEventInput,
  CommunicationEventType,
  CommunicationReplyStatus,
} from '../types/communicationHistory';
import { COMMUNICATION_EXCERPT_MAX_LENGTH } from '../types/communicationHistory';

export function createExcerpt(text: string, maxLength = COMMUNICATION_EXCERPT_MAX_LENGTH): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}

export function contextRefsEqual(
  a: CommunicationContextRef,
  b: CommunicationContextRef,
): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'none' && b.type === 'none') return true;
  if (a.id !== b.id) return false;
  if (a.type === 'invoice' && a.vorgangId !== b.vorgangId) return false;
  return true;
}

function cloneContextRef(ref: CommunicationContextRef): CommunicationContextRef {
  return { ...ref };
}

function createEventId(): string {
  return `comm-evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isDuplicateEvent(candidate: CommunicationEventInput, existing: CommunicationEvent[]): boolean {
  const latest = existing[0];
  if (!latest) return false;

  return (
    latest.type === candidate.type &&
    latest.channel === candidate.channel &&
    contextRefsEqual(latest.contextRef, candidate.contextRef) &&
    latest.userInputExcerpt === candidate.userInputExcerpt &&
    latest.resultExcerpt === candidate.resultExcerpt
  );
}

export function addCommunicationEvent(input: CommunicationEventInput): CommunicationEvent | null {
  const normalized: CommunicationEventInput = {
    ...input,
    contextRef: cloneContextRef(input.contextRef),
    userInputExcerpt: input.userInputExcerpt
      ? createExcerpt(input.userInputExcerpt)
      : undefined,
    resultExcerpt: input.resultExcerpt ? createExcerpt(input.resultExcerpt) : undefined,
  };

  const existing = getCommunicationHistoryStoreEvents();
  if (isDuplicateEvent(normalized, existing)) {
    return null;
  }

  const event: CommunicationEvent = {
    ...normalized,
    id: createEventId(),
    timestamp: new Date().toISOString(),
  };

  prependCommunicationEventToStore(event);
  persistAll();
  return event;
}

export function getCommunicationEvents(): CommunicationEvent[] {
  return getCommunicationHistoryStoreEvents().sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  );
}

export function getEventsForContext(contextRef: CommunicationContextRef): CommunicationEvent[] {
  if (contextRef.type === 'none') {
    return getCommunicationEvents();
  }
  return getCommunicationEvents().filter((event) =>
    contextRefsEqual(event.contextRef, contextRef),
  );
}

export function clearCommunicationHistory(): void {
  resetCommunicationHistoryStore();
  persistAll();
}

export function hydrateCommunicationHistory(items: CommunicationEvent[]): void {
  hydrateCommunicationHistoryStore(items);
}

export function getCommunicationHistorySnapshot(): CommunicationEvent[] {
  return getCommunicationHistoryStoreSnapshot();
}

function eventTypeFromResult(result: CommunicationResult): CommunicationEventType | null {
  if (result.status !== 'complete') return null;
  if (result.mode === 'question' && result.documentQa) {
    return 'document_question';
  }
  if (result.intent === 'document_reply' && result.drafts) {
    return 'document_answer';
  }
  if (result.drafts) {
    return 'draft_created';
  }
  return null;
}

function draftExcerpt(
  result: CommunicationResult,
  channel: CommunicationChannel,
): string | undefined {
  const draft = result.drafts?.[channel] ?? result.drafts?.email;
  if (!draft) return undefined;
  const parts = [draft.subject, draft.body].filter(Boolean);
  return parts.length > 0 ? createExcerpt(parts.join(' – ')) : undefined;
}

export function recordCommunicationResult(
  result: CommunicationResult,
  contextRef: CommunicationContextRef,
  userInput: string,
  channel: CommunicationChannel = 'email',
): CommunicationEvent | null {
  const type = eventTypeFromResult(result);
  if (!type) return null;

  const resultExcerpt =
    type === 'document_question'
      ? createExcerpt(result.documentQa?.answer ?? result.summary)
      : draftExcerpt(result, channel);

  return addCommunicationEvent({
    type,
    intent: result.intent,
    channel: result.drafts ? channel : undefined,
    contextRef,
    status: 'complete',
    userInputExcerpt: createExcerpt(userInput),
    resultExcerpt,
    disclaimerShown: Boolean(result.disclaimer?.trim()),
  });
}

export function recordDraftCopied(
  contextRef: CommunicationContextRef,
  channel: CommunicationChannel,
  result: CommunicationResult,
  userInput: string,
): CommunicationEvent | null {
  if (result.status !== 'complete' || !result.drafts) return null;

  return addCommunicationEvent({
    type: 'draft_copied',
    intent: result.intent,
    channel,
    contextRef,
    status: 'complete',
    userInputExcerpt: createExcerpt(userInput),
    resultExcerpt: draftExcerpt(result, channel),
    disclaimerShown: Boolean(result.disclaimer?.trim()),
  });
}

export function recordChannelSwitched(
  contextRef: CommunicationContextRef,
  channel: CommunicationChannel,
  result: CommunicationResult,
  userInput: string,
): CommunicationEvent | null {
  if (result.status !== 'complete' || !result.drafts) return null;

  return addCommunicationEvent({
    type: 'draft_channel_switched',
    intent: result.intent,
    channel,
    contextRef,
    status: 'complete',
    userInputExcerpt: createExcerpt(userInput),
    resultExcerpt: draftExcerpt(result, channel),
    disclaimerShown: Boolean(result.disclaimer?.trim()),
  });
}

const REPLY_STATUS_BY_EVENT: Partial<Record<CommunicationEventType, CommunicationReplyStatus>> = {
  marked_answered: 'answered',
  marked_no_reply_needed: 'no_reply_needed',
  draft_copied: 'copied',
  draft_created: 'draft_ready',
  document_answer: 'draft_ready',
  marked_remind_later: 'needs_reply',
};

export function getCommunicationReplyStatus(
  contextRef: CommunicationContextRef,
): CommunicationReplyStatus {
  if (contextRef.type === 'none') {
    return 'needs_reply';
  }

  const statusEvents = getEventsForContext(contextRef).filter(
    (event) => REPLY_STATUS_BY_EVENT[event.type],
  );

  if (statusEvents.length === 0) {
    return 'needs_reply';
  }

  const latest = statusEvents.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]!;
  return REPLY_STATUS_BY_EVENT[latest.type] ?? 'needs_reply';
}

export function recordMarkedAnswered(
  contextRef: CommunicationContextRef,
  userInput?: string,
): CommunicationEvent | null {
  return addCommunicationEvent({
    type: 'marked_answered',
    contextRef,
    status: 'complete',
    disclaimerShown: false,
    userInputExcerpt: userInput ? createExcerpt(userInput) : undefined,
    resultExcerpt: 'Als erledigt markiert',
  });
}

export function recordMarkedNoReplyNeeded(
  contextRef: CommunicationContextRef,
  userInput?: string,
): CommunicationEvent | null {
  return addCommunicationEvent({
    type: 'marked_no_reply_needed',
    contextRef,
    status: 'complete',
    disclaimerShown: false,
    userInputExcerpt: userInput ? createExcerpt(userInput) : undefined,
    resultExcerpt: 'Kein Antwortbedarf',
  });
}

export function recordRemindLater(
  contextRef: CommunicationContextRef,
  userInput?: string,
): CommunicationEvent | null {
  return addCommunicationEvent({
    type: 'marked_remind_later',
    contextRef,
    status: 'complete',
    disclaimerShown: false,
    userInputExcerpt: userInput ? createExcerpt(userInput) : undefined,
    resultExcerpt: 'Später erinnern',
  });
}
