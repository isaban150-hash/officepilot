/**
 * STEUERBERATER-06C — darf dieser Monat übergeben werden?
 *
 * Die Kernregel: **Ein Abschluss allein genügt nicht.** Vor jedem Export
 * werden die Monatsdaten frisch ausgewertet und gegen den gespeicherten
 * Abschluss gehalten. Damit führt auch ein formal gültiger Abschluss, der
 * fachlich unvollständig ist — etwa über einen direkten RPC-Aufruf erzeugt —
 * nicht zu einem Export.
 *
 * Zwei Ebenen werden **getrennt** bewertet:
 *
 *   1. Das **Steuerberater-Paket** — neutrale Buchungsdaten, Belege, Manifest.
 *      Es hängt an der fachlichen Vollständigkeit des Monats.
 *   2. Das **DATEV-Format** — braucht darüber hinaus Daten, die OfficeTakt
 *      heute nicht hat (siehe `collectDatevBlockers`). Sein Fehlen darf das
 *      neutrale Paket nicht blockieren; ein Steuerberater kann mit einer
 *      sauberen CSV und den Originalbelegen arbeiten.
 *
 * Dieses Modul ändert nichts. Es schliesst insbesondere **keinen Monat ab** —
 * ein Export fordert nie von sich aus eine neue Abschlussrevision an.
 */
import { getAccountingPeriodState } from './accountingPeriodService';
import type { AccountingPeriodState } from '../../types/accountingPeriod';

/* -------------------------------------------------------------------------- */
/* Blocker                                                                    */
/* -------------------------------------------------------------------------- */

export type ExportBlockerCode =
  | 'not_closed'
  | 'changed_after_close'
  | 'period_blockers'
  /* DATEV-spezifisch — blockiert nur das DATEV-Format, nie das Paket. */
  | 'datev_no_specification'
  | 'datev_no_counter_account'
  | 'datev_no_tax_key'
  | 'datev_no_client_profile';

export interface ExportBlocker {
  readonly code: ExportBlockerCode;
  /** Ergänzende Angabe für die Anzeige, etwa eine Anzahl. */
  readonly detail?: string;
}

export interface AccountingExportReadiness {
  readonly monthKey: string;
  /** Darf das neutrale Steuerberater-Paket erzeugt werden? */
  readonly packageAllowed: boolean;
  readonly packageBlockers: readonly ExportBlocker[];
  /** Darf ein echter DATEV-Buchungsstapel erzeugt werden? */
  readonly datevAllowed: boolean;
  readonly datevBlockers: readonly ExportBlocker[];
  /** Der Stand, auf dem diese Bewertung beruht. */
  readonly state: AccountingPeriodState;
}

/**
 * Warum OfficeTakt heute **kein** DATEV-Format erzeugt.
 *
 * Diese Liste ist das Ergebnis einer Bestandsaufnahme, keine Vermutung. Im
 * Repository fehlen:
 *
 *   - eine **Formatspezifikation**: kein Header, keine Formatversion, keine
 *     Feldreihenfolge, kein Encoding, keine Pflichtfeldliste. Ohne sie wäre
 *     jede erzeugte Datei geraten.
 *   - das **Gegenkonto** und damit die Buchungsrichtung. Eine Kontierung (06A)
 *     nennt ein Sachkonto, nicht die Gegenseite. Irgendein Bank-, Debitoren-
 *     oder Verrechnungskonto einzusetzen wäre eine erfundene Buchung.
 *   - der **Steuer-/BU-Schlüssel**. Der Steuerstatus aus 05B ist eine
 *     fachliche Angabe, kein DATEV-Schlüssel; die Zuordnung ist nirgends
 *     hinterlegt.
 *   - **Berater- und Mandantennummer** sowie der Wirtschaftsjahresbeginn.
 *
 * Solange das so ist, entsteht **keine** Datei, die „DATEV" heisst. Eine
 * falsch aufgebaute Datei unter diesem Namen wäre schlimmer als gar keine: Sie
 * sähe nach Buchhaltung aus und wäre keine.
 */
export function collectDatevBlockers(): ExportBlocker[] {
  return [
    { code: 'datev_no_specification' },
    { code: 'datev_no_counter_account' },
    { code: 'datev_no_tax_key' },
    { code: 'datev_no_client_profile' },
  ];
}

/**
 * Bewertet, was für diesen Monat erzeugt werden darf.
 *
 * `state` ist überschreibbar, damit die Funktion rein prüfbar bleibt; ohne
 * Angabe wird der Monat **frisch** ausgewertet — genau darum geht es.
 */
export function evaluateAccountingExportReadiness(
  monthKey: string,
  state: AccountingPeriodState = getAccountingPeriodState(monthKey),
): AccountingExportReadiness {
  const packageBlockers: ExportBlocker[] = [];

  if (!state.activeClosure) {
    packageBlockers.push({ code: 'not_closed' });
  } else if (!state.isCurrentClosureValid) {
    /*
     * Der Abschluss existiert, passt aber nicht mehr zum heutigen Stand. Der
     * gespeicherte Fingerprint wird dabei **nicht** stillschweigend
     * nachgezogen — der Nutzer soll den Monat bewusst erneut prüfen.
     */
    packageBlockers.push({ code: 'changed_after_close' });
  }

  /*
   * Die fachlichen Blocker werden **neu** erhoben, nicht aus dem Abschluss
   * übernommen. Ein per RPC erzeugter Abschluss hat die Bereitschaft nie
   * durchlaufen (der Server kann sie nicht nachrechnen, siehe 06B); hier
   * fällt das auf.
   */
  if (state.blockers.length > 0) {
    packageBlockers.push({
      code: 'period_blockers',
      detail: String(state.blockers.reduce((sum, item) => sum + item.count, 0)),
    });
  }

  const datevBlockers = collectDatevBlockers();

  return {
    monthKey,
    packageAllowed: packageBlockers.length === 0,
    packageBlockers,
    /*
     * Das DATEV-Format setzt das Paket voraus **und** die fehlenden Daten.
     * Beides wird getrennt gemeldet, damit die Oberfläche sagen kann, woran
     * es liegt.
     */
    datevAllowed: packageBlockers.length === 0 && datevBlockers.length === 0,
    datevBlockers,
    state,
  };
}
