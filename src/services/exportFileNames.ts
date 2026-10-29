/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.23 „Dateinamen“, F13; D-03.3) — die Dateinamen der Sicherung, des lesbaren Exports
 * und des Steuerberater-Pakets an einer Stelle.
 *
 * `<Betrieb>` ist der Firmenname aus Buchstaben, Ziffern und Bindestrich, höchstens 40 Zeichen. Jede andere Folge von
 * Zeichen (Leerzeichen, Punkte, Schrägstriche, Steuerzeichen …) wird zu einem Bindestrich; Bindestriche am Anfang und
 * Ende entfallen. Ohne verwertbaren Namen steht „Betrieb“. Datum und Uhrzeit sind die Ortszeit des Geräts.
 */
const BETRIEB_MAX_ZEICHEN = 40;
const BETRIEB_ERSATZ = 'Betrieb';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function zeitstempel(when: Date): string {
  const datum = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`;
  return `${datum}_${pad2(when.getHours())}-${pad2(when.getMinutes())}`;
}

export function sanitizeBetriebForFileName(name: string | null | undefined): string {
  // NFKC setzt Umlaute und Vollbreitformen zusammen; übrig bleiben nur Buchstaben und Ziffern (keine losen
  // Kombinationszeichen wie der Variantenwähler eines Emojis).
  const verbunden = (name ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  // Nach Zeichen (nicht UTF-16-Einheiten) kürzen, damit kein Zeichen halbiert wird.
  const gekuerzt = Array.from(verbunden).slice(0, BETRIEB_MAX_ZEICHEN).join('').replace(/-+$/g, '');
  return gekuerzt || BETRIEB_ERSATZ;
}

/** `OfficeTakt_Sicherung_<Betrieb>_<JJJJ-MM-TT>_<HH-MM>.zip` */
export function buildBackupFileName(betrieb: string | null | undefined, when: Date): string {
  return `OfficeTakt_Sicherung_${sanitizeBetriebForFileName(betrieb)}_${zeitstempel(when)}.zip`;
}

/** `OfficeTakt_Export_<Betrieb>_<JJJJ-MM-TT>_<HH-MM>.zip`, mit Lückenliste `…_unvollstaendig.zip` (1.24, K5). */
export function buildDataExportFileName(
  betrieb: string | null | undefined,
  when: Date,
  options: { incomplete?: boolean } = {},
): string {
  const zusatz = options.incomplete ? '_unvollstaendig' : '';
  return `OfficeTakt_Export_${sanitizeBetriebForFileName(betrieb)}_${zeitstempel(when)}${zusatz}.zip`;
}

/** `OfficeTakt_Steuerberater_<JJJJ-MM>.zip` — nur der Name; Paket und Sperren bleiben wie in FINANZ-CORE-01A. */
export function buildSteuerberaterFileName(monthKey: string): string {
  return `OfficeTakt_Steuerberater_${monthKey}.zip`;
}

/** Der Anzeigename des Betriebs wie in der Kopfzeile: Firmenprofil, sonst Einrichtung, sonst Betriebsname. */
export function resolveBetriebName(state: {
  companyProfile?: { companyName?: string } | null;
  setup?: { companyName?: string } | null;
  workspace?: { name?: string } | null;
}): string {
  return (
    state.companyProfile?.companyName?.trim() ||
    state.setup?.companyName?.trim() ||
    state.workspace?.name?.trim() ||
    ''
  );
}
