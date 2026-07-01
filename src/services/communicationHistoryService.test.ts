import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../data/mockData';
import { STORAGE_KEY, loadPersistedState, persistAll } from './persistenceService';
import {
  addCommunicationEvent,
  clearCommunicationHistory,
  createExcerpt,
  getCommunicationEvents,
  getEventsForContext,
  hydrateCommunicationHistory,
  recordCommunicationResult,
} from './communicationHistoryService';
import { resetCommunicationHistoryStore } from './communicationHistoryStore';
import type { CommunicationResult } from '../types/communication';
import { COMMUNICATION_EXCERPT_MAX_LENGTH } from '../types/communicationHistory';

function draftResult(overrides: Partial<CommunicationResult> = {}): CommunicationResult {
  return {
    mode: 'draft',
    intent: 'price_adjustment',
    status: 'complete',
    title: 'communication.intent.price_adjustment',
    summary: 'communication.draftReady.summary',
    drafts: {
      email: {
        intent: 'price_adjustment',
        channel: 'email',
        subject: 'Preisanpassung',
        body: 'Sehr geehrte Damen und Herren, wir passen den Preis an.',
        tone: 'formal',
        basedOnFacts: [],
        notIncluded: [],
      },
    },
    disclaimer: 'Hinweis',
    ...overrides,
  };
}

describe('communicationHistoryService', () => {
  beforeEach(() => {
    resetCommunicationHistoryStore();
    localStorage.clear();
  });

  it('stores events via addCommunicationEvent', () => {
    const event = addCommunicationEvent({
      type: 'draft_created',
      intent: 'price_adjustment',
      channel: 'email',
      contextRef: { type: 'vorgang', id: 'v-1' },
      status: 'complete',
      userInputExcerpt: 'Preis erhöhen',
      resultExcerpt: 'Preisanpassung',
      disclaimerShown: true,
    });

    expect(event).not.toBeNull();
    expect(getCommunicationEvents()).toHaveLength(1);
    expect(getCommunicationEvents()[0].type).toBe('draft_created');
  });

  it('persists events through persistenceService', () => {
    addCommunicationEvent({
      type: 'draft_created',
      contextRef: { type: 'vorgang', id: 'v-1' },
      status: 'complete',
      disclaimerShown: false,
      userInputExcerpt: 'Test',
      resultExcerpt: 'Entwurf',
    });

    persistAll({ ...DEFAULT_SETUP, setupComplete: true });

    resetCommunicationHistoryStore();
    const loaded = loadPersistedState();
    expect(loaded?.communicationHistory).toHaveLength(1);
    hydrateCommunicationHistory(loaded!.communicationHistory ?? []);
    expect(getCommunicationEvents()).toHaveLength(1);
  });

  it('sorts events newest first', () => {
    addCommunicationEvent({
      type: 'draft_created',
      contextRef: { type: 'vorgang', id: 'v-1' },
      status: 'complete',
      disclaimerShown: false,
    });

    addCommunicationEvent({
      type: 'draft_copied',
      contextRef: { type: 'vorgang', id: 'v-1' },
      status: 'complete',
      disclaimerShown: false,
    });

    const events = getCommunicationEvents();
    expect(events[0].type).toBe('draft_copied');
    expect(events[1].type).toBe('draft_created');
  });

  it('filters events by context', () => {
    addCommunicationEvent({
      type: 'draft_created',
      contextRef: { type: 'vorgang', id: 'v-1' },
      status: 'complete',
      disclaimerShown: false,
    });
    addCommunicationEvent({
      type: 'draft_created',
      contextRef: { type: 'inbox', id: 'inbox-1' },
      status: 'complete',
      disclaimerShown: false,
    });

    expect(getEventsForContext({ type: 'vorgang', id: 'v-1' })).toHaveLength(1);
    expect(getEventsForContext({ type: 'none' })).toHaveLength(2);
  });

  it('truncates excerpts and never stores full texts', () => {
    const longText = 'A'.repeat(300);
    addCommunicationEvent({
      type: 'draft_created',
      contextRef: { type: 'vorgang', id: 'v-1' },
      status: 'complete',
      disclaimerShown: false,
      userInputExcerpt: longText,
      resultExcerpt: longText,
    });

    const stored = getCommunicationEvents()[0];
    expect(stored.userInputExcerpt!.length).toBeLessThanOrEqual(COMMUNICATION_EXCERPT_MAX_LENGTH);
    expect(stored.resultExcerpt!.length).toBeLessThanOrEqual(COMMUNICATION_EXCERPT_MAX_LENGTH);
    expect(stored.userInputExcerpt).not.toBe(longText);
  });

  it('skips duplicate events with identical payload', () => {
    const payload = {
      type: 'draft_copied' as const,
      channel: 'email' as const,
      contextRef: { type: 'vorgang' as const, id: 'v-1' },
      status: 'complete' as const,
      disclaimerShown: true,
      userInputExcerpt: 'Preis',
      resultExcerpt: 'Entwurf',
    };

    expect(addCommunicationEvent(payload)).not.toBeNull();
    expect(addCommunicationEvent(payload)).toBeNull();
    expect(getCommunicationEvents()).toHaveLength(1);
  });

  it('does not record blocked or needs_info results', () => {
    expect(
      recordCommunicationResult(
        {
          mode: 'draft',
          intent: 'unknown',
          status: 'blocked',
          title: 'blocked',
          summary: 'blocked',
          disclaimer: '',
        },
        { type: 'vorgang', id: 'v-1' },
        'Test',
      ),
    ).toBeNull();

    expect(
      recordCommunicationResult(
        {
          mode: 'draft',
          intent: 'price_adjustment',
          status: 'needs_info',
          title: 'needs',
          summary: 'needs',
          disclaimer: '',
        },
        { type: 'vorgang', id: 'v-1' },
        'Test',
      ),
    ).toBeNull();
  });

  it('records document_question and draft_created from complete results', () => {
    recordCommunicationResult(
      {
        mode: 'question',
        intent: 'document_question',
        status: 'complete',
        title: 'qa',
        summary: 'Antworttext',
        documentQa: {
          questionType: 'deadline',
          answer: 'Die Frist ist der 15.07.',
          bullets: [],
          confidence: 'high',
          sources: [],
          uncertain: false,
        },
        disclaimer: 'Hinweis',
      },
      { type: 'inbox', id: 'inbox-1' },
      'Was ist die Frist?',
    );

    recordCommunicationResult(
      draftResult(),
      { type: 'vorgang', id: 'v-2' },
      'Preis erhöhen',
    );

    const events = getCommunicationEvents();
    expect(events.some((event) => event.type === 'document_question')).toBe(true);
    expect(events.some((event) => event.type === 'draft_created')).toBe(true);
  });

  it('clears history', () => {
    addCommunicationEvent({
      type: 'draft_created',
      contextRef: { type: 'vorgang', id: 'v-1' },
      status: 'complete',
      disclaimerShown: false,
    });
    clearCommunicationHistory();
    expect(getCommunicationEvents()).toHaveLength(0);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('createExcerpt adds ellipsis for long strings', () => {
    expect(createExcerpt('kurz')).toBe('kurz');
    expect(createExcerpt('x'.repeat(200)).length).toBe(COMMUNICATION_EXCERPT_MAX_LENGTH);
    expect(createExcerpt('x'.repeat(200)).endsWith('…')).toBe(true);
  });
});

describe('communicationHistory persistence roundtrip', () => {
  beforeEach(() => {
    resetCommunicationHistoryStore();
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('savePersistedState includes communicationHistory', () => {
    addCommunicationEvent({
      type: 'draft_created',
      contextRef: { type: 'expense', id: 'exp-1' },
      status: 'complete',
      disclaimerShown: false,
      resultExcerpt: 'Test',
    });

    persistAll({ ...DEFAULT_SETUP, setupComplete: true });
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toContain('communicationHistory');
    expect(raw).not.toContain('A'.repeat(200));
  });
});
