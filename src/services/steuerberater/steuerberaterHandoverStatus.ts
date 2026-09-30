/**
 * STEUERBERATER & BUCHFUEHRUNGSINTELLIGENZ 02B — der Übergabestatus.
 *
 * Bisher gab es zwei Vorstellungen von „bereit“: das Badge der Übersicht
 * (Belege da, nichts fehlt) und das 06C-Gate (Monat gültig abgeschlossen). Sie
 * konnten sich widersprechen — „vollständig“ im Kopf, „nicht möglich“ im
 * Übergabebereich. Dieser Status ist die **eine** fachliche Quelle; die
 * Übersicht und alle Hinweise leiten sich daraus ab.
 *
 * Er ist abgeleitet, nicht gespeichert: Er folgt jeder Änderung sofort.
 *
 * Drei Ebenen:
 *
 *   - **Paket erlaubt** — genau das Gate (abgeschlossen, Abschluss gültig,
 *     keine blockierenden Punkte). Fehlende Nachweise blockieren bewusst nicht.
 *   - **Paket vollständig** — erlaubt **und** keine fehlenden Nachweise, keine
 *     unklaren Fälle. Ein Paket mit Lücken heisst nie „vollständig“.
 *   - **Bankabgleich** — ein späterer Kontrollschritt, den es noch nicht gibt.
 *     Er wird ehrlich als „nicht verfügbar“ geführt, nie als bestätigt.
 */
import type { AccountingExportReadiness } from '../accounting/accountingExportGateService';

export type SteuerberaterHandoverState =
  | 'not_closed'
  | 'changed_after_close'
  | 'unclear_cases'
  | 'missing_proofs'
  | 'ready';

export type SteuerberaterHandoverIssue =
  | 'not_closed'
  | 'changed_after_close'
  | 'period_blockers'
  | 'unclear_cases'
  | 'missing_proofs';

export interface SteuerberaterHandoverStatus {
  readonly monthKey: string;
  /** Der vorrangige offene Punkt — oder `ready`. */
  readonly state: SteuerberaterHandoverState;
  /** Alle offenen Punkte, in fester Reihenfolge. */
  readonly issues: readonly SteuerberaterHandoverIssue[];
  /** Das 06C-Gate: Das Paket darf erstellt werden. */
  readonly packageAllowed: boolean;
  /** Erlaubt und ohne fehlende Nachweise bzw. unklare Fälle. */
  readonly packageComplete: boolean;
  /** Kein Bankabgleich im Produkt — nie „bestätigt“. */
  readonly bankReconciliation: 'not_available';
  readonly closedRevision: number | null;
  readonly counts: {
    readonly periodBlockers: number;
    readonly unclearCases: number;
    readonly missingProofs: number;
  };
}

export interface SteuerberaterHandoverInput {
  readonly readiness: AccountingExportReadiness;
  /** Steuerrelevante, noch nicht gebuchte Eingangsposten und Stornos ohne Datum. */
  readonly unclearCases: number;
  /** Belege ohne Originaldokument und offene Steuerberater-Unterlagen. */
  readonly missingProofs: number;
}

export function deriveSteuerberaterHandoverStatus(input: SteuerberaterHandoverInput): SteuerberaterHandoverStatus {
  const { readiness } = input;
  const codes = new Set(readiness.packageBlockers.map((blocker) => blocker.code));
  const periodBlockers = readiness.state.blockers.reduce((sum, blocker) => sum + blocker.count, 0);

  const issues: SteuerberaterHandoverIssue[] = [];
  if (codes.has('changed_after_close')) issues.push('changed_after_close');
  if (codes.has('not_closed')) issues.push('not_closed');
  if (periodBlockers > 0) issues.push('period_blockers');
  if (input.unclearCases > 0) issues.push('unclear_cases');
  if (input.missingProofs > 0) issues.push('missing_proofs');

  const state: SteuerberaterHandoverState = codes.has('changed_after_close')
    ? 'changed_after_close'
    : !readiness.packageAllowed
      ? 'not_closed'
      : input.unclearCases > 0
        ? 'unclear_cases'
        : input.missingProofs > 0
          ? 'missing_proofs'
          : 'ready';

  const activeClosure = readiness.state.activeClosure;
  return {
    monthKey: readiness.monthKey,
    state,
    issues,
    packageAllowed: readiness.packageAllowed,
    packageComplete: state === 'ready',
    bankReconciliation: 'not_available',
    closedRevision: activeClosure ? activeClosure.revision : null,
    counts: {
      periodBlockers,
      unclearCases: input.unclearCases,
      missingProofs: input.missingProofs,
    },
  };
}

/**
 * Offene Schritte bis zur vollständigen Übergabe — für Zähler wie „3 offen“.
 * Blockierende Punkte zählen einzeln; der Abschluss selbst ist ein Schritt.
 */
export function countHandoverOpenSteps(status: SteuerberaterHandoverStatus): number {
  const closeSteps = status.packageAllowed ? 0 : Math.max(1, status.counts.periodBlockers);
  return closeSteps + status.counts.unclearCases + status.counts.missingProofs;
}
