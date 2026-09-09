import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { getVorgangInvoice, applyInvoiceCancellationFromCloud } from '../vorgangService';
import {
  WorkspaceInvoiceCloudError,
  rpcCancelWorkspaceInvoice,
} from './workspaceInvoiceCloudService';

/**
 * FINAL-INVOICE-CANCELLATION-SERVER-FOUNDATION-01C — die technische Anbindung
 * der Stornierung einer Schlussrechnung.
 *
 * ⚠️ **Keine Benutzeraktion.** Dieser Dienst wird von keiner Oberfläche
 * aufgerufen. Er bereitet ausschliesslich die spätere Confirm-first-Bedienung
 * vor: Erst wenn ein Mensch die Stornierung samt Grund ausdrücklich bestätigt
 * hat, darf ein künftiger Aufrufer hierher kommen. Nichts an diesem Dienst
 * entscheidet selbst, und nichts läuft automatisch.
 *
 * Die Reihenfolge ist bewusst „Cloud zuerst, lokal danach": Die Datenbank ist
 * die Stornowahrheit. Ein lokal vorweggenommener Storno, dem der Server
 * widerspricht, wäre genau die zweite Wahrheit, die dieser Block verhindert.
 *
 * Alle Fehlerausgänge sind fail-closed — es wurde dann weder in der Cloud noch
 * lokal etwas verändert, keine Zahlung zurückgebucht und keine Rechnung
 * gelöscht.
 */
export type CancelInvoiceFailureReason =
  /** Nur Schlussrechnungen — Abschläge und andere Belegarten sind ein eigener Fachpunkt. */
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
  | 'unknown';

export type CancelInvoiceResult =
  | { ok: true; action: 'cancelled' | 'already_cancelled' }
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

export async function cancelFinalizedInvoice(input: {
  vorgangId: string;
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

  const cancelledAt = cancelled.invoice.cancelledAt;
  if (!cancelledAt) {
    /*
     * Der Server meldete Erfolg, die Antwort trägt aber keinen Zeitpunkt.
     * Dann ist der Zustand unklar — es wird nichts geraten und nichts lokal
     * geschrieben.
     */
    return { ok: false, reason: 'unknown', detail: 'response_without_cancelled_at' };
  }

  /* War die Rechnung lokal schon storniert, ist der Serveraufruf ein Replay. */
  const alreadyCancelled = Boolean(local.cancelledAt);

  const applied = applyInvoiceCancellationFromCloud(input.vorgangId, input.invoiceId, {
    cancelledAt,
    cancelReason: cancelled.invoice.cancelReason,
  });
  if (!applied.ok) {
    return {
      ok: false,
      reason: applied.reason === 'not_found' ? 'not_found' : 'local_persist_failed',
    };
  }

  return { ok: true, action: alreadyCancelled ? 'already_cancelled' : 'cancelled' };
}
