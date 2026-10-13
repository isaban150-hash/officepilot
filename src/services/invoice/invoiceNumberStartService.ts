/**
 * FINANZ-CORE-01A (RE-02) — die Startnummer aus der Einrichtung erreicht den
 * Server.
 *
 * Der Einrichtungsassistent fragt nach der zuletzt vergebenen
 * Rechnungsnummer („die nächste Rechnung erhält die folgende Nummer"). Bisher
 * blieb sie lokal; die verbindliche Nummer vergibt aber ausschließlich der
 * Server, und der begann bei 1. Wer aus einer anderen Software umstieg, bekam
 * Nummern, die es dort schon gab.
 *
 * Hier wird die lokale Angabe einmal je Betrieb, Jahr und Wert an
 * `set_workspace_invoice_number_start` gegeben. Der Server setzt sie nur für
 * ein Jahr ohne vergebene Nummer; ein benutzter Kreis bleibt, wie er ist.
 *
 * Kein Ausgang hier sperrt die Rechnungsstellung, außer einem vorübergehenden
 * Fehler — dann ist auch die Freigabe selbst nicht erreichbar. Ein Server ohne
 * die Funktion (Migration noch nicht angewendet) verhält sich wie bisher.
 */
import { isSupabaseConfigured } from '../../lib/supabase';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { getInvoiceNumberSequenceSnapshot } from '../invoiceNumberService';
import {
  WorkspaceInvoiceCloudError,
  rpcSetWorkspaceInvoiceNumberStart,
} from './workspaceInvoiceCloudService';

export type InvoiceNumberStartOutcome =
  /** Keine Startnummer hinterlegt — nichts zu tun. */
  | 'none'
  /** Ohne Cloud oder ohne Betrieb — die Nummer vergibt dann ohnehin niemand. */
  | 'local_only'
  /** Auf dem Server gesetzt. */
  | 'applied'
  /** Stand schon so (auch: in dieser Sitzung bereits bestätigt). */
  | 'unchanged'
  /** Der Kreis des Jahres ist benutzt; der Server bleibt maßgeblich. */
  | 'locked'
  /** Der Server kennt die Funktion noch nicht. */
  | 'unsupported'
  /** Rolle, Konto oder Lizenz — die Freigabe meldet denselben Grund selbst. */
  | 'forbidden'
  /** Netzfehler — dann ist auch die Freigabe nicht erreichbar; später erneut. */
  | 'failed';

const confirmed = new Set<string>();

export function resetInvoiceNumberStartForTests(): void {
  confirmed.clear();
}

export async function ensureInvoiceNumberStartOnServer(): Promise<InvoiceNumberStartOutcome> {
  const sequence = getInvoiceNumberSequenceSnapshot();
  const lastSequence = Math.trunc(sequence.lastIssuedNumber ?? 0);
  if (!Number.isFinite(lastSequence) || lastSequence <= 0) return 'none';
  if (!isSupabaseConfigured()) return 'local_only';

  let workspaceId = '';
  try {
    workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
  } catch {
    workspaceId = '';
  }
  if (!workspaceId) return 'local_only';

  const key = `${workspaceId}:${sequence.year}:${lastSequence}`;
  if (confirmed.has(key)) return 'unchanged';

  try {
    const result = await rpcSetWorkspaceInvoiceNumberStart({
      workspaceId,
      year: sequence.year,
      lastSequence,
    });
    confirmed.add(key);
    return result.applied ? 'applied' : 'unchanged';
  } catch (error) {
    /*
     * Nur ein Netzfehler hält die Freigabe an. Jeder andere Ausgang dieses
     * Hilfsaufrufs darf die Rechnungsstellung nicht sperren — er wird beim
     * nächsten Mal erneut versucht (nicht bestätigt).
     */
    if (!(error instanceof WorkspaceInvoiceCloudError)) return 'unsupported';
    switch (error.code) {
      case 'number_start_locked':
        confirmed.add(key);
        return 'locked';
      case 'network':
        return 'failed';
      case 'auth':
      case 'rls':
      case 'financial_action_denied':
        return 'forbidden';
      default:
        return 'unsupported';
    }
  }
}
