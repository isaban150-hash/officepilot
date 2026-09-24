/**
 * E-RECHNUNG-04E1 — die PDF/A-3-Verpackung eines bestehenden PDF-Dokuments.
 *
 * ## Warum diese Schicht überhaupt existiert
 *
 * `pdf-lib` kennt PDF/A nicht. Es gibt keine High-Level-Funktion, die ein
 * Dokument konform macht; die nötigen Strukturen müssen als PDF-Objekte angelegt
 * werden. Damit diese Objektbastelei **nicht** durch `invoicePdfService` wandert,
 * steckt sie vollständig hier: Der Renderer ruft eine Funktion auf und weiss von
 * `PDFDict`, `PDFName` und Objektreferenzen nichts.
 *
 * Es wird dabei ausschliesslich mit dem regulären Objektmodell gearbeitet — keine
 * Byte-Patcherei am fertigen Dokument, kein Suchen-und-Ersetzen im PDF-Strom.
 * Alles, was hier entsteht, entsteht als PDF-Objekt und wird vom Schreiber von
 * `pdf-lib` normal serialisiert.
 *
 * ## Was gemessen fehlte
 *
 * Grundlage ist keine Erinnerung, sondern ein Lauf von veraPDF 1.30.2 gegen das
 * unveränderte Rechnungs-PDF. Von 148 geprüften Regeln schlugen genau drei fehl:
 *
 *  - `6.1.3-1`   — im Trailer fehlt `/ID`
 *  - `6.6.2.1-1` — im Katalog fehlt `/Metadata` (XMP)
 *  - `6.2.4.3-2` — `DeviceRGB` ohne RGB-OutputIntent (70 Fundstellen)
 *
 * Alles andere — eingebettete Schriften, Unicode-Zuordnung, Farbräume, verbotene
 * Merkmale — war bereits erfüllt. Diese Datei schliesst genau diese drei Lücken
 * und fasst sonst nichts an.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  type PDFRef,
} from 'pdf-lib';

import { sha256Bytes } from '../../sha256Digest';
import { PDFA_ICC_COMPONENT_COUNT, loadPdfAColorProfile } from './pdfaColorProfile';
import {
  PDFA_CONFORMANCE,
  PDFA_OUTPUT_CONDITION_IDENTIFIER,
  PDFA_OUTPUT_CONDITION_REGISTRY,
  PDFA_OUTPUT_INTENT_SUBTYPE,
  PDFA_PART,
  PDFA_PRODUCER,
} from './pdfaProfile';
import { buildPdfAXmp } from './pdfaXmp';

export interface PdfAMetadata {
  /** Der Titel des Dokuments, z. B. `Rechnung 2026-0042`. */
  readonly title: string;
  /** Der Aussteller. Weggelassen, wenn leer. */
  readonly author?: string;
  /** Eine knappe Beschreibung. Weggelassen, wenn leer. */
  readonly subject?: string;
  /** Die erzeugende Anwendung. */
  readonly creatorTool: string;
  /**
   * Der Zeitpunkt des Dokuments — **kein** `new Date()` im Inneren.
   *
   * Siehe `buildDeterministicFileId`: Dieser Wert entscheidet mit darüber, ob
   * zweimaliges Erzeugen dieselben Bytes ergibt. Der Aufrufer reicht deshalb
   * einen fachlichen Zeitpunkt herein — das Rechnungsdatum, den
   * Freigabezeitpunkt — und nicht die Uhr des Geräts.
   */
  readonly createdAt: Date;
  /** Üblicherweise derselbe Wert wie `createdAt`; ein Archivbeleg wird nicht geändert. */
  readonly modifiedAt?: Date;
  /**
   * Der Ausgangswert der Dokumentkennung `/ID`. Gleiche Eingabe, gleiche
   * Kennung. Fehlt er, wird aus Titel und Zeitpunkt abgeleitet.
   */
  readonly idSeed?: string;
  /**
   * E-RECHNUNG-04E2 — zusätzliche XMP-Blöcke, fertig gerendert.
   *
   * Für ein hybrides Rechnungsformat sind das der Formatblock und das
   * PDF/A-Erweiterungsschema, das ihn anmeldet. Diese Schicht reicht sie
   * durch, ohne ihren Inhalt zu kennen — siehe `pdfaXmp`.
   */
  readonly additionalXmpDescriptions?: readonly string[];
}

/**
 * Die Dokumentkennung `/ID` — abgeleitet, nicht gewürfelt.
 *
 * PDF/A verlangt sie (Regel 6.1.3-1); die Spezifikation schlägt dafür einen aus
 * Zeit und Dateipfad gebildeten Wert vor. Genau das wäre hier schädlich: Ein
 * Zufalls- oder Uhrzeitwert machte jeden Lauf byteverschieden, und damit liesse
 * sich nie belegen, dass zweimal derselbe Beleg erzeugt wurde.
 *
 * Deshalb ein Hash über einen fachlichen Ausgangswert. Beide Einträge des
 * Arrays sind gleich — das ist die vorgesehene Form für ein Dokument, das seit
 * seiner Erstellung nicht verändert wurde.
 */
export function buildDeterministicFileId(seed: string): string {
  const digest = sha256Bytes(new TextEncoder().encode(seed));
  let hex = '';
  // Die ersten 16 Byte genügen: `/ID`-Einträge sind üblicherweise 16 Byte lang.
  for (let index = 0; index < 16; index += 1) {
    hex += digest[index].toString(16).padStart(2, '0');
  }
  return hex.toUpperCase();
}

/**
 * Hängt den OutputIntent samt eingebettetem ICC-Profil an den Katalog.
 *
 * Ohne ihn ist jedes `rgb(…)` im Dokument bedeutungslos: `DeviceRGB` sagt nicht,
 * *welches* Rot gemeint ist. Der OutputIntent liefert diese Auskunft mit.
 */
async function applyOutputIntent(pdfDoc: PDFDocument): Promise<void> {
  const iccBytes = await loadPdfAColorProfile();

  const profileRef: PDFRef = pdfDoc.context.register(
    pdfDoc.context.stream(iccBytes, {
      N: PDFNumber.of(PDFA_ICC_COMPONENT_COUNT),
    }),
  );

  const outputIntent = pdfDoc.context.obj({
    Type: 'OutputIntent',
    S: PDFA_OUTPUT_INTENT_SUBTYPE,
    OutputConditionIdentifier: PDFString.of(PDFA_OUTPUT_CONDITION_IDENTIFIER),
    OutputCondition: PDFString.of(PDFA_OUTPUT_CONDITION_IDENTIFIER),
    Info: PDFString.of(PDFA_OUTPUT_CONDITION_IDENTIFIER),
    RegistryName: PDFString.of(PDFA_OUTPUT_CONDITION_REGISTRY),
    DestOutputProfile: profileRef,
  });

  pdfDoc.catalog.set(PDFName.of('OutputIntents'), pdfDoc.context.obj([outputIntent]));
}

/**
 * Schreibt das XMP-Paket als `/Metadata`-Stream in den Katalog.
 *
 * Der Stream bleibt **unkomprimiert**. Das ist Absicht: Die Metadaten eines
 * Archivbelegs sollen ohne PDF-Werkzeug auffindbar bleiben — ein `grep` auf die
 * Datei muss `pdfaid:part` finden können. Die wenigen hundert Byte, die eine
 * Komprimierung spart, wiegen das nicht auf.
 */
function applyXmpMetadata(pdfDoc: PDFDocument, xmp: string): void {
  const metadataRef = pdfDoc.context.register(
    pdfDoc.context.stream(new TextEncoder().encode(xmp), {
      Type: 'Metadata',
      Subtype: 'XML',
    }),
  );
  pdfDoc.catalog.set(PDFName.of('Metadata'), metadataRef);
}

/**
 * Macht ein fertig gezeichnetes `pdf-lib`-Dokument zu PDF/A-3U.
 *
 * Aufzurufen **nach** allem Zeichnen und **vor** `save()`. Am sichtbaren Inhalt
 * ändert sich dabei nichts: Es werden ausschliesslich Metadaten, ein Farbprofil
 * und die Dokumentkennung ergänzt. Keine Seite, kein Textobjekt und kein Bild
 * wird angefasst.
 */
export async function applyPdfA3(pdfDoc: PDFDocument, metadata: PdfAMetadata): Promise<void> {
  const createdAt = metadata.createdAt;
  const modifiedAt = metadata.modifiedAt ?? createdAt;

  /*
   * Info-Dictionary und XMP müssen dasselbe sagen — siehe `pdfaXmp`. Die Werte
   * kommen deshalb aus genau einem Satz Variablen und werden zweimal
   * ausgegeben, statt an zwei Stellen unabhängig gebildet zu werden.
   */
  pdfDoc.setTitle(metadata.title);
  if (metadata.author?.trim()) pdfDoc.setAuthor(metadata.author.trim());
  if (metadata.subject?.trim()) pdfDoc.setSubject(metadata.subject.trim());
  pdfDoc.setCreator(metadata.creatorTool);
  pdfDoc.setProducer(PDFA_PRODUCER);
  pdfDoc.setCreationDate(createdAt);
  pdfDoc.setModificationDate(modifiedAt);

  applyXmpMetadata(
    pdfDoc,
    buildPdfAXmp({
      title: metadata.title,
      author: metadata.author,
      subject: metadata.subject,
      creatorTool: metadata.creatorTool,
      producer: PDFA_PRODUCER,
      createdAt,
      modifiedAt,
      part: PDFA_PART,
      conformance: PDFA_CONFORMANCE,
      additionalDescriptions: metadata.additionalXmpDescriptions,
    }),
  );

  await applyOutputIntent(pdfDoc);

  const fileId = buildDeterministicFileId(
    metadata.idSeed ?? `${metadata.title}\u0000${createdAt.toISOString()}`,
  );
  const idEntry = PDFHexString.of(fileId);
  pdfDoc.context.trailerInfo.ID = pdfDoc.context.obj([idEntry, idEntry]);
}

/**
 * Die Beziehung eines Anhangs zum Dokument (`/AFRelationship`).
 *
 * Für eine hybride Rechnung ist das später `Alternative`: Das XML ist eine
 * gleichwertige Darstellung desselben Belegs, kein Zusatzmaterial.
 */
export type PdfAFileRelationship =
  | 'Source'
  | 'Data'
  | 'Alternative'
  | 'Supplement'
  | 'Unspecified';

export interface PdfAAttachment {
  /** Der Dateiname, unter dem der Anhang erscheint. */
  readonly fileName: string;
  /** Der Medientyp, z. B. `application/xml`. */
  readonly mimeType: string;
  readonly relationship: PdfAFileRelationship;
  readonly bytes: Uint8Array;
  readonly description?: string;
  /** Wie bei `PdfAMetadata.createdAt`: hereingereicht, nicht von der Uhr gelesen. */
  readonly modifiedAt: Date;
}

/**
 * Hängt eine Datei so an, dass PDF/A-3 sie akzeptiert.
 *
 * Bewusst **generisch** und ohne jeden Bezug auf ZUGFeRD: Was hier entsteht, ist
 * ein regulärer PDF/A-3-Anhang. Eine ZUGFeRD-Rechnung ist mehr als das — sie
 * verlangt einen festgelegten Dateinamen und einen eigenen XMP-Block. Diese
 * Funktion behauptet nichts davon; sie stellt nur sicher, dass die Struktur
 * trägt, auf der 04E2 aufsetzen kann.
 *
 * `pdf-lib` bringt zwar `attach()` mit, legt dabei aber weder `/AFRelationship`
 * noch den `/AF`-Eintrag am Katalog an — beides ist für PDF/A-3 zwingend. Und es
 * setzt ein `ModDate` aus der aktuellen Uhrzeit, was die Byte-Gleichheit
 * zerstörte. Deshalb hier eigene Objekte statt des bequemen Wegs.
 */
export function attachPdfAFile(pdfDoc: PDFDocument, attachment: PdfAAttachment): void {
  const embeddedRef = pdfDoc.context.register(
    pdfDoc.context.flateStream(attachment.bytes, {
      Type: 'EmbeddedFile',
      Subtype: PDFName.of(attachment.mimeType),
      Params: pdfDoc.context.obj({
        ModDate: PDFString.fromDate(attachment.modifiedAt),
        Size: PDFNumber.of(attachment.bytes.length),
      }),
    }),
  );

  const description = attachment.description?.trim();
  const fileSpecRef = pdfDoc.context.register(
    pdfDoc.context.obj({
      Type: 'Filespec',
      /*
       * `F` und `UF` tragen denselben Namen. `UF` ist die Unicode-Fassung und
       * für PDF/A-3 die massgebliche; `F` bleibt für ältere Betrachter daneben
       * stehen.
       */
      F: PDFString.of(attachment.fileName),
      UF: PDFHexString.fromText(attachment.fileName),
      AFRelationship: PDFName.of(attachment.relationship),
      ...(description ? { Desc: PDFHexString.fromText(description) } : {}),
      EF: pdfDoc.context.obj({ F: embeddedRef }),
    }),
  );

  /*
   * Zwei Eintragungen, beide nötig:
   *
   *  - der Namensbaum `/Names /EmbeddedFiles`, damit Betrachter den Anhang
   *    überhaupt anzeigen,
   *  - das Feld `/AF` am Katalog, das PDF/A-3 fordert, damit maschinell erkennbar
   *    ist, dass diese Datei zu diesem Dokument gehört.
   *
   * Beide werden ergänzt und nicht ersetzt: Ein Dokument kann mehrere Anhänge
   * tragen, und ein zweiter Aufruf darf den ersten nicht verdrängen.
   */
  const names = pdfDoc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const namesDict = names ?? pdfDoc.context.obj({});
  if (!names) pdfDoc.catalog.set(PDFName.of('Names'), namesDict);

  const embeddedFiles = namesDict.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const embeddedFilesDict = embeddedFiles ?? pdfDoc.context.obj({});
  if (!embeddedFiles) namesDict.set(PDFName.of('EmbeddedFiles'), embeddedFilesDict);

  const nameEntries = embeddedFilesDict.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (nameEntries) {
    nameEntries.push(PDFHexString.fromText(attachment.fileName));
    nameEntries.push(fileSpecRef);
  } else {
    embeddedFilesDict.set(
      PDFName.of('Names'),
      pdfDoc.context.obj([PDFHexString.fromText(attachment.fileName), fileSpecRef]),
    );
  }

  const afEntries = pdfDoc.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
  if (afEntries) {
    afEntries.push(fileSpecRef);
  } else {
    pdfDoc.catalog.set(PDFName.of('AF'), pdfDoc.context.obj([fileSpecRef]));
  }
}
