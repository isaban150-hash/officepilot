/**
 * E-RECHNUNG-04B — die verbindlichen Projektfestlegungen und die zwei
 * kleinsten Bausteine, die der eingefrorene Beleg dafür braucht.
 *
 * Dieses Modul erzeugt **kein** XML und weiss nichts von UBL, CII, Einheiten-
 * oder Steuercodes. Es hält nur fest, wogegen später gebaut wird, und liefert
 * Ländercode und Währung in einer Form, die ein Beleg dauerhaft tragen kann.
 *
 * Rein: kein React, kein Store, keine Cloud, keine Uhr.
 */

/**
 * Wogegen OfficeTakt die E-Rechnung baut. Projektseitig festgelegt, nicht
 * geraten — und hier hinterlegt, damit ein erzeugter Beleg später sagen kann,
 * nach welchem Stand er entstanden ist.
 *
 * Ausdrücklich gegen XRechnung **3.0**, nicht gegen die Vorversion 4.0.
 */
export const EINVOICE_STANDARDS = {
  xrechnung: {
    /** Normative Generation. */
    generation: '3.0',
    /** Spezifikationsstand innerhalb der Generation. */
    specification: '3.0.2',
    /** Technisches Bundle (Codelisten, Schematron, Beispiele). */
    bundle: '2026-08-31',
  },
  /** Noch nicht implementiert — hier nur festgehalten, damit 04D nichts raten muss. */
  zugferd: {
    version: '2.5.2',
    facturX: '1.09.2',
  },
} as const;

/**
 * Die Währung einer OfficeTakt-Rechnung.
 *
 * OfficeTakt beherrscht heute keine echte Mehrwährungslogik: Es gibt keine
 * Wechselkurse, keine Währungsumrechnung in den Summen und keine
 * währungsabhängige Steuerbehandlung. Eine Auswahlliste mit Fremdwährungen
 * wäre deshalb ein Versprechen, das das Produkt nicht einlöst.
 *
 * Stattdessen wird das tatsächliche Verhalten **ausdrücklich** gemacht: Jede
 * Rechnung trägt ihren Währungscode eingefroren im Beleg. Kommt später echte
 * Mehrwährungsfähigkeit, ist der Platz dafür bereits da — und die Altbelege
 * sagen weiterhin ehrlich, in welcher Währung sie entstanden sind.
 *
 * Bewusst **nicht** aus `CompanyProfile.currency` abgeleitet: Dieses Feld wird
 * von `toInvoiceCompanySnapshot` ausdrücklich aus dem Firmen-Snapshot
 * entfernt — es ist eine Profil-Vorbelegung, kein historisches Rechnungsdatum.
 * Ein Beleg, dessen Währung erst beim Export aus dem heutigen Profil käme,
 * wäre genau die nachträgliche Zusammensetzung, die 04B verhindert.
 */
export const INVOICE_CURRENCY_CODE = 'EUR';

/** Der Ländercode, den ein Beleg trägt, wenn nichts anderes bekannt ist. */
export const DEFAULT_COUNTRY_CODE = 'DE';

/**
 * Die Länder, die OfficeTakt heute benennen kann.
 *
 * Bewusst kurz. Eine vollständige Ländertabelle wäre für einen Betrieb, der im
 * deutschsprachigen Raum arbeitet, totes Gewicht — und sie würde vortäuschen,
 * dass das Produkt internationale Steuerfälle beherrscht. Was fehlt, lässt
 * sich jederzeit ergänzen; was hier steht, ist geprüft.
 *
 * Die Schlüssel sind zweibuchstabige Ländercodes in der üblichen Schreibweise.
 */
export const KNOWN_COUNTRY_CODES = ['DE', 'AT', 'CH'] as const;

export type KnownCountryCode = (typeof KNOWN_COUNTRY_CODES)[number];

/** Schreibweisen, unter denen ein Land im Freitextfeld `country` auftaucht. */
const COUNTRY_TEXT_TO_CODE: ReadonlyMap<string, KnownCountryCode> = new Map([
  ['de', 'DE'],
  ['deu', 'DE'],
  ['deutschland', 'DE'],
  ['germany', 'DE'],
  ['at', 'AT'],
  ['aut', 'AT'],
  ['österreich', 'AT'],
  ['oesterreich', 'AT'],
  ['osterreich', 'AT'],
  ['austria', 'AT'],
  ['ch', 'CH'],
  ['che', 'CH'],
  ['schweiz', 'CH'],
  ['switzerland', 'CH'],
  ['suisse', 'CH'],
]);

export function isKnownCountryCode(value: unknown): value is KnownCountryCode {
  return typeof value === 'string' && (KNOWN_COUNTRY_CODES as readonly string[]).includes(value);
}

/**
 * Einen eingegebenen Länderwert auf einen Code bringen — oder ehrlich nichts
 * liefern.
 *
 * Akzeptiert wird der Code selbst (auch klein geschrieben) und die
 * ausgeschriebene Landesbezeichnung. Alles andere ergibt `undefined`: Ein
 * geratener Code wäre auf einem Beleg schlimmer als ein fehlender, weil ihn
 * niemand mehr hinterfragt.
 *
 * Insbesondere wird **nicht** auf Deutschland zurückgefallen. Wer einen
 * Standard braucht, nimmt ihn ausdrücklich (`DEFAULT_COUNTRY_CODE`).
 */
export function normalizeCountryCode(value: string | null | undefined): KnownCountryCode | undefined {
  const raw = (value ?? '').trim();
  if (!raw) return undefined;
  const upper = raw.toUpperCase();
  if (isKnownCountryCode(upper)) return upper;
  return COUNTRY_TEXT_TO_CODE.get(raw.toLowerCase());
}

/**
 * Der Ländercode, den ein Snapshot tragen soll: das ausdrückliche Feld zuerst,
 * sonst der Versuch über den Freitext. Der bestehende Freitext bleibt dabei
 * unangetastet — er ist weiterhin das, was auf dem Papier steht.
 */
export function resolveCountryCode(input: {
  countryCode?: string;
  country?: string;
}): KnownCountryCode | undefined {
  return normalizeCountryCode(input.countryCode) ?? normalizeCountryCode(input.country);
}
