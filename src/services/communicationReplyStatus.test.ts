import { beforeEach, describe, expect, it } from 'vitest';
import {
  addCommunicationEvent,
  getCommunicationEvents,
  getCommunicationReplyStatus,
  recordCommunicationResult,
  recordDraftCopied,
  recordMarkedAnswered,
  recordMarkedNoReplyNeeded,
} from './communicationHistoryService';
import { resetCommunicationHistoryStore } from './communicationHistoryStore';
import type { CommunicationResult } from '../types/communication';

const contextRef = { type: 'inbox' as const, id: 'inbox-1' };

function draftResult(): CommunicationResult {
  return {
    mode: 'draft',
    intent: 'delay_notice',
    status: 'complete',
    title: 'communication.intent.delay_notice',
    summary: 'communication.draftReady.summary',
    drafts: {
      email: {
        intent: 'delay_notice',
        channel: 'email',
        subject: 'Antwort',
        body: 'Sehr geehrte Damen und Herren, vielen Dank für Ihr Schreiben.',
        tone: 'formal',
        basedOnFacts: [],
        notIncluded: [],
      },
    },
    disclaimer: 'Bitte prüfen.',
  };
}

describe('communicationReplyStatus', () => {
  beforeEach(() => {
    resetCommunicationHistoryStore();
  });

  it('starts with needs_reply for a context without events', () => {
    expect(getCommunicationReplyStatus(contextRef)).toBe('needs_reply');
  });

  it('sets draft_ready when an draft is created', () => {
    recordCommunicationResult(draftResult(), contextRef, 'Brief beantworten');
    expect(getCommunicationReplyStatus(contextRef)).toBe('draft_ready');
  });

  it('sets copied when draft text was copied', () => {
    const result = draftResult();
    recordCommunicationResult(result, contextRef, 'Brief beantworten');
    recordDraftCopied(contextRef, 'email', result, 'Brief beantworten');
    expect(getCommunicationReplyStatus(contextRef)).toBe('copied');
  });

  it('sets answered when marked as done', () => {
    recordCommunicationResult(draftResult(), contextRef, 'Brief beantworten');
    recordMarkedAnswered(contextRef, 'Brief beantworten');
    expect(getCommunicationReplyStatus(contextRef)).toBe('answered');
  });

  it('sets no_reply_needed when marked accordingly', () => {
    recordMarkedNoReplyNeeded(contextRef, 'Werbung');
    expect(getCommunicationReplyStatus(contextRef)).toBe('no_reply_needed');
  });

  it('keeps communication history append-only', () => {
    const result = draftResult();
    recordCommunicationResult(result, contextRef, 'Brief beantworten');
    const afterDraft = getCommunicationEvents().length;

    recordDraftCopied(contextRef, 'email', result, 'Brief beantworten');
    expect(getCommunicationEvents().length).toBe(afterDraft + 1);

    recordMarkedAnswered(contextRef, 'Brief beantworten');
    expect(getCommunicationEvents().length).toBe(afterDraft + 2);

    const firstEventId = getCommunicationEvents().at(-1)?.id;
    expect(getCommunicationEvents().some((event) => event.id === firstEventId)).toBe(true);
    expect(getCommunicationEvents().some((event) => event.type === 'draft_created')).toBe(true);
  });

  it('does not mutate existing events when status changes', () => {
    addCommunicationEvent({
      type: 'draft_created',
      contextRef,
      status: 'complete',
      disclaimerShown: false,
      resultExcerpt: 'Erster Entwurf',
    });

    const draftEventsBefore = getCommunicationEvents().filter((event) => event.type === 'draft_created');
    recordMarkedAnswered(contextRef);
    const draftEventsAfter = getCommunicationEvents().filter((event) => event.type === 'draft_created');
    expect(draftEventsAfter).toEqual(draftEventsBefore);
  });
});
