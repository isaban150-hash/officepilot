/**
 * E-RECHNUNG-04D — die kontrollierte XML-Schreibschicht.
 *
 * Bewusst kein generischer XML-Baukasten: Die Zielstruktur ist vollständig
 * bekannt und geschlossen, und eine Fremdbibliothek brächte Freiheitsgrade,
 * die hier niemand braucht — allen voran eine Ausgabereihenfolge, die von
 * Objektschlüsseln abhängt. Determinismus ist in diesem Bereich kein Komfort:
 * Aus ihm folgt, dass derselbe Beleg immer dieselben Bytes und damit denselben
 * Prüfwert ergibt.
 *
 * Diese Datei kennt **keine** Rechnungsfachlichkeit. Sie maskiert, formatiert
 * und setzt Elemente — nichts sonst.
 *
 * Rein: kein Zustand, keine Uhr, kein Zufall.
 */

/**
 * Ein Zeichen, das XML 1.0 nicht darstellen kann.
 *
 * Erlaubt sind Tabulator, Zeilenvorschub und Wagenrücklauf; alles andere
 * unterhalb von 0x20 ist im Dokument verboten, ebenso die beiden
 * Nicht-Zeichen 0xFFFE und 0xFFFF und einzelne Ersatzzeichen ohne Partner.
 *
 * Solche Zeichen werden **nicht** stillschweigend entfernt. Ein Rechnungstext,
 * aus dem der Serialisierer eigenmächtig Zeichen tilgt, ist nicht mehr der
 * Text, den der Betrieb geschrieben hat — und niemand würde es bemerken.
 * Stattdessen bricht der Bau ab und sagt, wo.
 */
export class XmlUnrepresentableCharacterError extends Error {
  constructor(readonly codePoint: number) {
    super(`xml_control_character:0x${codePoint.toString(16)}`);
    this.name = 'XmlUnrepresentableCharacterError';
  }
}

function assertRepresentable(value: string): void {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20) throw new XmlUnrepresentableCharacterError(code);
    if (code === 0xfffe || code === 0xffff) throw new XmlUnrepresentableCharacterError(code);
    // Einzelne Ersatzzeichen (halbe Paare) sind kein gültiges Zeichen.
    if (code >= 0xd800 && code <= 0xdfff) throw new XmlUnrepresentableCharacterError(code);
  }
}

/**
 * Text für einen Elementinhalt.
 *
 * `&` zuerst, sonst würden die eigenen Ersetzungen erneut maskiert. `>` wird
 * mitmaskiert, obwohl es im Inhalt nur in der Folge `]]>` zwingend nötig wäre:
 * Die Ausnahme zu kennen hilft niemandem, und die Regel ohne Ausnahme ist die,
 * die auch in fünf Jahren noch stimmt.
 */
export function escapeXmlText(value: string): string {
  assertRepresentable(value);
  return value
    .split('&')
    .join('&amp;')
    .split('<')
    .join('&lt;')
    .split('>')
    .join('&gt;');
}

/** Text für einen Attributwert — zusätzlich beide Anführungszeichen. */
export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .split('"')
    .join('&quot;')
    .split("'")
    .join('&apos;');
}

/* ------------------------------------------------------------------ */
/* Zahlen und Daten                                                    */
/* ------------------------------------------------------------------ */

/**
 * Ein Geldbetrag in normgerechter Schreibweise.
 *
 * Immer Punkt als Trennzeichen, immer zwei Nachkommastellen, nie eine
 * Exponentialschreibweise und nie eine lokalisierte Ausgabe wie `1.234,56`.
 * `toFixed` erledigt beides zuverlässig; `Intl` wäre hier die falsche Wahl,
 * weil sein Ergebnis von der Umgebung abhängt.
 *
 * `-0` wird zu `0.00` geglättet — ein negatives Null wäre inhaltlich sinnlos
 * und in einem Byte-Vergleich eine stille Abweichung.
 */
export function formatXmlAmount(value: number): string {
  if (!Number.isFinite(value)) throw new Error('xml_amount_not_finite');
  const rounded = Math.round(value * 100) / 100;
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(2);
}

/**
 * Eine Menge. Bis zu vier Nachkommastellen, ohne nachlaufende Nullen — eine
 * Menge ist kein Geld und soll nicht als `2.00` erscheinen.
 */
export function formatXmlQuantity(value: number): string {
  if (!Number.isFinite(value)) throw new Error('xml_quantity_not_finite');
  const rounded = Math.round(value * 10000) / 10000;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return normalized.toFixed(4).replace(/\.?0+$/, '') || '0';
}

/** Ein Prozentsatz — wie ein Betrag, damit `0` nicht neben `0.00` steht. */
export function formatXmlPercent(value: number): string {
  return formatXmlAmount(value);
}

/**
 * Ein Datum im CII-Format 102 (`JJJJMMTT`).
 *
 * Erwartet ein ISO-Datum, wie es der Beleg trägt. Alles andere ist ein Fehler
 * und keine Gelegenheit zum Raten.
 */
export function formatXmlDate102(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) throw new Error(`xml_date_invalid:${isoDate}`);
  return `${match[1]}${match[2]}${match[3]}`;
}

/* ------------------------------------------------------------------ */
/* Elemente                                                            */
/* ------------------------------------------------------------------ */

export type XmlAttributes = ReadonlyArray<readonly [name: string, value: string]>;

/**
 * Ein Element mit Textinhalt.
 *
 * Attribute kommen als Liste, nicht als Objekt: Eine Liste hat eine
 * Reihenfolge, ein Objekt hat sie nur zufällig. Genau daran scheitert
 * Byte-Gleichheit sonst irgendwann.
 */
export function xmlLeaf(
  name: string,
  value: string,
  attributes: XmlAttributes = [],
  indent = 0,
): string {
  return `${' '.repeat(indent)}<${name}${renderAttributes(attributes)}>${escapeXmlText(value)}</${name}>`;
}

/** Ein Element, das andere umschliesst. Leere Kinderlisten ergeben `<name/>`. */
export function xmlNode(
  name: string,
  children: ReadonlyArray<string | null | undefined>,
  indent = 0,
  attributes: XmlAttributes = [],
): string {
  const pad = ' '.repeat(indent);
  const inner = children.filter((child): child is string => typeof child === 'string' && child.length > 0);
  if (inner.length === 0) return `${pad}<${name}${renderAttributes(attributes)}/>`;
  return [`${pad}<${name}${renderAttributes(attributes)}>`, ...inner, `${pad}</${name}>`].join('\n');
}

function renderAttributes(attributes: XmlAttributes): string {
  return attributes.map(([name, value]) => ` ${name}="${escapeXmlAttribute(value)}"`).join('');
}

/** Die Dokumentdeklaration — immer identisch, immer UTF-8. */
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
