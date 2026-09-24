/**
 * E-RECHNUNG-04E2 — die ZUGFeRD-Angaben im XMP des Hybriddokuments.
 *
 * ## Wozu das überhaupt nötig ist
 *
 * Ein ZUGFeRD-PDF ist von aussen ein gewöhnliches PDF/A-3 mit einem Anhang.
 * Damit ein Empfänger **ohne** die Datei zu öffnen erkennt, dass darin eine
 * strukturierte Rechnung steckt und welcher Art, trägt das XMP zwei Dinge:
 *
 *  1. Einen `fx:`-Block mit Dateiname, Dokumenttyp, Version und Profilstufe.
 *  2. Ein **PDF/A-Erweiterungsschema**, das diesen Block anmeldet. PDF/A
 *     erlaubt keine beliebigen Metadaten: Wer einen eigenen Namensraum
 *     benutzt, muss ihn im Dokument selbst beschreiben — Name, URI, Präfix und
 *     jede Eigenschaft mit Typ, Kategorie und Beschreibung. Fehlt das, ist das
 *     Dokument kein gültiges PDF/A mehr.
 *
 * Genau deshalb sind das hier zwei Blöcke und nicht einer, und genau deshalb
 * wurde der `fx:`-Block in 04E1 bewusst noch **nicht** geschrieben: Ohne
 * eingebettete Datei hätte er eine Rechnung behauptet, die es nicht gab.
 *
 * ## Warum das nicht in der PDF/A-Schicht steht
 *
 * `pdfa/pdfaXmp.ts` weiss, was PDF/A verlangt. Es soll nicht zusätzlich
 * wissen, was ZUGFeRD verlangt — sonst wäre die allgemeine Schicht an ein
 * einzelnes Rechnungsformat gebunden. Diese Datei erzeugt die Blöcke als Text
 * und reicht sie dort als `additionalDescriptions` hinein.
 *
 * Alle Bezeichner, Namensräume, Werte und Beschreibungen stammen aus
 * `zugferdProfile.ts`; deren Herkunft ist dort belegt. Ausgabe deterministisch.
 */
import { escapeXmlAttribute, escapeXmlText } from '../einvoiceXmlWriter';
import {
  ZUGFERD_XMP_CONFORMANCE_LEVEL,
  ZUGFERD_XMP_DOCUMENT_TYPE,
  ZUGFERD_XMP_NAMESPACE,
  ZUGFERD_XMP_PREFIX,
  ZUGFERD_XMP_PROPERTIES,
  ZUGFERD_XMP_SCHEMA_LABEL,
  ZUGFERD_XMP_VERSION,
} from './zugferdProfile';

export interface ZugferdXmpInput {
  /** Muss exakt dem Namen des eingebetteten Anhangs entsprechen. */
  readonly documentFileName: string;
  readonly documentType?: string;
  readonly version?: string;
  readonly conformanceLevel?: string;
}

/**
 * Das PDF/A-Erweiterungsschema, das den `fx:`-Namensraum anmeldet.
 *
 * Aufbau und Wortlaut folgen `XMPSchemaPDFAExtensions.attachExtensions` der
 * Referenzimplementierung: ein `pdfaExtension:schemas`-Bag mit einem Eintrag,
 * darin Schemaname, Namensraum-URI, Präfix und eine `pdfaSchema:property`-Seq
 * mit vier Einträgen. Jeder Eintrag nennt Name, Werttyp (`Text`), Kategorie
 * (`external`) und eine Beschreibung.
 *
 * `rdf:parseType="Resource"` ist an beiden Stellen nötig: Die Listeneinträge
 * sind strukturierte Werte, keine Literale.
 */
function buildExtensionSchema(): string {
  const properties = ZUGFERD_XMP_PROPERTIES.map((property) =>
    [
      '              <rdf:li rdf:parseType="Resource">',
      `                <pdfaProperty:name>${escapeXmlText(property.name)}</pdfaProperty:name>`,
      '                <pdfaProperty:valueType>Text</pdfaProperty:valueType>',
      '                <pdfaProperty:category>external</pdfaProperty:category>',
      `                <pdfaProperty:description>${escapeXmlText(property.description)}</pdfaProperty:description>`,
      '              </rdf:li>',
    ].join('\n'),
  );

  return [
    '    <rdf:Description rdf:about=""',
    '        xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"',
    '        xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"',
    '        xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">',
    '      <pdfaExtension:schemas>',
    '        <rdf:Bag>',
    '          <rdf:li rdf:parseType="Resource">',
    `            <pdfaSchema:schema>${escapeXmlText(ZUGFERD_XMP_SCHEMA_LABEL)}</pdfaSchema:schema>`,
    `            <pdfaSchema:namespaceURI>${escapeXmlText(ZUGFERD_XMP_NAMESPACE)}</pdfaSchema:namespaceURI>`,
    `            <pdfaSchema:prefix>${escapeXmlText(ZUGFERD_XMP_PREFIX)}</pdfaSchema:prefix>`,
    '            <pdfaSchema:property>',
    '              <rdf:Seq>',
    ...properties,
    '              </rdf:Seq>',
    '            </pdfaSchema:property>',
    '          </rdf:li>',
    '        </rdf:Bag>',
    '      </pdfaExtension:schemas>',
    '    </rdf:Description>',
  ].join('\n');
}

/**
 * Der `fx:`-Block mit den vier angemeldeten Eigenschaften.
 *
 * Die Reihenfolge entspricht der Anmeldung im Erweiterungsschema. Der
 * Dateiname muss mit dem tatsächlichen Anhang übereinstimmen — ein XMP, das
 * eine andere Datei nennt als die, die im PDF liegt, führt jedes
 * automatisierte Auslesen in die Irre. Der Artefaktdienst gibt deshalb beide
 * aus derselben Konstante.
 */
function buildFacturXBlock(input: ZugferdXmpInput): string {
  const prefix = ZUGFERD_XMP_PREFIX;
  return [
    '    <rdf:Description rdf:about=""',
    `        xmlns:${prefix}="${escapeXmlAttribute(ZUGFERD_XMP_NAMESPACE)}">`,
    `      <${prefix}:DocumentFileName>${escapeXmlText(input.documentFileName)}</${prefix}:DocumentFileName>`,
    `      <${prefix}:DocumentType>${escapeXmlText(input.documentType ?? ZUGFERD_XMP_DOCUMENT_TYPE)}</${prefix}:DocumentType>`,
    `      <${prefix}:Version>${escapeXmlText(input.version ?? ZUGFERD_XMP_VERSION)}</${prefix}:Version>`,
    `      <${prefix}:ConformanceLevel>${escapeXmlText(input.conformanceLevel ?? ZUGFERD_XMP_CONFORMANCE_LEVEL)}</${prefix}:ConformanceLevel>`,
    '    </rdf:Description>',
  ].join('\n');
}

/**
 * Die beiden zusätzlichen XMP-Blöcke eines ZUGFeRD-Dokuments.
 *
 * Reihenfolge: erst das Erweiterungsschema, dann der Block, den es anmeldet.
 * Umgekehrt wäre es nicht falsch, aber weniger lesbar — und Lesbarkeit ist
 * bei Metadaten, die zehn Jahre überdauern sollen, kein Nebenthema.
 */
export function buildZugferdXmpDescriptions(input: ZugferdXmpInput): readonly string[] {
  return [buildExtensionSchema(), buildFacturXBlock(input)];
}
