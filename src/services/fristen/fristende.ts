/**
 * FINANZ-CORE-01A (Feiertage, § 193 BGB) — das wirksame Ende einer Zahlungs- oder Skontofrist.
 *
 * Entscheidung des Auftraggebers (15.10.2026, nach WEISS-FAIL FC01A-END16-R1):
 *  - Fällt das kalendarische Fristende auf Samstag, Sonntag oder einen gesetzlichen Feiertag am
 *    maßgeblichen Ort, tritt der nächste Werktag an seine Stelle (§ 193 BGB, über § 186 auch für
 *    Rechtsgeschäfte). Maßgeblich ist der Leistungsort der Zahlung, der Sitz des Kunden (§§ 269,
 *    270 Abs. 4 BGB).
 *  - Ort: ausdrückliche Angabe am Kunden (`Customer.holidayLocation`), sonst das Land der
 *    Rechnungsanschrift und die Länder des PLZ-Leitbereichs (Obermenge), sonst unbekannt.
 *  - Ist der Ort nicht eindeutig (Grenz-PLZ, Gemeindefeiertag, unbekannt), entscheidet die App nicht:
 *    Das Fenster `fruehestens … spaetestens` umfasst jedes mögliche Fristende. Eine Zahlung darin ist
 *    „ungeklärt“ — kein verbindliches „verspätet“, keine Überfälligkeit, keine Schlussrechnung, bis
 *    der Ort am Kunden angegeben ist.
 *  - Ausland: Feiertage am ausländischen Sitz kennt die App nicht. Samstag/Sonntag verschieben; danach
 *    bleibt das Ende offen (Gesamtnacharbeit INV-02: keine Höchstdauer), bis entweder am Kunden bestätigt
 *    ist, dass dort keine Feiertage verschieben, oder das wirksame Ende genau dieser Frist an der Rechnung
 *    geprüft festgehalten ist (`geprueft`).
 *  - Eine ausdrücklich abweichende Vereinbarung (`VorgangInvoice.deadlineShiftWaived`) geht vor: Dann
 *    endet die Frist kalendarisch.
 *
 * Gesamtnacharbeit (INV-01/03): Die Lage wird bei der Freigabe gebunden (`VorgangInvoice.fristBasis`,
 * Server `workspace_invoices.frist_basis`) und danach nur über die protokollierte Klärung an der Rechnung
 * geändert — auch für eine Rechnung ohne Kundenverknüpfung. Spätere Kundenänderungen wirken nur auf neue
 * Rechnungen.
 *
 * Der Server rechnet dasselbe (Migrationen 20261118120000/20261119120000, `workspace_invoice_frist_lage`,
 * `workspace_fristfenster`); beide Seiten prüfen dieselben Vektoren.
 */
import type { CustomerHolidayLocation, InvoiceFristBasis, VorgangInvoice } from '../../types/models';
import { getCustomerById } from '../customerStoreService';
import { BUNDESLAENDER, addDays, feiertagImLand, isBundesland, isWeekend, type Bundesland } from './feiertage';
import { PLZ_LEITBEREICHE } from './plzLeitbereiche';

export interface GemeindeAngaben {
  fronleichnam?: boolean;
  mariaeHimmelfahrt?: boolean;
  augsburgerFriedensfest?: boolean;
}

export type FristLage =
  | { art: 'abbedungen' }
  | {
      art: 'inland';
      laender: readonly Bundesland[];
      gemeinde: GemeindeAngaben;
      quelle: 'kunde' | 'plz' | 'unbekannt' | 'klaerung';
    }
  | {
      art: 'ausland';
      ohneFeiertagBestaetigt: boolean;
      quelle: 'kunde' | 'land' | 'plz' | 'klaerung';
      /** INV-02 — geprüftes wirksames Ende je kalendarischem Fristende (ISO → ISO). */
      geprueft?: Readonly<Record<string, string>>;
    };

/**
 * Jedes mögliche Fristende liegt in `[fruehestens, spaetestens]` (ISO-Daten). `spaetestens: null` heißt
 * offen (INV-02): Ausland ohne Bestätigung und ohne geprüftes Ende — jede Zahlung danach ist ungeklärt.
 */
export interface FristFenster {
  fruehestens: string;
  spaetestens: string | null;
}

export type Fristpruefung = 'fristgerecht' | 'verspaetet' | 'ungeklaert';

/** Deutsche PLZ mit Leistungsort in Österreich: Jungholz (87491) und das Kleinwalsertal (87567–87569). */
const PLZ_IN_OESTERREICH = new Set(['87491', '87567', '87568', '87569']);

function decodeEintrag(eintrag: string): { laender: Bundesland[]; augsburg: string } {
  const [laender, augsburg] = eintrag.split(':');
  return { laender: laender.split('+').filter(isBundesland), augsburg: augsburg ?? 'teils' };
}

/** Länder und Augsburg-Lage eines PLZ-Leitbereichs; unbekannter Bereich → Obermenge der Leitregion. */
export function laenderFuerPlz(zip: string): { laender: Bundesland[]; augsburg: 'ja' | 'nein' | 'teils' } | null {
  if (!/^\d{5}$/.test(zip)) return null;
  const direkt = PLZ_LEITBEREICHE[zip.slice(0, 3)];
  if (direkt) {
    const { laender, augsburg } = decodeEintrag(direkt);
    return { laender, augsburg: augsburg === 'ja' || augsburg === 'nein' ? augsburg : 'teils' };
  }
  const region = zip.slice(0, 2);
  const laender = new Set<Bundesland>();
  let augsburgMoeglich = false;
  for (const [bereich, eintrag] of Object.entries(PLZ_LEITBEREICHE)) {
    if (!bereich.startsWith(region)) continue;
    const decoded = decodeEintrag(eintrag);
    decoded.laender.forEach((land) => laender.add(land));
    if (decoded.augsburg !== 'nein') augsburgMoeglich = true;
  }
  if (laender.size === 0) return null;
  return { laender: BUNDESLAENDER.filter((land) => laender.has(land)), augsburg: augsburgMoeglich ? 'teils' : 'nein' };
}

/**
 * Die Angabe am Kunden in kanonischer Form: nur die Schlüssel, die für ihr Land etwas bedeuten
 * (Fronleichnam nur Sachsen/Thüringen, Mariä Himmelfahrt und Friedensfest nur Bayern, die Bestätigung
 * nur im Ausland). Unbrauchbar → `undefined`. Dieselbe Form speichert die Cloud.
 */
export function normalizeHolidayLocation(value: unknown): CustomerHolidayLocation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (v.region === 'AUSLAND') {
    return v.auslandOhneFeiertag === true ? { region: 'AUSLAND', auslandOhneFeiertag: true } : { region: 'AUSLAND' };
  }
  if (!isBundesland(v.region)) return undefined;
  const out: CustomerHolidayLocation = { region: v.region };
  if ((v.region === 'SN' || v.region === 'TH') && typeof v.fronleichnam === 'boolean') out.fronleichnam = v.fronleichnam;
  if (v.region === 'BY') {
    if (typeof v.mariaeHimmelfahrt === 'boolean') out.mariaeHimmelfahrt = v.mariaeHimmelfahrt;
    if (typeof v.augsburgerFriedensfest === 'boolean') out.augsburgerFriedensfest = v.augsburgerFriedensfest;
  }
  return out;
}

function lageAusKunde(rohwert: CustomerHolidayLocation | undefined): FristLage | null {
  const angabe = normalizeHolidayLocation(rohwert);
  if (!angabe) return null;
  if (angabe.region === 'AUSLAND') {
    return { art: 'ausland', ohneFeiertagBestaetigt: angabe.auslandOhneFeiertag === true, quelle: 'kunde' };
  }
  if (!isBundesland(angabe.region)) return null;
  const gemeinde: GemeindeAngaben = {};
  for (const key of ['fronleichnam', 'mariaeHimmelfahrt', 'augsburgerFriedensfest'] as const) {
    if (typeof angabe[key] === 'boolean') gemeinde[key] = angabe[key];
  }
  return { art: 'inland', laender: [angabe.region], gemeinde, quelle: 'kunde' };
}

export interface FristLageEingabe {
  deadlineShiftWaived?: boolean;
  customerSnapshot?: { zip?: string; countryCode?: string } | null;
  kunde?: { holidayLocation?: CustomerHolidayLocation; sync?: { deleted?: boolean } } | null;
}

/** Reihenfolge: Vereinbarung → Angabe am Kunden → Land/PLZ der Rechnungsanschrift → unbekannt. */
export function ermittleFristLage(eingabe: FristLageEingabe): FristLage {
  if (eingabe.deadlineShiftWaived === true) return { art: 'abbedungen' };
  const kunde = eingabe.kunde && !eingabe.kunde.sync?.deleted ? lageAusKunde(eingabe.kunde.holidayLocation) : null;
  if (kunde) return kunde;
  const land = (eingabe.customerSnapshot?.countryCode ?? '').trim().toUpperCase();
  if (land && land !== 'DE') return { art: 'ausland', ohneFeiertagBestaetigt: false, quelle: 'land' };
  const zip = (eingabe.customerSnapshot?.zip ?? '').trim();
  if (PLZ_IN_OESTERREICH.has(zip)) return { art: 'ausland', ohneFeiertagBestaetigt: false, quelle: 'plz' };
  const ausPlz = laenderFuerPlz(zip);
  if (ausPlz) {
    const gemeinde: GemeindeAngaben = {};
    if (ausPlz.augsburg === 'ja') gemeinde.augsburgerFriedensfest = true;
    if (ausPlz.augsburg === 'nein') gemeinde.augsburgerFriedensfest = false;
    return { art: 'inland', laender: ausPlz.laender, gemeinde, quelle: 'plz' };
  }
  return { art: 'inland', laender: BUNDESLAENDER, gemeinde: {}, quelle: 'unbekannt' };
}

type TagStatus = 'frei' | 'werktag' | 'unklar';

function tagStatusInland(day: string, lage: Extract<FristLage, { art: 'inland' }>): TagStatus {
  if (isWeekend(day)) return 'frei';
  let ja = 0;
  let nein = 0;
  for (const land of lage.laender) {
    const feiertag = feiertagImLand(day, land);
    if (feiertag.art === 'kein') nein += 1;
    else if (feiertag.art === 'feiertag') ja += 1;
    else {
      const angabe = lage.gemeinde[feiertag.gemeinde];
      if (angabe === true) ja += 1;
      else if (angabe === false) nein += 1;
      else return 'unklar';
    }
    if (ja > 0 && nein > 0) return 'unklar';
  }
  return ja > 0 ? 'frei' : 'werktag';
}

/** Mehr als 40 freie Tage in Folge gibt es nicht; die Grenze schützt nur vor einer Endlosschleife. */
const HOECHSTENS = 40;

export function berechneFristFenster(kalenderEnde: string, lage: FristLage): FristFenster {
  const ende = kalenderEnde.slice(0, 10);
  if (lage.art === 'abbedungen') return { fruehestens: ende, spaetestens: ende };
  if (lage.art === 'ausland') {
    let fruehestens = ende;
    for (let i = 0; i < HOECHSTENS && isWeekend(fruehestens); i += 1) fruehestens = addDays(fruehestens, 1);
    // INV-02 — das geprüfte Ende genau dieses Fristendes; ein Tag vor dem Sa/So-Ende zählt nicht.
    const geprueft = lage.geprueft?.[ende];
    if (geprueft && ISO_DATUM.test(geprueft) && geprueft >= fruehestens) {
      return { fruehestens: geprueft, spaetestens: geprueft };
    }
    // INV-02 — ohne Bestätigung keine Höchstdauer: Das Ende bleibt offen.
    return { fruehestens, spaetestens: lage.ohneFeiertagBestaetigt ? fruehestens : null };
  }
  let fruehestens = ende;
  for (let i = 0; i < HOECHSTENS && tagStatusInland(fruehestens, lage) === 'frei'; i += 1) {
    fruehestens = addDays(fruehestens, 1);
  }
  let spaetestens = ende;
  for (let i = 0; i < HOECHSTENS && tagStatusInland(spaetestens, lage) !== 'werktag'; i += 1) {
    spaetestens = addDays(spaetestens, 1);
  }
  return { fruehestens, spaetestens };
}

export function pruefeZahlungstag(tag: string, fenster: FristFenster): Fristpruefung {
  const day = tag.slice(0, 10);
  if (day <= fenster.fruehestens) return 'fristgerecht';
  if (fenster.spaetestens !== null && day > fenster.spaetestens) return 'verspaetet';
  return 'ungeklaert';
}

/** Liegt der Tag nach jedem möglichen Fristende? Bei offenem Ende nie. */
export function nachFristende(tag: string, fenster: FristFenster): boolean {
  return fenster.spaetestens !== null && tag.slice(0, 10) > fenster.spaetestens;
}

const ISO_DATUM = /^\d{4}-\d{2}-\d{2}$/;

/**
 * INV-03 — die Fristlage im Serverformat (`frist_basis.lage`) lesen. Alles, was nicht genau einer
 * bekannten Form entspricht, ergibt `null` (dann rechnet der Client wie ohne Bindung).
 */
export function parseFristLage(raw: unknown): FristLage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v.art === 'abbedungen') return { art: 'abbedungen' };
  if (v.art === 'inland') {
    if (!Array.isArray(v.laender) || v.laender.length === 0 || !v.laender.every(isBundesland)) return null;
    const laender = BUNDESLAENDER.filter((land) => (v.laender as unknown[]).includes(land));
    const gemeinde: GemeindeAngaben = {};
    const rohGemeinde =
      v.gemeinde && typeof v.gemeinde === 'object' && !Array.isArray(v.gemeinde)
        ? (v.gemeinde as Record<string, unknown>)
        : {};
    for (const key of ['fronleichnam', 'mariaeHimmelfahrt', 'augsburgerFriedensfest'] as const) {
      const angabe = rohGemeinde[key];
      if (typeof angabe === 'boolean') gemeinde[key] = angabe;
    }
    const quelle = v.quelle === 'kunde' || v.quelle === 'plz' || v.quelle === 'klaerung' ? v.quelle : 'unbekannt';
    return { art: 'inland', laender, gemeinde, quelle };
  }
  if (v.art === 'ausland') {
    const quelle = v.quelle === 'kunde' || v.quelle === 'plz' || v.quelle === 'klaerung' ? v.quelle : 'land';
    const lage: Extract<FristLage, { art: 'ausland' }> = {
      art: 'ausland',
      ohneFeiertagBestaetigt: v.ohneFeiertagBestaetigt === true,
      quelle,
    };
    if (v.geprueft && typeof v.geprueft === 'object' && !Array.isArray(v.geprueft)) {
      const geprueft: Record<string, string> = {};
      for (const [kalender, wirksam] of Object.entries(v.geprueft as Record<string, unknown>)) {
        if (ISO_DATUM.test(kalender) && typeof wirksam === 'string' && ISO_DATUM.test(wirksam)) geprueft[kalender] = wirksam;
      }
      if (Object.keys(geprueft).length > 0) lage.geprueft = geprueft;
    }
    return lage;
  }
  return null;
}

export function istUngeklaert(fenster: FristFenster): boolean {
  return fenster.fruehestens !== fenster.spaetestens;
}

/**
 * INV-03 — die Fristgrundlage einer Serverzeile (`frist_basis`) lesen. Ungültig → `null`: Die Rechnung
 * wird dann nicht abgewiesen, sie rechnet nur wie ohne Bindung (der Server bleibt maßgeblich).
 */
export function parseInvoiceFristBasis(raw: unknown): InvoiceFristBasis | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (!parseFristLage(v.lage)) return null;
  if (v.quelle !== 'freigabe' && v.quelle !== 'bestand' && v.quelle !== 'klaerung') return null;
  const basis: InvoiceFristBasis = { lage: v.lage, quelle: v.quelle };
  if (typeof v.festgelegtAm === 'string') basis.festgelegtAm = v.festgelegtAm;
  const k = v.klaerung;
  if (k && typeof k === 'object' && !Array.isArray(k)) {
    const klaerung = k as Record<string, unknown>;
    if (typeof klaerung.id === 'string' && typeof klaerung.begruendung === 'string') {
      basis.klaerung = {
        id: klaerung.id,
        begruendung: klaerung.begruendung,
        ...(typeof klaerung.von === 'string' ? { von: klaerung.von } : {}),
        ...(typeof klaerung.am === 'string' ? { am: klaerung.am } : {}),
        ...(klaerung.angabe && typeof klaerung.angabe === 'object' && !Array.isArray(klaerung.angabe)
          ? { angabe: { ...(klaerung.angabe as Record<string, unknown>) } }
          : {}),
      };
    }
  }
  return basis;
}

/**
 * Die Lage einer Rechnung: die gebundene Fristgrundlage (INV-03), sonst wie bisher Kunde über
 * `customerId` (Kundenstamm), sonst ihre Rechnungsanschrift.
 */
export function invoiceFristLage(
  invoice: Pick<VorgangInvoice, 'deadlineShiftWaived' | 'customerId' | 'customerSnapshot' | 'fristBasis'>,
): FristLage {
  const gebunden = parseFristLage(invoice.fristBasis?.lage);
  if (gebunden) return gebunden;
  const customerId = invoice.customerId?.trim();
  return ermittleFristLage({
    deadlineShiftWaived: invoice.deadlineShiftWaived,
    customerSnapshot: invoice.customerSnapshot,
    kunde: customerId ? getCustomerById(customerId) : undefined,
  });
}

/** Fenster des Zahlungsziels (`paymentDueDate`), oder `null` ohne Zahlungsziel. */
export function zahlungszielFenster(
  invoice: Pick<VorgangInvoice, 'paymentDueDate' | 'deadlineShiftWaived' | 'customerId' | 'customerSnapshot' | 'fristBasis'>,
): FristFenster | null {
  const due = invoice.paymentDueDate?.trim().slice(0, 10);
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  return berechneFristFenster(due, invoiceFristLage(invoice));
}
