import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import {
  applyInvoiceCancellationFromCloud,
  getVorgangById,
  getVorgangInvoice,
  updateInvoiceCorrectionArchiveDocumentId,
} from '../vorgangService';
import {
  commitDocumentStoreMerge,
  getDocumentByLinkedInvoiceId,
  getDocumentStoreSnapshot,
} from '../documentService';
import { isEntitySyncActive } from '../sync/syncMetaService';
import {
  WorkspaceInvoiceCloudError,
  rpcCancelWorkspaceInvoice,
} from './workspaceInvoiceCloudService';
import { projectInvoiceCorrectionDocument } from './invoiceCorrectionArchive';
import type { VorgangInvoice } from '../../types/models';

/**
 * FINAL-INVOICE-CANCELLATION-SERVER-FOUNDATION-01C / NORMAL-INVOICE-CANCELLATION-01B
 * — die technische Anbindung der Stornierung einer freigegebenen Rechnung.
 *
 * ⚠️ Nur nach ausdrücklicher Bestätigung eines Menschen (Confirm-first im
 * `InvoiceCancelDialog`). Nichts hier entscheidet selbst, nichts läuft
 * automatisch.
 *
 * Reihenfolge bewusst „Cloud zuerst, lokal danach": Die Datenbank ist die
 * Stornowahrheit — und seit 01B auch die Wahrheit des Korrekturbelegs, der
 * dort atomar mit dem Storno entsteht. Lokal wird nur projiziert:
 *
 *   1. Stornofakten auf das Original (`applyInvoiceCancellationFromCloud`),
 *   2. bei `correction` das Archivdokument des Korrekturbelegs — dieselbe
 *      Kennung wie die Cloud-Zeile, idempotent, nie ein zweites.
 *
 * Scheitert ein lokaler Schritt, bleibt die Cloud vollständig; der nächste
 * Pull heilt die Projektion (`reconcileArchiveDocumentLinks`). Ein zweiter
 * Stornoversuch ist dann ein Replay und erzeugt nichts Neues.
 *
 * Alle Fehlerausgänge vor dem Cloud-Aufruf sind fail-closed — es wurde dann
 * weder in der Cloud noch lokal etwas verändert.
 */
export type CancelInvoiceFailureReason =
  /** Nur normale Rechnungen und Schlussrechnungen — Abschläge sind ein eigener Fachpunkt. */
  | 'type_not_supported'
  /** Ein Entwurf ist nie hinausgegangen; es gibt nichts zu stornieren. */
  | 'not_finalized'
  /** Aktive Zahlung vorhanden. Zuerst die Zahlung zurücknehmen — hier wird nichts gebucht. */
  | 'has_active_payments'
  /** Ohne Begründung wird nicht storniert. */
  | 'reason_required'
  | 'not_found'
  | 'forbidden'
  | 'offline'
  | 'workspace_missing'
  /** Die Cloud hat storniert, der lokale Nachtrag schlug fehl — der nächste Pull holt ihn nach. */
  | 'local_persist_failed'
  /**
   * 01B — der Server meldete eine Korrektur ohne Korrekturbeleg. Das darf es
   * nicht geben; lokal wird nichts als storniert markiert.
   */
  | 'correction_document_missing'
  | 'unknown';

export type CancelInvoiceResult =
  | {
      ok: true;
      action: 'cancelled' | 'already_cancelled';
      invoice: VorgangInvoice;
      /** Der autoritative Grund — bei einem Replay der **erste**, nie der erneut gesendete. */
      cancelReason: string;
      /** Replay mit anderem Grund: nichts überschrieben, der Aufrufer darf es zeigen. */
      reasonDiffers: boolean;
      /** Lokale Archivkennung des Korrekturbelegs, wenn einer gehört. */
      correctionArchiveDocumentId?: string;
    }
  | { ok: false; reason: CancelInvoiceFailureReason; detail?: string };

function mapCloudError(error: WorkspaceInvoiceCloudError): CancelInvoiceFailureReason {
  switch (error.code) {
    case 'cancel_type_not_supported':
      return 'type_not_supported';
    case 'cancel_not_finalized':
      return 'not_finalized';
    case 'cancel_has_active_payments':
      return 'has_active_payments';
    case 'cancel_reason_required':
      return 'reason_required';
    case 'not_found':
      return 'not_found';
    case 'auth':
    case 'rls':
      return 'forbidden';
    case 'network':
      return 'offline';
    default:
      return 'unknown';
  }
}

/**
 * Lokale Projektion des Korrekturbelegs — idempotent über Art + Rechnung.
 * Gibt die lokale Dokumentkennung zurück, oder `null` bei Persistenzfehler.
 */
export function archiveInvoiceCorrectionLocally(
  vorgangId: string | null,
  invoice: VorgangInvoice,
): { ok: true; documentId: string } | { ok: false } {
  const existing = getDocumentByLinkedInvoiceId(invoice.id, 'correction');
  let documentId = existing?.id ?? null;

  if (!documentId) {
    const vorgang = vorgangId === null ? null : (getVorgangById(vorgangId) ?? null);
    const projected = projectInvoiceCorrectionDocument(
      invoice,
      vorgang ? { vorgangId: vorgang.id, vorgangTitle: vorgang.title } : null,
    );
    if (!projected) return { ok: false };
    const snapshot = getDocumentStoreSnapshot();
    if (snapshot.some((doc) => doc.id === projected.id && isEntitySyncActive(doc))) {
      documentId = projected.id;
    } else if (!commitDocumentStoreMerge([projected, ...snapshot])) {
      return { ok: false };
    } else {
      documentId = projected.id;
    }
  }

  if (invoice.correctionArchiveDocumentId !== documentId) {
    const linked = updateInvoiceCorrectionArchiveDocumentId(vorgangId, invoice.id, documentId);
    if (!linked.ok) return { ok: false };
  }
  return { ok: true, documentId };
}

export async function cancelFinalizedInvoice(input: {
  /** NORMAL-INVOICE-CANCELLATION-01B — `null` ist die freie Rechnung ohne Auftrag. */
  vorgangId: string | null;
  invoiceId: string;
  /** Der vom Menschen formulierte Grund. Wird nicht erfunden und nicht ergänzt. */
  reason: string;
}): Promise<CancelInvoiceResult> {
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: 'reason_required' };

  const local = getVorgangInvoice(input.vorgangId, input.invoiceId);
  if (!local) return { ok: false, reason: 'not_found' };

  let workspaceId = '';
  try {
    workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
  } catch {
    workspaceId = '';
  }
  if (!workspaceId) return { ok: false, reason: 'workspace_missing' };

  let cancelled;
  try {
    cancelled = await rpcCancelWorkspaceInvoice({
      workspaceId,
      clientInvoiceId: input.invoiceId,
      reason,
    });
  } catch (error) {
    if (error instanceof WorkspaceInvoiceCloudError) {
      return { ok: false, reason: mapCloudError(error), detail: error.message };
    }
    return { ok: false, reason: 'unknown' };
  }

  const remote = cancelled.invoice;
  const cancelledAt = remote.cancelledAt;
  if (!cancelledAt) {
    // Erfolg ohne Zeitpunkt: unklarer Zustand — nichts raten, nichts schreiben.
    return { ok: false, reason: 'unknown', detail: 'response_without_cancelled_at' };
  }

  /*
   * 01B — Serverwahrheit prüfen, bevor sie lokal wird: Eine versendete
   * Rechnung darf nur mit Korrekturbeleg als storniert gelten. Ein Server, der
   * die Art kennt und `correction` ohne Beleg meldet, ist widersprüchlich.
   */
  if (remote.cancellationKind === 'correction' && !remote.correctionDocumentId) {
    return { ok: false, reason: 'correction_document_missing' };
  }

  const alreadyCancelled = Boolean(local.cancelledAt);
  const authoritativeReason = remote.cancelReason ?? local.cancelReason ?? reason;

  const applied = applyInvoiceCancellationFromCloud(input.vorgangId, input.invoiceId, {
    cancelledAt,
    cancelReason: remote.cancelReason,
    cancellationKind: remote.cancellationKind,
    correctionDocumentId: remote.correctionDocumentId,
    correctionNumber: remote.correctionNumber,
  });
  if (!applied.ok) {
    return {
      ok: false,
      reason: applied.reason === 'not_found' ? 'not_found' : 'local_persist_failed',
    };
  }

  let correctionArchiveDocumentId: string | undefined;
  let invoice = applied.invoice;
  if (invoice.cancellationKind === 'correction') {
    const archived = archiveInvoiceCorrectionLocally(input.vorgangId, invoice);
    if (!archived.ok) {
      // Cloud vollständig, lokale Projektion offen — der Pull heilt sie.
      return { ok: false, reason: 'local_persist_failed', detail: 'correction_archive' };
    }
    correctionArchiveDocumentId = archived.documentId;
    invoice = getVorgangInvoice(input.vorgangId, input.invoiceId) ?? invoice;
  }

  return {
    ok: true,
    action: alreadyCancelled ? 'already_cancelled' : 'cancelled',
    invoice,
    cancelReason: authoritativeReason,
    reasonDiffers: authoritativeReason !== reason,
    ...(correctionArchiveDocumentId ? { correctionArchiveDocumentId } : {}),
  };
}
