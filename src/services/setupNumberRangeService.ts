/**
 * EINRICHTUNG-01 (AP3, O-04.3; EIN-34) — die Startnummer der Rechnungen gehört zum Abschluss der Einrichtung.
 *
 * Bisher lief `ensureInvoiceNumberStartOnServer` erst nach dem Abschluss und ohne Blick auf das Ergebnis
 * (`.catch(() => undefined)`): Ein Fehler blieb unsichtbar, die Einrichtung galt als abgeschlossen. Jetzt wird die
 * Startnummer vor dem Abschluss beim Server hinterlegt. Scheitert das, bleibt der Assistent mit allen Eingaben stehen
 * und bietet die Wiederholung an — kein Setup-Erfolg.
 *
 * Die Regeln des Servers (FINANZ-CORE-01A, RE-02) und `ensureInvoiceNumberStartOnServer` bleiben unverändert: Der
 * Server setzt die Startnummer nur für ein Jahr ohne vergebene Nummer; ein benutzter Kreis bleibt, wie er ist
 * („locked“ ist kein Fehler). Ein Server ohne die Funktion verhält sich wie bisher; die erste Freigabe fragt ohnehin
 * erneut nach.
 */
import { isSupabaseConfigured } from '../lib/supabase';
import type { TranslationKey } from '../i18n';
import { buildPersistedStateSnapshot } from './persistenceService';
import { getCurrentInvoiceYear } from './invoiceNumberService';
import {
  WorkspaceInvoiceCloudError,
  rpcSetWorkspaceInvoiceNumberStart,
} from './invoice/workspaceInvoiceCloudService';

export type SetupNumberRangeOutcome =
  | { ok: true; outcome: 'applied' | 'unchanged' | 'locked' | 'unsupported' }
  | { ok: false; errorKey: TranslationKey };

/**
 * Der Cloud-Betrieb, in dem die Startnummer hinterlegt werden muss — oder `null`, wenn es keinen gibt (lokaler
 * Betrieb, noch nicht beim Server angelegt, keine Startnummer). Maßgeblich ist die vom Server bestätigte Kennung aus
 * der Provisionierung; die Kennung eines nur lokalen Betriebs kennt der Server nicht. Ohne Cloud-Betrieb vergibt auch
 * niemand eine Servernummer — wird er später angelegt, fragt die erste Freigabe nach (RE-02).
 */
export function resolveSetupNumberRangeWorkspaceId(lastInvoiceNumber: number): string | null {
  const lastSequence = Math.trunc(lastInvoiceNumber);
  if (!Number.isFinite(lastSequence) || lastSequence <= 0) return null;
  if (!isSupabaseConfigured()) return null;
  try {
    return buildPersistedStateSnapshot().syncClient?.serverWorkspaceId?.trim() || null;
  } catch {
    return null;
  }
}

export async function startInvoiceNumberRangeForSetup(
  workspaceId: string,
  lastInvoiceNumber: number,
): Promise<SetupNumberRangeOutcome> {
  try {
    const result = await rpcSetWorkspaceInvoiceNumberStart({
      workspaceId,
      year: getCurrentInvoiceYear(),
      lastSequence: Math.trunc(lastInvoiceNumber),
    });
    return { ok: true, outcome: result.applied ? 'applied' : 'unchanged' };
  } catch (error) {
    if (error instanceof WorkspaceInvoiceCloudError) {
      switch (error.code) {
        case 'number_start_locked':
          return { ok: true, outcome: 'locked' };
        case 'number_start_unsupported':
          return { ok: true, outcome: 'unsupported' };
        case 'network':
          return { ok: false, errorKey: 'setupFlow.numberRange.network' };
        case 'auth':
        case 'rls':
        case 'financial_action_denied':
          return { ok: false, errorKey: 'setupFlow.numberRange.forbidden' };
        default:
          break;
      }
    }
    return { ok: false, errorKey: 'setupFlow.numberRange.failed' };
  }
}
