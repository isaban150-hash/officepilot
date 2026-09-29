/**
 * E-MAIL-07D — Client-Orchestrator der freien Geschäfts-E-Mail.
 *
 * Eine Kette, keine Logik im Click-Handler:
 *   Entwurf (lokal, mit fester client_message_id) → Anhänge einzeln in den
 *   privaten Bucket → `create_workspace_email_message` (idempotent) →
 *   Edge Function `send-email` → autoritativen Status laden.
 *
 * Die client_message_id entsteht mit dem Entwurf und bleibt für diese
 * Nachricht stabil: Doppelklick, zweiter Tab (gleicher Entwurf), Reload
 * während des Versands — alles landet bei derselben Serverzeile, der Server
 * sendet höchstens einmal (Claim). Der Entwurf ist ein kleiner Datensatz in
 * localStorage (nur Metadaten der hochgeladenen Anhänge, keine Bytes) und
 * gehört nicht zum Sync-Bestand; die gesendete Nachricht lebt nur in der Cloud.
 *
 * E-MAIL 07F-01A — Antwort: derselbe Entwurf/Versand, zusätzlich
 * `replyToMessageId`. Jede Antwort hat einen eigenen Entwurfsschlüssel je
 * beantworteter Nachricht, damit sie nie mit einer freien E-Mail oder einer
 * anderen Antwort kollidiert. Gesendet wird nur durch die Benutzeraktion.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, isSupabaseConfigured } from '../../lib/supabase';
import { buildDocumentBlobScopeKey } from '../storage/documentBlobScopeService';
import { getActiveStorageScope } from '../storage/storageScopeService';
import { resolveClientMailProvider, resolveDeliveryWorkspaceId } from '../delivery/sendDocumentOrchestrator';
import {
  EMAIL_ATTACHMENT_MAX_COUNT,
  EMAIL_ATTACHMENT_MAX_TOTAL_BYTES,
  EMAIL_BODY_MAX,
  EMAIL_MAX_RECIPIENTS,
  EMAIL_MAX_TO,
  EMAIL_SUBJECT_MAX,
  normalizeRecipientLists,
  splitRecipientInput,
} from '../../../supabase/functions/_shared/emailMessageRules';
import {
  createInvokeSendEmail,
  rpcCreateEmailMessage,
  rpcGetEmailMessageChain,
  rpcRetryEmailMessage,
  type EmailMessageRpcError,
  type InvokeSendEmail,
  type SendEmailServerResponse,
  type UploadedEmailAttachment,
} from './emailMessageCloudService';
import type { EmailMessage } from '../../types/emailMessage';

export type FreeEmailPhase = 'editing' | 'creating' | 'sending';

export interface FreeEmailDraft {
  version: 1;
  scopeKey: string;
  workspaceId: string;
  clientMessageId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyText: string;
  /** Die Signatur wurde genau einmal eingefügt — nie erneut, auch wenn der Nutzer sie löscht. */
  signatureApplied: boolean;
  customerId?: string;
  vorgangId?: string;
  /** E-MAIL 07F-01A — beantwortete Nachricht (Verlauf, In-Reply-To/References setzt der Server). */
  replyToMessageId?: string;
  /**
   * E-MAIL 07F-01C — nur lokal: deterministischer Schluss der Antwort
   * (Signatur + Zitat), vor dem ein KI-Entwurf eingesetzt wird; der zuletzt
   * eingesetzte KI-Text (erkennt manuelle Änderungen) und die Zahl der
   * KI-Generierungen dieses Entwurfs (höchstens 3).
   */
  replyTail?: string;
  aiInsertedText?: string;
  aiGenerations?: number;
  attachments: UploadedEmailAttachment[];
  phase: FreeEmailPhase;
  updatedAt: string;
}

const DRAFT_PREFIX = 'officepilot.freeEmailDraft.v1';
const RETRY_PREFIX = 'officepilot.freeEmailRetry.v1';

function currentScopeKey(): string {
  return buildDocumentBlobScopeKey(getActiveStorageScope());
}

export function freeEmailDraftStorageKey(scopeKey: string, replyToMessageId?: string): string {
  return replyToMessageId ? `${DRAFT_PREFIX}:${scopeKey}:reply:${replyToMessageId}` : `${DRAFT_PREFIX}:${scopeKey}`;
}

export function generateClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `em-${crypto.randomUUID()}`;
  throw new Error('E-MAIL: sichere Zufallsquelle nicht verfügbar.');
}

export function loadFreeEmailDraft(scopeKey = currentScopeKey(), replyToMessageId?: string): FreeEmailDraft | null {
  try {
    const raw = localStorage.getItem(freeEmailDraftStorageKey(scopeKey, replyToMessageId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FreeEmailDraft;
    if (parsed?.version !== 1 || parsed.scopeKey !== scopeKey || typeof parsed.clientMessageId !== 'string' || !parsed.clientMessageId) return null;
    if ((parsed.replyToMessageId ?? undefined) !== (replyToMessageId ?? undefined)) return null;
    return { ...parsed, attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [] };
  } catch {
    return null;
  }
}

export function saveFreeEmailDraft(draft: FreeEmailDraft): FreeEmailDraft {
  const next = { ...draft, updatedAt: new Date().toISOString() };
  try {
    localStorage.setItem(freeEmailDraftStorageKey(draft.scopeKey, draft.replyToMessageId), JSON.stringify(next));
  } catch {
    /* Speicher nicht verfügbar — Versand funktioniert auch ohne Wiederaufnahme. */
  }
  return next;
}

export function clearFreeEmailDraft(scopeKey = currentScopeKey(), replyToMessageId?: string): void {
  try {
    localStorage.removeItem(freeEmailDraftStorageKey(scopeKey, replyToMessageId));
  } catch {
    /* ignorieren */
  }
}

export function createFreeEmailDraft(input: Partial<Pick<FreeEmailDraft, 'to' | 'cc' | 'subject' | 'bodyText' | 'customerId' | 'vorgangId' | 'signatureApplied' | 'replyToMessageId' | 'replyTail'>> = {}): FreeEmailDraft {
  return saveFreeEmailDraft({
    version: 1,
    scopeKey: currentScopeKey(),
    workspaceId: resolveDeliveryWorkspaceId(),
    clientMessageId: generateClientMessageId(),
    to: input.to ?? '',
    cc: input.cc ?? '',
    bcc: '',
    subject: input.subject ?? '',
    bodyText: input.bodyText ?? '',
    signatureApplied: input.signatureApplied ?? false,
    customerId: input.customerId,
    vorgangId: input.vorgangId,
    replyToMessageId: input.replyToMessageId,
    replyTail: input.replyTail,
    attachments: [],
    phase: 'editing',
    updatedAt: new Date().toISOString(),
  });
}

/* ------------------------------------------------------------------------ */
/* Prüfung vor dem Senden                                                    */
/* ------------------------------------------------------------------------ */

export type FreeEmailValidationError =
  | 'to_missing'
  | 'recipient_invalid'
  | 'too_many_to'
  | 'too_many_recipients'
  | 'subject_missing'
  | 'subject_too_long'
  | 'body_missing'
  | 'body_too_long'
  | 'too_many_attachments'
  | 'attachments_too_large';

export interface FreeEmailValidation {
  ok: boolean;
  errors: FreeEmailValidationError[];
  invalidRecipients: string[];
  recipients: { to: string[]; cc: string[]; bcc: string[] };
}

export function validateFreeEmailDraft(draft: Pick<FreeEmailDraft, 'to' | 'cc' | 'bcc' | 'subject' | 'bodyText' | 'attachments'>): FreeEmailValidation {
  const recipients = normalizeRecipientLists({ to: splitRecipientInput(draft.to), cc: splitRecipientInput(draft.cc), bcc: splitRecipientInput(draft.bcc) });
  const errors: FreeEmailValidationError[] = [];
  if (recipients.invalid.length > 0) errors.push('recipient_invalid');
  if (recipients.to.length === 0) errors.push('to_missing');
  if (recipients.to.length > EMAIL_MAX_TO) errors.push('too_many_to');
  if (recipients.to.length + recipients.cc.length + recipients.bcc.length > EMAIL_MAX_RECIPIENTS) errors.push('too_many_recipients');
  const subject = draft.subject.trim();
  if (!subject) errors.push('subject_missing');
  if (subject.length > EMAIL_SUBJECT_MAX) errors.push('subject_too_long');
  if (!draft.bodyText.trim()) errors.push('body_missing');
  if (draft.bodyText.length > EMAIL_BODY_MAX) errors.push('body_too_long');
  if (draft.attachments.length > EMAIL_ATTACHMENT_MAX_COUNT) errors.push('too_many_attachments');
  if (draft.attachments.reduce((sum, entry) => sum + entry.sizeBytes, 0) > EMAIL_ATTACHMENT_MAX_TOTAL_BYTES) errors.push('attachments_too_large');
  return {
    ok: errors.length === 0,
    errors,
    invalidRecipients: recipients.invalid,
    recipients: { to: recipients.to, cc: recipients.cc, bcc: recipients.bcc },
  };
}

/* ------------------------------------------------------------------------ */
/* Senden                                                                    */
/* ------------------------------------------------------------------------ */

export type FreeEmailClientError =
  | EmailMessageRpcError
  | 'workspace_missing'
  | 'validation'
  | 'offline'
  | 'send_not_deployed'
  | 'unauthenticated'
  | 'server_unavailable';

export type FreeEmailAction = 'sent' | 'replayed' | 'unknown_pending' | 'failed' | 'in_progress';

export type FreeEmailResult =
  | { ok: true; action: FreeEmailAction; message: EmailMessage; chain: EmailMessage[] }
  | { ok: false; error: FreeEmailClientError; message?: string; messageId?: string };

export interface FreeEmailDeps {
  client?: SupabaseClient | null;
  invokeSend?: InvokeSendEmail;
  onPhase?: (phase: FreeEmailPhase) => void;
  isOnline?: () => boolean;
}

function online(deps: FreeEmailDeps): boolean {
  if (deps.isOnline) return deps.isOnline();
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function actionFor(message: EmailMessage, serverAction: SendEmailServerResponse['action']): FreeEmailAction {
  if (message.status === 'sending' || message.status === 'queued') return 'in_progress';
  if (message.status === 'unknown') return 'unknown_pending';
  if (message.status === 'failed') return 'failed';
  return serverAction === 'replayed' ? 'replayed' : 'sent';
}

/** Versand durch den Server, danach die Serverwahrheit (Kette) laden. */
async function sendAndRefresh(
  client: SupabaseClient,
  created: EmailMessage,
  deps: FreeEmailDeps,
): Promise<{ response: { status: number; body: SendEmailServerResponse }; message: EmailMessage; chain: EmailMessage[] }> {
  const invoke = deps.invokeSend ?? createInvokeSendEmail(client);
  let response: { status: number; body: SendEmailServerResponse };
  try {
    response = await invoke({ workspaceId: created.workspaceId, clientMessageId: created.clientMessageId });
  } catch {
    // Antwort verloren: der Server kann angenommen haben — Status laden, nie erneut senden.
    response = { status: 0, body: { ok: false, error: 'server_unavailable' } };
  }
  const chain = await rpcGetEmailMessageChain({ workspaceId: created.workspaceId, messageId: created.id }, client);
  const fresh = chain.ok ? chain.messages.find((entry) => entry.id === created.id) : undefined;
  let message = fresh ?? created;
  if (!fresh && response.body.message && response.body.message.id === created.id && response.body.message.rowVersion >= created.rowVersion) {
    message = { ...created, status: response.body.message.status, rowVersion: response.body.message.rowVersion };
  }
  return { response, message, chain: chain.ok ? chain.messages : [message] };
}

function responseError(status: number): FreeEmailClientError {
  if (status === 404) return 'send_not_deployed';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  return 'server_unavailable';
}

const inFlight = new Map<string, Promise<FreeEmailResult>>();

/**
 * Sendet den Entwurf bzw. setzt einen unterbrochenen Versand fort.
 * Läuft für dieselbe client_message_id bereits ein Versand in diesem Tab,
 * wird dessen Ergebnis geteilt (Doppelklick).
 */
export function sendFreeEmail(draft: FreeEmailDraft, deps: FreeEmailDeps = {}): Promise<FreeEmailResult> {
  const running = inFlight.get(draft.clientMessageId);
  if (running) return running;
  const promise = runSendFreeEmail(draft, deps).finally(() => inFlight.delete(draft.clientMessageId));
  inFlight.set(draft.clientMessageId, promise);
  return promise;
}

async function runSendFreeEmail(input: FreeEmailDraft, deps: FreeEmailDeps): Promise<FreeEmailResult> {
  const client = deps.client ?? getSupabaseClient();
  if (!client || !isSupabaseConfigured()) return { ok: false, error: 'not_configured' };
  if (!input.workspaceId) return { ok: false, error: 'workspace_missing' };
  const validation = validateFreeEmailDraft(input);
  if (!validation.ok) return { ok: false, error: 'validation' };
  if (!online(deps)) return { ok: false, error: 'offline' };

  let draft = input;
  const phase = (next: FreeEmailPhase) => {
    draft = saveFreeEmailDraft({ ...draft, phase: next });
    deps.onPhase?.(next);
  };

  phase('creating');
  const created = await rpcCreateEmailMessage(
    {
      workspaceId: draft.workspaceId,
      clientMessageId: draft.clientMessageId,
      ...validation.recipients,
      subject: draft.subject.trim(),
      bodyText: draft.bodyText,
      attachments: draft.attachments,
      provider: resolveClientMailProvider(),
      customerId: draft.customerId,
      vorgangId: draft.vorgangId,
      replyToMessageId: draft.replyToMessageId,
    },
    client,
  );
  if (!created.ok) {
    // Nichts angelegt: zurück in die Bearbeitung, gleiche client_message_id.
    phase('editing');
    return { ok: false, error: created.error, message: created.message };
  }

  phase('sending');
  const { response, message, chain } = await sendAndRefresh(client, created.message, deps);

  if (message.status === 'queued') {
    // Der Server hat nichts übernommen: Entwurf bleibt, ein Fortsetzen ist gefahrlos.
    if (!response.body.ok) return { ok: false, error: responseError(response.status), messageId: message.id };
    return { ok: true, action: 'in_progress', message, chain };
  }

  clearFreeEmailDraft(draft.scopeKey, draft.replyToMessageId);
  return { ok: true, action: actionFor(message, response.body.action), message, chain };
}

/* ------------------------------------------------------------------------ */
/* Bewusster Neuversuch und Statusprüfung                                    */
/* ------------------------------------------------------------------------ */

function retryStorageKey(scopeKey: string, messageId: string): string {
  return `${RETRY_PREFIX}:${scopeKey}:${messageId}`;
}

/** Stabile client_message_id je Neuversuch (Doppelklick/Reload legen keinen zweiten an). */
function retryClientMessageId(scopeKey: string, messageId: string): string {
  const key = retryStorageKey(scopeKey, messageId);
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = generateClientMessageId();
    localStorage.setItem(key, created);
    return created;
  } catch {
    return generateClientMessageId();
  }
}

export function retryFreeEmail(
  input: { previous: EmailMessage; confirmUncertainRetry?: boolean },
  deps: FreeEmailDeps = {},
): Promise<FreeEmailResult> {
  const scopeKey = currentScopeKey();
  const clientMessageId = retryClientMessageId(scopeKey, input.previous.id);
  const running = inFlight.get(clientMessageId);
  if (running) return running;
  const promise = runRetry(input, clientMessageId, scopeKey, deps).finally(() => inFlight.delete(clientMessageId));
  inFlight.set(clientMessageId, promise);
  return promise;
}

async function runRetry(
  input: { previous: EmailMessage; confirmUncertainRetry?: boolean },
  clientMessageId: string,
  scopeKey: string,
  deps: FreeEmailDeps,
): Promise<FreeEmailResult> {
  const client = deps.client ?? getSupabaseClient();
  if (!client || !isSupabaseConfigured()) return { ok: false, error: 'not_configured' };
  const workspaceId = resolveDeliveryWorkspaceId() || input.previous.workspaceId;
  if (!workspaceId) return { ok: false, error: 'workspace_missing' };
  if (!online(deps)) return { ok: false, error: 'offline' };
  const created = await rpcRetryEmailMessage(
    { workspaceId, clientMessageId, retryOfMessageId: input.previous.id, confirmUncertainRetry: input.confirmUncertainRetry },
    client,
  );
  if (!created.ok) return { ok: false, error: created.error, message: created.message };
  const { response, message, chain } = await sendAndRefresh(client, created.message, deps);
  if (message.status === 'queued' && !response.body.ok) return { ok: false, error: responseError(response.status), messageId: message.id };
  if (message.status !== 'queued') {
    try {
      localStorage.removeItem(retryStorageKey(scopeKey, input.previous.id));
    } catch {
      /* ignorieren */
    }
  }
  return { ok: true, action: actionFor(message, response.body.action), message, chain };
}

/**
 * „Status prüfen": bei `queued`/`sending` fragt der Client die Edge Function
 * mit derselben client_message_id — gefahrlos, der Server sendet nie doppelt
 * und löst einen hängenden Claim zu `unknown` auf. Sonst nur neu laden.
 */
export async function checkFreeEmailStatus(message: EmailMessage, deps: FreeEmailDeps = {}): Promise<FreeEmailResult> {
  const client = deps.client ?? getSupabaseClient();
  if (!client || !isSupabaseConfigured()) return { ok: false, error: 'not_configured' };
  if (message.status === 'queued' || message.status === 'sending') {
    const { response, message: fresh, chain } = await sendAndRefresh(client, message, deps);
    return { ok: true, action: actionFor(fresh, response.body.action), message: fresh, chain };
  }
  const chain = await rpcGetEmailMessageChain({ workspaceId: message.workspaceId, messageId: message.id }, client);
  if (!chain.ok) return { ok: false, error: chain.error };
  const fresh = chain.messages.find((entry) => entry.id === message.id) ?? message;
  return { ok: true, action: actionFor(fresh, undefined), message: fresh, chain: chain.messages };
}

/* ------------------------------------------------------------------------ */
/* Gruppierung: eine Zeile je Nachricht samt Neuversuchen                    */
/* ------------------------------------------------------------------------ */

export interface EmailThread {
  id: string;
  root: EmailMessage;
  latest: EmailMessage;
  attempts: EmailMessage[];
}

export function groupEmailThreads(input: EmailMessage[]): EmailThread[] {
  // Jede Nachricht genau einmal, auch wenn sie aus zwei Quellen kommt.
  const byId = new Map(input.map((message) => [message.id, message]));
  const messages = [...byId.values()];
  const rootOf = (message: EmailMessage): EmailMessage => {
    let current = message;
    const seen = new Set<string>();
    while (current.retryOfMessageId && byId.has(current.retryOfMessageId) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.retryOfMessageId)!;
    }
    return current;
  };
  const groups = new Map<string, EmailMessage[]>();
  for (const message of messages) {
    const root = rootOf(message);
    groups.set(root.id, [...(groups.get(root.id) ?? []), message]);
  }
  const threads: EmailThread[] = [];
  for (const [rootId, attempts] of groups) {
    const sorted = [...attempts].sort((a, b) => a.attemptNumber - b.attemptNumber || a.createdAt.localeCompare(b.createdAt));
    threads.push({ id: rootId, root: byId.get(rootId)!, latest: sorted[sorted.length - 1], attempts: sorted });
  }
  return threads.sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt));
}
