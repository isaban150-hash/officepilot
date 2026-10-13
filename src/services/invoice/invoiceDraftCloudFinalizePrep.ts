/**
 * CLOUD-SYNC S5 — „Erst den Entwurf zur Ruhe bringen" vor der Freigabe (Muster
 * der Angebote, ANGEBOT-01B).
 *
 * Der zuletzt bestätigte lokale Stand wird gespiegelt, ein Sync-Lauf
 * abgewartet und geprüft, dass die Cloud genau diesen fachlichen Kern trägt.
 * Ein Lauf, dann die Prüfung — kein Endlosversuch. Die eigentliche Bindung
 * liest der Koordinator anschliessend noch einmal synchron im selben
 * Queue-Lauf wie die Freigabe; dieser Schritt erspart nur den vergeblichen Start.
 *
 * Ohne freigegebene Cloud-Seite geschieht nichts: Dann gibt es keine Bindung,
 * und die Freigabe läuft wie bisher.
 */
import type { InvoiceDraft } from '../../types/models';
import type { InvoiceDraftRecord } from '../../types/invoiceDraftDurability';
import { runSyncFromUi } from '../sync/syncUiService';
import { getSyncOutboxSnapshot } from '../sync/syncOutboxService';
import { isSupabaseSyncAllowed } from '../sync/cloudSyncAllowlist';
import {
  applyLocalDraftCommitToMirror,
  isInvoiceDraftCloudSyncAllowed,
  resolveInvoiceDraftCloudBinding,
  type InvoiceDraftCloudBindingResult,
} from './invoiceDraftCloudBridge';

/**
 * FINANZ-CORE-01A — `vorgang_not_synced` (RE-07): Der Auftrag trägt noch nicht übertragene
 * Änderungen. `prep_timeout` (RE-12): Der Abgleich hing länger als die Frist. In beiden
 * Fällen hat nichts begonnen; ein erneuter Versuch ist erlaubt.
 */
export type InvoiceFinalizePrepResult =
  | InvoiceDraftCloudBindingResult
  | { ok: false; reason: 'vorgang_not_synced' | 'prep_timeout' };

export type InvoiceFinalizePrepFailureReason = Extract<InvoiceFinalizePrepResult, { ok: false }>['reason'];

/** FINANZ-CORE-01A (RE-12) — Frist für den Abgleich vor dem Start. */
export const INVOICE_FINALIZE_PREP_DEADLINE_MS = 30_000;

/** FINANZ-CORE-01A (RE-12) — ab hier erklärt ein Hinweis eine ungewöhnlich lange Freigabe. */
export const INVOICE_FINALIZE_SLOW_NOTICE_MS = 45_000;

function hasPendingVorgangUpload(vorgangId: string): boolean {
  return getSyncOutboxSnapshot().some(
    (entry) =>
      entry.entityType === 'vorgang' &&
      entry.entityId === vorgangId &&
      (entry.status === 'pending' || entry.status === 'blocked' || entry.status === 'error'),
  );
}

/** Ein Abgleich mit Frist; `false`, wenn er länger hing (er läuft im Hintergrund weiter). */
async function syncWithinDeadline(deadlineMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deadlineMs);
  });
  try {
    const outcome = await Promise.race([
      runSyncFromUi().then(
        () => 'done' as const,
        () => 'done' as const,
      ),
      timeout,
    ]);
    return outcome !== 'timeout';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function prepareInvoiceDraftCloudForFinalization(
  record: InvoiceDraftRecord,
  draft: InvoiceDraft,
  options: { deadlineMs?: number } = {},
): Promise<InvoiceFinalizePrepResult> {
  const deadlineMs = options.deadlineMs ?? INVOICE_FINALIZE_PREP_DEADLINE_MS;
  /*
   * FINANZ-CORE-01A (RE-07) — der Server prüft gegen seinen Stand des Auftrags. Lokal
   * erfasste, noch nicht übertragene Änderungen (Aufmaß, Positionen, Preise) kennt er
   * nicht; seine Abweisung kam erst nach dem Start (`quantity_exceeds_available`,
   * `position_*`). Deshalb zuerst übertragen — ein Lauf, dann die Prüfung.
   */
  const vorgangId = record.vorgangId;
  if (vorgangId && isSupabaseSyncAllowed('vorgang') && hasPendingVorgangUpload(vorgangId)) {
    if (!(await syncWithinDeadline(deadlineMs))) return { ok: false, reason: 'prep_timeout' };
    if (hasPendingVorgangUpload(vorgangId)) return { ok: false, reason: 'vorgang_not_synced' };
  }
  if (!isInvoiceDraftCloudSyncAllowed()) return { ok: true, binding: null };
  try {
    applyLocalDraftCommitToMirror(record, draft);
  } catch {
    /* die Prüfung unten entscheidet */
  }
  const first = resolveInvoiceDraftCloudBinding(draft);
  if (first.ok || first.reason !== 'draft_not_synced') return first;
  // FINANZ-CORE-01A (RE-12) — hängt das Netz, beginnt nichts; der Nutzer bekommt eine Antwort.
  if (!(await syncWithinDeadline(deadlineMs))) return { ok: false, reason: 'prep_timeout' };
  return resolveInvoiceDraftCloudBinding(draft);
}

/** Der Hinweis, wenn die Freigabe deshalb gar nicht erst beginnt. */
export function invoiceDraftCloudPrepMessageKey(
  reason: InvoiceFinalizePrepFailureReason,
):
  | 'invoiceDraftCloud.approve.notSynced'
  | 'invoiceDraftCloud.approve.conflict'
  | 'invoiceDraftCloud.approve.ended'
  | 'invoice.approve.orderNotSynced'
  | 'invoice.approve.prepTimeout' {
  if (reason === 'draft_conflict') return 'invoiceDraftCloud.approve.conflict';
  if (reason === 'draft_ended') return 'invoiceDraftCloud.approve.ended';
  if (reason === 'vorgang_not_synced') return 'invoice.approve.orderNotSynced';
  if (reason === 'prep_timeout') return 'invoice.approve.prepTimeout';
  return 'invoiceDraftCloud.approve.notSynced';
}
