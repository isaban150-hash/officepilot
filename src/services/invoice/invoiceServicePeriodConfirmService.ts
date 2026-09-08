/**
 * LEGACY-INVOICE-SERVICE-PERIOD-RECOVERY-01B
 *
 * Rechnungen, die vor der Einführung von `servicePeriodConfirmed` finalisiert
 * wurden, tragen die Bestätigung ihres Leistungszeitraums nicht — und können
 * sie auch nicht nachträglich beweisen. Der PDF-Pfad blockiert sie deshalb zu
 * Recht. Was fehlte, war der Weg, den **bereits gespeicherten** Zeitraum
 * ausdrücklich nachzubestätigen.
 *
 * Dieser Dienst ergänzt genau ein Faktum und nichts sonst. Er ändert weder den
 * Zeitraum noch Beträge, Positionen, Nummern, Snapshots, Versand oder Storno,
 * und er finalisiert nichts neu.
 *
 * Der Cloud-Zustand wird **abgeleitet**, nicht gespeichert: aus dem lokalen
 * Wert plus einem schmalen Einzelread. Deshalb gibt es keinen Pending-Marker,
 * der verloren gehen könnte — die Diskrepanz wird nach jedem Neustart aus den
 * beiden Wahrheiten neu berechnet.
 */
import type { VorgangInvoice } from '../../types/models';
import { isFinalizedInvoice } from '../invoiceArchiveService';
import { getVorgangInvoice, updateInvoiceServicePeriodConfirmation } from '../vorgangService';

export type ServicePeriodConfirmReason =
  | 'invoice_missing'
  | 'not_finalized'
  | 'service_period_missing'
  | 'service_period_invalid'
  | 'persist_failed';

export type ServicePeriodConfirmResult =
  | { ok: true; invoice: VorgangInvoice; action: 'confirmed' | 'noop' }
  | { ok: false; reason: ServicePeriodConfirmReason };

/**
 * Dieselbe strenge Datumsprüfung wie im Freigabe-Gate: erst die Form, dann der
 * echte Kalender. Ohne den zweiten Schritt kämen `2026-02-30` und `2026-04-31`
 * durch — beides gibt es nicht.
 */
function isIsoDate(value: string): boolean {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === trimmed;
}

type PreconditionFailure = Exclude<ServicePeriodConfirmReason, 'invoice_missing' | 'persist_failed'>;

/**
 * Ausdrücklich die **rohen** Felder der Rechnung, nicht die Rückfallwerte des
 * PDF-Validators. Wer keinen eigenen Leistungszeitraum gespeichert hat, soll
 * nicht das Rechnungsdatum bestätigen, ohne es zu merken.
 */
function checkPreconditions(invoice: VorgangInvoice): PreconditionFailure | null {
  if (!isFinalizedInvoice(invoice)) return 'not_finalized';

  const from = invoice.servicePeriodFrom?.trim() ?? '';
  const to = invoice.servicePeriodTo?.trim() ?? '';
  if (!from || !to) return 'service_period_missing';
  if (!isIsoDate(from) || !isIsoDate(to)) return 'service_period_invalid';
  // ISO-Daten sind lexikografisch vergleichbar.
  if (from > to) return 'service_period_invalid';

  return null;
}

/**
 * Darf diese Rechnung überhaupt bestätigt werden? Steuert die Sichtbarkeit des
 * Panels und die Vorprüfung der Mutation aus derselben Quelle — damit die
 * Oberfläche nie einen Knopf zeigt, den der Dienst danach ablehnt.
 */
export function canConfirmInvoiceServicePeriod(invoice: VorgangInvoice): boolean {
  return checkPreconditions(invoice) === null;
}

/** Bestätigbar **und** noch nicht bestätigt — der eigentliche Legacy-Fall. */
export function needsServicePeriodRecovery(invoice: VorgangInvoice): boolean {
  return invoice.servicePeriodConfirmed !== true && canConfirmInvoiceServicePeriod(invoice);
}

/**
 * Die ausdrückliche Nutzerbestätigung. Monoton: `undefined` und `false` dürfen
 * zu `true` werden, `true` bleibt `true`. Es gibt keinen Rückweg — ein Widerruf
 * wäre eine Belegänderung und gehört nach Storno/Korrektur, nicht hierher.
 */
export function confirmFinalizedInvoiceServicePeriod(
  vorgangId: string,
  invoiceId: string,
): ServicePeriodConfirmResult {
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) return { ok: false, reason: 'invoice_missing' };

  if (invoice.servicePeriodConfirmed === true) {
    // Bereits bestätigt: kein erneutes Schreiben, keine neue Revision.
    return { ok: true, invoice, action: 'noop' };
  }

  const failure = checkPreconditions(invoice);
  if (failure) return { ok: false, reason: failure };

  const updated = updateInvoiceServicePeriodConfirmation(vorgangId, invoiceId);
  if (!updated.ok) {
    return {
      ok: false,
      reason: updated.reason === 'not_found' ? 'invoice_missing' : 'persist_failed',
    };
  }
  return { ok: true, invoice: updated.invoice, action: updated.action };
}

/**
 * Ausgang der Cloud-Sicherung. `supabase_not_configured` ist der bewusst lokale
 * Betrieb und kein Fehler; alles andere darf die Oberfläche nicht als Erfolg
 * verbuchen.
 */
export type ServicePeriodCloudSyncResult =
  | 'synced'
  | 'supabase_not_configured'
  | 'workspace_missing'
  | 'local_invoice_invalid'
  | 'failed';

/** Nur diese beiden Ausgänge darf die Oberfläche schweigend hinnehmen. */
export function isServicePeriodCloudSyncSilent(result: ServicePeriodCloudSyncResult): boolean {
  return result === 'synced' || result === 'supabase_not_configured';
}

/**
 * Sichert die lokale Bestätigung in der Cloud. Wird sowohl direkt nach der
 * Nutzeraktion aufgerufen als auch später über „Jetzt sichern" — dieselbe
 * Mutation, kein zweiter Weg.
 *
 * Ein Fehlschlag nimmt die Entscheidung des Nutzers **nicht** zurück: Lokal
 * bleibt `true`, PDF und Druck bleiben möglich. Die Diskrepanz wird beim
 * nächsten Öffnen der Rechnung neu erkannt.
 */
export async function syncInvoiceServicePeriodConfirmationToCloud(
  vorgangId: string,
  invoiceId: string,
): Promise<ServicePeriodCloudSyncResult> {
  try {
    const invoice = getVorgangInvoice(vorgangId, invoiceId);
    if (!invoice || !isFinalizedInvoice(invoice) || invoice.servicePeriodConfirmed !== true) {
      // Was lokal nicht bestätigt ist, wird nicht hochgeladen.
      return 'local_invoice_invalid';
    }

    const { isSupabaseConfigured } = await import('../../lib/supabase');
    if (!isSupabaseConfigured()) return 'supabase_not_configured';

    const [{ rpcConfirmWorkspaceInvoiceServicePeriod }, { resolveCloudWorkspaceId }, persistence] =
      await Promise.all([
        import('./workspaceInvoiceCloudService'),
        import('../workspace/workspaceSyncPayloadService'),
        import('../persistenceService'),
      ]);

    const workspaceId = resolveCloudWorkspaceId(persistence.buildPersistedStateSnapshot()).trim();
    if (!workspaceId) {
      // Cloud vorhanden, Workspace nicht auflösbar — das ist ein Fehler.
      return 'workspace_missing';
    }

    await rpcConfirmWorkspaceInvoiceServicePeriod({ workspaceId, clientInvoiceId: invoice.id });
    return 'synced';
  } catch {
    return 'failed';
  }
}

/**
 * Der abgeleitete Cloud-Zustand.
 *
 * `unknown` ist ein vollwertiges Ergebnis und keine Notlösung: Ohne Antwort
 * gibt es keinen Beweis, und ohne Beweis wird weder „gesichert" noch „nicht
 * gesichert" behauptet.
 */
export type ServicePeriodCloudState =
  | 'confirmed'
  | 'not_confirmed'
  | 'missing'
  | 'unknown'
  | 'not_configured';

export async function readInvoiceServicePeriodConfirmationFromCloud(
  invoiceId: string,
): Promise<ServicePeriodCloudState> {
  try {
    const { isSupabaseConfigured } = await import('../../lib/supabase');
    if (!isSupabaseConfigured()) return 'not_configured';

    const [
      { rpcGetWorkspaceInvoiceServicePeriodConfirmation },
      { resolveCloudWorkspaceId },
      persistence,
    ] = await Promise.all([
      import('./workspaceInvoiceCloudService'),
      import('../workspace/workspaceSyncPayloadService'),
      import('../persistenceService'),
    ]);

    const workspaceId = resolveCloudWorkspaceId(persistence.buildPersistedStateSnapshot()).trim();
    if (!workspaceId) return 'unknown';

    const state = await rpcGetWorkspaceInvoiceServicePeriodConfirmation({
      workspaceId,
      clientInvoiceId: invoiceId,
    });
    /*
     * 01B2 — `missing` ist ein eigener Zustand und ausdrücklich **nicht**
     * `not_confirmed`.
     *
     * Die Confirm-RPC kann nur eine bereits vorhandene Cloud-Zeile ergänzen;
     * fehlt sie, endet jeder Sicherungsversuch strukturell mit „Rechnung nicht
     * gefunden". Diese Lage als reparierbares „noch nicht gesichert" zu zeigen,
     * hiesse einen Knopf anzubieten, der nie gelingen kann.
     *
     * Und die Lage ist real: `workspace_invoices` existiert erst seit
     * 20250723120000 — Rechnungen von davor haben dort nie eine Zeile gehabt.
     * Dasselbe gilt nach einem Workspace-Wechsel, denn die Zeile wird über
     * `workspace_id + client_invoice_id` identifiziert.
     */
    if (!state.found) return 'missing';
    return state.confirmed ? 'confirmed' : 'not_confirmed';
  } catch {
    return 'unknown';
  }
}
