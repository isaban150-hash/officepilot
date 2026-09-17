import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase';
import { generateApprovedInvoicePdf, generateInvoiceCorrectionPdf } from '../invoicePdfService';
import type { DeliveryDocumentIdentity, DeliveryProvider, DocumentDelivery } from '../../types/documentDelivery';
import type { VorgangInvoice } from '../../types/models';
import {
  DELIVERY_ATTACHMENT_BUCKET,
  DELIVERY_ATTACHMENT_MAX_BYTES,
  buildDeliveryAttachmentStoragePath,
  isValidRecipientEmail,
  normalizeRecipientEmail,
  parseDocumentDeliveryRow,
  sha256Hex,
} from './documentDeliveryContract';

/**
 * EMAIL-01B1 — Cloud-Vertrag des Versands: Anhang vorbereiten (historisches
 * PDF), Anhang in den privaten Bucket legen, Delivery idempotent anlegen,
 * Historie lesen. **Kein Provider-Aufruf** — das ist die Edge Function in
 * EMAIL-01B2; hier entsteht nur der Auftrag.
 */

export interface PreparedDeliveryAttachment {
  bytes: Uint8Array;
  filename: string;
  sha256: string;
  sizeBytes: number;
  mimeType: 'application/pdf';
}

export type PrepareDeliveryAttachmentResult =
  | { ok: true; attachment: PreparedDeliveryAttachment }
  | { ok: false; reason: 'not_finalized' | 'validation_failed' | 'encode_failed' | 'too_large' };

/**
 * Historische Wahrheit: derselbe Renderer wie im Detail/Download —
 * `generateApprovedInvoicePdf` (bzw. Korrektur) aus den eingefrorenen
 * Snapshots. Keine Live-Firmendaten, kein zweiter Renderer.
 */
export async function prepareInvoiceDeliveryAttachment(
  invoice: VorgangInvoice,
  identity: DeliveryDocumentIdentity,
): Promise<PrepareDeliveryAttachmentResult> {
  const generated =
    identity.kind === 'invoice_correction'
      ? await generateInvoiceCorrectionPdf(invoice)
      : await generateApprovedInvoicePdf(invoice);
  if (!generated.ok) return { ok: false, reason: generated.reason };
  if (generated.bytes.byteLength > DELIVERY_ATTACHMENT_MAX_BYTES) return { ok: false, reason: 'too_large' };
  return {
    ok: true,
    attachment: {
      bytes: generated.bytes,
      filename: generated.filename,
      sha256: await sha256Hex(generated.bytes),
      sizeBytes: generated.bytes.byteLength,
      mimeType: 'application/pdf',
    },
  };
}

export type DeliveryAttachmentUploadError = 'not_configured' | 'forbidden' | 'network' | 'unknown';

export type DeliveryAttachmentUploadResult =
  | { ok: true; storagePath: string; reused: boolean }
  | { ok: false; error: DeliveryAttachmentUploadError };

function mapStorageError(error: { message?: string; statusCode?: string | number }): DeliveryAttachmentUploadError {
  const status = Number(error.statusCode ?? NaN);
  if (status === 403 || status === 401) return 'forbidden';
  const message = (error.message ?? '').toLowerCase();
  if (message.includes('failed to fetch') || message.includes('network')) return 'network';
  return 'unknown';
}

/**
 * Legt den Anhang unter `{workspace}/{dokument}/{sha256}.pdf` ab. Der Pfad
 * ist inhaltsadressiert: derselbe Beleg landet nur einmal, ein bereits
 * vorhandenes Objekt (409) gilt als Erfolg (`reused`). Kein Überschreiben.
 */
export async function uploadDeliveryAttachment(
  input: { workspaceId: string; identity: DeliveryDocumentIdentity; attachment: PreparedDeliveryAttachment },
  client?: SupabaseClient | null,
): Promise<DeliveryAttachmentUploadResult> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const segment = `${input.identity.kind}-${input.identity.clientInvoiceId}`;
  const storagePath = buildDeliveryAttachmentStoragePath(input.workspaceId, segment, input.attachment.sha256);
  try {
    const { error } = await supabase.storage
      .from(DELIVERY_ATTACHMENT_BUCKET)
      .upload(storagePath, new Blob([input.attachment.bytes as BlobPart], { type: 'application/pdf' }), {
        contentType: 'application/pdf',
        upsert: false,
      });
    if (error) {
      const status = Number((error as { statusCode?: string | number }).statusCode ?? NaN);
      const message = (error.message ?? '').toLowerCase();
      if (status === 409 || message.includes('already exists') || message.includes('duplicate')) {
        return { ok: true, storagePath, reused: true };
      }
      return { ok: false, error: mapStorageError(error) };
    }
  } catch (error) {
    return { ok: false, error: mapStorageError((error ?? {}) as { message?: string }) };
  }
  return { ok: true, storagePath, reused: false };
}

export interface CreateDocumentDeliveryInput {
  workspaceId: string;
  clientDeliveryId: string;
  identity: DeliveryDocumentIdentity;
  recipientEmail: string;
  subject: string;
  bodyText: string;
  attachment: { storagePath: string; sha256: string; sizeBytes: number; filename: string };
  provider: DeliveryProvider;
  retryOfDeliveryId?: string;
}

export type CreateDocumentDeliveryResult =
  | { ok: true; outcome: 'created' | 'replayed'; delivery: DocumentDelivery }
  | {
      ok: false;
      error:
        | 'not_configured'
        | 'invalid_recipient'
        | 'idempotency_conflict'
        | 'forbidden'
        | 'not_found'
        | 'not_sendable'
        | 'uncertain_pending'
        | 'invalid_response'
        | 'rpc_failed';
      message?: string;
    };

function classifyRpcError(message: string): Exclude<CreateDocumentDeliveryResult, { ok: true }>['error'] {
  const lower = message.toLowerCase();
  if (lower.includes('idempotenzkonflikt')) return 'idempotency_conflict';
  if (lower.includes('kein zugriff') || lower.includes('schreibberechtigung') || lower.includes('nicht angemeldet')) {
    return 'forbidden';
  }
  // V1-B1 — serverseitige Sperre: Retry auf einen Versuch mit ungewissem Handoff.
  if (lower.includes('versandstatus unklar')) return 'uncertain_pending';
  if (lower.includes('nicht gefunden')) return 'not_found';
  if (lower.includes('nicht finalisiert') || lower.includes('storniert') || lower.includes('korrekturbeleg')) {
    return 'not_sendable';
  }
  if (lower.includes('recipient_email')) return 'invalid_recipient';
  return 'rpc_failed';
}

export async function rpcCreateWorkspaceDocumentDelivery(
  input: CreateDocumentDeliveryInput,
  client?: SupabaseClient | null,
): Promise<CreateDocumentDeliveryResult> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  if (!isValidRecipientEmail(input.recipientEmail)) return { ok: false, error: 'invalid_recipient' };

  const { data, error } = await supabase.rpc('create_workspace_document_delivery', {
    p_workspace_id: input.workspaceId,
    p_client_delivery_id: input.clientDeliveryId,
    p_document_kind: input.identity.kind,
    p_linked_invoice_id: input.identity.clientInvoiceId,
    p_recipient_email: normalizeRecipientEmail(input.recipientEmail),
    p_subject: input.subject.trim(),
    p_body_text: input.bodyText,
    p_attachment_storage_path: input.attachment.storagePath,
    p_attachment_sha256: input.attachment.sha256,
    p_attachment_size_bytes: input.attachment.sizeBytes,
    p_attachment_filename: input.attachment.filename,
    p_attachment_mime_type: 'application/pdf',
    p_provider: input.provider,
    p_retry_of_delivery_id: input.retryOfDeliveryId ?? null,
    p_linked_document_id: null,
  });
  if (error) return { ok: false, error: classifyRpcError(error.message ?? ''), message: error.message };

  const envelope = (data ?? null) as { outcome?: unknown; delivery?: unknown } | null;
  const outcome = envelope?.outcome;
  const delivery = parseDocumentDeliveryRow(envelope?.delivery);
  if ((outcome !== 'created' && outcome !== 'replayed') || !delivery) {
    return { ok: false, error: 'invalid_response' };
  }
  return { ok: true, outcome, delivery };
}

export type ListDocumentDeliveriesResult =
  | { ok: true; deliveries: DocumentDelivery[] }
  | { ok: false; error: 'not_configured' | 'forbidden' | 'invalid_response' | 'rpc_failed'; message?: string };

/** Historie eines Dokuments, neueste zuerst; unbekannte Zeilen werden fail-closed verworfen. */
export async function rpcListWorkspaceDocumentDeliveries(
  input: { workspaceId: string; identity: DeliveryDocumentIdentity | { kind?: undefined; clientInvoiceId: string } },
  client?: SupabaseClient | null,
): Promise<ListDocumentDeliveriesResult> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc('list_workspace_document_deliveries', {
    p_workspace_id: input.workspaceId,
    p_document_kind: input.identity.kind ?? null,
    p_linked_invoice_id: input.identity.clientInvoiceId,
  });
  if (error) {
    const lower = (error.message ?? '').toLowerCase();
    return {
      ok: false,
      error: lower.includes('kein zugriff') || lower.includes('nicht angemeldet') ? 'forbidden' : 'rpc_failed',
      message: error.message,
    };
  }
  if (!Array.isArray(data)) return { ok: false, error: 'invalid_response' };
  const deliveries: DocumentDelivery[] = [];
  for (const row of data) {
    const parsed = parseDocumentDeliveryRow(row);
    if (!parsed) return { ok: false, error: 'invalid_response' };
    deliveries.push(parsed);
  }
  return { ok: true, deliveries };
}
