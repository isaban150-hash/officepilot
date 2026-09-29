/**
 * E-MAIL-07D — Kern der freien Geschäfts-E-Mail, ohne Deno- und Supabase-
 * Abhängigkeit (Vitest prüft ihn direkt).
 *
 * Dieselben Regeln wie der Dokumentversand (07B), eigene Daten:
 *   * nur `queued` wird gesendet; der atomare Claim `queued -> sending` ist der
 *     letzte Schritt vor dem Provider — nur wer ihn gewinnt, sendet,
 *   * ein hängendes `sending` wird `unknown`, nie automatisch erneut gesendet,
 *   * `unknown` / `failed` / `provider_accepted` lösen keinen Provider-Aufruf aus,
 *   * der Testempfänger-Schutz prüft ALLE Empfänger (An, Cc, Bcc),
 *   * jeder Anhang wird aus dem privaten Bucket geladen und gegen Pfad,
 *     Workspace, Typ, Größe, Inhalt und SHA-256 geprüft.
 */
import { allRecipientAddresses, type DeliveryErrorCategory, type EmailProviderAdapter, type SendTransactionalEmailResult } from './emailProvider.ts';
import {
  EMAIL_ATTACHMENT_MAX_COUNT,
  EMAIL_ATTACHMENT_MAX_FILE_BYTES,
  EMAIL_ATTACHMENT_MAX_TOTAL_BYTES,
  EMAIL_MAX_RECIPIENTS,
  EMAIL_MAX_TO,
  attachmentContentMatchesType,
  isSafeAttachmentFilename,
  isValidEmailAddress,
  mimeTypeForExtension,
  parseEmailAttachmentStoragePath,
} from './emailMessageRules.ts';
import { STALE_SENDING_CLAIM_SECONDS, bytesToBase64, type TestRecipientAllowlist } from './sendDocumentCore.ts';

export type EmailMessageStatus = 'queued' | 'sending' | 'provider_accepted' | 'failed' | 'unknown';

export interface EmailMessageAttachmentRow {
  id?: string;
  position: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
}

export interface EmailMessageRow {
  id: string;
  workspace_id: string;
  client_message_id: string;
  to_recipients: string[];
  cc_recipients: string[];
  bcc_recipients: string[];
  subject: string;
  body_text: string;
  sender_name: string;
  reply_to_email: string;
  provider: string;
  provider_message_id: string | null;
  status: EmailMessageStatus;
  row_version: number;
  error_category: string | null;
  error_code: string | null;
  error_message_safe: string | null;
  attachments: EmailMessageAttachmentRow[];
}

export interface SendEmailDeps {
  senderEmail: string;
  testRecipientAllowlist?: TestRecipientAllowlist;
  userCanWrite(workspaceId: string, userId: string): Promise<boolean>;
  loadMessage(workspaceId: string, clientMessageId: string): Promise<EmailMessageRow | null>;
  downloadAttachment(storagePath: string): Promise<Uint8Array | null>;
  sha256Hex(bytes: Uint8Array): Promise<string>;
  provider: EmailProviderAdapter;
  claim(messageId: string, expectedRowVersion: number): Promise<{ claimed: boolean; message: EmailMessageRow }>;
  resolveStaleClaim(messageId: string, staleAfterSeconds: number): Promise<{ resolved: boolean; message: EmailMessageRow }>;
  markAccepted(messageId: string, providerMessageId: string, expectedRowVersion: number): Promise<EmailMessageRow>;
  markStatus(messageId: string, status: 'failed' | 'unknown', error: { category: DeliveryErrorCategory; code: string; message: string }, expectedRowVersion: number): Promise<EmailMessageRow>;
  log(entry: Record<string, string | number | boolean | null>): void;
}

export type SendEmailErrorCode = 'unauthenticated' | 'forbidden' | 'message_not_found' | 'provider_mismatch' | 'invalid_state';
export type SendEmailAction = 'sent' | 'replayed' | 'unknown_pending' | 'failed' | 'in_progress';

export interface SendEmailResponseMessage {
  id: string;
  clientMessageId: string;
  status: EmailMessageStatus;
  providerMessageId: string | null;
  errorCategory: string | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  rowVersion: number;
}

export type SendEmailOutcome =
  | { ok: true; action: SendEmailAction; message: SendEmailResponseMessage }
  | { ok: false; error: SendEmailErrorCode };

export function toResponseMessage(row: EmailMessageRow): SendEmailResponseMessage {
  return {
    id: row.id,
    clientMessageId: row.client_message_id,
    status: row.status,
    providerMessageId: row.provider_message_id,
    errorCategory: row.error_category,
    errorCode: row.error_code,
    errorMessageSafe: row.error_message_safe,
    rowVersion: Number(row.row_version),
  };
}

function actionForForeignState(status: EmailMessageStatus): SendEmailAction {
  if (status === 'provider_accepted') return 'replayed';
  if (status === 'unknown') return 'unknown_pending';
  if (status === 'failed') return 'failed';
  return 'in_progress';
}

/** E-MAIL-07D — alle Adressen der Nachricht, normalisiert. */
export function messageRecipients(message: Pick<EmailMessageRow, 'to_recipients' | 'cc_recipients' | 'bcc_recipients'>): string[] {
  return [...(message.to_recipients ?? []), ...(message.cc_recipients ?? []), ...(message.bcc_recipients ?? [])].map((entry) =>
    entry.trim().toLowerCase(),
  );
}

export async function runSendEmail(
  input: { userId: string | null; workspaceId: string; clientMessageId: string },
  deps: SendEmailDeps,
): Promise<SendEmailOutcome> {
  if (!input.userId) return { ok: false, error: 'unauthenticated' };
  if (!input.workspaceId || !input.clientMessageId) return { ok: false, error: 'message_not_found' };
  if (!(await deps.userCanWrite(input.workspaceId, input.userId))) return { ok: false, error: 'forbidden' };

  const message = await deps.loadMessage(input.workspaceId, input.clientMessageId);
  // Nie über einen fremden Workspace erreichbar: Laden nur mit workspace_id + client_message_id.
  if (!message || message.workspace_id !== input.workspaceId) return { ok: false, error: 'message_not_found' };
  const base = { messageId: message.id, workspaceId: message.workspace_id, provider: deps.provider.provider, kind: 'free_email' };

  if (message.status === 'provider_accepted') {
    deps.log({ ...base, outcome: 'replayed' });
    return { ok: true, action: 'replayed', message: toResponseMessage(message) };
  }
  if (message.status === 'sending') {
    const stale = await deps.resolveStaleClaim(message.id, STALE_SENDING_CLAIM_SECONDS);
    if (stale.resolved) {
      deps.log({ ...base, outcome: 'stale_claim_unknown' });
      return { ok: true, action: 'unknown_pending', message: toResponseMessage(stale.message) };
    }
    deps.log({ ...base, outcome: 'in_progress' });
    return { ok: true, action: actionForForeignState(stale.message.status), message: toResponseMessage(stale.message) };
  }
  if (message.status === 'unknown') {
    deps.log({ ...base, outcome: 'unknown_pending' });
    return { ok: true, action: 'unknown_pending', message: toResponseMessage(message) };
  }
  if (message.status === 'failed') {
    deps.log({ ...base, outcome: 'already_failed' });
    return { ok: true, action: 'failed', message: toResponseMessage(message) };
  }
  if (message.status !== 'queued') return { ok: false, error: 'invalid_state' };

  if (message.provider !== deps.provider.provider) {
    deps.log({ ...base, outcome: 'provider_mismatch' });
    return { ok: false, error: 'provider_mismatch' };
  }

  const heldRowVersion = message.row_version;
  const fail = async (status: 'failed' | 'unknown', category: DeliveryErrorCategory, code: string, text: string, version = heldRowVersion) => {
    const updated = await deps.markStatus(message.id, status, { category, code, message: text }, version);
    deps.log({ ...base, outcome: status, errorCategory: category, errorCode: code });
    return { ok: true as const, action: status === 'unknown' ? ('unknown_pending' as const) : ('failed' as const), message: toResponseMessage(updated) };
  };

  // Empfänger (erneut, serverseitig): gültig, mindestens ein „An", Grenzen.
  const to = message.to_recipients ?? [];
  const recipients = messageRecipients(message);
  if (to.length < 1 || to.length > EMAIL_MAX_TO || recipients.length > EMAIL_MAX_RECIPIENTS || recipients.some((entry) => !isValidEmailAddress(entry))) {
    return fail('failed', 'recipient', 'recipients_invalid', 'Die Empfängerangaben sind ungültig. Es wurde nichts gesendet.');
  }

  // Testempfänger-Schutz: ALLE Empfänger — ein erlaubtes „An" nimmt kein fremdes Cc/Bcc mit.
  const allowlist = deps.testRecipientAllowlist ?? { mode: 'off' as const };
  if (allowlist.mode === 'invalid') {
    return fail('failed', 'unknown', 'test_recipient_allowlist_invalid', 'Der Testmodus ist fehlerhaft eingerichtet. Es wurde nichts gesendet.');
  }
  if (allowlist.mode === 'on' && recipients.some((entry) => !allowlist.recipients.includes(entry))) {
    return fail('failed', 'recipient', 'test_recipient_not_allowed', 'Testmodus: Mindestens eine Empfängeradresse (An, Cc oder Bcc) ist für Testsendungen nicht freigegeben. Es wurde nichts gesendet.');
  }

  // Absender-Snapshot aus der Anlage.
  const senderName = (message.sender_name ?? '').trim();
  const replyTo = (message.reply_to_email ?? '').trim().toLowerCase();
  if (!senderName || !isValidEmailAddress(replyTo)) {
    return fail('failed', 'unknown', 'sender_snapshot_invalid', 'Absenderdaten des Betriebs sind unvollständig. Es wurde nichts gesendet.');
  }

  // Anhänge: jeder einzeln geladen und geprüft.
  const attachments = [...(message.attachments ?? [])].sort((a, b) => a.position - b.position);
  if (attachments.length > EMAIL_ATTACHMENT_MAX_COUNT) {
    return fail('failed', 'attachment', 'attachment_count_exceeded', 'Zu viele Anhänge. Es wurde nichts gesendet.');
  }
  let total = 0;
  const loaded: { filename: string; mimeType: string; contentBase64: string }[] = [];
  for (const attachment of attachments) {
    const parsed = parseEmailAttachmentStoragePath(attachment.storage_path ?? '');
    const size = Number(attachment.size_bytes);
    if (
      !parsed ||
      parsed.workspaceId.toLowerCase() !== message.workspace_id.toLowerCase() ||
      parsed.sha256 !== attachment.sha256 ||
      mimeTypeForExtension(parsed.extension) !== attachment.mime_type ||
      !isSafeAttachmentFilename(attachment.filename ?? '', parsed.extension)
    ) {
      return fail('failed', 'attachment', 'attachment_metadata_invalid', `Der Anhang „${attachment.filename}" ist nicht korrekt hinterlegt. Es wurde nichts gesendet.`);
    }
    if (!(size > 0) || size > EMAIL_ATTACHMENT_MAX_FILE_BYTES) {
      return fail('failed', 'attachment', 'attachment_too_large', `Der Anhang „${attachment.filename}" ist zu groß. Es wurde nichts gesendet.`);
    }
    total += size;
    if (total > EMAIL_ATTACHMENT_MAX_TOTAL_BYTES) {
      return fail('failed', 'attachment', 'attachments_total_too_large', 'Die Anhänge sind zusammen zu groß. Es wurde nichts gesendet.');
    }
  }
  // Erst wenn alle Metadaten und Grenzen stimmen, wird geladen und der Inhalt geprüft.
  for (const attachment of attachments) {
    const parsed = parseEmailAttachmentStoragePath(attachment.storage_path)!;
    const size = Number(attachment.size_bytes);
    const bytes = await deps.downloadAttachment(attachment.storage_path);
    if (!bytes) {
      return fail('failed', 'attachment', 'attachment_missing', `Der Anhang „${attachment.filename}" ist nicht mehr verfügbar. Es wurde nichts gesendet.`);
    }
    if (bytes.byteLength !== size) {
      return fail('failed', 'attachment', 'attachment_size_mismatch', `Der Anhang „${attachment.filename}" hat nicht die erwartete Größe. Es wurde nichts gesendet.`);
    }
    if (!attachmentContentMatchesType(bytes, parsed.extension)) {
      return fail('failed', 'attachment', 'attachment_content_mismatch', `Der Inhalt von „${attachment.filename}" passt nicht zum Dateityp. Es wurde nichts gesendet.`);
    }
    if ((await deps.sha256Hex(bytes)) !== attachment.sha256) {
      return fail('failed', 'attachment', 'attachment_sha256_mismatch', `Der Anhang „${attachment.filename}" entspricht nicht dem hinterlegten Prüfwert. Es wurde nichts gesendet.`);
    }
    loaded.push({ filename: attachment.filename, mimeType: attachment.mime_type, contentBase64: bytesToBase64(bytes) });
  }

  // Claim — letzter Schritt vor dem Provider.
  const claim = await deps.claim(message.id, message.row_version);
  if (!claim.claimed) {
    deps.log({ ...base, outcome: 'claim_lost', status: claim.message.status });
    return { ok: true, action: actionForForeignState(claim.message.status), message: toResponseMessage(claim.message) };
  }
  const claimedVersion = Number(claim.message.row_version);

  const providerInput = {
    from: { email: deps.senderEmail, name: senderName },
    replyTo: { email: replyTo, name: senderName },
    to: to.map((email) => ({ email })),
    cc: (message.cc_recipients ?? []).map((email) => ({ email })),
    bcc: (message.bcc_recipients ?? []).map((email) => ({ email })),
    subject: message.subject,
    text: message.body_text,
    attachments: loaded,
    idempotencyKey: `${message.workspace_id}:email:${message.client_message_id}`,
  };
  // Doppelte Absicherung: der Provider bekommt genau die geprüften Adressen.
  if (allRecipientAddresses(providerInput).length !== recipients.length) {
    return fail('failed', 'unknown', 'recipients_inconsistent', 'Die Empfängerangaben sind inkonsistent. Es wurde nichts gesendet.', claimedVersion);
  }

  let result: SendTransactionalEmailResult;
  try {
    result = await deps.provider.sendTransactionalEmail(providerInput);
  } catch {
    return fail('unknown', 'unknown', 'provider_adapter_threw', 'Der Versanddienst hat unerwartet abgebrochen — Ergebnis unbekannt.', claimedVersion);
  }

  if (result.accepted) {
    const accepted = await deps.markAccepted(message.id, result.providerMessageId, claimedVersion);
    deps.log({ ...base, outcome: 'provider_accepted', attachments: loaded.length, recipients: recipients.length });
    return { ok: true, action: 'sent', message: toResponseMessage(accepted) };
  }
  if (result.handoffUncertain) {
    return fail('unknown', result.errorCategory, result.errorCode, result.errorMessageSafe, claimedVersion);
  }
  return fail('failed', result.errorCategory, result.errorCode, result.errorMessageSafe, claimedVersion);
}
