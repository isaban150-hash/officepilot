/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.24, Festlegungen „CSV-Format“, „Schutz gegen Formel-Injektion“, „Sichere Inhalte“;
 * D-06.2–D-07.3) — reine Formatbausteine des lesbaren Exports, ohne Zugriff auf Bestand oder Netz.
 *
 * CSV: UTF-8 mit BOM, Trenner `;`, Zeilenende CRLF, Kopfzeile mit deutschen Spaltennamen, Datum `JJJJ-MM-TT`, Beträge
 * mit Dezimalkomma ohne Tausendertrenner, Quoting nach RFC 4180. Eine Textzelle, die — auch nach Leerzeichen,
 * geschützten Leerzeichen, Zeilenumbrüchen oder unsichtbaren Formatzeichen — mit `=`, `+`, `-`, `@` (auch in Vollbreit-
 * und Kleinform, auch als typografisches Minuszeichen) oder direkt mit Tab bzw. CR beginnt, erhält ein vorangestelltes
 * `'`. Zahlenspalten bleiben Zahlen und werden nie verändert.
 *
 * Bewusst ohne `\u`-Schreibweisen im Quelltext: Sonderzeichen entstehen aus Codepunkten bzw. Unicode-Eigenschaften.
 */

/** Byte Order Mark (U+FEFF). */
export const CSV_BOM = String.fromCharCode(0xfeff);
export const CSV_DELIMITER = ';';
export const CSV_LINE_END = '\r\n';

export type CsvCell =
  | { kind: 'text'; value: string | null | undefined }
  /** Betrag mit Dezimalkomma (Standard: 2 Nachkommastellen). */
  | { kind: 'amount'; value: number | null | undefined; decimals?: number }
  | { kind: 'integer'; value: number | null | undefined }
  /** Kalendertag `JJJJ-MM-TT`. */
  | { kind: 'date'; value: string | null | undefined }
  /** Zeitpunkt `JJJJ-MM-TT HH:MM` in der Ortszeit des Geräts. */
  | { kind: 'datetime'; value: string | null | undefined }
  | { kind: 'boolean'; value: boolean | null | undefined };

export interface CsvColumn<T> {
  header: string;
  cell: (row: T) => CsvCell;
}

export const text = (value: string | null | undefined): CsvCell => ({ kind: 'text', value });
export const amount = (value: number | null | undefined, decimals = 2): CsvCell => ({ kind: 'amount', value, decimals });
export const integer = (value: number | null | undefined): CsvCell => ({ kind: 'integer', value });
export const date = (value: string | null | undefined): CsvCell => ({ kind: 'date', value });
export const datetime = (value: string | null | undefined): CsvCell => ({ kind: 'datetime', value });
export const yesNo = (value: boolean | null | undefined): CsvCell => ({ kind: 'boolean', value });

/** Typografisches Minuszeichen (U+2212); NFKC macht es nicht zu „-“. */
const MINUSZEICHEN = String.fromCharCode(0x2212);
const FORMELZEICHEN = new Set(['=', '+', '-', '@', MINUSZEICHEN]);

/**
 * Formel-Anfang: direkt Tab oder CR; sonst nach führendem Leerraum (`\s` umfasst auch geschützte und typografische
 * Leerzeichen, Zeilen- und Absatztrenner und das BOM) und unsichtbaren Formatzeichen (`\p{Cf}`, etwa Null-Breiten-
 * Zeichen) ein Formelzeichen. NFKC führt Vollbreit- und Kleinformen (Vollbreit-Gleich, -Plus, -Minus, -At und die
 * kleinen Formen) auf die einfachen Zeichen zurück.
 */
export function startsLikeFormula(value: string): boolean {
  if (/^[\t\r]/.test(value)) return true;
  const ohneLeerraum = value.normalize('NFKC').replace(/^[\s\p{Cf}]+/u, '');
  return FORMELZEICHEN.has(ohneLeerraum.charAt(0));
}

export function protectCsvText(value: string): string {
  return startsLikeFormula(value) ? `'${value}` : value;
}

/** RFC 4180: Felder mit Trenner, Anführungszeichen oder Zeilenumbruch in Anführungszeichen, `"` verdoppelt. */
export function quoteCsvField(value: string): string {
  if (/[;"\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatCsvDate(value: string | null | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return '';
  return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
}

export function formatCsvDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) return '';
  return `${formatCsvDate(value)} ${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`;
}

export function formatCsvAmount(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  // Kein Tausendertrenner; ein auf null gerundeter negativer Wert erscheint als 0 (nicht „-0,00“).
  const gerundet = Number(value.toFixed(decimals));
  return (gerundet === 0 ? 0 : gerundet).toFixed(decimals).replace('.', ',');
}

export function formatCsvCell(cell: CsvCell): string {
  switch (cell.kind) {
    case 'text':
      return quoteCsvField(protectCsvText(cell.value ?? ''));
    case 'amount':
      return formatCsvAmount(cell.value, cell.decimals ?? 2);
    case 'integer':
      return cell.value === null || cell.value === undefined || !Number.isFinite(cell.value) ? '' : String(Math.trunc(cell.value));
    case 'date':
      return formatCsvDate(cell.value);
    case 'datetime':
      return formatCsvDateTime(cell.value);
    case 'boolean':
      return cell.value === null || cell.value === undefined ? '' : cell.value ? 'ja' : 'nein';
  }
}

/** Eine vollständige CSV-Datei: BOM, Kopfzeile, je Datensatz eine Zeile, jede Zeile mit CRLF abgeschlossen. */
export function buildCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  const lines = [columns.map((column) => quoteCsvField(protectCsvText(column.header))).join(CSV_DELIMITER)];
  for (const row of rows) {
    lines.push(columns.map((column) => formatCsvCell(column.cell(row))).join(CSV_DELIMITER));
  }
  return CSV_BOM + lines.join(CSV_LINE_END) + CSV_LINE_END;
}

/** HTML-Escaping für jeden Geschäftstext in `uebersicht.html` (`& < > " '`). */
export function escapeHtml(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Windows-Gerätenamen, auch mit hochgestellter Ziffer (COM¹ …), geprüft am Teil vor dem ersten Punkt. */
const RESERVIERTE_GERAETENAMEN = /^(con|prn|aux|nul|com\p{N}|lpt\p{N}|conin\$|conout\$)$/iu;
const MAX_DATEINAME = 100;
const ERSATZNAME = 'datei';

/**
 * Ein sicherer Dateiname aus einem Originalnamen: nur der letzte Pfadteil, ohne Laufwerk, UNC-Präfix, `..`,
 * Steuerzeichen (`\p{Cc}`, Zeilen- und Absatztrenner) und unter Windows unzulässige Zeichen; kein reservierter
 * Gerätename (auch mit Endung); ohne Punkte oder Leerzeichen am Anfang und Ende; höchstens 100 Zeichen, die Endung
 * bleibt erhalten.
 */
export function sanitizeZipFileName(original: string | null | undefined): string {
  let name = (original ?? '').normalize('NFC');
  // Nur der letzte Pfadteil (beide Trenner), danach ein Laufwerkspräfix wie „C:“.
  name = name.split(/[\\/]/).pop() ?? '';
  name = name.replace(/^[a-zA-Z]:/, '');
  name = name
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '')
    .replace(/[<>:"|?*\\/]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (!name) name = ERSATZNAME;
  const punkt = name.lastIndexOf('.');
  let basis = punkt > 0 ? name.slice(0, punkt) : name;
  const endung = Array.from(punkt > 0 ? name.slice(punkt + 1) : '').slice(0, 10).join('');
  if (RESERVIERTE_GERAETENAMEN.test(basis.split('.')[0] ?? '')) basis = `_${basis}`;
  const platz = MAX_DATEINAME - (endung ? endung.length + 1 : 0);
  basis = Array.from(basis).slice(0, Math.max(1, platz)).join('').replace(/[.\s]+$/, '') || ERSATZNAME;
  return endung ? `${basis}.${endung}` : basis;
}

/** Ein sicherer Ordnername für `dateien/<bereich>/…` (nur Kleinbuchstaben, Ziffern und Bindestrich). */
export function sanitizeZipFolderName(value: string): string {
  const name = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name || 'sonstiges';
}

/**
 * Deterministische Namensvergabe innerhalb eines Ordners: Kollisionen (ohne Rücksicht auf Groß- und Kleinschreibung,
 * wie unter Windows und macOS) werden mit `-2`, `-3` … vor der Endung aufgelöst.
 */
export function createZipNameAllocator(): (folder: string, original: string | null | undefined) => string {
  const vergeben = new Set<string>();
  return (folder, original) => {
    const sicher = sanitizeZipFileName(original);
    const punkt = sicher.lastIndexOf('.');
    const basis = punkt > 0 ? sicher.slice(0, punkt) : sicher;
    const endung = punkt > 0 ? sicher.slice(punkt) : '';
    let kandidat = sicher;
    for (let n = 2; vergeben.has(`${folder}/${kandidat}`.toLowerCase()); n += 1) {
      kandidat = `${basis}-${n}${endung}`;
    }
    vergeben.add(`${folder}/${kandidat}`.toLowerCase());
    return `${folder}/${kandidat}`;
  };
}
