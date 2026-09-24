/**
 * E-RECHNUNG-04E2 — die verbindlichen Kennungen von ZUGFeRD 2.5.2 / Factur-X 1.09.2.
 *
 * ## Woher diese Werte stammen
 *
 * Das Infopaket von FeRD und FNFE-MPE steht nur hinter einem Anmeldeformular
 * bereit. Die **normativen Artefakte** daraus — XSD, Schematron, Profil-,
 * XMP- und Anhangskennungen — werden von der Referenzimplementierung des
 * ZUGFeRD-Projekts unverändert mitgeliefert und sind dort öffentlich:
 *
 *   github.com/ZUGFeRD/mustangproject, Stand `core-2.26.0`
 *     - `validator/src/main/resources/schema/ZF_250/EN16931/FACTUR-X_EN16931.xsd`
 *     - `validator/src/main/resources/zugferd2p0_en16931.sch`
 *     - `library/src/main/java/org/mustangproject/ZUGFeRD/Profiles.java`
 *     - `library/src/main/java/org/mustangproject/ZUGFeRD/ZUGFeRDExporterFromA3.java`
 *     - `library/src/main/java/org/mustangproject/ZUGFeRD/XMPSchemaZugferd.java`
 *     - `library/src/main/java/org/mustangproject/ZUGFeRD/XMPSchemaPDFAExtensions.java`
 *
 * Release 2.25.0 dieses Projekts nennt die Unterstützung von ZUGFeRD 2.5.2
 * (= Factur-X 1.09.2) ausdrücklich in den Veröffentlichungshinweisen.
 *
 * **Kein Wert in dieser Datei ist geraten oder aus einem Beispiel im Netz
 * übernommen.** Jeder einzelne ist an genau einer dieser Quellen abgelesen.
 *
 * ## Die Fallstricke, die hier abgeräumt sind
 *
 * Drei Werte sehen harmlos aus und sind es nicht:
 *
 *  - Die Guideline-Kennung des Profils EN16931 ist **ohne** Zusatz. Jede
 *    andere Zeichenfolge lässt den Prüfer ein anderes Profil wählen.
 *  - Die Konformitätsstufe heisst im XMP `EN 16931` — **mit Leerzeichen**,
 *    anders als der Profilname `EN16931`.
 *  - Der Medientyp des Anhangs ist `text/xml`, nicht `application/xml`.
 */

/** Die Guideline-Kennung (BT-24) des Profils EN16931. Siehe `Profiles.java`. */
export const ZUGFERD_EN16931_GUIDELINE_ID = 'urn:cen.eu:en16931:2017';

/**
 * Die Profilkennungen der übrigen Stufen — **nicht** zum Erzeugen, sondern zur
 * Abgrenzung.
 *
 * Sie stehen hier, damit ein Test belegen kann, dass OfficeTakt genau EN16931
 * erzeugt und keine der anderen Stufen; und damit niemand später versehentlich
 * die XRechnung-Kennung einsetzt, die hier als eigener Eintrag sichtbar ist.
 */
export const ZUGFERD_OTHER_PROFILE_IDS = {
  minimum: 'urn:factur-x.eu:1p0:minimum',
  basicwl: 'urn:factur-x.eu:1p0:basicwl',
  basic: 'urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic',
  extended: 'urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended',
  xrechnung: 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0',
} as const;

/** Die CII-Namensräume des Profils, aus `FACTUR-X_EN16931.xsd`. */
export const ZUGFERD_NAMESPACES = [
  ['xmlns:rsm', 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100'],
  ['xmlns:ram', 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100'],
  ['xmlns:qdt', 'urn:un:unece:uncefact:data:standard:QualifiedDataType:100'],
  ['xmlns:udt', 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100'],
] as const satisfies ReadonlyArray<readonly [string, string]>;

/* ------------------------------------------------------------------ */
/* Einbettung in das PDF                                               */
/* ------------------------------------------------------------------ */

/**
 * Der Dateiname des eingebetteten Rechnungsdatensatzes.
 *
 * `getFilenameForVersion` liefert für Factur-X genau diesen Namen. Der
 * abweichende Name `xrechnung.xml` ist dort ausdrücklich dem Referenzprofil
 * XRECHNUNG vorbehalten und hier deshalb falsch.
 */
export const ZUGFERD_EMBEDDED_FILE_NAME = 'factur-x.xml';

/**
 * Der Medientyp des Anhangs, aus `ZUGFeRDExporterFromA3.prepare()`.
 *
 * Bewusst `text/xml` und nicht `application/xml`: Die Referenzimplementierung
 * setzt genau diesen Wert, und der XRechnung-Anhang aus 04D3 verwendet
 * daneben weiterhin `application/xml`. Die beiden sind verschiedene Artefakte
 * und dürfen verschiedene Typen tragen.
 */
export const ZUGFERD_EMBEDDED_MIME_TYPE = 'text/xml';

/**
 * Die Beziehung des Anhangs zum Dokument (`/AFRelationship`).
 *
 * `Alternative` für EN16931. In derselben Funktion steht die einzige Ausnahme:
 * Nur MINIMUM und BASIC WL verwenden `Data`, weil sie keine vollständige
 * Rechnung enthalten. EN16931 ist vollständig, also eine gleichwertige
 * Darstellung desselben Belegs.
 */
export const ZUGFERD_AF_RELATIONSHIP = 'Alternative';

/** Die Beschreibung des Anhangs, wörtlich aus `ZUGFeRDExporterFromA3`. */
export const ZUGFERD_EMBEDDED_DESCRIPTION =
  'Invoice metadata conforming to ZUGFeRD standard (https://www.ferd-net.de/en/standards/zugferd/factur-x)';

/* ------------------------------------------------------------------ */
/* XMP                                                                 */
/* ------------------------------------------------------------------ */

/** Namensraum und Präfix des Factur-X-XMP-Blocks, aus `getNamespaceForVersion(2)`. */
export const ZUGFERD_XMP_NAMESPACE = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#';
export const ZUGFERD_XMP_PREFIX = 'fx';

/** `fx:DocumentType`. */
export const ZUGFERD_XMP_DOCUMENT_TYPE = 'INVOICE';

/**
 * `fx:ConformanceLevel` — **mit Leerzeichen**.
 *
 * `Profile.getXMPName()` bildet den Profilnamen `EN16931` ausdrücklich auf
 * `EN 16931` ab. Der Profilname im XML und die Stufe im XMP sind also nicht
 * dieselbe Zeichenfolge; wer das übersieht, erzeugt ein Dokument, dessen
 * Metadaten nicht zu seinem Inhalt passen.
 */
export const ZUGFERD_XMP_CONFORMANCE_LEVEL = 'EN 16931';

/**
 * `fx:Version` — die Fassung des XMP-Datensatzes, nicht die des Standards.
 *
 * `XMPSchemaZugferd` setzt für Factur-X `1.0`. Das ist bewusst **nicht**
 * `1.09.2` und nicht `2.5.2`: Das Feld beschreibt die Version des
 * XMP-Schemas, und die steht seit Factur-X 1.0 unverändert.
 */
export const ZUGFERD_XMP_VERSION = '1.0';

/** Der Name des Erweiterungsschemas im PDF/A-Extension-Block. */
export const ZUGFERD_XMP_SCHEMA_LABEL = 'Factur-X PDFA Extension Schema';

/**
 * Die vier Eigenschaften des Erweiterungsschemas, wörtlich wie in
 * `XMPSchemaPDFAExtensions.attachExtensions`. Reihenfolge und Beschreibungen
 * sind übernommen und nicht umformuliert.
 */
export const ZUGFERD_XMP_PROPERTIES = [
  { name: 'DocumentFileName', description: 'name of the embedded XML invoice file' },
  { name: 'DocumentType', description: 'INVOICE' },
  { name: 'Version', description: 'The actual version of the ZUGFeRD XML schema' },
  { name: 'ConformanceLevel', description: 'The selected ZUGFeRD profile completeness' },
] as const;

/** Die Fassung des Erzeugers — Teil der Artefaktkennung. */
export const ZUGFERD_GENERATOR_VERSION = 'officetakt-zugferd-en16931-1';
