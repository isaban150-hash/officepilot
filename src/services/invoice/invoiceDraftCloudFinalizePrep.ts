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
import {
  applyLocalDraftCommitToMirror,
  isInvoiceDraftCloudSyncAllowed,
  resolveInvoiceDraftCloudBinding,
  type InvoiceDraftCloudBindingResult,
} from './invoiceDraftCloudBridge';

export async function prepareInvoiceDraftCloudForFinalization(
  record: InvoiceDraftRecord,
  draft: InvoiceDraft,
): Promise<InvoiceDraftCloudBindingResult> {
  if (!isInvoiceDraftCloudSyncAllowed()) return { ok: true, binding: null };
  try {
    applyLocalDraftCommitToMirror(record, draft);
  } catch {
    /* die Prüfung unten entscheidet */
  }
  const first = resolveInvoiceDraftCloudBinding(draft);
  if (first.ok || first.reason !== 'draft_not_synced') return first;
  try {
    await runSyncFromUi();
  } catch {
    /* die Prüfung unten entscheidet */
  }
  return resolveInvoiceDraftCloudBinding(draft);
}

/** Der Hinweis, wenn die Freigabe deshalb gar nicht erst beginnt. */
export function invoiceDraftCloudPrepMessageKey(
  reason: 'draft_not_synced' | 'draft_conflict' | 'draft_ended',
): 'invoiceDraftCloud.approve.notSynced' | 'invoiceDraftCloud.approve.conflict' | 'invoiceDraftCloud.approve.ended' {
  if (reason === 'draft_conflict') return 'invoiceDraftCloud.approve.conflict';
  if (reason === 'draft_ended') return 'invoiceDraftCloud.approve.ended';
  return 'invoiceDraftCloud.approve.notSynced';
}
