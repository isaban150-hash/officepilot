/**
 * EMAIL-01B2 — Kern der Versandkette, ohne Deno- und Supabase-Abhängigkeit.
 *
 * Die Edge Function `send-document` liefert die Abhängigkeiten (Laden,
 * Download, Provider, autoritative Statuspfade); dieser Kern trifft die
 * Entscheidungen: Berechtigung, Zustand, Anhang-Integrität, Absender-
 * Wahrheit, Provider-Aufruf, Ergebnisübernahme, Replay/Unknown-Regeln.
 * Dadurch ist die Logik in Vitest vollständig prüfbar.
 */
import type { DeliveryErrorCategory, EmailProviderAdapter, SendTransactionalEmailResult } from './emailProvider.ts';

/**
 * BREVO-LIVE-CONFIG-01 — die technische Absenderadresse ist Serverkonfiguration
 * (`MAIL_SENDER_EMAIL`, eine in Brevo authentifizierte Domain). Kein Default,
 * kein Fallback: Die Edge Function validiert sie fail-closed und reicht sie als
 * Abhängigkeit herein. Der Kern kennt keine feste Adresse mehr.
 */
const SENDER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function resolveConfiguredSenderEmail(value: string | undefined | null): string | null {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized || normalized.length > 254 || !SENDER_EMAIL_PATTERN.test(normalized)) return null;
  return normalized;
}

export type DeliveryStatus =
  | 'prepared' | 'queued' | 'provider_accepted' | 'failed' | 'unknown'
  | 'delivered' | 'bounced' | 'complained' | 'rejected';

export interface DeliveryRow {
  id: string;
  workspace_id: string;
  client_delivery_id: string;
  document_kind: string;
  linked_invoice_id: string | null;
  linked_document_id?: string | null;
  recipient_email: string;
  subject: string;
  body_text: string;
  attachment_storage_path: string | null;
  attachment_sha256: string | null;
  attachment_size_bytes: number | null;
  attachment_filename: string | null;
  attachment_mime_type: string | null;
  provider: string;
  provider_message_id: string | null;
  status: DeliveryStatus;
  row_version: number;
  error_category: string | null;
  error_code: string | null;
  error_message_safe: string | null;
}

export interface InvoiceContext {
  client_invoice_id: string;
  invoice_number: string;
  invoice_status: string;
  cancelled_at: string | null;
  cancellation_kind: string | null;
  correction_document_id: string | null;
  sent_source: string | null;
  sent_delivery_id: string | null;
  company_snapshot: { companyName?: unknown; legalForm?: unknown; email?: unknown } | null;
}

/** V1-B2 — normales archiviertes Dokument als Versandbezug. */
export interface DocumentContext {
  client_document_id: string;
  deleted: boolean;
  classified_kind: string | null;
  title: string | null;
  /** Der Anhang-Hash der Delivery ist eine an dieses Dokument gebundene PDF-Datei. */
  attachment_bound: boolean;
}

/** V1-B2 — aktuelles Firmenprofil als Absenderkontext fuer normale Dokumente. */
export interface CompanyContext {
  companyName?: unknown;
  legalForm?: unknown;
  email?: unknown;
  /** Kommunikations-Einstellungen: eigener Anzeigename (leer = Firmenname Rechtsform). */
  senderDisplayName?: unknown;
  /** Kommunikations-Einstellungen: Antwortadresse (leer = Firmen-E-Mail). */
  replyToEmail?: unknown;
}

export interface LoadedDelivery {
  delivery: DeliveryRow;
  invoice: InvoiceContext | null;
  document?: DocumentContext | null;
  company?: CompanyContext | null;
}

export const DOCUMENT_DELIVERY_KINDS: ReadonlySet<string> = new Set(['letter', 'offer', 'other']);

export interface SendDocumentDeps {
  /** Validierte technische Absenderadresse (Envelope-/Header-From) aus der Serverkonfiguration. */
  senderEmail: string;
  userCanWrite(workspaceId: string, userId: string): Promise<boolean>;
  loadDelivery(workspaceId: string, clientDeliveryId: string): Promise<LoadedDelivery | null>;
  downloadAttachment(storagePath: string): Promise<Uint8Array | null>;
  sha256Hex(bytes: Uint8Array): Promise<string>;
  provider: EmailProviderAdapter;
  markAccepted(deliveryId: string, providerMessageId: string, expectedRowVersion: number): Promise<{ delivery: DeliveryRow; coupling: string }>;
  markStatus(deliveryId: string, status: 'failed' | 'unknown' | 'rejected', error: { category: DeliveryErrorCategory; code: string; message: string }, expectedRowVersion: number): Promise<DeliveryRow>;
  log(entry: Record<string, string | number | boolean | null>): void;
}

export type SendDocumentErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'delivery_not_found'
  | 'provider_mismatch'
  | 'invalid_state';

/** Sichere Antwort an den Client — keine Rohdaten, kein Key, kein Anhang. */
export interface SendDocumentResponseDelivery {
  id: string;
  clientDeliveryId: string;
  status: DeliveryStatus;
  providerMessageId: string | null;
  errorCategory: string | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  rowVersion: number;
}

export type SendDocumentOutcome =
  | { ok: true; action: 'sent' | 'replayed' | 'unknown_pending' | 'failed'; coupling?: string; delivery: SendDocumentResponseDelivery }
  | { ok: false; error: SendDocumentErrorCode };

export function toResponseDelivery(row: DeliveryRow): SendDocumentResponseDelivery {
  return {
    id: row.id,
    clientDeliveryId: row.client_delivery_id,
    status: row.status,
    providerMessageId: row.provider_message_id,
    errorCategory: row.error_category,
    errorCode: row.error_code,
    errorMessageSafe: row.error_message_safe,
    rowVersion: Number(row.row_version),
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Absender-Wahrheit (N): Anzeigename und Reply-To aus dem historischen
 * companySnapshot der finalisierten Rechnung — nie aus dem heutigen Profil.
 * Fehlt die Firmen-E-Mail im Snapshot: fail-closed (kein Versand).
 */
export function resolveSenderIdentity(invoice: InvoiceContext | null):
  | { ok: true; fromName: string; replyTo: string }
  | { ok: false; code: 'sender_snapshot_missing' | 'sender_reply_to_missing' } {
  const snapshot = invoice?.company_snapshot;
  if (!snapshot) return { ok: false, code: 'sender_snapshot_missing' };
  const name = [text(snapshot.companyName), text(snapshot.legalForm)].filter(Boolean).join(' ');
  const replyTo = text(snapshot.email).toLowerCase();
  if (!name) return { ok: false, code: 'sender_snapshot_missing' };
  if (!replyTo || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(replyTo)) return { ok: false, code: 'sender_reply_to_missing' };
  return { ok: true, fromName: name, replyTo };
}

/**
 * V1-B2 — Absender fuer normale Dokumente: aktuelles Firmenprofil (Name,
 * Reply-To = Firmen-E-Mail). Fail-closed ohne Name oder gueltige E-Mail; es
 * wird nie eine technische Adresse erfunden.
 */
export function resolveCompanySenderIdentity(company: CompanyContext | null | undefined):
  | { ok: true; fromName: string; replyTo: string }
  | { ok: false; code: 'sender_company_missing' | 'sender_reply_to_missing' } {
  if (!company) return { ok: false, code: 'sender_company_missing' };
  // Dieselbe Ableitung wie in den Kommunikations-Einstellungen: Anzeigename bzw. Antwortadresse, sonst Firmenname/Firmen-E-Mail.
  const name = text(company.senderDisplayName) || [text(company.companyName), text(company.legalForm)].filter(Boolean).join(' ');
  const explicitReplyTo = text(company.replyToEmail).toLowerCase();
  const replyTo = explicitReplyTo && SENDER_EMAIL_PATTERN.test(explicitReplyTo) ? explicitReplyTo : text(company.email).toLowerCase();
  if (!name) return { ok: false, code: 'sender_company_missing' };
  if (!replyTo || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(replyTo)) return { ok: false, code: 'sender_reply_to_missing' };
  return { ok: true, fromName: name, replyTo };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export async function runSendDocument(
  input: { userId: string | null; workspaceId: string; clientDeliveryId: string },
  deps: SendDocumentDeps,
): Promise<SendDocumentOutcome> {
  if (!input.userId) return { ok: false, error: 'unauthenticated' };
  if (!input.workspaceId || !input.clientDeliveryId) return { ok: false, error: 'delivery_not_found' };

  // 3. Schreibberechtigung des Aufrufers (owner/admin) — der Server prüft sie stellvertretend.
  if (!(await deps.userCanWrite(input.workspaceId, input.userId))) return { ok: false, error: 'forbidden' };

  // 2. Delivery (workspace_id + client_delivery_id) — nie über Fremdworkspace erreichbar.
  const loaded = await deps.loadDelivery(input.workspaceId, input.clientDeliveryId);
  if (!loaded) return { ok: false, error: 'delivery_not_found' };
  const { delivery, invoice } = loaded;
  const document = loaded.document ?? null;
  const company = loaded.company ?? null;
  const isDocumentKind = DOCUMENT_DELIVERY_KINDS.has(delivery.document_kind);
  const base = { deliveryId: delivery.id, workspaceId: delivery.workspace_id, provider: deps.provider.provider };

  // 4. Zustand: Replay/Unknown/Endzustände — kein zweiter Provider-Aufruf.
  if (delivery.status === 'provider_accepted' || delivery.status === 'delivered' || delivery.status === 'bounced' || delivery.status === 'complained') {
    // Replay (J): Kopplung idempotent bestätigen/reparieren, keine zweite Mail.
    let coupling = 'not_applicable';
    if (delivery.document_kind === 'invoice' && delivery.provider_message_id) {
      const repaired = await deps.markAccepted(delivery.id, delivery.provider_message_id, delivery.row_version);
      coupling = repaired.coupling;
    }
    deps.log({ ...base, outcome: 'replayed', status: delivery.status, coupling });
    return { ok: true, action: 'replayed', coupling, delivery: toResponseDelivery(delivery) };
  }
  if (delivery.status === 'unknown') {
    // (H) Ergebnis des letzten Versuchs ist ungewiss — kein blinder Neuversand.
    deps.log({ ...base, outcome: 'unknown_pending' });
    return { ok: true, action: 'unknown_pending', delivery: toResponseDelivery(delivery) };
  }
  if (delivery.status === 'failed' || delivery.status === 'rejected') {
    deps.log({ ...base, outcome: 'already_failed' });
    return { ok: true, action: 'failed', delivery: toResponseDelivery(delivery) };
  }
  if (delivery.status !== 'queued') return { ok: false, error: 'invalid_state' };

  // 7. Providerwahl ist Serverkonfiguration; die Delivery muss dazu passen.
  if (delivery.provider !== deps.provider.provider) {
    deps.log({ ...base, outcome: 'provider_mismatch', deliveryProvider: delivery.provider });
    return { ok: false, error: 'provider_mismatch' };
  }

  const fail = async (status: 'failed' | 'unknown', category: DeliveryErrorCategory, code: string, message: string) => {
    const updated = await deps.markStatus(delivery.id, status, { category, code, message }, delivery.row_version);
    deps.log({ ...base, outcome: status, errorCategory: category, errorCode: code });
    return { ok: true as const, action: status === 'unknown' ? ('unknown_pending' as const) : ('failed' as const), delivery: toResponseDelivery(updated) };
  };

  // Dokumentkontext: Rechnung muss existieren und versandfähig sein (Server glaubt dem Client nicht).
  if (delivery.document_kind === 'invoice' || delivery.document_kind === 'invoice_correction') {
    if (!invoice) return fail('failed', 'unknown', 'invoice_missing', 'Die Rechnung zu diesem Versand wurde nicht gefunden.');
    if (invoice.invoice_status === 'entwurf') return fail('failed', 'unknown', 'invoice_not_finalized', 'Die Rechnung ist nicht finalisiert.');
    if (delivery.document_kind === 'invoice' && invoice.cancelled_at) return fail('failed', 'unknown', 'invoice_cancelled', 'Die Rechnung ist storniert.');
    if (delivery.document_kind === 'invoice_correction' && (invoice.cancellation_kind !== 'correction' || !invoice.correction_document_id)) {
      return fail('failed', 'unknown', 'correction_missing', 'Zu dieser Rechnung gibt es keinen Korrekturbeleg.');
    }
  }
  // V1-B2 — normales Dokument: existiert, nicht geloescht, Anhang an das Dokument gebunden (Server glaubt dem Client nicht).
  if (isDocumentKind) {
    if (!delivery.linked_document_id) return fail('failed', 'unknown', 'document_missing', 'Das Dokument zu diesem Versand wurde nicht gefunden.');
    if (!document || document.deleted) return fail('failed', 'unknown', 'document_missing', 'Das Dokument zu diesem Versand ist nicht mehr verfuegbar.');
    if (!document.attachment_bound) return fail('failed', 'attachment', 'attachment_not_bound', 'Der Anhang gehoert nicht zu diesem Dokument.');
  }

  // 5./6. Anhang laden und gegen die Delivery-Metadaten prüfen (O).
  const path = delivery.attachment_storage_path ?? '';
  const expectedPrefix = `${delivery.workspace_id}/`;
  if (!path.startsWith(expectedPrefix) || !delivery.attachment_sha256 || !delivery.attachment_size_bytes || delivery.attachment_mime_type !== 'application/pdf' || !delivery.attachment_filename) {
    return fail('failed', 'attachment', 'attachment_metadata_invalid', 'Der Anhang ist nicht korrekt hinterlegt.');
  }
  if (!path.endsWith(`/${delivery.attachment_sha256}.pdf`)) {
    return fail('failed', 'attachment', 'attachment_path_hash_mismatch', 'Der Anhangspfad passt nicht zum Prüfwert.');
  }
  const bytes = await deps.downloadAttachment(path);
  if (!bytes) return fail('failed', 'attachment', 'attachment_missing', 'Der Anhang wurde im Speicher nicht gefunden.');
  if (bytes.byteLength !== Number(delivery.attachment_size_bytes)) {
    return fail('failed', 'attachment', 'attachment_size_mismatch', 'Der Anhang hat nicht die erwartete Größe.');
  }
  const header = String.fromCharCode(...bytes.subarray(0, 5));
  if (header !== '%PDF-') return fail('failed', 'attachment', 'attachment_not_pdf', 'Der Anhang ist kein PDF.');
  const actualSha = await deps.sha256Hex(bytes);
  if (actualSha !== delivery.attachment_sha256) {
    return fail('failed', 'attachment', 'attachment_sha256_mismatch', 'Der Anhang entspricht nicht dem hinterlegten Prüfwert.');
  }

  // (N) Absender: Rechnung aus dem historischen Snapshot; normales Dokument aus dem aktuellen Firmenprofil.
  const sender = isDocumentKind ? resolveCompanySenderIdentity(company) : resolveSenderIdentity(invoice);
  if (!sender.ok) {
    return fail('failed', 'unknown', sender.code, isDocumentKind ? 'Absenderdaten des Betriebs sind unvollständig (Firmenname oder E-Mail fehlt).' : 'Absenderdaten der Rechnung sind unvollständig.');
  }

  // 8. Provider.
  let result: SendTransactionalEmailResult;
  try {
    result = await deps.provider.sendTransactionalEmail({
      from: { email: deps.senderEmail, name: sender.fromName },
      replyTo: { email: sender.replyTo, name: sender.fromName },
      to: { email: delivery.recipient_email },
      subject: delivery.subject,
      text: delivery.body_text,
      attachment: { filename: delivery.attachment_filename, mimeType: 'application/pdf', contentBase64: bytesToBase64(bytes) },
      idempotencyKey: `${delivery.workspace_id}:${delivery.client_delivery_id}`,
    });
  } catch {
    // Unerwarteter Adapterfehler nach möglichem Absenden: konservativ unknown.
    return fail('unknown', 'unknown', 'provider_adapter_threw', 'Der Versanddienst hat unerwartet abgebrochen — Ergebnis unbekannt.');
  }

  // 9./10. Ergebnis autoritativ übernehmen — bei Annahme inklusive atomarer Rechnungs-Kopplung.
  if (result.accepted) {
    const accepted = await deps.markAccepted(delivery.id, result.providerMessageId, delivery.row_version);
    deps.log({ ...base, outcome: 'provider_accepted', coupling: accepted.coupling });
    return { ok: true, action: 'sent', coupling: accepted.coupling, delivery: toResponseDelivery(accepted.delivery) };
  }
  if (result.handoffUncertain) {
    return fail('unknown', result.errorCategory, result.errorCode, result.errorMessageSafe);
  }
  return fail('failed', result.errorCategory, result.errorCode, result.errorMessageSafe);
}
