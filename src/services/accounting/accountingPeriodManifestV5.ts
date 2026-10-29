/**
 * FINANZ-CORE-01A (systemische Gesamtnacharbeit, SYS-01/SYS-03) — Abschlussmanifest Fassung 5.
 *
 * Fassung 5 ist die erste, die der Server gegen seinen eigenen Finanzbestand nachprüft
 * (`close_workspace_accounting_period`, Folgemigration 20261123). Dafür ist der kanonische Text exakt festgelegt und
 * auf beiden Seiten gleich gebaut — der Server bildet ihn aus seinen Tabellen, der Client aus der Monatsmappe:
 *
 *   v=5|month=<YYYY-MM>|chart=<Kontenrahmen des Betriebs>
 *   E|<sourceType>|<sourceId>|<belegart>|<datum>|<brutto>|<netto>|<steuer>|<skonto>|<status>|<kontenrahmen>|<konto>|
 *     <steuerbehandlung>|<kontierungsstatus>|<buchungstext>   (je Beleg und Storno des Monats; <skonto> = Skonto des
 *     Belegs zum Monatsende wie in buchungen.csv, sonst 0)
 *   P|<sourceType>|<sourceId>|<zahlungId>|<datum>|<betrag>|<skonto>|<zahlungsart>     (je Zahlung des Monats)
 *   M|<zahlungId>|<art>|<datum>|<betrag>|<art der Zahlung>|<zahlungsweg>|<status>     (je Mitarbeiterzahlungszeile)
 *   O|<belegart>|<belegId>|<datum>|<brutto>|<bezahlt>|<offen>|<fällig am>            (kumulierte offene Posten)
 *
 * Beträge in ganzen Cent, `-` für ungeklärt (Netto/Steuer). Text maskiert (`\` → `\\`, `|` → `\p`, Zeilenumbruch →
 * `\n`). Zeilen je Abschnitt nach Bytes sortiert (kein `localeCompare`, der Server sortiert `COLLATE "C"`).
 * Fingerabdruck `p5:<sha256 der UTF-8-Bytes>`.
 *
 * Bewusst NICHT gebunden (R4: reine Anzeige- oder Metadaten): Belegnummer, Gegenpartei, Kontobezeichnung,
 * Leistungszeitraum, Zahlungsreferenz, Nachweisdateien, Mitarbeitername/-nummer, Hinweise, abgeleiteter
 * Zahlungsstatus (überfällig o. ä.). Gebunden sind alle Geld-, Steuer-, Skonto-, Status-, Datums- und
 * Kontierungswerte sowie die kumulierten offenen Posten.
 */
import { canonicalAccountingAssignmentsBySource } from './accountingCanonical';
import { sha256Hex } from './sha256';
import { toCents } from '../invoiceMoney';
import type { MonatsmappeBeleg, MonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import type {
  AccountingPeriodManifest,
  AccountingPeriodManifestEmployeePayment,
  AccountingPeriodManifestEntry,
  AccountingPeriodManifestOpenItem,
  AccountingPeriodManifestPayment,
} from '../../types/accountingPeriod';
import type { AccountingAssignment } from '../../types/accounting';

// Exakt wie der Server (`round(x * 100)`, halb weg von null) — keine Gleitkommarundung.
const round = (value: number): number => toCents(value) / 100;
const roundOrNull = (value: number | null | undefined): number | null =>
  value === null || value === undefined || !Number.isFinite(value) ? null : round(value);
/** Bytegenaue Ordnung wie `COLLATE "C"` (für die verwendeten Zeichen gleich der UTF-16-Ordnung). */
const vergleiche = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sourceTypeOf(beleg: MonatsmappeBeleg): 'invoice' | 'expense' {
  return beleg.belegart === 'ausgangsrechnung' || beleg.belegart === 'rechnungsstorno' ? 'invoice' : 'expense';
}

export function buildPeriodManifestV5(
  model: MonatsmappeModel,
  assignments: readonly AccountingAssignment[],
  chartOfAccounts: string,
): AccountingPeriodManifest {
  const bySource = canonicalAccountingAssignmentsBySource(assignments);
  const entries: AccountingPeriodManifestEntry[] = [];
  const gesehen = new Set<string>();
  for (const beleg of [...model.ausgangsrechnungen, ...model.eingangsbelege, ...model.stornos]) {
    const key = `${beleg.belegart}:${beleg.id}`;
    if (gesehen.has(key)) continue;
    gesehen.add(key);
    const sourceType = sourceTypeOf(beleg);
    const assignment = bySource.get(`${sourceType}:${beleg.id}`);
    entries.push({
      sourceType,
      sourceId: beleg.id,
      belegnummer: beleg.belegnummer,
      datum: beleg.datum,
      brutto: round(beleg.brutto),
      /*
       * P1-KORREKTURBLOCK A-04 — bei offener Steueraufteilung stehen Netto/Steuer in der Monatsmappe leer; der Server
       * kennt nur die gespeicherten Platzhalter. Gebunden wird, was gespeichert ist — so bleibt der Text beidseitig gleich.
       */
      netto: roundOrNull(beleg.fingerprintBetraege ? beleg.fingerprintBetraege.netto : beleg.netto),
      steuer: roundOrNull(beleg.fingerprintBetraege ? beleg.fingerprintBetraege.steuer : beleg.steuer),
      belegStatus: beleg.status,
      accountNumber: assignment?.accountNumber.trim() ?? '',
      taxTreatment: assignment?.taxTreatment ?? '',
      bookingText: assignment?.bookingText.trim() ?? '',
      assignmentStatus: assignment?.status ?? 'none',
      belegart: beleg.belegart,
      kontenrahmen: assignment?.chartOfAccounts ?? '',
      // Das Skonto des Belegs zum Monatsende (buchungen.csv) — gebunden wie jeder andere Geldwert.
      skontoAbzug: round(beleg.skontoAbzug ?? 0),
    });
  }
  entries.sort(
    (a, b) => vergleiche(a.sourceType, b.sourceType) || vergleiche(a.sourceId, b.sourceId) || vergleiche(a.belegart ?? '', b.belegart ?? ''),
  );

  const payments: AccountingPeriodManifestPayment[] = [...(model.zahlungenAusgang ?? []), ...(model.zahlungenEingang ?? [])].map((zahlung) => ({
    sourceType: zahlung.belegart === 'eingangsbeleg' ? ('expense' as const) : ('invoice' as const),
    sourceId: zahlung.belegId,
    paymentId: zahlung.zahlungId,
    datum: zahlung.datum,
    betrag: round(zahlung.betrag),
    skontoAbzug: round(zahlung.skontoAbzug ?? 0),
    zahlungsart: zahlung.zahlungsart ?? '',
  }));
  payments.sort((a, b) => vergleiche(a.sourceType, b.sourceType) || vergleiche(a.sourceId, b.sourceId) || vergleiche(a.paymentId, b.paymentId));

  const employeePayments: AccountingPeriodManifestEmployeePayment[] = (model.mitarbeiterZahlungen ?? []).map((zeile) => ({
    paymentId: zeile.zahlungId,
    art: zeile.art,
    datum: zeile.datum,
    betrag: round(zeile.betrag),
    kind: zeile.kind,
    method: zeile.zahlungsart,
    status: zeile.status,
  }));
  employeePayments.sort((a, b) => vergleiche(a.paymentId, b.paymentId) || vergleiche(a.art, b.art));

  const offenePosten: AccountingPeriodManifestOpenItem[] = (model.offenePostenMonatsende ?? []).map((posten) => ({
    belegart: posten.belegart,
    belegId: posten.belegId,
    datum: posten.datum,
    brutto: round(posten.brutto),
    bezahlt: round(posten.bezahlt),
    offen: round(posten.offen),
    faelligAm: posten.faelligAm ?? '',
  }));
  offenePosten.sort((a, b) => vergleiche(a.belegart, b.belegart) || vergleiche(a.belegId, b.belegId));

  return {
    fingerprintVersion: 5,
    monthKey: model.monthKey,
    chartOfAccounts,
    documentCount: entries.length,
    totalBrutto: round(entries.reduce((sum, entry) => sum + entry.brutto, 0)),
    totalNetto: round(entries.reduce((sum, entry) => sum + (entry.netto ?? 0), 0)),
    totalSteuer: round(entries.reduce((sum, entry) => sum + (entry.steuer ?? 0), 0)),
    entries,
    payments,
    employeePayments,
    offenePosten,
  };
}

/** Maskierung wie auf dem Server (`workspace_fc_kanon_text`). */
export function kanonText(value: string | undefined | null): string {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\p').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function cent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return String(toCents(value));
}

export function buildPeriodCanonicalTextV5(manifest: AccountingPeriodManifest): string {
  const zeilen = [`v=5|month=${kanonText(manifest.monthKey)}|chart=${kanonText(manifest.chartOfAccounts)}`];
  const e = [...manifest.entries].sort(
    (a, b) => vergleiche(a.sourceType, b.sourceType) || vergleiche(a.sourceId, b.sourceId) || vergleiche(a.belegart ?? '', b.belegart ?? ''),
  );
  for (const x of e) {
    zeilen.push(
      ['E', x.sourceType, x.sourceId, x.belegart ?? '', x.datum, cent(x.brutto), cent(x.netto), cent(x.steuer), cent(x.skontoAbzug ?? 0), x.belegStatus, x.kontenrahmen ?? '', x.accountNumber, x.taxTreatment, x.assignmentStatus, x.bookingText]
        .map(kanonText)
        .join('|'),
    );
  }
  const p = [...(manifest.payments ?? [])].sort((a, b) => vergleiche(a.sourceType, b.sourceType) || vergleiche(a.sourceId, b.sourceId) || vergleiche(a.paymentId, b.paymentId));
  for (const x of p) {
    zeilen.push(['P', x.sourceType, x.sourceId, x.paymentId, x.datum, cent(x.betrag), cent(x.skontoAbzug ?? 0), x.zahlungsart ?? ''].map(kanonText).join('|'));
  }
  const m = [...(manifest.employeePayments ?? [])].sort((a, b) => vergleiche(a.paymentId, b.paymentId) || vergleiche(a.art, b.art));
  for (const x of m) {
    zeilen.push(['M', x.paymentId, x.art, x.datum, cent(x.betrag), x.kind, x.method, x.status].map(kanonText).join('|'));
  }
  const o = [...(manifest.offenePosten ?? [])].sort((a, b) => vergleiche(a.belegart, b.belegart) || vergleiche(a.belegId, b.belegId));
  for (const x of o) {
    zeilen.push(['O', x.belegart, x.belegId, x.datum, cent(x.brutto), cent(x.bezahlt), cent(x.offen), x.faelligAm].map(kanonText).join('|'));
  }
  return zeilen.join('\n');
}

export function buildPeriodFingerprintV5(manifest: AccountingPeriodManifest): string {
  return `p5:${sha256Hex(buildPeriodCanonicalTextV5(manifest))}`;
}
