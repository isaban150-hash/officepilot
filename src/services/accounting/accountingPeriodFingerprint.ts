/**
 * STEUERBERATER-06B — Manifest und Fingerprint eines Monats.
 *
 * Der Fingerprint beantwortet genau eine Frage: **Ist das noch derselbe Stand,
 * den jemand abgeschlossen hat?** Er ist ausdrücklich kein Sicherheitsmerkmal
 * und soll keines sein — er erkennt Veränderung, er verhindert sie nicht.
 * Dieselbe Rolle und dieselbe Technik wie
 * `buildDocumentWorkResultSourceFingerprint`: eine stabile, nicht
 * kryptografische Prüfsumme über eine kanonische Darstellung.
 *
 * Was hineingehört, entscheidet eine einzige Frage: Würde ein Steuerberater
 * das anders buchen? Betrag, Steuer, Stornozustand, Konto, Steuerbehandlung,
 * Buchungstext und Kontierungsstand — ja. Sortierung, Ansichtseinstellungen,
 * Zeitstempel des letzten Klicks — nein. Deshalb wird kanonisch sortiert und
 * nicht die Reihenfolge übernommen, in der die Daten zufällig ankommen.
 */
import type {
  AccountingPeriodManifest,
  AccountingPeriodManifestEntry,
} from '../../types/accountingPeriod';
import type { AccountingAssignment } from '../../types/accounting';
import type { MonatsmappeBeleg, MonatsmappeModel } from '../steuerberater/monatsmappeModelService';

/** Dieselbe Zuordnung wie in der Monatsprüfliste — eine Regel, nicht zwei. */
function sourceTypeOf(beleg: MonatsmappeBeleg): 'expense' | 'invoice' {
  return beleg.belegart === 'ausgangsrechnung' || beleg.belegart === 'rechnungsstorno'
    ? 'invoice'
    : 'expense';
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Das Manifest des **aktuellen** Datenstands.
 *
 * Die Belegmenge kommt unverändert aus dem `MonatsmappeModel` — derselben
 * Quelle, die Monatsmappe und Kontierungsübersicht benutzen. Eine zweite
 * Monatsdefinition gäbe je nach Ansicht eine andere Belegzahl.
 */
export function buildPeriodManifest(
  model: MonatsmappeModel,
  assignments: readonly AccountingAssignment[],
  chartOfAccounts: string,
): AccountingPeriodManifest {
  const bySource = new Map<string, AccountingAssignment>();
  for (const assignment of assignments) {
    bySource.set(`${assignment.sourceType}:${assignment.sourceId}`, assignment);
  }

  const entries: AccountingPeriodManifestEntry[] = [];
  /*
   * Ein Beleg genau einmal. Eine stornierte Rechnung steht in der Monatsmappe
   * unter Umständen als Rechnung **und** als Storno; für den Abschluss ist sie
   * derselbe Beleg.
   */
  const gesehen = new Set<string>();

  for (const beleg of [...model.ausgangsrechnungen, ...model.eingangsbelege, ...model.stornos]) {
    const sourceType = sourceTypeOf(beleg);
    const key = `${sourceType}:${beleg.id}`;
    if (gesehen.has(key)) continue;
    gesehen.add(key);

    const assignment = bySource.get(key);
    entries.push({
      sourceType,
      sourceId: beleg.id,
      belegnummer: beleg.belegnummer,
      datum: beleg.datum,
      brutto: round(beleg.brutto),
      netto: round(beleg.netto),
      steuer: round(beleg.steuer),
      belegStatus: beleg.status,
      accountNumber: assignment?.accountNumber.trim() ?? '',
      taxTreatment: assignment?.taxTreatment ?? '',
      bookingText: assignment?.bookingText.trim() ?? '',
      assignmentStatus: assignment?.status ?? 'none',
    });
  }

  /*
   * Kanonische Sortierung. Ohne sie würde eine blosse Umsortierung der
   * Quelldaten einen neuen Fingerprint erzeugen — ein falscher Alarm, der das
   * Vertrauen in echte Alarme kostet.
   */
  entries.sort(
    (a, b) =>
      a.sourceType.localeCompare(b.sourceType) ||
      a.sourceId.localeCompare(b.sourceId),
  );

  return {
    monthKey: model.monthKey,
    chartOfAccounts,
    documentCount: entries.length,
    totalBrutto: round(entries.reduce((sum, entry) => sum + entry.brutto, 0)),
    totalNetto: round(entries.reduce((sum, entry) => sum + entry.netto, 0)),
    totalSteuer: round(entries.reduce((sum, entry) => sum + entry.steuer, 0)),
    entries,
  };
}

/**
 * Die kanonische Zeichenfolge, aus der der Fingerprint entsteht.
 *
 * Als eigene Funktion, weil sie beim Nachvollziehen eines Unterschieds hilft:
 * Wer wissen will, *warum* zwei Stände auseinanderlaufen, vergleicht diese
 * Texte, nicht zwei Hexzahlen.
 */
export function buildPeriodCanonicalText(manifest: AccountingPeriodManifest): string {
  const head = [
    `month=${manifest.monthKey}`,
    `chart=${manifest.chartOfAccounts}`,
    `count=${manifest.documentCount}`,
    `brutto=${manifest.totalBrutto.toFixed(2)}`,
    `netto=${manifest.totalNetto.toFixed(2)}`,
    `steuer=${manifest.totalSteuer.toFixed(2)}`,
  ].join('|');

  const rows = manifest.entries.map((entry) =>
    [
      entry.sourceType,
      entry.sourceId,
      entry.belegnummer,
      entry.datum,
      entry.brutto.toFixed(2),
      entry.netto.toFixed(2),
      entry.steuer.toFixed(2),
      entry.belegStatus,
      entry.accountNumber,
      entry.taxTreatment,
      entry.bookingText,
      entry.assignmentStatus,
    ].join('\u0001'),
  );

  return [head, ...rows].join('\n');
}

/**
 * Eine stabile, **nicht kryptografische** Prüfsumme (FNV-1a).
 *
 * Für Veränderungserkennung genügt das und ist synchron verfügbar; dieselbe
 * Wahl und dieselbe Begründung wie bei
 * `buildDocumentWorkResultSourceFingerprint`. Wer eine fälschungssichere
 * Signatur bräuchte, bräuchte auch ein Schlüsselmanagement — und hätte immer
 * noch keinen Schutz gegen eine Änderung am Beleg selbst.
 *
 * Die Länge wird mitgeführt: Sie macht die ohnehin geringe Kollisionsgefahr
 * zweier fachlich verschiedener Stände noch unwahrscheinlicher.
 */
export function buildPeriodFingerprint(manifest: AccountingPeriodManifest): string {
  const text = buildPeriodCanonicalText(manifest);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `p1:${(hash >>> 0).toString(16)}:${text.length}`;
}
