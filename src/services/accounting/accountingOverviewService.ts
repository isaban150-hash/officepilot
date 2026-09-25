/**
 * STEUERBERATER-06A — der Kontierungsstand eines Monats.
 *
 * Welche Belege eines Monats steuerlich relevant sind, entscheidet **nicht**
 * dieses Modul: Das weiss die Monatsmappe längst (`buildMonatsmappeModel`), und
 * sie weiss es einschliesslich der Stornos und ihrer Datumsregeln. Eine zweite
 * Relevanzregel daneben wäre eine zweite Wahrheit — und der Steuerberater
 * bekäme je nach Ansicht eine andere Belegzahl.
 *
 * Hier wird nur zusammengeführt: Beleg aus der Monatsmappe, Kontierung aus dem
 * Kontierungsbestand, daraus die Zähler und die Liste dessen, was noch offen
 * ist.
 *
 * Es wird **nichts festgeschrieben** und nichts exportiert. Diese Zahlen sind
 * die Grundlage für einen späteren Monatsabschluss, nicht der Abschluss selbst.
 */
import { buildMonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import { collectMonatsmappeInput } from '../steuerberater/monatsmappeInputService';
import { getAllAccountingAssignments } from './accountingStore';
import { getChartOfAccounts } from './accountingSettingsService';
import type {
  MonatsmappeBeleg,
  MonatsmappeModel,
} from '../steuerberater/monatsmappeModelService';
import type {
  AccountingAssignment,
  AccountingChecklist,
  AccountingChecklistEntry,
  AccountingSourceType,
} from '../../types/accounting';

/**
 * Welche Belegart zu welchem Quelltyp gehört.
 *
 * Ein Storno ist kein eigener Belegtyp der Kontierung: Er gehört zu derselben
 * Rechnung beziehungsweise Ausgabe und wird über dieselbe Kennung kontiert.
 */
function sourceTypeOf(beleg: MonatsmappeBeleg): AccountingSourceType {
  return beleg.belegart === 'ausgangsrechnung' || beleg.belegart === 'rechnungsstorno'
    ? 'invoice'
    : 'expense';
}

function toEntry(
  beleg: MonatsmappeBeleg,
  assignment: AccountingAssignment | undefined,
): AccountingChecklistEntry {
  return {
    sourceType: sourceTypeOf(beleg),
    sourceId: beleg.id,
    belegnummer: beleg.belegnummer,
    datum: beleg.datum,
    gegenpartei: beleg.gegenpartei,
    brutto: beleg.brutto,
    status: assignment?.status ?? null,
    accountNumber: assignment?.accountNumber ?? '',
    bookingText: assignment?.bookingText ?? '',
    /*
     * Storno und Gutschrift bleiben sichtbar und behalten ihren Betrag — auch
     * den negativen. Der Hinweis sagt, was der Beleg ist, statt ihn aus der
     * Liste zu nehmen oder sein Vorzeichen zu glätten.
     */
    hinweis: beleg.status !== 'aktiv' ? beleg.status : beleg.hinweis,
  };
}

/** Alle steuerlich relevanten Belege eines Monats, Stornos eingeschlossen. */
export function collectRelevantBelege(model: MonatsmappeModel): MonatsmappeBeleg[] {
  return [...model.ausgangsrechnungen, ...model.eingangsbelege, ...model.stornos];
}

/**
 * Der Kontierungsstand eines Monats.
 *
 * `assignments` ist überschreibbar, damit die Funktion rein prüfbar bleibt;
 * ohne Angabe kommt der lokale Bestand.
 */
export function buildAccountingChecklist(
  model: MonatsmappeModel,
  assignments: readonly AccountingAssignment[] = getAllAccountingAssignments(),
  chartOfAccounts = getChartOfAccounts(),
): AccountingChecklist {
  const bySource = new Map<string, AccountingAssignment>();
  for (const assignment of assignments) {
    bySource.set(`${assignment.sourceType}:${assignment.sourceId}`, assignment);
  }

  const entries: AccountingChecklistEntry[] = [];
  /*
   * Ein Beleg zählt genau einmal. Eine stornierte Rechnung steht in der
   * Monatsmappe unter Umständen sowohl als Rechnung als auch als Storno; für
   * den Kontierungsstand ist sie derselbe Beleg mit derselben Kontierung.
   */
  const gesehen = new Set<string>();

  for (const beleg of collectRelevantBelege(model)) {
    const key = `${sourceTypeOf(beleg)}:${beleg.id}`;
    if (gesehen.has(key)) continue;
    gesehen.add(key);
    entries.push(toEntry(beleg, bySource.get(key)));
  }

  entries.sort((a, b) => a.datum.localeCompare(b.datum) || a.belegnummer.localeCompare(b.belegnummer));

  const confirmedEntries = entries.filter((entry) => entry.status === 'confirmed');
  const openEntries = entries.filter((entry) => entry.status !== 'confirmed');

  return {
    monthKey: model.monthKey,
    chartOfAccounts,
    totalRelevantDocuments: entries.length,
    /*
     * 01H — vier getrennte Stände, die zusammen genau `totalRelevantDocuments`
     * ergeben. Bis 01H zählte „zu prüfen" auch die Belege ohne jede Kontierung
     * mit; die Übersicht zeigte dadurch „24 zu prüfen" für 23 nicht kontierte
     * und einen tatsächlich zu prüfenden Beleg. Nicht angefasst und
     * vorgeschlagen-aber-ungeprüft sind verschiedene Arbeitsschritte.
     * Dieselbe Trennung macht der Monatsabschluss (`collectPeriodBlockers`).
     */
    confirmedCount: confirmedEntries.length,
    needsReviewCount: entries.filter((entry) => entry.status === 'needs_review').length,
    needsClarificationCount: entries.filter((entry) => entry.status === 'needs_clarification').length,
    unassignedCount: entries.filter((entry) => entry.status === null).length,
    openEntries,
    confirmedEntries,
  };
}

/** Bequemer Zugriff über den Monatsschlüssel (`YYYY-MM`). */
export function getAccountingChecklist(monthKey: string): AccountingChecklist {
  const model = buildMonatsmappeModel(collectMonatsmappeInput(monthKey));
  return buildAccountingChecklist(model);
}
