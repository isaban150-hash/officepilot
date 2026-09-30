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
  AccountingPeriodClosure,
  AccountingPeriodFingerprintVersion,
  AccountingPeriodManifest,
  AccountingPeriodManifestEntry,
  AccountingPeriodManifestPayment,
} from '../../types/accountingPeriod';
import type { AccountingAssignment } from '../../types/accounting';
import { belegExportKey } from '../steuerberater/monatsmappeModelService';
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
  /**
   * 02B — Version 1 bildet exakt die alte Semantik nach (ein Eintrag je
   * Quelle, Stornozustand unabhängig vom Stornomonat, keine Zahlungen), damit
   * alte Abschlüsse nach ihrer eigenen Logik geprüft werden.
   */
  version: AccountingPeriodFingerprintVersion = 2,
): AccountingPeriodManifest {
  const bySource = new Map<string, AccountingAssignment>();
  for (const assignment of assignments) {
    bySource.set(`${assignment.sourceType}:${assignment.sourceId}`, assignment);
  }

  const entries: AccountingPeriodManifestEntry[] = [];
  /*
   * Ein Beleg genau einmal — je Exportidentität. 02B: Original und Storno
   * derselben Rechnung im selben Monat sind zwei Buchungen (+ und −), nicht
   * ein Beleg. Dieselbe Identität verwendet der Buchungsexport. Version 1
   * dedupliziert wie früher je Quelle.
   */
  const gesehen = new Set<string>();

  for (const beleg of [...model.ausgangsrechnungen, ...model.eingangsbelege, ...model.stornos]) {
    const sourceType = sourceTypeOf(beleg);
    const sourceKey = `${sourceType}:${beleg.id}`;
    const key = version === 1 ? sourceKey : belegExportKey(beleg);
    if (gesehen.has(key)) continue;
    gesehen.add(key);

    const assignment = bySource.get(sourceKey);
    /* Version 1 kannte den Stornomonat nicht: storniert ist storniert. */
    const belegStatus = version === 1 && beleg.spaeterStorniertAm ? 'storniert' : beleg.status;
    entries.push({
      sourceType,
      sourceId: beleg.id,
      belegnummer: beleg.belegnummer,
      datum: beleg.datum,
      brutto: round(beleg.brutto),
      netto: round(beleg.netto),
      steuer: round(beleg.steuer),
      belegStatus,
      accountNumber: assignment?.accountNumber.trim() ?? '',
      taxTreatment: assignment?.taxTreatment ?? '',
      bookingText: assignment?.bookingText.trim() ?? '',
      assignmentStatus: assignment?.status ?? 'none',
      ...(version === 1 ? {} : { belegart: beleg.belegart }),
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
      a.sourceId.localeCompare(b.sourceId) ||
      (a.belegart ?? '').localeCompare(b.belegart ?? ''),
  );

  if (version === 1) {
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

  /*
   * P0/P1-INTEGRITAET 01B / P2 — Zahlungen, deren Zahlungsdatum im Monat
   * liegt (dieselbe Auswahl wie die Monatsmappe). Eine neue Zahlung, eine
   * Rücknahme oder eine Teilzahlung im Monat ändert den Stand; eine Zahlung im
   * Folgemonat nicht.
   */
  const payments: AccountingPeriodManifestPayment[] = [
    ...(model.zahlungenAusgang ?? []),
    ...(model.zahlungenEingang ?? []),
  ].map((zahlung) => ({
    sourceType: zahlung.belegart === 'eingangsbeleg' ? ('expense' as const) : ('invoice' as const),
    sourceId: zahlung.belegId,
    paymentId: zahlung.zahlungId,
    datum: zahlung.datum,
    betrag: round(zahlung.betrag),
  }));
  payments.sort(
    (a, b) =>
      a.sourceType.localeCompare(b.sourceType) ||
      a.sourceId.localeCompare(b.sourceId) ||
      a.paymentId.localeCompare(b.paymentId),
  );

  return {
    fingerprintVersion: 2,
    monthKey: model.monthKey,
    chartOfAccounts,
    documentCount: entries.length,
    totalBrutto: round(entries.reduce((sum, entry) => sum + entry.brutto, 0)),
    totalNetto: round(entries.reduce((sum, entry) => sum + entry.netto, 0)),
    totalSteuer: round(entries.reduce((sum, entry) => sum + entry.steuer, 0)),
    entries,
    payments,
  };
}

/** Die Algorithmusversion eines Manifests; ohne Angabe Version 1. */
export function manifestFingerprintVersion(manifest: AccountingPeriodManifest): AccountingPeriodFingerprintVersion {
  return manifest.fingerprintVersion === 2 ? 2 : 1;
}

/** Die Algorithmusversion, mit der ein gespeicherter Abschluss entstand. */
export function closureFingerprintVersion(closure: AccountingPeriodClosure): AccountingPeriodFingerprintVersion {
  return manifestFingerprintVersion(closure.manifest) === 2 || closure.fingerprint.startsWith('p2:') ? 2 : 1;
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

  const version = manifestFingerprintVersion(manifest);
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
      // 02B — ab Version 2 gehört die Belegart zur Identität des Eintrags.
      ...(version === 2 ? [entry.belegart ?? ''] : []),
    ].join('\u0001'),
  );

  if (version === 1) {
    return [head, ...rows].join('\n');
  }

  // Version 2: Kopfzeile und Belegzeilen wie bisher, danach die Zahlungen des Monats.
  const paymentRows = (manifest.payments ?? []).map((payment) =>
    ['payment', payment.sourceType, payment.sourceId, payment.paymentId, payment.datum, payment.betrag.toFixed(2)].join(
      '\u0001',
    ),
  );
  return [`v=2|${head}`, ...rows, ...paymentRows].join('\n');
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
  const prefix = manifestFingerprintVersion(manifest) === 2 ? 'p2' : 'p1';
  return `${prefix}:${(hash >>> 0).toString(16)}:${text.length}`;
}
