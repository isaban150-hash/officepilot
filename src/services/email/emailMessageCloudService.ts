/**
 * E-MAIL-07D — Cloud-Vertrag der freien Geschäfts-E-Mail.
 *
 * Anhang in den privaten Bucket `email-attachments` (inhaltsadressiert,
 * `{workspace}/{sha256}.{endung}`), Nachricht idempotent anlegen, bewusster
 * Neuversuch (Server kopiert alles eingefroren), Lesen, Versand über die
 * Edge Function `send-email`. Der Browser setzt nie einen Versandstatus.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, getSupabaseUrl } from '../../lib/supabase';
import {
  EMAIL_ATTACHMENT_BUCKET,
  buildEmailAttachmentStoragePath,
  fileExtension,
  mimeTypeForExtension,
  parseEmailAttachmentStoragePath,
} from '../../../supabase/functions/_shared/emailMessageRules';
import { isDeliveryErrorCategory, isDeliveryProvider, sha256Hex } from '../delivery/documentDeliveryContract';
import { parseProviderDeliveryState } from '../delivery/providerDeliveryState';
import type { EmailMessage, EmailMessageAttachment, EmailMessageStatus, MailboxConnection, MailboxOAuthPending, MailboxOAuthProviderType, SkippedInboundAttachment } from '../../types/emailMessage';

const STATUSES: readonly EmailMessageStatus[] = ['queued', 'sending', 'provider_accepted', 'failed', 'unknown', 'received'];
/** E-MAIL-07E — Postfach-Anbieter eingehender Mail. */
const INBOUND_PROVIDERS = ['microsoft_graph', 'google_gmail', 'inbound_channel', 'imap', 'stub'] as const;
/** E-MAIL-07E — nur diese privaten Buckets; ein Pfad aus einer Zeile wählt nie einen anderen. */
const ATTACHMENT_BUCKETS = ['email-attachments', 'inbound-email-attachments'] as const;
type AttachmentBucket = (typeof ATTACHMENT_BUCKETS)[number];
const SKIP_REASONS: readonly SkippedInboundAttachment['reason'][] = ['type_not_allowed', 'too_large', 'content_mismatch', 'too_many', 'empty', 'unavailable'];

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export function parseEmailMessageRow(input: unknown): EmailMessage | null {
  if (!input || typeof input !== 'object') return null;
  const row = input as Record<string, unknown>;
  const status = row.status as EmailMessageStatus;
  if (typeof row.id !== 'string' || typeof row.client_message_id !== 'string' || !STATUSES.includes(status)) return null;
  const direction = row.direction === 'inbound' ? 'inbound' : 'outbound';
  const providerValid = direction === 'inbound'
    ? (INBOUND_PROVIDERS as readonly unknown[]).includes(row.provider)
    : isDeliveryProvider(row.provider);
  if (!providerValid) return null;
  const attachments: EmailMessageAttachment[] = Array.isArray(row.attachments)
    ? (row.attachments as Record<string, unknown>[])
        .map((entry) => ({
          position: Number(entry.position),
          filename: String(entry.filename ?? ''),
          mimeType: String(entry.mime_type ?? ''),
          sizeBytes: Number(entry.size_bytes),
          sha256: String(entry.sha256 ?? ''),
          storagePath: String(entry.storage_path ?? ''),
          storageBucket: ((ATTACHMENT_BUCKETS as readonly unknown[]).includes(entry.storage_bucket) ? entry.storage_bucket : 'email-attachments') as AttachmentBucket,
          originalFilename: text(entry.original_filename),
        }))
        .sort((a, b) => a.position - b.position)
    : [];
  return {
    id: row.id,
    workspaceId: String(row.workspace_id ?? ''),
    clientMessageId: row.client_message_id,
    customerId: text(row.customer_id),
    vorgangId: text(row.vorgang_id),
    to: stringList(row.to_recipients),
    cc: stringList(row.cc_recipients),
    bcc: stringList(row.bcc_recipients),
    subject: String(row.subject ?? ''),
    bodyText: String(row.body_text ?? ''),
    senderName: String(row.sender_name ?? ''),
    replyToEmail: String(row.reply_to_email ?? ''),
    provider: row.provider as EmailMessage['provider'],
    providerMessageId: text(row.provider_message_id),
    status,
    createdAt: String(row.created_at ?? ''),
    sendingStartedAt: text(row.sending_started_at),
    providerAcceptedAt: text(row.provider_accepted_at),
    failedAt: text(row.failed_at),
    errorCategory: isDeliveryErrorCategory(row.error_category) ? row.error_category : undefined,
    errorCode: text(row.error_code),
    errorMessageSafe: text(row.error_message_safe),
    retryOfMessageId: text(row.retry_of_message_id),
    attemptNumber: Number(row.attempt_number ?? 1),
    rowVersion: Number(row.row_version ?? 1),
    attachments,
    direction,
    mailboxConnectionId: text(row.mailbox_connection_id),
    internetMessageId: text(row.internet_message_id),
    fromAddress: text(row.from_address),
    fromName: text(row.from_name),
    receivedAt: text(row.received_at),
    importedAt: text(row.imported_at),
    hasHtml: row.has_html === true,
    skippedAttachments: Array.isArray(row.skipped_attachments)
      ? (row.skipped_attachments as Record<string, unknown>[])
          .filter((entry) => (SKIP_REASONS as readonly unknown[]).includes(entry?.reason))
          .map((entry) => ({ filename: String(entry.filename ?? ''), mimeType: String(entry.mime_type ?? ''), sizeBytes: Number(entry.size_bytes ?? 0), reason: entry.reason as SkippedInboundAttachment['reason'] }))
      : [],
    assignmentStatus: row.assignment_status === 'assigned' || row.assignment_status === 'needs_review' ? row.assignment_status : undefined,
    assignmentSource: row.assignment_source === 'auto_sender' || row.assignment_source === 'auto_reference' || row.assignment_source === 'auto_thread' || row.assignment_source === 'manual' ? row.assignment_source : undefined,
    suggestedVorgangId: text(row.suggested_vorgang_id),
    assignedAt: text(row.assigned_at),
    threadId: text(row.thread_id),
    replyToMessageId: text(row.reply_to_message_id),
    rfcMessageId: text(row.rfc_message_id),
    inReplyTo: text(row.in_reply_to),
    references: stringList(row.references_ids),
    replyToAddresses: stringList(row.reply_to_addresses),
    deliveryState: row.direction === 'inbound' ? undefined : parseProviderDeliveryState(row.delivery_state),
    deliveryStateAt: text(row.delivery_state_at),
  };
}

/* ------------------------------------------------------------------------ */
/* Anhang                                                                    */
/* ------------------------------------------------------------------------ */

export interface UploadedEmailAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
}

export type EmailAttachmentUploadResult =
  | { ok: true; attachment: UploadedEmailAttachment; reused: boolean }
  | { ok: false; error: 'not_configured' | 'type_not_allowed' | 'forbidden' | 'too_large' | 'network' | 'unknown' };

export async function uploadEmailAttachment(
  input: { workspaceId: string; filename: string; bytes: Uint8Array },
  client?: SupabaseClient | null,
): Promise<EmailAttachmentUploadResult> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const extension = fileExtension(input.filename);
  const mimeType = mimeTypeForExtension(extension);
  if (!mimeType) return { ok: false, error: 'type_not_allowed' };
  const sha256 = await sha256Hex(input.bytes);
  const storagePath = buildEmailAttachmentStoragePath(input.workspaceId, sha256, extension);
  const attachment: UploadedEmailAttachment = { filename: input.filename, mimeType, sizeBytes: input.bytes.byteLength, sha256, storagePath };
  try {
    const { error } = await supabase.storage
      .from(EMAIL_ATTACHMENT_BUCKET)
      .upload(storagePath, new Blob([input.bytes as BlobPart], { type: mimeType }), { contentType: mimeType, upsert: false });
    if (error) {
      const status = Number((error as { statusCode?: string | number }).statusCode ?? NaN);
      const message = (error.message ?? '').toLowerCase();
      // Inhaltsadressiert: gleiche Datei liegt schon da — kein zweiter Upload nötig.
      if (status === 409 || message.includes('already exists') || message.includes('duplicate')) return { ok: true, attachment, reused: true };
      if (status === 413 || message.includes('size')) return { ok: false, error: 'too_large' };
      if (status === 401 || status === 403 || message.includes('row-level security') || message.includes('unauthorized')) return { ok: false, error: 'forbidden' };
      if (message.includes('mime') || message.includes('type')) return { ok: false, error: 'type_not_allowed' };
      return { ok: false, error: message.includes('fetch') || message.includes('network') ? 'network' : 'unknown' };
    }
  } catch {
    return { ok: false, error: 'network' };
  }
  return { ok: true, attachment, reused: false };
}

/**
 * E-MAIL-HALBZEIT-FIX B1 — gespeicherten Anhang laden (Öffnen/Herunterladen).
 *
 * Nur über den angemeldeten Storage-Zugriff: Die Lese-Policy des privaten
 * Buckets erlaubt ausschließlich aktiven Mitgliedern des Workspaces, dem der
 * Pfad gehört. Es entsteht keine öffentliche oder dauerhafte URL — der Aufrufer
 * bekommt die Bytes als Blob mit dem gespeicherten MIME-Typ.
 */
export type EmailAttachmentDownloadResult =
  | { ok: true; blob: Blob }
  | { ok: false; error: 'not_configured' | 'missing' | 'forbidden' | 'network' };

export async function downloadEmailAttachment(
  input: { storagePath: string; mimeType: string; storageBucket?: AttachmentBucket },
  client?: SupabaseClient | null,
): Promise<EmailAttachmentDownloadResult> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  if (!parseEmailAttachmentStoragePath(input.storagePath)) return { ok: false, error: 'missing' };
  try {
    const bucket = input.storageBucket && (ATTACHMENT_BUCKETS as readonly string[]).includes(input.storageBucket) ? input.storageBucket : EMAIL_ATTACHMENT_BUCKET;
    const { data, error } = await supabase.storage.from(bucket).download(input.storagePath);
    if (error || !data) {
      const status = Number((error as { statusCode?: string | number } | null)?.statusCode ?? (error as { status?: number } | null)?.status ?? NaN);
      const message = (error?.message ?? '').toLowerCase();
      if (status === 404 || message.includes('not found') || message.includes('does not exist')) return { ok: false, error: 'missing' };
      if (status === 401 || status === 403 || message.includes('unauthorized') || message.includes('row-level security')) return { ok: false, error: 'forbidden' };
      // Storage meldet ein fehlendes Objekt bei privaten Buckets teils als 400 ohne eindeutigen Text.
      if (status === 400) return { ok: false, error: 'missing' };
      return { ok: false, error: 'network' };
    }
    const bytes = await data.arrayBuffer();
    return { ok: true, blob: new Blob([bytes], { type: input.mimeType }) };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/* ------------------------------------------------------------------------ */
/* Anlegen / Neuversuch                                                      */
/* ------------------------------------------------------------------------ */

export interface CreateEmailMessageInput {
  workspaceId: string;
  clientMessageId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  attachments: UploadedEmailAttachment[];
  provider: 'brevo' | 'stub';
  customerId?: string;
  vorgangId?: string;
  /** E-MAIL 07F-01A — beantwortete Nachricht: gleicher Verlauf, In-Reply-To/References setzt der Server. */
  replyToMessageId?: string;
}

export type EmailMessageRpcError =
  | 'not_configured'
  | 'not_deployed'
  | 'forbidden'
  | 'invalid_recipient'
  | 'too_many_recipients'
  | 'context_invalid'
  | 'context_conflict'
  | 'attachment_type'
  | 'attachment_too_large'
  | 'attachments_too_large'
  | 'attachment_missing'
  | 'attachment_invalid'
  | 'sender_incomplete'
  | 'idempotency_conflict'
  | 'uncertain_pending'
  | 'retry_exists'
  | 'reply_parent_missing'
  | 'not_retryable'
  | 'rate_limited'
  | 'invalid_response'
  | 'rpc_failed';

export type EmailMessageRpcResult =
  | { ok: true; outcome: 'created' | 'replayed'; message: EmailMessage }
  | { ok: false; error: EmailMessageRpcError; message?: string };

function isMissingRpcFunction(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '');
}

export function classifyEmailRpcError(error: { code?: string; message?: string }): EmailMessageRpcError {
  if (isMissingRpcFunction(error)) return 'not_deployed';
  const lower = (error.message ?? '').toLowerCase();
  if (lower.includes('idempotenzkonflikt')) return 'idempotency_conflict';
  if (lower.includes('versandlimit')) return 'rate_limited';
  if (lower.includes('bereits angelegt')) return 'retry_exists';
  if (lower.includes('beantwortete nachricht nicht gefunden')) return 'reply_parent_missing';
  if (lower.includes('versandstatus unklar')) return 'uncertain_pending';
  if (lower.includes('nur nach fehlschlag')) return 'not_retryable';
  if (lower.includes('kunde passt nicht zum vorgang')) return 'context_conflict';
  if (lower.includes('customer_id gehoert nicht') || lower.includes('vorgang_id gehoert nicht')) return 'context_invalid';
  if (lower.includes('zu viele empfaenger')) return 'too_many_recipients';
  if (lower.includes('ungueltige adresse') || lower.includes('mindestens ein empfaenger')) return 'invalid_recipient';
  if (lower.includes('dateityp')) return 'attachment_type';
  if (lower.includes('zusammen zu gross') || lower.includes('zu viele anhaenge')) return 'attachments_too_large';
  if (lower.includes('datei zu gross')) return 'attachment_too_large';
  if (lower.includes('anhang nicht gefunden')) return 'attachment_missing';
  if (lower.includes('anhang')) return 'attachment_invalid';
  if (lower.includes('absender')) return 'sender_incomplete';
  if (lower.includes('kein zugriff') || lower.includes('schreibberechtigung') || lower.includes('nicht angemeldet')) return 'forbidden';
  return 'rpc_failed';
}

function envelope(data: unknown): EmailMessageRpcResult {
  const payload = data as { outcome?: string; message?: unknown } | null;
  const message = parseEmailMessageRow(payload?.message);
  if (!message || (payload?.outcome !== 'created' && payload?.outcome !== 'replayed')) return { ok: false, error: 'invalid_response' };
  return { ok: true, outcome: payload.outcome, message };
}

export async function rpcCreateEmailMessage(input: CreateEmailMessageInput, client?: SupabaseClient | null): Promise<EmailMessageRpcResult> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc('create_workspace_email_message', {
    p_workspace_id: input.workspaceId,
    p_client_message_id: input.clientMessageId,
    p_to: input.to,
    p_cc: input.cc,
    p_bcc: input.bcc,
    p_subject: input.subject,
    p_body_text: input.bodyText,
    p_attachments: input.attachments.map((attachment) => ({
      storage_path: attachment.storagePath,
      sha256: attachment.sha256,
      filename: attachment.filename,
      mime_type: attachment.mimeType,
      size_bytes: attachment.sizeBytes,
    })),
    p_provider: input.provider,
    p_customer_id: input.customerId ?? null,
    p_vorgang_id: input.vorgangId ?? null,
    // 07F-01A: nur bei Antworten gesendet — freie E-Mails rufen die RPC unverändert auf.
    ...(input.replyToMessageId ? { p_reply_to_message_id: input.replyToMessageId } : {}),
  });
  if (error) return { ok: false, error: classifyEmailRpcError(error), message: error.message };
  return envelope(data);
}

export async function rpcRetryEmailMessage(
  input: { workspaceId: string; clientMessageId: string; retryOfMessageId: string; confirmUncertainRetry?: boolean },
  client?: SupabaseClient | null,
): Promise<EmailMessageRpcResult> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc('retry_workspace_email_message', {
    p_workspace_id: input.workspaceId,
    p_client_message_id: input.clientMessageId,
    p_retry_of_message_id: input.retryOfMessageId,
    p_confirm_uncertain_retry: input.confirmUncertainRetry === true,
  });
  if (error) return { ok: false, error: classifyEmailRpcError(error), message: error.message };
  return envelope(data);
}

/* ------------------------------------------------------------------------ */
/* Lesen                                                                     */
/* ------------------------------------------------------------------------ */

export type EmailMessageListResult = { ok: true; messages: EmailMessage[] } | { ok: false; error: EmailMessageRpcError };

function parseList(data: unknown): EmailMessage[] {
  return Array.isArray(data) ? data.map(parseEmailMessageRow).filter((entry): entry is EmailMessage => entry !== null) : [];
}

export async function rpcListEmailMessages(
  input: { workspaceId: string; customerId?: string; vorgangId?: string; limit?: number },
  client?: SupabaseClient | null,
): Promise<EmailMessageListResult> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc('list_workspace_email_messages', {
    p_workspace_id: input.workspaceId,
    p_customer_id: input.customerId ?? null,
    p_vorgang_id: input.vorgangId ?? null,
    p_limit: input.limit ?? 200,
  });
  if (error) return { ok: false, error: classifyEmailRpcError(error) };
  return { ok: true, messages: parseList(data) };
}

export async function rpcGetEmailMessageChain(
  input: { workspaceId: string; messageId: string },
  client?: SupabaseClient | null,
): Promise<EmailMessageListResult> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc('get_workspace_email_message_chain', {
    p_workspace_id: input.workspaceId,
    p_message_id: input.messageId,
  });
  if (error) return { ok: false, error: classifyEmailRpcError(error) };
  return { ok: true, messages: parseList(data) };
}

/**
 * E-MAIL 07F-01A — Gesprächsverlauf einer Nachricht: alle ein- und ausgehenden
 * Nachrichten desselben OfficeTakt-Threads, älteste zuerst (eine Anfrage).
 */
export async function rpcGetEmailThread(
  input: { workspaceId: string; messageId: string },
  client?: SupabaseClient | null,
): Promise<EmailMessageListResult> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc('get_workspace_email_thread', {
    p_workspace_id: input.workspaceId,
    p_message_id: input.messageId,
  });
  if (error) return { ok: false, error: classifyEmailRpcError(error) };
  return { ok: true, messages: parseList(data) };
}

/**
 * E-MAIL 07F-01B — Zustellverlauf einer Nachricht (Rückmeldungen des
 * E-Mail-Dienstes, älteste zuerst). Nur normalisierte Zustände + Zeitpunkt.
 */
export interface DeliveryStateEvent {
  state: import('../delivery/providerDeliveryState').ProviderDeliveryState;
  at: string;
  applied: boolean;
}

export type DeliveryEventsResult = { ok: true; events: DeliveryStateEvent[] } | { ok: false; error: EmailMessageRpcError };

export async function rpcListDeliveryEvents(
  input: { workspaceId: string; emailMessageId?: string; documentDeliveryId?: string },
  client?: SupabaseClient | null,
): Promise<DeliveryEventsResult> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc('list_workspace_email_delivery_events', {
    p_workspace_id: input.workspaceId,
    p_email_message_id: input.emailMessageId ?? null,
    p_document_delivery_id: input.documentDeliveryId ?? null,
  });
  if (error) return { ok: false, error: classifyEmailRpcError(error) };
  const events = (Array.isArray(data) ? data : [])
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      const state = parseProviderDeliveryState(row.state);
      const at = text(row.event_at);
      return state && at ? { state, at, applied: row.applied === true } : null;
    })
    .filter((entry): entry is DeliveryStateEvent => entry !== null);
  return { ok: true, events };
}

/* ------------------------------------------------------------------------ */
/* Versand (Edge Function)                                                   */
/* ------------------------------------------------------------------------ */

export interface SendEmailServerResponse {
  ok: boolean;
  action?: 'sent' | 'replayed' | 'unknown_pending' | 'failed' | 'in_progress';
  error?: string;
  message?: { id: string; status: EmailMessageStatus; rowVersion: number };
}

export type InvokeSendEmail = (input: { workspaceId: string; clientMessageId: string }) => Promise<{ status: number; body: SendEmailServerResponse }>;

export function createInvokeSendEmail(client: SupabaseClient): InvokeSendEmail {
  return async (input) => {
    const baseUrl = getSupabaseUrl();
    const { data: sessionData } = await client.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (!baseUrl || !accessToken) return { status: 401, body: { ok: false, error: 'unauthenticated' } };
    const response = await fetch(`${baseUrl}/functions/v1/send-email`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await response.json().catch(() => ({ ok: false, error: 'invalid_response' }))) as SendEmailServerResponse;
    return { status: response.status, body };
  };
}

/* ------------------------------------------------------------------------ */
/* E-MAIL-07E — Posteingang                                                  */
/* ------------------------------------------------------------------------ */

export async function rpcListInboundEmailMessages(
  input: { workspaceId: string; customerId?: string; vorgangId?: string; needsReviewOnly?: boolean; limit?: number },
  client?: SupabaseClient | null,
): Promise<EmailMessageListResult> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc('list_workspace_inbound_email_messages', {
    p_workspace_id: input.workspaceId,
    p_customer_id: input.customerId ?? null,
    p_vorgang_id: input.vorgangId ?? null,
    p_needs_review_only: input.needsReviewOnly === true,
    p_limit: input.limit ?? 200,
  });
  if (error) return { ok: false, error: classifyEmailRpcError(error) };
  return { ok: true, messages: parseList(data) };
}

export type InboundMessageResult = { ok: true; message: EmailMessage | null } | { ok: false; error: EmailMessageRpcError };

export async function rpcGetInboundEmailMessage(
  input: { workspaceId: string; messageId: string },
  client?: SupabaseClient | null,
): Promise<InboundMessageResult> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc('get_workspace_inbound_email_message', { p_workspace_id: input.workspaceId, p_message_id: input.messageId });
  if (error) return { ok: false, error: classifyEmailRpcError(error) };
  return { ok: true, message: data ? parseEmailMessageRow(data) : null };
}

export type AssignInboundError = EmailMessageRpcError | 'stale';

export async function rpcAssignInboundEmailMessage(
  input: { workspaceId: string; messageId: string; customerId?: string; vorgangId?: string; expectedRowVersion?: number },
  client?: SupabaseClient | null,
): Promise<{ ok: true; message: EmailMessage } | { ok: false; error: AssignInboundError }> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc('assign_workspace_inbound_email_message', {
    p_workspace_id: input.workspaceId,
    p_message_id: input.messageId,
    p_customer_id: input.customerId ?? null,
    p_vorgang_id: input.vorgangId ?? null,
    p_expected_row_version: input.expectedRowVersion ?? null,
  });
  if (error) return { ok: false, error: /row_version/i.test(error.message ?? '') ? 'stale' : classifyEmailRpcError(error) };
  const message = parseEmailMessageRow(data);
  return message ? { ok: true, message } : { ok: false, error: 'invalid_response' };
}

export async function rpcListMailboxConnections(
  input: { workspaceId: string },
  client?: SupabaseClient | null,
): Promise<{ ok: true; connections: MailboxConnection[] } | { ok: false; error: EmailMessageRpcError }> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc('list_workspace_mailbox_connections', { p_workspace_id: input.workspaceId });
  if (error) return { ok: false, error: classifyEmailRpcError(error) };
  const connections: MailboxConnection[] = Array.isArray(data)
    ? (data as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        providerType: row.provider_type as MailboxConnection['providerType'],
        mailboxAddress: String(row.mailbox_address ?? ''),
        displayName: text(row.display_name),
        status: row.status as MailboxConnection['status'],
        lastSuccessfulSyncAt: text(row.last_successful_sync_at),
        lastAttemptAt: text(row.last_attempt_at),
        nextAttemptAt: text(row.next_attempt_at),
        errorCategory: text(row.error_category),
        errorCode: text(row.error_code),
        safeErrorMessage: text(row.safe_error_message),
        hasCredentials: row.has_credentials === true,
        authMode: row.auth_mode === 'application' || row.auth_mode === 'delegated' ? row.auth_mode : undefined,
        mailboxSourceKind: row.mailbox_source_kind === 'folder' || row.mailbox_source_kind === 'label' ? row.mailbox_source_kind : undefined,
        mailboxSourceName: text(row.mailbox_source_name),
        importFrom: text(row.import_from),
        accountVerifiedAt: text(row.account_verified_at),
      }))
    : [];
  return { ok: true, connections };
}

/* ------------------------------------------------------------------------ */
/* E-MAIL-07E-MSA — Microsoft-Postfach per OAuth                             */
/* ------------------------------------------------------------------------ */

export type StartMailboxOAuthResult =
  | { ok: true; authorizeUrl: string }
  | {
      ok: false;
      error: 'not_configured' | 'not_deployed' | 'oauth_not_configured' | 'provider_not_available' | 'unauthenticated' | 'forbidden' | 'invalid_address' | 'invalid_source' | 'source_not_allowed' | 'invalid_import_window' | 'server_unavailable';
    };

/**
 * Erlaubte Anmeldeseiten je OAuth-Anbieter: Der Browser wird nur dorthin
 * weitergeleitet (Schutz gegen eine manipulierte Server-Antwort).
 * google_gmail ist vorbereitet; der Server startet es noch nicht.
 */
export const MAILBOX_AUTHORIZE_PREFIXES: Record<MailboxOAuthProviderType, string> = {
  microsoft_graph: 'https://login.microsoftonline.com/',
  google_gmail: 'https://accounts.google.com/o/oauth2/v2/auth?',
};

/**
 * Startet die Anmeldung beim gewählten Anbieter (Edge Function
 * `mailbox-oauth-start`). Der Server erzeugt state/PKCE; zurück kommt nur die
 * Anmelde-URL des Anbieters — sie wird nur akzeptiert, wenn sie zu genau
 * diesem Anbieter gehört. Kein Passwort, kein Token im Browser.
 */
export async function startMailboxOAuth(
  input: { workspaceId: string; provider: MailboxOAuthProviderType; expectedAddress: string; sourceName: string; importDays: number },
  client?: SupabaseClient | null,
): Promise<StartMailboxOAuthResult> {
  const supabase = client ?? getSupabaseClient();
  const baseUrl = getSupabaseUrl();
  if (!supabase || !baseUrl) return { ok: false, error: 'not_configured' };
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (!accessToken) return { ok: false, error: 'unauthenticated' };
  try {
    const response = await fetch(`${baseUrl}/functions/v1/mailbox-oauth-start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.ok === true && typeof body.authorizeUrl === 'string' && body.authorizeUrl.startsWith(MAILBOX_AUTHORIZE_PREFIXES[input.provider] ?? 'ungueltig:')) {
      return { ok: true, authorizeUrl: body.authorizeUrl };
    }
    if (response.status === 401) return { ok: false, error: 'unauthenticated' };
    if (response.status === 403) return { ok: false, error: 'forbidden' };
    const known = ['oauth_not_configured', 'provider_not_available', 'invalid_address', 'invalid_source', 'source_not_allowed', 'invalid_import_window'] as const;
    const error = known.find((entry) => entry === body.error);
    if (error) return { ok: false, error };
    return { ok: false, error: response.status === 404 ? 'not_deployed' : 'server_unavailable' };
  } catch {
    return { ok: false, error: 'server_unavailable' };
  }
}

export async function rpcGetMailboxOAuthPending(
  input: { workspaceId: string; stateId: string },
  client?: SupabaseClient | null,
): Promise<{ ok: true; pending: MailboxOAuthPending | null } | { ok: false; error: EmailMessageRpcError }> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc('get_workspace_mailbox_oauth_pending', { p_workspace_id: input.workspaceId, p_state_id: input.stateId });
  if (error) return { ok: false, error: classifyEmailRpcError(error) };
  const row = data as Record<string, unknown> | null;
  if (!row || typeof row.detected_address !== 'string') return { ok: true, pending: null };
  return {
    ok: true,
    pending: {
      stateId: String(row.state_id),
      expectedAddress: String(row.expected_address ?? ''),
      detectedAddress: row.detected_address,
      providerType: row.provider_type === 'google_gmail' ? 'google_gmail' : 'microsoft_graph',
      reason: row.reason === 'account_changed' ? 'account_changed' : 'address_mismatch',
      sourceKind: row.source_kind === 'label' ? 'label' : 'folder',
      sourceName: String(row.source_name ?? ''),
      pendingUntil: String(row.pending_until ?? ''),
    },
  };
}

export async function rpcResolveMailboxOAuthPending(
  input: { workspaceId: string; stateId: string; decision: 'confirm' | 'cancel' },
  client?: SupabaseClient | null,
): Promise<{ ok: true } | { ok: false; error: EmailMessageRpcError | 'expired' }> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const { error } = await supabase.rpc(
    input.decision === 'confirm' ? 'confirm_workspace_mailbox_oauth_pending' : 'cancel_workspace_mailbox_oauth_pending',
    { p_workspace_id: input.workspaceId, p_state_id: input.stateId },
  );
  if (error) return { ok: false, error: /abgelaufen|keine ausstehende/i.test(error.message ?? '') ? 'expired' : classifyEmailRpcError(error) };
  return { ok: true };
}

/** Trennen: Zugang wird serverseitig gelöscht; importierte E-Mails bleiben. */
export async function rpcDisconnectMailbox(
  input: { workspaceId: string; connectionId: string },
  client?: SupabaseClient | null,
): Promise<{ ok: true } | { ok: false; error: EmailMessageRpcError }> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const { error } = await supabase.rpc('disconnect_workspace_mailbox_connection', { p_workspace_id: input.workspaceId, p_connection_id: input.connectionId });
  if (error) return { ok: false, error: classifyEmailRpcError(error) };
  return { ok: true };
}

export type SyncMailboxResult =
  | { ok: true; action: 'synced'; imported: number; failed: number; more: boolean }
  | { ok: true; action: 'busy' | 'backoff' | 'disconnected' }
  | { ok: true; action: 'cooldown'; retryAfterSeconds: number }
  | { ok: false; error: 'not_configured' | 'not_deployed' | 'unauthenticated' | 'forbidden' | 'provider_error' | 'server_unavailable'; category?: string };

/** E-MAIL-07E — Abruf auslösen (Edge Function `sync-mailbox`). Nie ein Versand. */
export async function invokeSyncMailbox(input: { workspaceId: string; connectionId: string }, client?: SupabaseClient | null): Promise<SyncMailboxResult> {
  const supabase = client ?? getSupabaseClient();
  const baseUrl = getSupabaseUrl();
  if (!supabase || !baseUrl) return { ok: false, error: 'not_configured' };
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (!accessToken) return { ok: false, error: 'unauthenticated' };
  try {
    const response = await fetch(`${baseUrl}/functions/v1/sync-mailbox`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 401) return { ok: false, error: 'unauthenticated' };
    if (response.status === 403) return { ok: false, error: 'forbidden' };
    if (body.ok === true) return body as SyncMailboxResult;
    if (body.action === 'provider_error') return { ok: false, error: 'provider_error', category: String(body.category ?? 'unknown') };
    return { ok: false, error: response.status === 404 ? 'not_deployed' : 'server_unavailable' };
  } catch {
    return { ok: false, error: 'server_unavailable' };
  }
}
