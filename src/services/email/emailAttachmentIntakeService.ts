/**
 * EINGANG-01B — ein eingegangener Mail-Anhang wird manuell in den bestehenden
 * Dokumenteingang übernommen („In Eingang übernehmen").
 *
 * Kein zweiter Dokumentweg: Dieser Dienst ist nur der Adapter von einem
 * Cloud-Mail-Anhang zur bestehenden Zweistufe des Uploads
 * (`processDocumentFileForPreview` → `executePendingDocumentDecision`), deren
 * persistierender Kern `intakeCachedDocumentFile` bleibt. Prüfung, OCR,
 * Klassifikation, Duplikaterkennung und die 01A-Regeln laufen dort unverändert.
 *
 * Was dieser Adapter selbst entscheidet:
 *  * Berechtigung — nur mit `canIntake` (fail-closed bei unbekannter Mitgliedschaft).
 *  * Eignung — PDF/PNG/JPEG bis zum Eingangslimit, mit echter Server-Anhang-ID.
 *  * Idempotenz — derselbe Anhang (Anhang-ID, deterministische Eingangs-ID
 *    `inbox-mail-<attachmentId>`) wird nie ein zweites Mal übernommen.
 *  * Vertrauensgrenze — die heruntergeladenen Bytes müssen exakt dem vom Server
 *    beim Mail-Import gespeicherten SHA-256 entsprechen.
 *
 * Bewusst nicht: Die Kunden-/Vorgangszuordnung der Mail wird nicht übernommen
 * (auch nicht bei manueller Mail-Zuordnung). Ein gesetzter Vorgang am Eingang
 * würde in 01A als ausdrückliche Auswahl gelten und bei der Übernahme
 * automatisch verknüpft.
 */
import type { EmailMessage, EmailMessageAttachment } from '../../types/emailMessage';
import type { InboxEmailOrigin, InboxItem } from '../../types/models';
import { computeBufferContentHash } from '../documentFileHashService';
import { MAX_UPLOAD_FILE_SIZE_BYTES } from '../documentUploadValidation';
import { getInboxStoreSnapshot } from '../inboxService';
import {
  executePendingDocumentDecision,
  isPendingDocumentDecisionResultIntake,
} from '../pendingDocumentDecisionService';
import {
  discardPendingDocumentIntake,
  processDocumentFileForPreview,
} from '../pendingDocumentIntakeService';
import { isEntitySyncActive } from '../sync/syncMetaService';
import {
  resolveWorkspaceWriteAccess,
  type WorkspaceWriteAccess,
} from '../workspace/workspaceRoleService';
import {
  downloadEmailAttachment,
  type EmailAttachmentDownloadResult,
} from './emailMessageCloudService';

const INTAKE_MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const INTAKE_FILE_NAME = /\.(pdf|png|jpe?g)$/i;
const INBOUND_BUCKET: EmailMessageAttachment['storageBucket'] = 'inbound-email-attachments';

export function emailAttachmentInboxItemId(attachmentId: string): string {
  return `inbox-mail-${attachmentId}`;
}

export type EmailAttachmentIntakeEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'not_inbound' | 'no_id' | 'type' | 'too_large' };

/** Nur eingegangene PDF/PNG/JPEG-Anhänge mit Server-ID und bis zum Eingangslimit. */
export function isEmailAttachmentIntakeEligible(
  attachment: EmailMessageAttachment,
): EmailAttachmentIntakeEligibility {
  if (attachment.storageBucket !== INBOUND_BUCKET) return { eligible: false, reason: 'not_inbound' };
  if (!attachment.id?.trim()) return { eligible: false, reason: 'no_id' };
  if (!INTAKE_MIME_TYPES.has(attachment.mimeType) || !INTAKE_FILE_NAME.test(attachment.filename)) {
    return { eligible: false, reason: 'type' };
  }
  if (!(attachment.sizeBytes > 0) || attachment.sizeBytes > MAX_UPLOAD_FILE_SIZE_BYTES) {
    return { eligible: false, reason: 'too_large' };
  }
  return { eligible: true };
}

export type EmailAttachmentInboxMatch = { item: InboxItem; removed: boolean };

/**
 * Der Eingang zu genau diesem Anhang — über die Herkunft oder die
 * deterministische ID. Ein aus dem Eingang entfernter (Sync-Grabstein) Eintrag
 * zählt als `removed`: Unter derselben ID kann kein neuer entstehen.
 */
export function findInboxItemForEmailAttachment(
  attachmentId: string | undefined,
): EmailAttachmentInboxMatch | null {
  const id = attachmentId?.trim();
  if (!id) return null;
  const expectedId = emailAttachmentInboxItemId(id);
  const matches = getInboxStoreSnapshot().filter(
    (item) => item.emailOrigin?.attachmentId === id || item.id === expectedId,
  );
  const active = matches.find((item) => isEntitySyncActive(item));
  if (active) return { item: { ...active }, removed: false };
  const removed = matches[0];
  return removed ? { item: { ...removed }, removed: true } : null;
}

export type EmailAttachmentIntakeError =
  | 'not_permitted'
  | 'not_eligible'
  | 'too_large'
  | 'in_progress'
  | 'previously_removed'
  | 'download_forbidden'
  | 'download_failed'
  | 'hash_mismatch'
  | 'intake_failed';

export type EmailAttachmentIntakeResult =
  | { outcome: 'created'; inboxItemId: string }
  | { outcome: 'already_imported'; inboxItemId: string }
  | { outcome: 'duplicate'; existing: { type: 'inbox' | 'document'; id: string } | null }
  | { outcome: 'failed'; error: EmailAttachmentIntakeError; detail?: string };

export interface EmailAttachmentIntakeDeps {
  userId?: string | null;
  cloudConfigured?: boolean;
  /** Vorab aufgelöster Zugriff (Tests, Seite); sonst über den Workspace-Resolver. */
  access?: WorkspaceWriteAccess;
  download?: (input: {
    storagePath: string;
    mimeType: string;
    storageBucket: EmailMessageAttachment['storageBucket'];
  }) => Promise<EmailAttachmentDownloadResult>;
  now?: () => string;
}

/** Läuft für diesen Anhang gerade eine Übernahme? (Doppelklick, parallele Aufrufe) */
const inFlight = new Set<string>();

function senderHintOf(message: EmailMessage): string | undefined {
  return message.fromName?.trim() || message.fromAddress?.trim() || undefined;
}

export async function importEmailAttachmentToInbox(
  message: EmailMessage,
  attachment: EmailMessageAttachment,
  deps: EmailAttachmentIntakeDeps = {},
): Promise<EmailAttachmentIntakeResult> {
  // 1. Berechtigung — dieselbe wie beim Upload; ohne bekannte Mitgliedschaft nichts.
  const access =
    deps.access ??
    resolveWorkspaceWriteAccess({ userId: deps.userId, cloudConfigured: deps.cloudConfigured ?? false });
  if (access.canIntake !== true) return { outcome: 'failed', error: 'not_permitted' };

  // 2. Bereits übernommen?
  const known = findInboxItemForEmailAttachment(attachment.id);
  if (known && !known.removed) return { outcome: 'already_imported', inboxItemId: known.item.id };
  if (known?.removed) return { outcome: 'failed', error: 'previously_removed' };

  // 3. Eignung
  const eligibility = isEmailAttachmentIntakeEligible(attachment);
  if (!eligibility.eligible) {
    return { outcome: 'failed', error: eligibility.reason === 'too_large' ? 'too_large' : 'not_eligible' };
  }
  const attachmentId = attachment.id!.trim();
  const expectedSha = attachment.sha256.trim().toLowerCase();
  if (message.direction !== 'inbound' || !/^[0-9a-f]{64}$/.test(expectedSha)) {
    return { outcome: 'failed', error: 'not_eligible' };
  }

  if (inFlight.has(attachmentId)) return { outcome: 'failed', error: 'in_progress' };
  inFlight.add(attachmentId);
  try {
    // 4. Download über den bestehenden, angemeldeten Storage-Zugriff.
    const download = deps.download ?? downloadEmailAttachment;
    const downloaded = await download({
      storagePath: attachment.storagePath,
      mimeType: attachment.mimeType,
      storageBucket: attachment.storageBucket,
    });
    if (!downloaded.ok) {
      return {
        outcome: 'failed',
        error: downloaded.error === 'forbidden' ? 'download_forbidden' : 'download_failed',
        detail: downloaded.error,
      };
    }

    // 5./7. Vertrauensgrenze — die Bytes müssen die beim Mail-Import geprüften sein.
    // Vor der Vorschau geprüft, damit manipulierte Bytes weder OCR noch KI erreichen.
    const bytes = new Uint8Array(await downloaded.blob.arrayBuffer());
    if ((await computeBufferContentHash(bytes)) !== expectedSha) {
      return { outcome: 'failed', error: 'hash_mismatch' };
    }
    const file = new File([bytes], attachment.filename, { type: attachment.mimeType });

    // 6. Bestehende Vorschau: Prüfung, OCR, Klassifikation, Duplikaterkennung.
    const preview = await processDocumentFileForPreview(file);
    if (!preview.success) {
      return {
        outcome: 'failed',
        error: preview.error === 'file_too_large' ? 'too_large' : preview.error === 'invalid_type' ? 'not_eligible' : 'intake_failed',
        detail: preview.error,
      };
    }
    const pending = preview.pending;

    // Die tatsächlich zu speichernden Bytes sind dieselben (kein Umweg, keine Umwandlung).
    if ((await computeBufferContentHash(pending.cachedFile.bytes)) !== expectedSha) {
      discardPendingDocumentIntake(pending);
      return { outcome: 'failed', error: 'hash_mismatch' };
    }

    // Während der Vorschau entstanden? Dann nichts zweites anlegen.
    const again = findInboxItemForEmailAttachment(attachmentId);
    if (again) {
      discardPendingDocumentIntake(pending);
      return again.removed
        ? { outcome: 'failed', error: 'previously_removed' }
        : { outcome: 'already_imported', inboxItemId: again.item.id };
    }

    // Gleicher Inhalt schon vorhanden (andere Mail, Upload, Archiv): kein zweites Dokument.
    const duplicate = pending.storageRecommendation.duplicateMatch;
    if (duplicate) {
      discardPendingDocumentIntake(pending);
      return { outcome: 'duplicate', existing: { type: duplicate.type, id: duplicate.id } };
    }

    // 8. Bestehende Entscheidung → intakeCachedDocumentFile.
    const emailOrigin: InboxEmailOrigin = {
      messageId: message.id,
      attachmentId,
      position: attachment.position,
      sha256: expectedSha,
      ...(message.receivedAt ? { receivedAt: message.receivedAt } : {}),
      importedAt: deps.now?.() ?? new Date().toISOString(),
    };
    const result = await executePendingDocumentDecision(pending, 'save_permanently', {
      importSource: 'email',
      senderHint: senderHintOf(message),
      emailOrigin,
      inboxItemId: emailAttachmentInboxItemId(attachmentId),
    });

    // 9. Ergebnis fachlich unterscheiden — nichts als Erfolg maskieren.
    if (!isPendingDocumentDecisionResultIntake(result)) {
      discardPendingDocumentIntake(pending);
      return { outcome: 'failed', error: 'intake_failed', detail: result.outcome };
    }
    if (!result.success) {
      discardPendingDocumentIntake(pending);
      return { outcome: 'failed', error: 'intake_failed', detail: result.error };
    }
    if (result.duplicate) {
      discardPendingDocumentIntake(pending);
      return {
        outcome: 'duplicate',
        existing: result.existing ? { type: result.existing.type, id: result.existing.id } : null,
      };
    }
    return { outcome: 'created', inboxItemId: result.inboxItem.id };
  } finally {
    inFlight.delete(attachmentId);
  }
}
