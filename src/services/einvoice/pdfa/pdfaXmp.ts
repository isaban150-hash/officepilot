/**
 * E-RECHNUNG-04E1 — die XMP-Metadaten eines PDF/A-Dokuments.
 *
 * XMP ist in einem PDF/A-Dokument keine Zierde, sondern die Stelle, an der das
 * Dokument **von sich selbst behauptet**, PDF/A zu sein: `pdfaid:part` und
 * `pdfaid:conformance` sind das, woran jeder Prüfer zuerst schaut. Fehlen sie,
 * ist die Datei ein gewöhnliches PDF, ganz gleich wie sauber der Rest ist.
 *
 * Zwei Dinge, die hier leicht übersehen werden und beide zum Durchfallen führen:
 *
 *  - **Synchronität.** Was in der Info-Dictionary steht (`/Title`, `/Creator`,
 *    `/Producer`, `/CreationDate`, `/ModDate`), muss in XMP dasselbe sagen.
 *    Deshalb nimmt diese Funktion genau die Werte entgegen, die der Aufrufer
 *    auch in die Info-Dictionary schreibt — eine Quelle, zwei Ausgaben.
 *  - **Leere Felder.** Ein `<dc:title>` mit leerem Inhalt ist schlechter als gar
 *    keines. Nicht gesetzte optionale Angaben werden weggelassen, nicht leer
 *    geschrieben.
 *
 * Die Ausgabe ist **deterministisch**: feste Reihenfolge, feste Einrückung,
 * keine erzeugten Zufallswerte, keine Uhrzeit von aussen. Gleiche Eingabe,
 * gleiche Bytes.
 *
 * Für 04E2 ist hier bewusst noch **nichts** ZUGFeRD-spezifisches eingetragen.
 * Ein `fx:DocumentType`-Block, während gar kein XML eingebettet ist, wäre eine
 * Behauptung über einen Beleg, den es nicht gibt. Die Erweiterung gehört in den
 * Block, der die Einbettung mitbringt.
 */
import { escapeXmlAttribute, escapeXmlText } from '../einvoiceXmlWriter';
import { PDFA_CONFORMANCE, PDFA_PART, type PdfAConformance } from './pdfaProfile';

export interface PdfAXmpInput {
  /** Muss `/Title` der Info-Dictionary entsprechen. */
  readonly title: string;
  /** Muss `/Author` entsprechen; weggelassen, wenn leer. */
  readonly author?: string;
  /** Muss `/Subject` entsprechen; weggelassen, wenn leer. */
  readonly subject?: string;
  /** Muss `/Creator` entsprechen — die Anwendung, die das Dokument verfasst hat. */
  readonly creatorTool: string;
  /** Muss `/Producer` entsprechen — die Bibliothek, die die Bytes geschrieben hat. */
  readonly producer: string;
  /** Muss `/CreationDate` entsprechen. */
  readonly createdAt: Date;
  /** Muss `/ModDate` entsprechen. */
  readonly modifiedAt: Date;
  readonly part?: number;
  readonly conformance?: PdfAConformance;
  /**
   * E-RECHNUNG-04E2 — zusätzliche `rdf:Description`-Blöcke, fertig gerendert.
   *
   * Ein hybrides Rechnungsformat wie ZUGFeRD braucht im XMP einen eigenen
   * Metadatenblock **und** ein PDF/A-Erweiterungsschema, das ihn anmeldet.
   * Beides gehört fachlich nicht hierher: Diese Datei weiss, was PDF/A
   * verlangt, und soll nicht zusätzlich wissen, was ZUGFeRD verlangt.
   *
   * Deshalb nimmt sie die Blöcke als Text entgegen und fügt sie an der
   * richtigen Stelle ein — innerhalb von `rdf:RDF`, nach den PDF/A-eigenen
   * Angaben. Wer sie erzeugt, verantwortet ihren Inhalt; siehe
   * `zugferd/zugferdXmp.ts`.
   */
  readonly additionalDescriptions?: readonly string[];
}

/**
 * Der Zeitstempel in der Schreibweise, die XMP verlangt — und in derselben
 * Zeitzone, in der `pdf-lib` die Info-Dictionary schreibt (UTC mit `Z`).
 * Liefen die beiden auseinander, bemängelte der Prüfer die Synchronität.
 */
export function formatXmpDate(value: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}` +
    `T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}Z`
  );
}

/** Ein `rdf:Alt` mit einem sprachneutralen Eintrag — die Form, die dc:title verlangt. */
function altText(tag: string, value: string, indent: string): string {
  return [
    `${indent}<${tag}>`,
    `${indent}  <rdf:Alt>`,
    `${indent}    <rdf:li xml:lang="${escapeXmlAttribute('x-default')}">${escapeXmlText(value)}</rdf:li>`,
    `${indent}  </rdf:Alt>`,
    `${indent}</${tag}>`,
  ].join('\n');
}

/** Ein `rdf:Seq` mit einem Eintrag — die Form, die dc:creator verlangt. */
function seqText(tag: string, value: string, indent: string): string {
  return [
    `${indent}<${tag}>`,
    `${indent}  <rdf:Seq>`,
    `${indent}    <rdf:li>${escapeXmlText(value)}</rdf:li>`,
    `${indent}  </rdf:Seq>`,
    `${indent}</${tag}>`,
  ].join('\n');
}

/**
 * Das XMP-Paket als Text.
 *
 * Die `xpacket`-Klammer gehört dazu: Sie erlaubt es Werkzeugen, die Metadaten in
 * einer Datei zu finden, ohne das PDF zu verstehen. `id` ist der feste, in der
 * XMP-Spezifikation vorgegebene Wert; `end="w"` bedeutet, dass das Paket
 * beschreibbar ist.
 */
export function buildPdfAXmp(input: PdfAXmpInput): string {
  const part = input.part ?? PDFA_PART;
  const conformance = input.conformance ?? PDFA_CONFORMANCE;
  const created = formatXmpDate(input.createdAt);
  const modified = formatXmpDate(input.modifiedAt);

  const dcEntries = [altText('dc:title', input.title, '        ')];
  if (input.author?.trim()) dcEntries.push(seqText('dc:creator', input.author.trim(), '        '));
  if (input.subject?.trim()) {
    dcEntries.push(altText('dc:description', input.subject.trim(), '        '));
  }

  return [
    /* Das BOM im `begin` ist vorgeschrieben — es weist die Kodierung aus. */
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '    <rdf:Description rdf:about=""',
    '        xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">',
    `      <pdfaid:part>${escapeXmlText(String(part))}</pdfaid:part>`,
    `      <pdfaid:conformance>${escapeXmlText(conformance)}</pdfaid:conformance>`,
    '    </rdf:Description>',
    '    <rdf:Description rdf:about=""',
    '        xmlns:dc="http://purl.org/dc/elements/1.1/">',
    ...dcEntries,
    '    </rdf:Description>',
    '    <rdf:Description rdf:about=""',
    '        xmlns:xmp="http://ns.adobe.com/xap/1.0/">',
    `      <xmp:CreatorTool>${escapeXmlText(input.creatorTool)}</xmp:CreatorTool>`,
    `      <xmp:CreateDate>${created}</xmp:CreateDate>`,
    `      <xmp:ModifyDate>${modified}</xmp:ModifyDate>`,
    /*
     * MetadataDate ist der Stand der Metadaten, nicht des Inhalts. Solange nach
     * dem Erzeugen nichts mehr angefasst wird, ist das derselbe Zeitpunkt — und
     * genau deshalb wird hier keine zweite Uhr gelesen.
     */
    `      <xmp:MetadataDate>${modified}</xmp:MetadataDate>`,
    '    </rdf:Description>',
    '    <rdf:Description rdf:about=""',
    '        xmlns:pdf="http://ns.adobe.com/pdf/1.3/">',
    `      <pdf:Producer>${escapeXmlText(input.producer)}</pdf:Producer>`,
    '    </rdf:Description>',
    ...(input.additionalDescriptions ?? []),
    '  </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
}
