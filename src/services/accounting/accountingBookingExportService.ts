/**
 * STEUERBERATER-06C — die Buchungsdaten für die Übergabe.
 *
 * **Bewusst nicht „DATEV" genannt.** Das hier ist eine neutrale, lesbare
 * Aufstellung: ein Beleg je Zeile, mit Beträgen, Steuerstatus und der
 * bestätigten Kontierung. Sie nennt kein Gegenkonto und kein Soll/Haben, weil
 * OfficeTakt beides heute nicht kennt — und erhebt deshalb auch nicht den
 * Anspruch, ein Buchungsstapel zu sein.
 *
 * Ein Steuerberater kann damit arbeiten: Er bekommt Belege, Beträge,
 * Steuerstatus, Sachkonto und Buchungstext, und die Originaldokumente liegen
 * daneben. Was er selbst entscheiden muss — Gegenkonto, Buchungsrichtung,
 * BU-Schlüssel — behauptet OfficeTakt nicht.
 *
 * Gerechnet wird in **Cent** über die vorhandenen Money-Helfer. Vorzeichen
 * bleiben, wie sie sind: Eine Gutschrift steht negativ da, ein Storno bleibt
 * ein Storno.
 */
import { fromCents, sumCents, toCents } from '../invoiceMoney';
import {
  belegBuchungsId,
  belegExportKey,
  safeFileNamePart,
  ZAHLUNGSSTATUS_LABEL,
} from '../steuerberater/monatsmappeModelService';
import type { MonatsmappeBeleg, MonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import type { AccountingAssignment } from '../../types/accounting';

/* -------------------------------------------------------------------------- */

/** Lesbare Bezeichnungen — im Export steht kein Enum-Wert. */
const BELEGART_LABEL: Record<string, string> = {
  ausgangsrechnung: 'Ausgangsrechnung',
  eingangsbeleg: 'Eingangsbeleg',
  rechnungsstorno: 'Storno Ausgangsrechnung',
  ausgabenstorno: 'Storno Eingangsbeleg',
};

const STATUS_LABEL: Record<string, string> = {
  aktiv: 'Aktiv',
  storniert: 'Storniert',
  storno: 'Stornobeleg',
};

const TAX_LABEL: Record<string, string> = {
  standard_19: 'Umsatzsteuer 19 %',
  standard_7: 'Umsatzsteuer 7 %',
  kleinunternehmer_19: 'Kleinunternehmer (§ 19 UStG)',
  reverse_charge_13b: 'Reverse Charge (§ 13b UStG)',
  tax_free: 'Steuerfrei',
  unclear: 'Unklar',
};

const ASSIGNMENT_LABEL: Record<string, string> = {
  confirmed: 'Bestätigt',
  needs_review: 'Zu prüfen',
  needs_clarification: 'Klärung nötig',
};

export interface BookingExportRow {
  /** 02B — deterministische, lesbare Buchungs-ID (`<id>` bzw. `<id>-Storno`). */
  readonly exportId: string;
  readonly belegart: string;
  readonly sourceType: 'expense' | 'invoice';
  readonly sourceId: string;
  readonly belegnummer: string;
  readonly belegdatum: string;
  readonly gegenpartei: string;
  readonly netto: number;
  readonly steuer: number;
  readonly brutto: number;
  readonly steuerstatus: string;
  readonly kontenrahmen: string;
  readonly sachkonto: string;
  readonly kontobezeichnung: string;
  readonly buchungstext: string;
  readonly kontierungsstatus: string;
  readonly belegstatus: string;
  /** „ja" bei Storno oder Gutschrift — im Export nicht versteckt. */
  readonly stornoOderGutschrift: string;
  /**
   * 02B — Zahlungsstatus und offener Betrag zum Monatsende (Originalbelege).
   * Eine Zahlung im Folgemonat ändert beides nicht. Leer bei Stornozeilen.
   */
  readonly zahlungsstatusMonatsende: string;
  readonly offenMonatsende: number | '';
}

export interface BookingExportTotals {
  readonly belegCount: number;
  readonly netto: number;
  readonly steuer: number;
  readonly brutto: number;
}

export interface BookingExport {
  readonly monthKey: string;
  readonly chartOfAccounts: string;
  readonly rows: readonly BookingExportRow[];
  readonly totals: BookingExportTotals;
  /** Belege ohne Originaldokument — gemeldet, nicht verschwiegen. */
  readonly withoutDocument: readonly { sourceId: string; belegnummer: string }[];
}

function sourceTypeOf(beleg: MonatsmappeBeleg): 'expense' | 'invoice' {
  return beleg.belegart === 'ausgangsrechnung' || beleg.belegart === 'rechnungsstorno'
    ? 'invoice'
    : 'expense';
}

/**
 * Baut die Buchungszeilen eines Monats.
 *
 * **Nur bestätigte Kontierungen.** Ein ungeprüfter Vorschlag gehört nicht in
 * eine Übergabe; das Export-Gate lässt einen solchen Monat ohnehin nicht
 * durch, aber diese Funktion verlässt sich nicht darauf.
 */
export function buildBookingExport(
  model: MonatsmappeModel,
  assignments: readonly AccountingAssignment[],
  chartOfAccounts: string,
): BookingExport {
  const bySource = new Map<string, AccountingAssignment>();
  for (const assignment of assignments) {
    bySource.set(`${assignment.sourceType}:${assignment.sourceId}`, assignment);
  }

  const rows: BookingExportRow[] = [];
  const withoutDocument: { sourceId: string; belegnummer: string }[] = [];
  const gesehen = new Set<string>();

  for (const beleg of [...model.ausgangsrechnungen, ...model.eingangsbelege, ...model.stornos]) {
    const sourceType = sourceTypeOf(beleg);
    /*
     * 02B — je Exportidentität genau einmal. Original (+) und Storno (−)
     * derselben Rechnung im selben Monat sind zwei Buchungen; vorher fiel die
     * Stornozeile hier weg und die Kontrollsummen waren zu hoch. Die
     * Kontierung gehört zur Quelle und gilt für beide Zeilen.
     */
    const exportKey = belegExportKey(beleg);
    if (gesehen.has(exportKey)) continue;
    gesehen.add(exportKey);

    const assignment = bySource.get(`${sourceType}:${beleg.id}`);
    if (!assignment || assignment.status !== 'confirmed') continue;

    /*
     * `missing` heisst: Der Beleg sollte ein Dokument haben, es ist aber keins
     * da. `none` heisst: Er hat fachlich keins (interner Storno) — das ist
     * kein Mangel und wird nicht gemeldet.
     */
    if (beleg.documentStatus === 'missing') {
      withoutDocument.push({ sourceId: beleg.id, belegnummer: beleg.belegnummer });
    }

    rows.push({
      exportId: belegBuchungsId(beleg),
      belegart: BELEGART_LABEL[beleg.belegart] ?? beleg.belegart,
      sourceType,
      sourceId: beleg.id,
      belegnummer: beleg.belegnummer,
      belegdatum: beleg.datum,
      gegenpartei: beleg.gegenpartei,
      /* Vorzeichen bleiben — eine Gutschrift steht negativ da. */
      netto: beleg.netto,
      steuer: beleg.steuer,
      brutto: beleg.brutto,
      steuerstatus: TAX_LABEL[assignment.taxTreatment] ?? assignment.taxTreatment,
      kontenrahmen: assignment.chartOfAccounts,
      sachkonto: assignment.accountNumber.trim(),
      kontobezeichnung: assignment.accountLabel.trim(),
      buchungstext: assignment.bookingText.trim(),
      kontierungsstatus: ASSIGNMENT_LABEL[assignment.status] ?? assignment.status,
      belegstatus: STATUS_LABEL[beleg.status] ?? beleg.status,
      stornoOderGutschrift: beleg.status !== 'aktiv' || beleg.brutto < 0 ? 'ja' : 'nein',
      zahlungsstatusMonatsende:
        beleg.status === 'storno' ? '' : (ZAHLUNGSSTATUS_LABEL[beleg.zahlungsstatus] ?? beleg.zahlungsstatus),
      offenMonatsende: beleg.status === 'storno' || beleg.offenerBetrag === undefined ? '' : beleg.offenerBetrag,
    });
  }

  /*
   * Kanonische Reihenfolge: Datum, dann Belegnummer, dann stabile Kennung.
   * Ohne sie käme die Reihenfolge aus der Aufzählungsfolge der Speicher — und
   * zwei Exporte desselben Stands wären nicht mehr vergleichbar.
   */
  rows.sort(
    (a, b) =>
      a.belegdatum.localeCompare(b.belegdatum) ||
      a.belegnummer.localeCompare(b.belegnummer) ||
      a.sourceId.localeCompare(b.sourceId) ||
      a.exportId.localeCompare(b.exportId),
  );

  /* Kontrollsummen in Cent — kein Gleitkomma-Aufaddieren. */
  const nettoCents = sumCents(rows.map((row) => toCents(row.netto)));
  const steuerCents = sumCents(rows.map((row) => toCents(row.steuer)));
  const bruttoCents = sumCents(rows.map((row) => toCents(row.brutto)));

  return {
    monthKey: model.monthKey,
    chartOfAccounts,
    rows,
    totals: {
      belegCount: rows.length,
      netto: fromCents(nettoCents),
      steuer: fromCents(steuerCents),
      brutto: fromCents(bruttoCents),
    },
    withoutDocument,
  };
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                        */
/* -------------------------------------------------------------------------- */

function csvCell(value: string | number): string {
  const text = typeof value === 'number' ? value.toFixed(2).replace('.', ',') : value;
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(cells: Array<string | number>): string {
  return cells.map(csvCell).join(';');
}

/**
 * Die Buchungsdaten als CSV.
 *
 * Konventionen wie bei der bestehenden Monatsmappe: BOM, Semikolon, CRLF —
 * damit Excel sie in Deutschland ohne Nachfrage richtig öffnet. Beträge mit
 * Dezimalkomma, weil sie in derselben Umgebung gelesen werden.
 */
export function buildBookingCsv(bookings: BookingExport): string {
  const lines = [
    csvLine([
      'Belegart',
      'Beleg-ID',
      'Belegnummer',
      'Belegdatum',
      'Gegenpartei',
      'Netto',
      'Steuer',
      'Brutto',
      'Steuerstatus',
      'Kontenrahmen',
      'Sachkonto',
      'Kontobezeichnung',
      'Buchungstext',
      'Kontierung',
      'Belegstatus',
      'Storno/Gutschrift',
      'Buchungs-ID',
      'Zahlungsstatus zum Monatsende',
      'Offen zum Monatsende',
    ]),
  ];

  for (const row of bookings.rows) {
    lines.push(
      csvLine([
        row.belegart,
        row.sourceId,
        row.belegnummer,
        row.belegdatum,
        row.gegenpartei,
        row.netto,
        row.steuer,
        row.brutto,
        row.steuerstatus,
        row.kontenrahmen,
        row.sachkonto,
        row.kontobezeichnung,
        row.buchungstext,
        row.kontierungsstatus,
        row.belegstatus,
        row.stornoOderGutschrift,
        row.exportId,
        row.zahlungsstatusMonatsende,
        row.offenMonatsende,
      ]),
    );
  }

  /* Die Kontrollsummen stehen in der Datei selbst — nachrechenbar ohne Manifest. */
  lines.push(
    csvLine([
      'Summe',
      '',
      '',
      '',
      `${bookings.totals.belegCount} Belege`,
      bookings.totals.netto,
      bookings.totals.steuer,
      bookings.totals.brutto,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]),
  );

  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Ein stabiler, dateisystemsicherer Name für das Paket. */
export function buildExportPackageFilename(monthKey: string, revision: number): string {
  return `Steuerberater_${safeFileNamePart(monthKey)}_Revision-${revision}.zip`;
}
