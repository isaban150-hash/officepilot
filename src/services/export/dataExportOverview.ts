/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.24 „Vollständigkeitsprüfung“, „Lückenexport“, „Sichere Inhalte“; D-05, D-06.3) —
 * Lückenliste und Übersichtsseite des lesbaren Exports. Rein: kein Speicher, kein Netz.
 *
 * `uebersicht.html` trägt die Inhaltsrichtlinie `default-src 'none'` (kein Skript, kein Stil, kein externer Abruf);
 * jeder Geschäftstext ist HTML-escaped. Ein Export mit Lücken heißt in Übersicht, `luecken.csv` und Dateiname
 * ausdrücklich „unvollständig“; er ist kein Steuerberater-Paket und setzt keinen Abschluss-, Übergabe- oder
 * Exportstatus.
 */
import { buildCsv, escapeHtml, text, type CsvColumn } from './dataExportFormat';

export type DataExportGapKind =
  | 'sync_open'
  | 'sync_rejected'
  | 'sync_held'
  | 'pull_skipped'
  | 'pull_failed'
  | 'persist_failed'
  | 'file_unavailable'
  | 'finance_unconfirmed'
  | 'emails_unavailable'
  | 'emails_truncated';

export interface DataExportGap {
  kind: DataExportGapKind;
  /** Betroffener Bereich in Klartext (z. B. „Dokumente“). */
  area: string;
  /** Beschreibung für Übersicht und `luecken.csv` (deutsch, wie die Spaltennamen). */
  description: string;
  /** Kennung des Datensatzes bzw. der Datei, falls es eine gibt. */
  reference?: string;
  /** Zahl gleichartiger Fälle (z. B. offene Aufträge). */
  count?: number;
}

export const DATA_EXPORT_GAP_LABEL: Record<DataExportGapKind, string> = {
  sync_open: 'Offene Änderungen',
  sync_rejected: 'Abgewiesene Änderungen',
  sync_held: 'Zurückgehaltene Änderungen',
  pull_skipped: 'Kein frischer Abzug',
  pull_failed: 'Abzug gescheitert',
  persist_failed: 'Letztes Speichern gescheitert',
  file_unavailable: 'Datei nicht verfügbar',
  finance_unconfirmed: 'Finanzzustand nicht bestätigt',
  emails_unavailable: 'E-Mails nicht geladen',
  emails_truncated: 'E-Mails gekürzt',
};

const GAP_COLUMNS: readonly CsvColumn<DataExportGap>[] = [
  { header: 'Bereich', cell: (g) => text(g.area) },
  { header: 'Art', cell: (g) => text(DATA_EXPORT_GAP_LABEL[g.kind]) },
  { header: 'Beschreibung', cell: (g) => text(g.description) },
  { header: 'Kennung', cell: (g) => text(g.reference) },
];

/** `luecken.csv` — immer im Export; ohne Lücken nur die Kopfzeile. */
export function buildGapsCsv(gaps: readonly DataExportGap[]): string {
  return buildCsv(GAP_COLUMNS, gaps);
}

export interface DataExportOverviewInput {
  betrieb: string;
  workspaceId: string | null;
  exportedAt: Date;
  exportedBy: string;
  role: 'owner' | 'admin' | 'local';
  cloud: boolean;
  incomplete: boolean;
  areas: ReadonlyArray<{ label: string; path: string; rows: number }>;
  files: { referenced: number; included: number; missing: number };
  gaps: readonly DataExportGap[];
  /** Name der ZIP-Datei, wie er auch im Download steht. */
  fileName: string;
}

const ROLLE: Record<DataExportOverviewInput['role'], string> = { owner: 'Inhaber', admin: 'Admin', local: 'lokaler Betrieb' };

function zeitpunkt(when: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}:${p(when.getMinutes())}`;
}

export function buildDataExportOverviewHtml(input: DataExportOverviewInput): string {
  const e = escapeHtml;
  const zeilen = input.areas
    .map((area) => `<tr><td>${e(area.label)}</td><td>${e(area.path)}</td><td>${area.rows}</td></tr>`)
    .join('\n');
  const luecken = input.gaps.length
    ? `<ul>\n${input.gaps
        .map((gap) => `<li><strong>${e(DATA_EXPORT_GAP_LABEL[gap.kind])}</strong> (${e(gap.area)}): ${e(gap.description)}${gap.reference ? ` <code>${e(gap.reference)}</code>` : ''}</li>`)
        .join('\n')}\n</ul>`
    : '<p>Keine Lücken: Die Vollständigkeitsprüfung war ohne Befund.</p>';
  const status = input.incomplete
    ? '<p><strong>UNVOLLSTÄNDIGER allgemeiner Datenexport.</strong> Die Lückenliste unten und <code>luecken.csv</code> nennen, was fehlt oder nicht bestätigt ist.</p>'
    : '<p>Vollständiger allgemeiner Datenexport nach der Vollständigkeitsprüfung.</p>';
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<meta name="referrer" content="no-referrer">
<title>Datenexport ${e(input.betrieb)}</title>
</head>
<body>
<h1>Datenexport: ${e(input.betrieb || 'Betrieb')}</h1>
${status}
<dl>
<dt>Betrieb</dt><dd>${e(input.betrieb || 'Betrieb')}${input.workspaceId ? ` (Kennung <code>${e(input.workspaceId)}</code>)` : ''}</dd>
<dt>Zeitpunkt</dt><dd>${e(zeitpunkt(input.exportedAt))}</dd>
<dt>Exportiert von</dt><dd>${e(input.exportedBy || '—')} (${e(ROLLE[input.role])})</dd>
<dt>Betriebsart</dt><dd>${input.cloud ? 'Cloud-Betrieb: Stand nach frischem Abzug vom Server' : 'Lokaler Betrieb ohne Cloud: Daten auf diesem Gerät'}</dd>
<dt>Datei</dt><dd>${e(input.fileName)}</dd>
<dt>Dateien</dt><dd>${input.files.included} von ${input.files.referenced} referenzierten Dateien enthalten${input.files.missing ? `, ${input.files.missing} fehlen (siehe Lückenliste)` : ''}</dd>
</dl>
<h2>Anzahl je Bereich</h2>
<table>
<thead><tr><th>Bereich</th><th>Datei</th><th>Zeilen</th></tr></thead>
<tbody>
${zeilen}
</tbody>
</table>
<h2>Lückenliste</h2>
${luecken}
<h2>Hinweise zum Format</h2>
<ul>
<li>CSV-Dateien: UTF-8 mit BOM, Trennzeichen Semikolon, Zeilenende CRLF, Kopfzeile mit deutschen Spaltennamen, Datum JJJJ-MM-TT, Beträge mit Dezimalkomma ohne Tausendertrenner, Währung in einer eigenen Spalte, Anführungszeichen nach RFC 4180.</li>
<li>Textzellen, die mit =, +, -, @, Tab oder CR beginnen (auch nach Leerzeichen oder in Vollbreitform), beginnen mit einem Hochkomma, damit Tabellenprogramme sie nicht als Formel ausführen.</li>
<li>Die Spalte Cloud-Status kennzeichnet Datensätze, die nicht in der Cloud bestätigt sind. Solche Daten gehören nicht zum regulären Steuerberater-Paket.</li>
<li>Dieser Export ist kein Steuerberater-Paket und keine Sicherung zum Wiederherstellen. Er setzt keinen Abschluss-, Übergabe- oder Exportstatus.</li>
<li>Rechnungen: Ausgangsrechnungen haben kein gespeichertes PDF; ihre Daten stehen in rechnungen.csv und rechnungspositionen.csv. PDFs werden nicht neu erzeugt. Gespeicherte erzeugte PDFs (Angebote, Briefe, Quittungen) liegen unter pdf/.</li>
<li>Originaldateien liegen unter dateien/ mit bereinigten Namen; der Originalname steht in dokumente.csv.</li>
</ul>
</body>
</html>
`;
}
