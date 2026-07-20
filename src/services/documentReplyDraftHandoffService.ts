import { buildCommunicationContext } from './communicationContextService';
import type {
  CommunicationChannel,
  CommunicationContext,
  CommunicationDraft,
  CommunicationDraftCore,
  CommunicationResult,
} from '../types/communication';
import type { DocumentConfirmedReplyDraft } from '../types/documentConfirmedReplyDraft';
import {
  DOCUMENT_REPLY_DRAFT_HANDOFF_SCHEMA_VERSION,
  DOCUMENT_REPLY_DRAFT_HANDOFF_STATE_KEY,
  type DocumentReplyDraftHandoffLocationState,
  type DocumentReplyDraftHandoffPayload,
} from '../types/documentReplyDraftHandoff';
import type { InboxItem } from '../types/models';

export function buildDocumentReplyDraftHandoffPayload(input: {
  item: InboxItem;
  draft: DocumentConfirmedReplyDraft;
  coreMessage: string;
}): DocumentReplyDraftHandoffPayload | null {
  const coreMessage = input.coreMessage.trim();
  const draftText = input.draft.body.trim();
  if (!coreMessage || !draftText) {
    return null;
  }

  const subject = input.item.title?.trim();
  const sender = input.item.sender?.trim();

  return Object.freeze({
    schemaVersion: DOCUMENT_REPLY_DRAFT_HANDOFF_SCHEMA_VERSION,
    contextRef: Object.freeze({ type: 'inbox' as const, id: input.item.id }),
    documentId: input.item.id,
    draftText,
    coreMessage,
    considered: Object.freeze(
      input.draft.considered.map((fact) => Object.freeze({ ...fact })),
    ),
    notIncluded: Object.freeze([...input.draft.notIncluded]),
    ...(subject ? { subject } : {}),
    ...(sender ? { sender } : {}),
  });
}

export function isDocumentReplyDraftHandoffPayload(
  value: unknown,
): value is DocumentReplyDraftHandoffPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as DocumentReplyDraftHandoffPayload;
  if (candidate.schemaVersion !== DOCUMENT_REPLY_DRAFT_HANDOFF_SCHEMA_VERSION) return false;
  if (!candidate.contextRef || candidate.contextRef.type !== 'inbox') return false;
  if (!candidate.contextRef.id?.trim()) return false;
  if (!candidate.documentId?.trim()) return false;
  if (!candidate.draftText?.trim()) return false;
  if (!candidate.coreMessage?.trim()) return false;
  if (!Array.isArray(candidate.considered) || !Array.isArray(candidate.notIncluded)) {
    return false;
  }
  return true;
}

export function readDocumentReplyDraftHandoffFromLocationState(
  state: unknown,
): DocumentReplyDraftHandoffPayload | null {
  if (!state || typeof state !== 'object') return null;
  const payload = (state as DocumentReplyDraftHandoffLocationState)[
    DOCUMENT_REPLY_DRAFT_HANDOFF_STATE_KEY
  ];
  return isDocumentReplyDraftHandoffPayload(payload) ? payload : null;
}

export function createDocumentReplyDraftHandoffLocationState(
  payload: DocumentReplyDraftHandoffPayload,
): DocumentReplyDraftHandoffLocationState {
  return Object.freeze({
    [DOCUMENT_REPLY_DRAFT_HANDOFF_STATE_KEY]: payload,
  });
}

/**
 * Map handoff into existing document_reply CommunicationResult shape.
 * Preserves draft text / facts; does not invent greeting, subject, or closing.
 */
export function buildCommunicationDraftCoreFromReplyHandoff(
  payload: DocumentReplyDraftHandoffPayload,
): CommunicationDraftCore {
  return Object.freeze({
    intent: 'document_reply' as const,
    ...(payload.subject?.trim() ? { subject: payload.subject.trim() } : {}),
    body: payload.draftText,
    tone: 'formal' as const,
    basedOnFacts: Object.freeze(
      payload.considered.map((fact) => `${fact.label}: ${fact.value}`),
    ) as string[],
    notIncluded: Object.freeze([...payload.notIncluded]) as string[],
  });
}

function exactChannelDraft(
  core: CommunicationDraftCore,
  channel: CommunicationChannel,
): CommunicationDraft {
  return Object.freeze({
    intent: core.intent,
    channel,
    ...(core.subject ? { subject: core.subject } : {}),
    body: core.body,
    tone: core.tone,
    basedOnFacts: [...core.basedOnFacts],
    notIncluded: [...core.notIncluded],
  });
}

export function buildCommunicationResultFromReplyHandoff(
  payload: DocumentReplyDraftHandoffPayload,
  context: CommunicationContext = buildCommunicationContext(payload.contextRef),
): CommunicationResult {
  const core = buildCommunicationDraftCoreFromReplyHandoff(payload);
  return Object.freeze({
    mode: 'draft' as const,
    intent: 'document_reply' as const,
    status: 'complete' as const,
    title: 'communication.intent.document_reply',
    summary: 'communication.draftReady.summary',
    drafts: Object.freeze({
      email: exactChannelDraft(core, 'email'),
      whatsapp: exactChannelDraft(core, 'whatsapp'),
      letter: exactChannelDraft(core, 'letter'),
    }),
    disclaimer: context.disclaimer,
  });
}
