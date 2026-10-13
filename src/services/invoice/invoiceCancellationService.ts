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
  readWorkspaceInvoiceCancelFacts,
  type CancelledInvoiceFacts,
} from './workspaceInvoiceCloudService';
import { projectInvoiceCorrectionDocument } from './invoiceCorrectionArchive';
import { reconcileInvoicePaymentTasks } from './invoicePaymentTaskSync';
import { readInvoiceSentStateFromCloud, syncInvoiceSentToCloud } from '../invoiceSentService';
import { findFinalInvoiceBlockingCancel } from './invoiceCancelEligibility';
import { runQueuedSyncOperation } from '../sync/syncOperationQueue';
import type { WorkspaceActor } from '../workspace/workspaceRoleService';
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
  /**
   * FINANZ-CORE-01A (SQL-01) — der Beleg ist in einer wirksamen
   * Schlussrechnung abgerechnet. Zuerst die Schlussrechnung stornieren.
   */
  | 'final_invoice_exists'
  /**
   * FINANZ-CORE-01A (STO-02) — lokal „versendet", der Vermerk liegt aber nicht
   * nachweislich in der Cloud. Der Server entschiede sonst ein internes Storno
   * ohne Korrekturbeleg, obwohl der Kunde die Rechnung hat.
   */
  | 'sent_not_synced'
  /**
   * FINANZ-CORE-01A (SQL-07) — für die Rechnung läuft gerade ein E-Mail-Versand;
   * erst nach seinem Ausgang stornieren. Nichts storniert.
   */
  | 'delivery_in_progress'
  /**
   * FINANZ-CORE-01A (SQL-07) — der Ausgang eines E-Mail-Versands ist unklar. Ein
   * internes Storno ohne Korrekturbeleg wäre falsch, wenn sie angekommen ist.
   */
  | 'delivery_uncertain'
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
      /**
       * FINANZ-CORE-01A (STO-06) — storniert (Cloud und lokal), nur die lokale Ablage des
       * Korrekturbelegs fehlt noch; der nächste Abgleich holt sie nach.
       */
      correctionArchivePending?: boolean;
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
    case 'cancel_final_invoice_exists':
      return 'final_invoice_exists';
    case 'cancel_delivery_in_progress':
      return 'delivery_in_progress';
    case 'cancel_delivery_uncertain':
      return 'delivery_uncertain';
    case 'not_found':
      return 'not_found';
    case 'auth':
    case 'rls':
    // GO-LIVE-SECURITY-01 / ABSCHLUSS — Rolle, Sperre oder Lizenz (assert_financial_action_allowed).
    case 'financial_action_denied':
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

// FINANZ-CORE-01A (SQL-01) — die Regel steht in einem eigenen, seiteneffektfreien Modul.
export { findFinalInvoiceBlockingCancel } from './invoiceCancelEligibility';

export interface CancelFinalizedInvoiceInput {
  /** NORMAL-INVOICE-CANCELLATION-01B — `null` ist die freie Rechnung ohne Auftrag. */
  vorgangId: string | null;
  invoiceId: string;
  /** Der vom Menschen formulierte Grund. Wird nicht erfunden und nicht ergänzt. */
  reason: string;
  /** FINANZ-CORE-01A (STO-02) — wer storniert; nötig, um einen offenen Versandvermerk zu sichern. */
  actor?: WorkspaceActor;
}

/**
 * FINANZ-CORE-01A — der ganze Storno läuft in der Sync-Warteschlange, wie die
 * Freigabe (`invoiceFinalizationCoordinator`).
 *
 * Befund aus der App-Prüfung: Ein Sync-Lauf beginnt mit dem Stand von seinem
 * Start und schreibt seinen Endstand zurück. Lief er während eines Stornos,
 * überschrieb er die gerade projizierten Stornofakten samt Korrekturbeleg mit
 * dem älteren Stand; der Korrekturbeleg fehlte bis zum nächsten vollständigen
 * Abruf. In der Warteschlange wartet der Storno auf einen laufenden Lauf, und
 * ein späterer Lauf beginnt erst mit dem Stand danach.
 */
export async function cancelFinalizedInvoice(input: CancelFinalizedInvoiceInput): Promise<CancelInvoiceResult> {
  return runQueuedSyncOperation(() => cancelFinalizedInvoiceSerialized(input));
}

async function cancelFinalizedInvoiceSerialized(input: CancelFinalizedInvoiceInput): Promise<CancelInvoiceResult> {
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: 'reason_required' };

  const local = getVorgangInvoice(input.vorgangId, input.invoiceId);
  if (!local) return { ok: false, reason: 'not_found' };
  // Ein bereits stornierter Beleg ist ein Replay — er darf seinen Erfolg weiter abholen.
  if (!local.cancelledAt && findFinalInvoiceBlockingCancel(input.vorgangId, local)) {
    return { ok: false, reason: 'final_invoice_exists' };
  }
  /*
   * FINANZ-CORE-01A (ZAH-19) — wie der Dialog: keine Stornierung mit erfassten Zahlungen. Eine nur
   * lokal gesicherte Zahlung kennt der Server nicht und hielte den Storno nicht auf; danach
   * liesse sie sich nie mehr sichern.
   */
  if (!local.cancelledAt && (local.payments ?? []).length > 0) {
    return { ok: false, reason: 'has_active_payments' };
  }

  /*
   * FINANZ-CORE-01A (STO-02) — der Server entscheidet die Art des Stornos nach
   * SEINEM Versandstand (versendet ⇒ Korrekturbeleg). Ein nur lokal gesetzter
   * Versandvermerk ergäbe ein internes Storno ohne Korrekturbeleg, obwohl der
   * Kunde die Rechnung hat (§ 14c UStG: ausgewiesene Steuer ohne Berichtigung).
   * Deshalb zuerst den Stand prüfen und einen offenen Vermerk sichern; ohne
   * nachgewiesenen Vermerk kein Storno.
   */
  if (!local.cancelledAt && local.status === 'versendet') {
    const sentState = await readInvoiceSentStateFromCloud(input.vorgangId, input.invoiceId);
    if (sentState.kind === 'pending') {
      const pushed = await syncInvoiceSentToCloud(input.vorgangId, input.invoiceId, input.actor);
      if (pushed === 'forbidden') return { ok: false, reason: 'forbidden' };
      if (pushed !== 'synced') return { ok: false, reason: 'sent_not_synced' };
    } else if (sentState.kind !== 'synced' && sentState.kind !== 'not_configured') {
      return { ok: false, reason: 'sent_not_synced' };
    }
  }

  let workspaceId = '';
  try {
    workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
  } catch {
    workspaceId = '';
  }
  if (!workspaceId) return { ok: false, reason: 'workspace_missing' };

  let cancelled: { invoice: CancelledInvoiceFacts };
  // Fünf Minuten Vorlauf: Uhrzeiten von Gerät und Server müssen nicht übereinstimmen.
  const versuchtAb = new Date(Date.now() - 5 * 60_000).toISOString();
  try {
    cancelled = await rpcCancelWorkspaceInvoice({
      workspaceId,
      clientInvoiceId: input.invoiceId,
      reason,
    });
  } catch (error) {
    const grund = error instanceof WorkspaceInvoiceCloudError ? mapCloudError(error) : 'unknown';
    /*
     * FINANZ-CORE-01A (STO-06) — bei unklarem Ausgang einmal nachlesen, statt „unklar" stehen zu
     * lassen: Ist die Rechnung in der Cloud storniert, gilt das auch hier. Gelingt das Nachlesen
     * nicht, bleibt der Ausgang unklar (ein erneuter Versuch ist ein sicheres Replay).
     */
    if (grund !== 'offline' && grund !== 'unknown') {
      return { ok: false, reason: grund, detail: error instanceof Error ? error.message : undefined };
    }
    const nachgelesen = await readWorkspaceInvoiceCancelFacts({
      workspaceId,
      clientInvoiceId: input.invoiceId,
      since: versuchtAb,
    });
    if (!nachgelesen?.cancelledAt) {
      return { ok: false, reason: grund, detail: error instanceof Error ? error.message : undefined };
    }
    cancelled = { invoice: nachgelesen };
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
  let correctionArchivePending = false;
  let invoice = applied.invoice;
  if (invoice.cancellationKind === 'correction') {
    const archived = archiveInvoiceCorrectionLocally(input.vorgangId, invoice);
    if (archived.ok) {
      correctionArchiveDocumentId = archived.documentId;
      invoice = getVorgangInvoice(input.vorgangId, input.invoiceId) ?? invoice;
    } else {
      /*
       * FINANZ-CORE-01A (STO-06) — die Rechnung ist in der Cloud UND lokal storniert; nur die
       * lokale Ablage des Korrekturbelegs fehlt (der Pull heilt sie). Bisher hiess das
       * „local_persist_failed", und die Seite zeigte den alten, nicht stornierten Stand.
       */
      correctionArchivePending = true;
    }
  }

  // P0/P1-INTEGRITAET 01B / P1 — eine stornierte Rechnung ist keine offene Forderung mehr.
  try {
    reconcileInvoicePaymentTasks({ invoiceId: input.invoiceId });
  } catch (error) {
    console.warn('[storno] Überfälligkeitsaufgabe konnte nicht geschlossen werden', error);
  }

  return {
    ok: true,
    action: alreadyCancelled ? 'already_cancelled' : 'cancelled',
    invoice,
    cancelReason: authoritativeReason,
    reasonDiffers: authoritativeReason !== reason,
    ...(correctionArchiveDocumentId ? { correctionArchiveDocumentId } : {}),
    ...(correctionArchivePending ? { correctionArchivePending: true } : {}),
  };
}
