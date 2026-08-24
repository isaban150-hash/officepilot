import { pickBestConstructionSiteCandidate } from './documentSummaryContent';

export interface ExtractedDocumentFields {
  Absender?: string;
  Empfänger?: string;
  Datum?: string;
  Aktenzeichen?: string;
  Baustelle?: string;
  Kunde?: string;
  Vorgang?: string;
  Rechnungsnummer?: string;
  Betrag?: string;
  Frist?: string;
  Projekt?: string;
  Straße?: string;
  Ort?: string;
  Lieferant?: string;
  Betreff?: string;
  Gewerk?: string;
}

export type FieldConfidenceLevel = 'high' | 'medium' | 'low';

export interface ConfidentField {
  value: string;
  confidence: FieldConfidenceLevel;
}

export type ExtractedDocumentFieldsWithConfidence = Partial<
  Record<keyof ExtractedDocumentFields, ConfidentField>
>;

const LABEL_VALUE =
  /^(?:absender|von|auftraggeber|lieferant|aussteller|anbieter|empfänger|empfaenger|an|kunde|mandant)\s*[:]\s*(.+)$/i;

// Note: "Auftraggeber" maps to Kunde in the line loop — never to Absender.

/** Letterhead / issuer names often appear unlabeled in the first text window. */
const LETTERHEAD_HEAD_CHARS = 520;
const LETTERHEAD_SKIP =
  /^(?:seite|datum|betreff|rechnung|rechnungsnummer|vertrag|werkvertrag|angebot|mahnung|gutschrift|newsletter|leistung|netto|brutto|ust|pos\.?|artikel|dokument|sehr|geehrte|damen|herren)$/i;
/**
 * SCAN-OCR-EVIDENCE-01B — a field or role word is never part of a sender name.
 * Flat OCR merges "Auftraggeber" and the company into one line; without this the
 * letterhead heuristic would return the label plus a foreign company. Generic
 * vocabulary only — no company names, no position based rule, so a real
 * letterhead at the top of the page keeps working.
 */
const LEADING_FIELD_LABEL =
  /^(?:auftraggeber|auftragnehmer|subunternehmer|nachunternehmer|vermieter|mieter|leasinggeber|leasingnehmer|verk[äa]ufer|k[äa]ufer|versicherer|versicherungsnehmer|arbeitgeber|arbeitnehmer|dienstleister|kunde|empf[äa]nger|absender|lieferant|bauvorhaben|baustelle|firma)(?:in)?\b[\s:–—-]*/i;

/** Strips a leading role or field label from a candidate name. */
export function stripLeadingFieldLabel(value: string): string {
  let current = value.trim();
  for (let guard = 0; guard < 3; guard += 1) {
    const next = current.replace(LEADING_FIELD_LABEL, '').trim();
    if (next === current) break;
    current = next;
  }
  return current;
}
const LETTERHEAD_INSTITUTION =
  /\b((?:Finanzamt|Stadtwerke|Handwerkskammer|Industrie-?\s*und\s*Handelskammer|Amtsgericht|Landgericht|Arbeitsgericht|BG\s*BAU|Berufsgenossenschaft(?:\s+der\s+Bauwirtschaft)?|SOKA-?BAU|Agentur\s+für\s+Arbeit|Bundesagentur(?:\s+für\s+Arbeit)?|AOK|Barmer|Techniker\s+Krankenkasse|DAK|IKK|Sparkasse|Volksbank|Commerzbank|Deutsche\s+Bank|Hotel|Steuerberatung|Kanzlei|AutoService)(?:\s+[\p{L}][\p{L}\d .&\-\/']{1,40})?)/iu;
/** Standalone issuer brands that should not swallow the recipient address block. */
const LETTERHEAD_ISSUER_BRAND =
  /\b(VHV(?:\s+Gewerbeversicherung)?|Alphabet(?:\s+Fuhrparkleasing)?|Telekom(?:\s+Geschäftskunden)?)\b/iu;
/** Fuel / retail station letterheads without GmbH suffix. */
const LETTERHEAD_FUEL_STATION =
  /\b((?:Aral|Shell|Esso|Total(?:Energies)?|JET|OMV|Agip|Star|Hem|Westfalen|bft|Oil!\s*Tankstellen?)\s+(?:Station\s+)?[\p{L}][\p{L}\d .&\-]{1,40})/iu;
const LETTERHEAD_TANKSTELLE =
  /\b([A-ZÄÖÜ][\p{L}\d][\p{L}\d .&\-]{2,45}?)\s+Tankstelle\b/u;
const LETTERHEAD_LEGAL_ENTITY =
  /\b([A-ZÄÖÜ][\p{L}\d][\p{L}\d .&\-\/'’]{1,55}?\s(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|KG|OHG|GbR|UG|e\.?\s*V\.?))\b/u;
const LETTERHEAD_BRAND =
  /(?:^|[\n|·])\s*(?:[A-ZÄÖÜ]\s+)?([A-ZÄÖÜ][\p{L}\d]+(?:\s+[A-ZÄÖÜ\d][\p{L}\d]*){0,4})\s*[—–\-]\s*(?:Newsletter|Rundschreiben|Mitteilung|Information)\b/u;

const DATE_PATTERN = /\b(\d{1,2}[./]\d{1,2}[./]\d{2,4})\b/;
/** Labeled dates anywhere in flattened PDF text (not only line-start). */
const DATE_LABELED_INLINE =
  /(?<!(?:ohne|kein|keine|nicht)\s)\b(?:datum|vertragsdatum|belegdatum|lieferdatum|rechnungsdatum|aufenthalt)\s*[:.]?\s*(?!unbekannt|folgt|offen|tbd\b)(\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\.?[–—-]\d{1,2}\.\d{1,2}\.\d{2,4})/i;
const AMOUNT_PATTERN =
  /\b(?:betrag|summe|gesamt|total|brutto|gutschrift\s+brutto)\s*[:\s]*(-?\d{1,3}(?:[.\s]\d{3})*,\d{2}\s*€?|-?\d{1,3}(?:[.\s]\d{3})*,\d{2}\s*(?:EUR|eur))|\b(-?\d{1,3}(?:[.\s]\d{3})*,\d{2}\s*€|-?\d{1,3}(?:[.\s]\d{3})*,\d{2}\s*(?:EUR|eur))\b/i;
const INVOICE_NUMBER_PATTERN =
  // `[\s-]*` nach der bereits vorhandenen Repository-Konvention (vgl.
  // RECEIPT_NUMBER_PATTERN): auch `Rechnungs-Nr.` und `Beleg Nr.` sind gemeint.
  /\b(?:rechnungs[\s-]*(?:nummer|nr\.?)|invoice(?:\s*no\.?)?|beleg[\s-]*(?:nummer|nr\.?))\s*[:#]?\s*([A-Z0-9][\w./-]{2,})/i;
const REFERENCE_PATTERN =
  /\b(?:aktenzeichen|az\.?|vorgang(?:snummer|snr\.?)?|auftrags(?:nummer|nr\.?)|referenz)\s*[:#]?\s*([A-Z0-9][\w./-]{2,})/i;
const DEADLINE_PATTERN =
  /\b(?:frist|fällig(?:keit| am)?|zahlbar bis|bis zum|zahlungsziel|gültig bis|gueltig bis)\s*[:.]?\s*(\d{1,2}[./]\d{1,2}[./]\d{2,4})/i;
/** Prefer explicit site labels — bare "Projekt:" often captures titles/table bleed. */
const SITE_PATTERN =
  /\b(?:baustelle|bauobjekt)\s*[:]\s*(.+)$/i;
const SITE_INLINE =
  /\b(?:ihre\s+)?(?:baustelle|bauobjekt)\s*[:]\s*([^\n]+?)(?=\s{2,}|\s*Pos\.|\s*Zwischen\b|\s*Auftraggeber\b|\s*Lieferadresse\b|\s*Art\.-?\s*Nr|\s*Leistungs|\s*Netto\b|\s*Brutto\b|\s*Sehr\s+geehrte|\s*€|$)/i;
const PROJECT_INLINE =
  /\b(?:bauvorhaben|projekt)\s*[:]\s*([^\n]+?)(?=\s{2,}|\s*Pos\.|\s*Baustelle\b|\s*Leistungs|\s*Zwischen\b|\s*Sehr\s+geehrte|$)/i;
const PROJECT_QUOTED =
  /\bbauvorhaben\s*[„“"]\s*([^”"“]{3,80}?)\s*[”"“]/i;
const AUFTRAGGEBER_INLINE =
  /\b(?:auftraggeber|kunde|rechnungsempfänger|rechnungsempfaenger)\s*[:]\s*([^\n·]+?)(?=\s{2,}|\s*Auftragnehmer|\s*Baustelle|\s*Bauvorhaben|$)/i;
const AUFTRAGGEBER_PAREN = /\(\s*Auftraggeber\s+([^)]+?)\)/i;
const KENNZEICHEN_LABELED =
  /\bkennzeichen\s*[:\s]*([A-ZÄÖÜ]{1,3}-[A-ZÄÖÜ]{1,3}\s*\d{1,4})\b/i;
const EMPFAENGER_INLINE =
  /\b(?:empfänger|empfaenger)\s*[:]\s*([^\n·]+?)(?=\s{2,}|\s*Absender|\s*Datum|$)/i;
const AUFTRAGGEBER_ROLE =
  /\b(?:und\s+)?(?:der|die|das)\s+([\p{L}][\p{L}\d .&\-\/'’]{2,70}?(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|KG|OHG|GbR|UG|e\.?\s*V\.?|WEG\b[\p{L}\d .&\-]{0,40}))\s*(?:,[^()]{0,100})?\(\s*Auftraggeber\s*\)/iu;
/**
 * Fast probe: skip recipient-zHd work when no attention marker exists.
 * Matching still requires `z. Hd.` / `z.Hd.` (historical RECIPIENT_ZHD behavior).
 */
const RECIPIENT_ATTENTION_PROBE = /z\.\s*Hd\.|z\.\s*H\.|zu\s+H(?:ä|ae)nden|attn/i;
/** Locates supported z. Hd. markers only (linear scan). */
const RECIPIENT_ZHD_MARKER = /z\.\s*Hd\./giu;
/**
 * Company/WEG immediately before a z. Hd. marker.
 * All quantifiers are bounded — safe on a short lookbehind window.
 */
const RECIPIENT_BEFORE_ZHD =
  /((?:WEG\s+[\p{L}][\p{L}\d .&\-]{2,50}|[A-ZÄÖÜ][\p{L}][\p{L}\d &\/'’-]{0,60}(?:\s+[A-ZÄÖÜ\d][\p{L}\d &\/'’-]{0,40}){0,6}\s(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|KG|OHG|GbR|UG)))\s*$/u;
/** Max characters inspected immediately before each z. Hd. marker. */
const RECIPIENT_ZHD_LOOKBACK = 120;
/** Street + PLZ/city that follow a "z. Hd." recipient block on flat PDF text. */
const RECIPIENT_STREET =
  /\bz\.\s*Hd\.\s+[\p{L}.\s-]{1,40}?\b([A-ZÄÖÜ][\p{L}\-]*(?:straße|strasse|weg|platz|allee)\s+\d+)\s+(\d{5}\s+[A-ZÄÖÜ][\p{L}\-]+)/iu;
const LIEFERADRESSE_INLINE =
  /\b(?:lieferadresse|lieferanschrift)\s*[:.]?\s*([^\n]+?)(?=\s{2,}|\s*Zahlungsziel|\s*Art\.-?\s*Nr|\s*Pos\.|\s*Netto|$)/i;
const ADDRESS_PATTERN =
  /\b(?:baustellenadresse|adresse|straße|strasse)\s*[:]\s*(.+)$/i;
const CITY_PATTERN = /\b(\d{5})\s+([A-ZÄÖÜ][\p{L}\-]+(?:\s+[A-ZÄÖÜ][\p{L}\-]+)*)/u;
/**
 * A street line standing on its own: name plus house number, nothing else.
 * Deliberately shape-based rather than suffix-based, so "Westring 88" counts
 * just like "Lindenweg 4" — the caller is responsible for handing in only lines
 * that already belong to one address block.
 */
const STANDALONE_STREET_LINE =
  /^([\p{Lu}][\p{L}.\-]*(?:\s+[\p{L}.\-]+){0,3}\s+\d{1,4}\s*[a-zA-Z]?)$/u;
/** A PLZ/city line standing on its own, e.g. "33330 Gütersloh". */
const STANDALONE_ZIP_CITY_LINE = /^(\d{5})\s+([A-ZÄÖÜ][\p{L}\-]+(?:\s+[A-ZÄÖÜ][\p{L}\-]+)*)$/u;

/** Street, postal code and city as separate fields — none of them guessed. */
export interface ExtractedPostalAddress {
  street?: string;
  zip?: string;
  city?: string;
}

/**
 * Reads a postal address out of a set of lines that are already known to belong
 * together. Pure and reusable: it makes no assumption about who the address
 * belongs to, so the caller must pass a block it has bound itself. Lines
 * carrying a label ("Baustelle: …") are ignored — a labelled address describes
 * something other than the block owner.
 */
export function extractPostalAddressFromLines(lines: readonly string[]): ExtractedPostalAddress {
  const address: ExtractedPostalAddress = {};
  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/\s+/g, ' ');
    if (!line || line.includes(':')) continue;
    if (!address.street) {
      const street = STANDALONE_STREET_LINE.exec(line);
      if (street) {
        address.street = street[1].trim();
        continue;
      }
    }
    if (!address.zip) {
      const cityLine = STANDALONE_ZIP_CITY_LINE.exec(line);
      if (cityLine) {
        address.zip = cityLine[1];
        address.city = cityLine[2].trim();
      }
    }
  }
  return address;
}
const GEWERK_INLINE =
  /\b(?:gewerk|fachrichtung)\s*[:]\s*([^\n·]+?)(?=\s{2,}|\s*Pos\.|$)/i;
/** Prefer specific trades over the umbrella "SHK" brand token in letterheads. */
const GEWERK_KEYWORD =
  /\b(Heizung|Heizzentrale|Sanitär|Lüftung|Klima|Elektro|Rohrleitungsbau|Dach|Trockenbau)\b/u;
const BETREFF_BEFORE_DATUM =
  /\b((?:Erinnerung|Mahnung|Bescheid|Beitragsbescheid|Beitragsnachweis|Ladung|Mitteilung|Aufforderung|Kündigung|Abrechnung|Gutschrift|Unterlagenchecklist\w*|Newsletter|Werbung)(?:\s+[\p{L}\d][\p{L}\d /–—-]{0,55})?)\s+(?:Datum|Az\.|Aktenzeichen)\b/iu;
const BETREFF_HEADLINE_BEFORE_DATUM =
  /(?:^|[\n·|])\s*([A-ZÄÖÜ][\p{L}][\p{L}\d /–—-]{6,70})\s+Datum\s+\d{1,2}[./]/u;
const BETREFF_SKIP =
  /^(?:rechnung|angebot|lieferschein|werkvertrag|vertrag|seite|sehr|geehrte|pos\.?|netto|brutto|cirmak)/i;

function firstMatch(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  const value = match?.[1] ?? match?.[2];
  return value?.trim();
}

function pickLabeledValue(lines: string[], labels: RegExp): string | undefined {
  for (const line of lines) {
    const match = line.match(labels);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

function normalizeAmount(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function setField(
  fields: ExtractedDocumentFieldsWithConfidence,
  key: keyof ExtractedDocumentFields,
  value: string | undefined,
  confidence: FieldConfidenceLevel,
): void {
  if (!value?.trim()) return;
  const existing = fields[key];
  if (existing && rankConfidence(existing.confidence) >= rankConfidence(confidence)) {
    return;
  }
  fields[key] = { value: value.trim(), confidence };
}

function rankConfidence(level: FieldConfidenceLevel): number {
  if (level === 'high') return 3;
  if (level === 'medium') return 2;
  return 1;
}

export function isFieldConfidentEnough(level: FieldConfidenceLevel): boolean {
  return level === 'high' || level === 'medium';
}

/**
 * Narrow normalisation: whitespace plus a single leading logo glyph ("A Aral …",
 * "F Finanzamt …") — nothing else.
 *
 * Receipt merchants need exactly this and nothing more: on a receipt the header line
 * is the merchant name, so rubric words like "Tankstelle" are part of the name and
 * must survive. Letterhead callers keep the broad cleanup below.
 */
export function stripLetterheadLogoInitial(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[A-ZÄÖÜ]\s+(?=[A-ZÄÖÜ])/u, '')
    .trim();
}

/**
 * Shared letterhead normalisation. Also used by the authority sender path so a raw
 * header line never reaches an organisation field unnormalised. Starts from the narrow
 * logo-initial rule and then applies the broad letterhead cleanup.
 */
export function cleanLetterheadCandidate(raw: string): string | undefined {
  let value = stripLetterheadLogoInitial(raw);
  value = value.split(/\s*[·|]\s*/)[0]?.trim() ?? value;
  value = value
    .replace(
      /\s+(?:Industriestraße|IndustrieStrasse|Parkstraße|Büchenstraße|Energieallee|Werkstraße|Vlothoer|Straße|Strasse|Str\.)\b.*$/iu,
      '',
    )
    .trim();
  value = value
    .replace(
      /\s+(?:SHK|Werkverträge|Behörden\w*|Gerichtsschreiben|Hotelrechnung|Energie\s*\/\s*Versorgung|Kundenbeleg|Tankbeleg|Tankstelle|Mobilfunk|Festnetz|arbeitsunfähig|seit|voraus|Prüfbericht|Werkstattrechnung|Bezeichnung|Bruttogeh\w*|Steuerberatung\b(?!\s+Ostwestfalen))\b.*$/iu,
      '',
    )
    .trim();
  // "Steuerberatung Ostwestfalen GmbH Steuerberatung Bahnhofstraße…" — drop repeated label + street.
  value = value
    .replace(/\s+Steuerberatung\s+(?=\d|\w+\s*(?:straße|strasse|weg))/iu, ' ')
    .replace(/\s+(?:Bahnhofstraße|Werkstattweg)\b.*$/iu, '')
    .trim();
  // Drop a trailing second legal entity (issuer + recipient bleed on one PDF line).
  const entities = [
    ...value.matchAll(
      /\b[\p{L}][\p{L}\d .&\-\/'’]{1,55}?\s(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|KG|OHG|GbR|UG)\b/gu,
    ),
  ];
  if (entities.length >= 2 && entities[0]?.index != null) {
    value = value.slice(0, entities[0].index + entities[0][0].length).trim();
  }
  if (value.length < 3 || value.length > 80) return undefined;
  if (LETTERHEAD_SKIP.test(value)) return undefined;
  if (!/[\p{L}]{2,}/u.test(value)) return undefined;
  return value;
}

/**
 * Infer issuer/sender from unlabeled letterhead text (common in scans / text-layer PDFs).
 * Prefer institutions, then legal entities, then brand heads — never invent placeholders.
 */
/**
 * OFFICEPILOT-RECEIPT-MERCHANT-SELECTION-FIX-01 — Strukturwörter, die in echten
 * Firmennamen regelmäßig als Kurz-Token auftreten. Sie dürfen einen Namen nicht
 * als Fragment erscheinen lassen: „Müller GmbH & Co. KG", „Firma 24 GmbH".
 * Keine Händler- oder Markenliste — ausschließlich Rechtsformen, Bindewörter
 * und Zahlen.
 */
const MERCHANT_STRUCTURE_TOKEN =
  /^(?:&|\+|und|co\.?|gmbh|mbh|ag|kg|ohg|gbr|ug|e\.?\s?k\.?|se|ltd\.?|inc\.?|\d+[.,]?)$/i;

/**
 * Ein sehr kurzes Token. Für sich genommen **kein** Beweis für OCR-Müll:
 * „Bau", „Ost", „Pro", „Top", „Max" sind gewöhnliche Namensbestandteile.
 * Erst eine ganze Kette davon trägt die Beweislast — siehe MIN_GARBLED_TOKENS.
 */
function isFragmentToken(token: string): boolean {
  if (MERCHANT_STRUCTURE_TOKEN.test(token)) return false;
  return token.replace(/[^\p{L}\d]/gu, '').length <= 3;
}

/**
 * OFFICEPILOT-TANKBELEG-TANKSTELLE-FIELD-FIX-01 — wahr, wenn ein Wert
 * ausschließlich aus einer Kette kurzer Fragmente besteht. Bewusst dieselbe
 * Schwelle wie `MIN_GARBLED_TOKENS`: ein oder zwei kurze Wörter sind alltäglich,
 * eine ganze Reihe davon nicht. Für sich allein ist das **kein** hinreichender
 * Beweis — der Aufrufer muss zusätzlich einen im Dokument bestätigten, davon
 * unabhängigen Alternativwert vorweisen.
 */
export function isAllFragmentTokens(value: string): boolean {
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length < MIN_GARBLED_TOKENS) return false;
  return tokens.every((token) => isFragmentToken(token));
}

/** Wahr, wenn `part` als vollständiges Wort in `value` vorkommt. */
export function containsMerchantToken(value: string, part: string): boolean {
  const tokens = value.split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  const partTokens = part.split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  if (partTokens.length === 0) return false;
  return partTokens.every((token) => tokens.includes(token));
}

/**
 * OFFICEPILOT-RECEIPT-MERCHANT-SELECTION-FIX-01B — Mindestzahl kurzer Resttoken,
 * ab der ein Anhang als OCR-Müll gilt. Bewusst hoch angesetzt: ein oder zwei
 * kurze Wörter hinter einem Namen sind alltäglich („Muster Bau", „Muster Bau
 * Ost"), drei und mehr aneinandergereihte Fragmente sind es nicht. Ohne diese
 * Schwelle hätte bereits ein einzelnes echtes Namenswort zur Kürzung geführt.
 */
const MIN_GARBLED_TOKENS = 3;

/**
 * Wahr, wenn `longer` derselbe Name wie `shorter` ist, ergänzt um reinen
 * OCR-Müll: `shorter` ist vollständiges Wortpräfix, und der Rest besteht
 * ausschließlich aus Fragmenten — etwa eine als Logo gelesene Kopfzeile
 * „NAME EEE nn Ef Enz" gegenüber der sauberen Zeile „NAME".
 */
function isGarbledExtensionOf(longer: string, shorter: string): boolean {
  const longerTokens = longer.split(/\s+/).filter(Boolean);
  const shorterTokens = shorter.split(/\s+/).filter(Boolean);
  if (shorterTokens.length === 0 || longerTokens.length <= shorterTokens.length) return false;

  const isPrefix = shorterTokens.every(
    (token, index) => longerTokens[index]?.toLowerCase() === token.toLowerCase(),
  );
  if (!isPrefix) return false;

  const rest = longerTokens.slice(shorterTokens.length);
  // Beweislast: eine ganze Kette von Fragmenten, nicht ein einzelnes kurzes Wort.
  if (rest.length < MIN_GARBLED_TOKENS) return false;
  return rest.every((token) => isFragmentToken(token));
}

/**
 * OFFICEPILOT-RECEIPT-MERCHANT-SELECTION-FIX-01D — führende Scan-Artefakte vor
 * dem eigentlichen Namen („= NAME"). Bewusst nur diese wenigen Zeichen und
 * ausschließlich **vor** dem ersten alphanumerischen Zeichen: interne Zeichen
 * bleiben unangetastet, damit „H&M", „T.Bau" oder „A & O Bau" unverändert
 * bleiben. Absichtlich lokal auf den Merchant-Vergleich begrenzt statt in
 * `stripLetterheadLogoInitial` — jene Funktion hat weitere Aufrufer.
 */
const LEADING_MERCHANT_NOISE = /^[=:|*~•·]+\s*/u;

/** Liefert den Namen ohne führendes Scan-Rauschen — oder nichts, wenn keiner bleibt. */
export function stripLeadingMerchantNoise(line: string): string | undefined {
  const stripped = line.replace(LEADING_MERCHANT_NOISE, '').trim();
  if (!stripped || !/[\p{L}\d]/u.test(stripped)) return undefined;
  return stripped;
}

/**
 * Bewusst eng: ersetzt einen Kandidaten nur durch eine Kopfzeile, die
 * nachweislich derselbe Name ohne angehängten OCR-Müll ist. Findet sich keine
 * solche Zeile, bleibt der übergebene Kandidat unverändert — der Fix kann also
 * verbessern, aber nichts verschlechtern.
 *
 * Verglichen und zurückgegeben wird die um führendes Rauschen bereinigte Form,
 * damit nicht „= NAME" als Händlername erscheint.
 */
export function pickCleanerMerchantVariant(candidate: string, lines: string[]): string {
  const cleaner = lines
    .map((line) => stripLeadingMerchantNoise(line.trim()))
    .filter((line): line is string => Boolean(line))
    .find((line) => line !== candidate && isGarbledExtensionOf(candidate, line));
  return cleaner ?? candidate;
}

export function inferUnlabeledSenderFromText(text: string): string | undefined {
  const sender = resolveUnlabeledSenderFromText(text);
  if (!sender) return sender;
  /**
   * OFFICEPILOT-RECEIPT-MERCHANT-SELECTION-FIX-01 — derselbe Auswahlvertrag wie
   * im Belegkopf. Sonst trüge der Absender — und daraus der Betreff — den
   * OCR-Müll weiter, während das Händlerfeld bereits sauber ist.
   */
  return pickCleanerMerchantVariant(sender, text.split(/\r?\n/).slice(0, 6));
}

function resolveUnlabeledSenderFromText(text: string): string | undefined {
  if (!text?.trim()) return undefined;
  const head = text.slice(0, LETTERHEAD_HEAD_CHARS);

  const institution = head.match(LETTERHEAD_INSTITUTION)?.[1];
  const cleanedInstitution = institution ? cleanLetterheadCandidate(institution) : undefined;
  if (cleanedInstitution) return cleanedInstitution;

  const issuerBrand = head.match(LETTERHEAD_ISSUER_BRAND)?.[1];
  const cleanedIssuer = issuerBrand ? cleanLetterheadCandidate(issuerBrand) : undefined;
  if (cleanedIssuer) return cleanedIssuer;

  const fuel = head.match(LETTERHEAD_FUEL_STATION)?.[1];
  const cleanedFuel = fuel ? cleanLetterheadCandidate(fuel) : undefined;
  if (cleanedFuel) return cleanedFuel;

  const tankstelle = head.match(LETTERHEAD_TANKSTELLE)?.[1];
  const cleanedTankstelle = tankstelle ? cleanLetterheadCandidate(tankstelle) : undefined;
  if (cleanedTankstelle) return cleanedTankstelle;

  const legal = head.match(LETTERHEAD_LEGAL_ENTITY)?.[1];
  // A role or field label in front of the entity means this is a labelled field,
  // not a letterhead — strip it and keep only the actual name.
  const legalWithoutLabel = legal ? stripLeadingFieldLabel(legal) : undefined;
  const cleanedLegal = legalWithoutLabel ? cleanLetterheadCandidate(legalWithoutLabel) : undefined;
  if (cleanedLegal) return cleanedLegal;

  const brand = text.match(LETTERHEAD_BRAND)?.[1];
  const cleanedBrand = brand ? cleanLetterheadCandidate(brand) : undefined;
  if (cleanedBrand) return cleanedBrand;

  return undefined;
}

function isPlausibleSiteValue(value: string): boolean {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length < 3 || trimmed.length > 120) return false;
  if (/^\d+[.,]\d{2}\b/.test(trimmed)) return false;
  if (/\b€\b|\bEUR\b/i.test(trimmed) && /netto|brutto|pos\.?/i.test(trimmed)) return false;
  if (/^pos\.?\s*\d/i.test(trimmed)) return false;
  if (/\bzwischen\b/i.test(trimmed)) return false;
  // Sites need a street / house-number signal — project titles alone are not sites.
  if (!/\d/.test(trimmed) && !/straße|strasse|weg|platz|allee/i.test(trimmed)) return false;
  // Prefer street-like or "street, city" — reject bare city / PLZ-city from letterheads.
  if (/^\d{4,5}\s+[\p{L}]/u.test(trimmed) && !/,/.test(trimmed) && trimmed.length < 40) {
    return false;
  }
  return /[\p{L}]{3,}/u.test(trimmed);
}

function preferConstructionSiteMergeValue(existing: string | undefined, incoming: string): string {
  return pickBestConstructionSiteCandidate(existing, incoming) ?? incoming;
}

function isPlausibleProjectValue(value: string): boolean {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length < 3 || trimmed.length > 100) return false;
  if (/^\d+[.,]\d{2}\b/.test(trimmed)) return false;
  if (/^pos\.?\s*\d/i.test(trimmed)) return false;
  if (/\bzwischen\b|\bauftraggeber\b|\bauftragnehmer\b/i.test(trimmed)) return false;
  return /[\p{L}]{3,}/u.test(trimmed);
}

function isPlausiblePartyValue(value: string): boolean {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length < 3 || trimmed.length > 90) return false;
  if (/^(?:unbekannt|lieferant|kunde|absender|der|die|das)$/i.test(trimmed)) return false;
  return /[\p{L}]{2,}/u.test(trimmed);
}

function cleanSiteCapture(raw: string): string {
  let value = raw.replace(/\s+/g, ' ').trim();
  value = value
    .replace(/\s+Zwischen\b.*$/i, '')
    .replace(/\s+Auftraggeber\b.*$/i, '')
    .replace(/\s+Pos\.?\s*.*$/i, '')
    .trim();
  // Prefer the street segment when a project title and address share one label.
  const parts = value
    .split(/\s*[·|]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const streetLike = parts.find((part) =>
    /\d/.test(part) &&
    /straße|strasse|weg|platz|allee|[A-Za-zÄÖÜäöüß].*\d|\d.*[A-Za-zÄÖÜäöüß]/i.test(part),
  );
  if (streetLike) return streetLike.trim();
  return value;
}

/** Project title sibling when Baustelle label is "Project · Street, City". */
function projectTitleFromSiteLabel(raw: string): string | undefined {
  const parts = raw
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s*[·|]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  const title = parts.find(
    (part) =>
      !/\d{4,5}/.test(part) &&
      !/straße|strasse|weg|platz|allee/i.test(part) &&
      isPlausibleProjectValue(part),
  );
  return title;
}

function cleanPartyCapture(raw: string): string | undefined {
  let value = raw.replace(/\s+/g, ' ').trim();
  value = value.replace(/^(?:und\s+)?(?:der|die|das)\s+/i, '').trim();
  value = value.replace(/,\s*$/, '').trim();
  // Drop email / domain bleed before the party name.
  value = value.replace(/^[\w.-]+@[\w.-]+\s+/u, '').trim();
  value = value.replace(/^[\w.-]+\.(?:example|de|com|net)\s+/iu, '').trim();
  value = value.replace(/^(?:example|info|www)\s+/iu, '').trim();
  if (/@|\.example\b/i.test(value)) {
    const entity = value.match(
      /\b([A-ZÄÖÜ][\p{L}\d .&\-]{2,55}?\s(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|KG|OHG|GbR|UG))\b/u,
    );
    value = entity?.[1]?.trim() ?? '';
  }
  if (!value) return undefined;
  const cleaned = cleanLetterheadCandidate(value) ?? value;
  if (!isPlausiblePartyValue(cleaned)) return undefined;
  return cleaned;
}

function inferRecipientFromAddressBlock(
  text: string,
  issuer?: string,
): string | undefined {
  if (!text || !RECIPIENT_ATTENTION_PROBE.test(text)) {
    return undefined;
  }

  // Match on the line segment carrying each z. Hd. marker, or on the single
  // non-empty line immediately before it.
  const markerRe = new RegExp(RECIPIENT_ZHD_MARKER.source, RECIPIENT_ZHD_MARKER.flags);
  let marker: RegExpExecArray | null;
  while ((marker = markerRe.exec(text)) !== null) {
    if (marker[0].length === 0) {
      markerRe.lastIndex += 1;
      continue;
    }

    const end = marker.index;
    const lookbackStart = Math.max(0, end - RECIPIENT_ZHD_LOOKBACK);
    const rawWindow = text.slice(lookbackStart, end);
    // Native PDF text keeps the line break, so "z. Hd." can start its own line and the
    // recipient sits on the line above; flat text keeps both on one line. Check the
    // marker's own segment first, then exactly one preceding non-empty segment — never
    // the whole letterhead. RECIPIENT_BEFORE_ZHD stays anchored at the segment end, so
    // e-mail, address and heading lines cannot qualify.
    // Bound to physical lines FIRST, then drop empties: a marker at the start of its own
    // line leaves an empty trailing segment, and removing it before slicing would pull an
    // extra older line into range.
    const segments = rawWindow
      .split(/\r?\n|\r/)
      .slice(-2)
      .reverse()
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    let match: string | undefined;
    for (const segment of segments) {
      match = segment.match(RECIPIENT_BEFORE_ZHD)?.[1]?.trim();
      if (match) break;
    }
    if (!match) continue;

    const cleaned = cleanPartyCapture(match);
    if (!cleaned) continue;
    if (issuer && cleaned.toLowerCase().includes(issuer.toLowerCase().slice(0, 12))) {
      continue;
    }
    return cleaned;
  }

  return undefined;
}

function inferBetreffFromText(text: string): string | undefined {
  const labeled = text.match(BETREFF_BEFORE_DATUM)?.[1]?.trim();
  if (labeled && !BETREFF_SKIP.test(labeled)) {
    return labeled.replace(/\s+/g, ' ').trim().slice(0, 90);
  }
  const headline = text.match(BETREFF_HEADLINE_BEFORE_DATUM)?.[1]?.trim();
  if (headline && !BETREFF_SKIP.test(headline) && headline.length >= 8) {
    return headline.replace(/\s+/g, ' ').trim().slice(0, 90);
  }
  // Shared head-topic cues (document subject intelligence) — still no kind switches.
  try {
    // Lazy pattern: avoid circular import issues by dynamic require of signals only via inline TOPIC match.
    const topic = text
      .slice(0, 720)
      .match(
        /\b((?:Beitrags(?:rechnung|bescheid|nachweis)|Betriebshaftpflicht|Kfz[-\s]?Versicherung|Leasingvertrag|Prüfbericht|HU\s*\/\s*AU|Arbeitsvertrag|Urlaubsantrag|Krankmeldung|Lohnabrechnung|Gehaltsabrechnung|Anwaltliches\s+Schreiben|Ladung(?:\s+zum\s+Termin)?|Checkliste|Unterlagen(?:checkliste)?|Jahresabschluss|Newsletter|Angebot)(?:\s*[—–\-/]\s*[\p{L}\d][\p{L}\d /–—-]{0,40})?)/iu,
      )?.[1];
    if (topic && !BETREFF_SKIP.test(topic)) {
      return topic.replace(/\s+/g, ' ').trim().slice(0, 90);
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function extractFieldsWithConfidence(text: string): ExtractedDocumentFieldsWithConfidence {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const fields: ExtractedDocumentFieldsWithConfidence = {};

  for (const line of lines) {
    const generic = line.match(LABEL_VALUE);
    if (!generic) continue;

    const label = line.split(':')[0]?.trim().toLowerCase() ?? '';
    const value = generic[1].trim();
    if (!value) continue;

    if (/auftraggeber/.test(label)) {
      setField(fields, 'Kunde', value, 'high');
      continue;
    }
    if (/absender|von|lieferant|aussteller|anbieter/.test(label)) {
      setField(fields, 'Absender', value, 'high');
      if (/lieferant|anbieter/.test(label)) {
        setField(fields, 'Lieferant', value, 'high');
      }
    }
    if (/empfänger|empfaenger|an|kunde|mandant/.test(label)) {
      setField(fields, 'Empfänger', value, 'high');
      setField(fields, 'Kunde', value, 'high');
    }
  }

  setField(
    fields,
    'Absender',
    pickLabeledValue(lines, /^(?:absender|von|lieferant|aussteller)\s*[:]\s*(.+)$/i),
    'high',
  );
  setField(
    fields,
    'Empfänger',
    pickLabeledValue(lines, /^(?:empfänger|empfaenger|an)\s*[:]\s*(.+)$/i),
    'high',
  );

  // Letterhead first — used to avoid treating the issuer as customer/recipient.
  if (!fields.Absender?.value) {
    const letterheadSender = inferUnlabeledSenderFromText(text);
    setField(fields, 'Absender', letterheadSender, 'medium');
  }

  const auftraggeberRole = firstMatch(text, AUFTRAGGEBER_ROLE);
  const auftraggeberLabeled =
    pickLabeledValue(lines, /^(?:auftraggeber|kunde)\s*[:]\s*(.+)$/i) ??
    firstMatch(text, AUFTRAGGEBER_INLINE) ??
    firstMatch(text, AUFTRAGGEBER_PAREN) ??
    auftraggeberRole;
  const auftraggeberClean = auftraggeberLabeled
    ? cleanPartyCapture(auftraggeberLabeled)
    : undefined;
  if (auftraggeberClean) {
    setField(fields, 'Kunde', auftraggeberClean, 'high');
  }

  const recipientZhd = inferRecipientFromAddressBlock(text, fields.Absender?.value);
  if (recipientZhd) {
    setField(fields, 'Empfänger', recipientZhd, 'medium');
    if (!fields.Kunde?.value) setField(fields, 'Kunde', recipientZhd, 'medium');
  }

  const recipientStreet = text.match(RECIPIENT_STREET);
  if (recipientStreet?.[1] && recipientStreet[2]) {
    const street = recipientStreet[1].trim();
    const city = recipientStreet[2].replace(/^\d{4,5}\s+/, '').trim();
    const combined = `${street}, ${city}`;
    if (isPlausibleSiteValue(combined)) {
      setField(fields, 'Straße', `${street}, ${recipientStreet[2].trim()}`, 'medium');
      setField(fields, 'Baustelle', combined, 'medium');
    }
  }

  if (!fields.Kunde?.value) {
    setField(
      fields,
      'Kunde',
      fields.Empfänger?.value ?? pickLabeledValue(lines, /^kunde\s*[:]\s*(.+)$/i),
      'high',
    );
  }

  const empfaengerInline = firstMatch(text, EMPFAENGER_INLINE);
  if (empfaengerInline) {
    const cleaned = cleanPartyCapture(empfaengerInline);
    if (cleaned) {
      setField(fields, 'Empfänger', cleaned, 'medium');
      if (!fields.Kunde?.value) setField(fields, 'Kunde', cleaned, 'medium');
    }
  }

  // Never keep Absender when it is clearly the Auftraggeber/customer role.
  if (
    fields.Absender?.value &&
    fields.Kunde?.value &&
    fields.Absender.value.toLowerCase() === fields.Kunde.value.toLowerCase() &&
    auftraggeberClean
  ) {
    // Absender was wrongly taken from Auftraggeber label — clear and re-infer issuer.
    delete fields.Absender;
    const letterheadSender = inferUnlabeledSenderFromText(text);
    setField(fields, 'Absender', letterheadSender, 'medium');
  }

  // Sync Lieferant after letterhead so profile placeholders ("Unbekannt") can be overwritten.
  const lieferantLabeled = pickLabeledValue(lines, /^lieferant\s*[:]\s*(.+)$/i);
  if (lieferantLabeled && isPlausiblePartyValue(lieferantLabeled)) {
    setField(fields, 'Lieferant', lieferantLabeled, 'high');
  } else if (fields.Absender?.value) {
    setField(fields, 'Lieferant', fields.Absender.value, fields.Absender.confidence);
  }

  const siteLine = lines.find((line) => SITE_PATTERN.test(line));
  if (siteLine) {
    const match = siteLine.match(SITE_PATTERN);
    const value = match?.[1] ? cleanSiteCapture(match[1]) : undefined;
    if (value) {
      setField(fields, 'Baustelle', value, 'high');
    }
  }

  const siteInline = firstMatch(text, SITE_INLINE);
  if (siteInline) {
    const projectSibling = projectTitleFromSiteLabel(siteInline);
    if (projectSibling) {
      setField(fields, 'Projekt', projectSibling, 'medium');
      setField(fields, 'Vorgang', projectSibling, 'medium');
    }
    const cleaned = cleanSiteCapture(siteInline);
    if (isPlausibleSiteValue(cleaned)) {
      setField(fields, 'Baustelle', cleaned, 'medium');
    } else {
      const asProject = cleaned.replace(/\s+Pos\.?\s*.*$/i, '').trim();
      if (isPlausibleProjectValue(asProject)) {
        setField(fields, 'Projekt', asProject, 'medium');
        setField(fields, 'Vorgang', asProject, 'medium');
      }
    }
  }

  const lieferadresse = firstMatch(text, LIEFERADRESSE_INLINE);
  if (lieferadresse) {
    const cleaned = cleanSiteCapture(lieferadresse);
    if (isPlausibleSiteValue(cleaned)) {
      setField(fields, 'Straße', cleaned, 'high');
      const existingSite = fields.Baustelle?.value;
      if (!existingSite || !isPlausibleSiteValue(existingSite)) {
        // Prefer explicit delivery-address evidence over earlier non-site project-title captures.
        fields.Baustelle = { value: cleaned, confidence: 'high' };
      } else {
        setField(fields, 'Baustelle', cleaned, 'medium');
      }
    }
  }

  const projectInline = firstMatch(text, PROJECT_INLINE) ?? firstMatch(text, PROJECT_QUOTED);
  if (projectInline) {
    const projectSibling = projectTitleFromSiteLabel(projectInline);
    const streetSibling = cleanSiteCapture(projectInline);
    const title = (projectSibling ?? projectInline.split(/\s*[·|]\s*/)[0] ?? projectInline)
      .replace(/\s+Pos\.?\s*.*$/i, '')
      .trim();
    if (isPlausibleProjectValue(title)) {
      setField(fields, 'Projekt', title, 'medium');
      setField(fields, 'Vorgang', title, 'medium');
    }
    if (streetSibling && isPlausibleSiteValue(streetSibling)) {
      setField(fields, 'Baustelle', streetSibling, 'medium');
    }
  }

  const addressLine = lines.find((line) => ADDRESS_PATTERN.test(line));
  if (addressLine) {
    const match = addressLine.match(ADDRESS_PATTERN);
    if (match?.[1]?.trim()) {
      const cleaned = cleanSiteCapture(match[1]);
      if (isPlausibleSiteValue(cleaned)) {
        setField(fields, 'Straße', cleaned, 'high');
        setField(fields, 'Baustelle', cleaned, 'medium');
      }
    }
  }

  const cityLine = lines.find((line) => CITY_PATTERN.test(line));
  if (cityLine) {
    const cityMatch = cityLine.match(CITY_PATTERN);
    if (cityMatch) {
      const cityValue = `${cityMatch[1]} ${cityMatch[2]}`.trim();
      const confidence: FieldConfidenceLevel = /adresse|straße|strasse|ort|baustelle/i.test(cityLine)
        ? 'high'
        : 'medium';
      setField(fields, 'Ort', cityValue, confidence);
      // City/PLZ alone is not a construction site (often the issuer HQ).
    }
  }

  const labeledDateLine = pickLabeledValue(
    lines,
    /^(?:datum|vertragsdatum|belegdatum|lieferdatum|rechnungsdatum)\s*[:]\s*(.+)$/i,
  );
  const labeledDateInline = firstMatch(text, DATE_LABELED_INLINE);
  const labeledDate = labeledDateLine ?? labeledDateInline;
  if (labeledDate) {
    const range = labeledDate.match(
      /(\d{1,2})\.?[–—-](\d{1,2})\.(\d{1,2})\.(\d{2,4})/,
    );
    const dateOnly = range
      ? `${range[2]}.${range[3]}.${range[4].length === 2 ? `20${range[4]}` : range[4]}`
      : labeledDate.match(DATE_PATTERN)?.[1] ?? labeledDate.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    setField(fields, 'Datum', dateOnly ?? labeledDate, labeledDateLine ? 'high' : 'medium');
  } else {
    setField(fields, 'Datum', firstMatch(text, DATE_PATTERN), 'low');
  }

  setField(fields, 'Rechnungsnummer', firstMatch(text, INVOICE_NUMBER_PATTERN), 'high');
  setField(fields, 'Aktenzeichen', firstMatch(text, REFERENCE_PATTERN), 'high');
  // Vehicle docs often carry Kennzeichen instead of Az. — usable as reference fact.
  if (!fields.Aktenzeichen?.value) {
    const plate = firstMatch(text, KENNZEICHEN_LABELED);
    if (plate) setField(fields, 'Aktenzeichen', plate.replace(/\s+/g, ' ').trim(), 'medium');
  }
  setField(fields, 'Betrag', firstMatch(text, AMOUNT_PATTERN), 'high');
  if (fields.Betrag?.value) {
    fields.Betrag = {
      value: normalizeAmount(fields.Betrag.value),
      confidence: fields.Betrag.confidence,
    };
  }
  setField(fields, 'Frist', firstMatch(text, DEADLINE_PATTERN), 'high');

  const subjectLine = lines.find((line) => /^betreff\s*[:]/i.test(line));
  if (subjectLine) {
    setField(fields, 'Betreff', subjectLine.replace(/^betreff\s*[:]\s*/i, '').trim(), 'high');
  } else {
    const betreffInline = text.match(/\bbetreff\s*[:]\s*([^\n·]+)/i)?.[1]?.trim();
    if (betreffInline) {
      setField(fields, 'Betreff', betreffInline, 'medium');
    } else {
      const inferred = inferBetreffFromText(text);
      if (inferred) setField(fields, 'Betreff', inferred, 'medium');
    }
  }

  const gewerkLabeled = firstMatch(text, GEWERK_INLINE);
  if (gewerkLabeled && isPlausiblePartyValue(gewerkLabeled)) {
    setField(fields, 'Gewerk', gewerkLabeled, 'high');
  } else {
    const body = text.slice(Math.min(180, text.length));
    let gewerkKeyword = body.match(GEWERK_KEYWORD)?.[1] ?? text.match(GEWERK_KEYWORD)?.[1];
    if (gewerkKeyword && /^heiz/i.test(gewerkKeyword)) gewerkKeyword = 'Heizung';
    if (gewerkKeyword) setField(fields, 'Gewerk', gewerkKeyword, 'medium');
  }

  if (!fields.Baustelle?.value && fields.Straße?.value) {
    const street = fields.Straße.value;
    const ort = fields.Ort?.value?.replace(/^\d{4,5}\s+/, '').trim();
    const combined = ort && !street.includes(ort) ? `${street}, ${ort}` : street;
    if (isPlausibleSiteValue(combined)) {
      setField(fields, 'Baustelle', combined, 'medium');
    }
  }

  return fields;
}

export function toConfidentPlainFields(
  fields: ExtractedDocumentFieldsWithConfidence,
): ExtractedDocumentFields {
  const plain: ExtractedDocumentFields = {};
  for (const [key, field] of Object.entries(fields) as Array<
    [keyof ExtractedDocumentFields, ConfidentField]
  >) {
    if (!field || !isFieldConfidentEnough(field.confidence)) continue;
    plain[key] = field.value;
  }
  return plain;
}

export function listUncertainFieldKeys(
  fields: ExtractedDocumentFieldsWithConfidence,
): Array<keyof ExtractedDocumentFields> {
  return (Object.keys(fields) as Array<keyof ExtractedDocumentFields>).filter((key) => {
    const field = fields[key];
    return Boolean(field?.value?.trim()) && field?.confidence === 'low';
  });
}

export function extractFieldsFromText(text: string): ExtractedDocumentFields {
  return toConfidentPlainFields(extractFieldsWithConfidence(text));
}

export function mergeExtractedFields(
  base: Record<string, string>,
  extracted: ExtractedDocumentFields,
): Record<string, string> {
  const merged = { ...base };
  const extractedWins = new Set<keyof ExtractedDocumentFields>([
    'Kunde',
    'Absender',
    'Lieferant',
    'Empfänger',
    'Baustelle',
    'Projekt',
    'Gewerk',
    'Betreff',
    'Datum',
    'Vorgang',
    'Aktenzeichen',
    'Straße',
    'Ort',
    'Frist',
    'Rechnungsnummer',
    'Betrag',
  ]);

  for (const [key, value] of Object.entries(extracted) as Array<
    [keyof ExtractedDocumentFields, string]
  >) {
    if (!value?.trim()) continue;
    const existing = merged[key];
    if (key === 'Baustelle') {
      merged.Baustelle = preferConstructionSiteMergeValue(existing, value.trim());
      continue;
    }
    const placeholder =
      !existing ||
      /^RE-2026|^ca\.|^Unbekannt|^Lieferant$|^Kunde$|^Absender$|^Interessent$|^Tankstelle$|^Baustelle laut|^Mitarbeiter$|^Dokument$/i.test(
        existing,
      );
    if (placeholder || extractedWins.has(key)) {
      merged[key] = value.trim();
    }
  }

  if (merged.Kunde?.trim() && !merged.Auftraggeber?.trim()) {
    merged.Auftraggeber = merged.Kunde.trim();
  }
  if (merged.Projekt?.trim() && !merged.Bauvorhaben?.trim()) {
    merged.Bauvorhaben = merged.Projekt.trim();
  }

  return merged;
}
