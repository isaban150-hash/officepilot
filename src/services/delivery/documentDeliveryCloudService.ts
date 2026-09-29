import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase';
import { generateApprovedInvoicePdf, generateInvoiceCorrectionPdf } from '../invoicePdfService';
import { deliveryIdentityDocumentId, isInvoiceDeliveryIdentity, type ArchivedDocumentDeliveryKind, type DeliveryDocumentIdentity, type DeliveryProvider, type DocumentDelivery } from '../../types/documentDelivery';
import type { CompanyDocument, VorgangInvoice } from '../../types/models';
import { resolveDocumentFileRepresentation } from '../documentFileRepresentationReadService';
import { getDocumentFileRepresentationBindingStoreSnapshot } from '../documentFileRepresentationBindingStoreService';
import { getSyncOutboxSnapshot } from '../sync/syncOutboxService';
import { getDocumentFileBlob, getDocumentFileRefById } from '../documentFileStoreService';
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
/**
 * V1-B2 — Versandart eines archivierten Dokuments: dieselbe Ableitung wie
 * serverseitig (brief → letter, angebot → offer, sonst other). Der Server
 * lehnt eine abweichende Art ab.
 *
 * E-MAIL-07B — ein selbst verfasster Geschäftsbrief (`linkedLetterId`) ist
 * immer ein Brief. Sein Archiveintrag ist bewusst als „schriftverkehr"
 * klassifiziert (Ablage), und landete dadurch bis 07B unter `other`.
 */
export function resolveArchivedDocumentDeliveryKind(document: Pick<CompanyDocument, 'classifiedKind' | 'linkedLetterId'>): ArchivedDocumentDeliveryKind {
  if (document.linkedLetterId?.trim()) return 'letter';
  if (document.classifiedKind === 'brief') return 'letter';
  if (document.classifiedKind === 'angebot') return 'offer';
  return 'other';
}

export type PrepareArchivedDocumentAttachmentResult =
  | { ok: true; attachment: PreparedDeliveryAttachment }
  | { ok: false; reason: 'document_missing' | 'no_pdf' | 'file_unavailable' | 'too_large' };

/**
 * E-MAIL-07B — der **eine** Anhangsname eines archivierten Dokuments: derselbe
 * Wert steht im Versanddialog und geht an den Server. Nur Zeichen, die die
 * serverseitige Prüfung zulässt (`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}\.pdf$`);
 * Pfadtrenner und Umlaute werden ersetzt, ein Pfad kann nie entstehen.
 */
const FILENAME_TRANSLITERATION: Record<string, string> = {
  ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', '–': '-', '—': '-',
};

export function buildArchivedDocumentAttachmentFilename(document: Pick<CompanyDocument, 'title' | 'originalFileName'>): string {
  const base = (document.title || document.originalFileName || 'Dokument')
    .replace(/\.pdf$/i, '')
    // Lesbar statt Unterstrich: dieselbe Umschrift wie beim Brief-Dateinamen.
    .replace(/[äöüÄÖÜß–—]/g, (zeichen) => FILENAME_TRANSLITERATION[zeichen] ?? '_')
    .replace(/[^A-Za-z0-9 ._-]+/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 120)
    .trim();
  return `${base || 'Dokument'}.pdf`;
}

function isCommittedPdfRef(refId: string | undefined): string | null {
  if (!refId) return null;
  const ref = getDocumentFileRefById(refId);
  return ref && ref.mimeType === 'application/pdf' && ref.lifecycleStatus === 'committed' ? ref.id : null;
}

/**
 * V1-B2 — Welche PDF-Datei gehört zu einem archivierten Dokument?
 * Reihenfolge: Archiv-PDF (aus Bild abgeleitet) → Original, wenn es ein PDF ist.
 * Kein Rendern, keine Konvertierung hier — nur die bereits gebundene Datei-
 * Wahrheit, die der Server über die Bindings gegenprüft. Synchron nutzbar
 * für die Frage „versendbar?“, die Bytes lädt `prepareArchivedDocumentDeliveryAttachment`.
 *
 * E-MAIL-07B — bis hierher prüfte die Funktion entgegen ihrer Beschreibung
 * nur das Original: Ein Foto mit gültigem Archiv-PDF galt als „keine PDF-Datei".
 * Ein Bild selbst wird nie als PDF behandelt — nur eine gebundene, fertige
 * PDF-Datei zählt.
 */
export function findArchivedDocumentPdfFileRefId(document: Pick<CompanyDocument, 'id' | 'fileRefId' | 'mimeType'>): string | null {
  const archiveBinding = getDocumentFileRepresentationBindingStoreSnapshot().find(
    (binding) => binding.documentId === document.id && binding.kind === 'archive',
  );
  return isCommittedPdfRef(archiveBinding?.fileRefId) ?? isCommittedPdfRef(document.fileRefId);
}

/**
 * 07B-FIX2 — steckt der Cloud-Stand dieses Dokuments fest? Ein blockierter
 * Sync-Auftrag für das Dokument, seine Datei oder seine Dateibindung heißt:
 * Lokaler und Cloud-Stand sind uneins, eine Entscheidung steht aus. Dann wird
 * nicht gesendet — ein Versand darf keinen Konflikt „heilen" und kein PDF
 * verschicken, dessen Online-Stand ungeklärt ist.
 */
export function isArchivedDocumentSyncBlocked(document: Pick<CompanyDocument, 'id' | 'fileRefId'>): boolean {
  const archiveBinding = getDocumentFileRepresentationBindingStoreSnapshot().find(
    (binding) => binding.documentId === document.id && binding.kind === 'archive',
  );
  const fileRefIds = new Set([document.fileRefId, archiveBinding?.fileRefId].filter((id): id is string => Boolean(id)));
  return getSyncOutboxSnapshot().some(
    (entry) =>
      entry.status === 'blocked' &&
      ((entry.entityType === 'document' && entry.entityId === document.id) ||
        (entry.entityType === 'document_file_binding' && entry.entityId.startsWith(`${document.id}|`)) ||
        (entry.entityType === 'document_file' && fileRefIds.has(entry.entityId))),
  );
}

export async function prepareArchivedDocumentDeliveryAttachment(
  document: CompanyDocument | undefined,
): Promise<PrepareArchivedDocumentAttachmentResult> {
  if (!document) return { ok: false, reason: 'document_missing' };
  let blob: Blob | null = null;
  // Archiv-PDF (abgeleitet, z. B. aus einem Foto) hat Vorrang — dieselbe Bindung kennt der Server.
  const archive = await resolveDocumentFileRepresentation({ documentId: document.id, kind: 'archive' }).catch(() => null);
  if (archive && archive.kind === 'ready' && archive.fileRef.mimeType === 'application/pdf') {
    blob = archive.blob;
  } else {
    const refId = isCommittedPdfRef(document.fileRefId);
    if (!refId) return { ok: false, reason: 'no_pdf' };
    blob = await getDocumentFileBlob(refId);
    if (!blob) return { ok: false, reason: 'file_unavailable' };
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength === 0) return { ok: false, reason: 'file_unavailable' };
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') return { ok: false, reason: 'no_pdf' };
  if (bytes.byteLength > DELIVERY_ATTACHMENT_MAX_BYTES) return { ok: false, reason: 'too_large' };
  return {
    ok: true,
    attachment: { bytes, filename: buildArchivedDocumentAttachmentFilename(document), sha256: await sha256Hex(bytes), sizeBytes: bytes.byteLength, mimeType: 'application/pdf' },
  };
}

export async function uploadDeliveryAttachment(
  input: { workspaceId: string; identity: DeliveryDocumentIdentity; attachment: PreparedDeliveryAttachment },
  client?: SupabaseClient | null,
): Promise<DeliveryAttachmentUploadResult> {
  const supabase = client ?? getSupabaseClient();
  if (!supabase) return { ok: false, error: 'not_configured' };
  const segment = `${input.identity.kind}-${deliveryIdentityDocumentId(input.identity)}`;
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
  /**
   * E-MAIL-07B — ausdrücklich bestätigter Neuversuch nach `unknown`. Wird nur
   * mitgeschickt, wenn er gesetzt ist; der Server prüft ihn selbst.
   */
  confirmUncertainRetry?: boolean;
  /**
   * E-MAIL-07C — Kunden-/Vorgangskontext (echte Kennungen). Der Server prüft,
   * dass beide zum Workspace gehören.
   */
  context?: { customerId?: string; vorgangId?: string };
}

/**
 * E-MAIL-07C — fehlt die Kontext-RPC in der Cloud noch (Migration
 * 20261011120000 nicht angewendet), antwortet PostgREST mit PGRST202, ohne
 * irgendetwas auszuführen. Nur dann — und nur dann — wird derselbe Auftrag
 * über den unveränderten 07B-Weg angelegt; idempotent über die
 * client_delivery_id, also ohne Doppelanlage.
 */
function isMissingRpcFunction(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '');
}

/**
 * E-MAIL-07C — der Server hat nur den **Kontext** abgelehnt (z. B. ein eben
 * lokal angelegter Kunde ist noch nicht in der Cloud). Die Prüfung läuft vor
 * jeder Anlage; es entstand nichts. Der Versand darf daran nicht scheitern —
 * er wird ohne Kontext angelegt, die Historie ordnet ihn weiter über das
 * Dokument zu. Gespeichert wird nie ein falscher Kontext.
 */
function isRejectedContextOnly(error: { message?: string }): boolean {
  const lower = (error.message ?? '').toLowerCase();
  return (
    lower.includes('customer_id gehoert nicht zum workspace') ||
    lower.includes('vorgang_id gehoert nicht zum workspace') ||
    lower.includes('vorgang_id passt nicht zur rechnung')
  );
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
        | 'uncertain_retry_exists'
        | 'rate_limited'
        | 'attachment_not_synced'
        | 'invalid_response'
        | 'rpc_failed';
      message?: string;
    };

function classifyRpcError(message: string): Exclude<CreateDocumentDeliveryResult, { ok: true }>['error'] {
  const lower = message.toLowerCase();
  if (lower.includes('idempotenzkonflikt')) return 'idempotency_conflict';
  // E-MAIL-07B — Missbrauchsschutz und „ein Neuversuch je unklarem Versuch".
  if (lower.includes('versandlimit')) return 'rate_limited';
  if (lower.includes('bereits angelegt')) return 'uncertain_retry_exists';
  /*
   * 07B-FIX1 — der Server kennt das Dokument bzw. dessen PDF-Bindung (noch)
   * nicht. Das heißt nicht „es gibt kein PDF": Das Archivdokument und seine
   * Datei kommen erst über den Sync in die Cloud. Bis 07B-FIX1 erschien hier
   * „keine versendbare PDF-Datei" — neben einem sichtbaren PDF-Anhang.
   */
  if (lower.includes('anhang gehoert nicht zu diesem dokument') || lower.includes('dokument nicht gefunden')) {
    return 'attachment_not_synced';
  }
  if (lower.includes('kein zugriff') || lower.includes('schreibberechtigung') || lower.includes('nicht angemeldet')) {
    return 'forbidden';
  }
  // V1-B1 — serverseitige Sperre: Retry auf einen Versuch mit ungewissem Handoff.
  if (lower.includes('versandstatus unklar')) return 'uncertain_pending';
  if (lower.includes('nicht gefunden')) return 'not_found';
  // V1-B2 — Dokumentbezug/Anhang passen nicht: kein Versand.
  if (lower.includes('gehoert nicht zu diesem dokument') || lower.includes('passt nicht zum dokument') || lower.includes('linked_document_id')) return 'not_sendable';
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

  const baseArgs = {
    p_workspace_id: input.workspaceId,
    p_client_delivery_id: input.clientDeliveryId,
    p_document_kind: input.identity.kind,
    // V1-B2 — Rechnung ODER Dokument, nie beides; der Server prüft den Bezug.
    p_linked_invoice_id: isInvoiceDeliveryIdentity(input.identity) ? input.identity.clientInvoiceId : null,
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
    p_linked_document_id: isInvoiceDeliveryIdentity(input.identity) ? null : input.identity.clientDocumentId,
    // Nur wenn gesetzt: ein gewöhnlicher Versand trägt den Parameter gar nicht.
    ...(input.confirmUncertainRetry ? { p_confirm_uncertain_retry: true } : {}),
  };
  const customerId = input.context?.customerId?.trim() || null;
  const vorgangId = input.context?.vorgangId?.trim() || null;
  let { data, error } =
    customerId || vorgangId
      ? await supabase.rpc('create_workspace_document_delivery_with_context', {
          ...baseArgs,
          p_customer_id: customerId,
          p_vorgang_id: vorgangId,
        })
      : await supabase.rpc('create_workspace_document_delivery', baseArgs);
  if (error && (customerId || vorgangId) && (isMissingRpcFunction(error) || isRejectedContextOnly(error))) {
    ({ data, error } = await supabase.rpc('create_workspace_document_delivery', baseArgs));
  }
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
  // V1-B2 — normale Dokumente haben ihre eigene Historienabfrage (über die Dokument-Kennung).
  const documentIdentity = input.identity.kind && !isInvoiceDeliveryIdentity(input.identity as DeliveryDocumentIdentity) ? (input.identity as Extract<DeliveryDocumentIdentity, { clientDocumentId: string }>) : null;
  const { data, error } = documentIdentity
    ? await supabase.rpc('list_workspace_document_deliveries_for_document', {
        p_workspace_id: input.workspaceId,
        p_client_document_id: documentIdentity.clientDocumentId,
      })
    : await supabase.rpc('list_workspace_document_deliveries', {
        p_workspace_id: input.workspaceId,
        p_document_kind: input.identity.kind ?? null,
        p_linked_invoice_id: (input.identity as { clientInvoiceId: string }).clientInvoiceId,
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
