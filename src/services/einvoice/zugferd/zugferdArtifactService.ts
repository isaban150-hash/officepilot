/**
 * E-RECHNUNG-04E2 — das fertige ZUGFeRD-Dokument.
 *
 * Hier laufen die vier Stränge zusammen, und zwar in genau dieser Reihenfolge,
 * weil jeder den nächsten absichert:
 *
 *  1. **Kanonisches Modell** (04C) — die fachliche Wahrheit aus dem
 *     eingefrorenen Beleg. Keine Stammdatenabfrage, keine Live-Daten, keine
 *     zweite Rechen-Engine.
 *  2. **XML** (`zugferdEn16931Renderer`) — ZUGFeRD 2.5.2, Profil EN16931.
 *  3. **Gleichheitsprüfung** (`zugferdPdfXmlConsistency`) — PDF und XML müssen
 *     denselben Beleg zeigen. Das ist die Stelle, an der ein Widerspruch
 *     auffällt, **bevor** eine Datei entsteht.
 *  4. **PDF/A-3U** (04E1) mit `factur-x.xml` als Anhang und dem erweiterten
 *     XMP.
 *
 * Jeder Schritt ist **fail-closed**: Was hier scheitert, erzeugt kein
 * Dokument. Ein ZUGFeRD-PDF, das nur „grösstenteils" stimmt, ist schlimmer als
 * keines — der Empfänger bucht danach.
 *
 * In 04E2 ruft das Produkt diese Funktion noch **nirgends** auf. Es gibt keinen
 * Knopf, keine Auswahl, keine Cloud-Ablage. Das ist Absicht: Erst muss der
 * Artefaktkern beweisbar richtig sein.
 */
import { buildCanonicalEInvoice } from '../canonicalEInvoiceBuilder';
import type { CanonicalEInvoice, CanonicalEInvoiceIssue } from '../canonicalEInvoice';
import { EINVOICE_STANDARDS } from '../einvoiceStandards';
import { buildInvoicePrintModelFromInvoice } from '../../invoicePrintModel';
import { generateHybridInvoicePdfA3 } from '../../invoicePdfService';
import { PDFA_CONFORMANCE, PDFA_PART } from '../pdfa/pdfaProfile';
import { sha256Bytes } from '../../sha256Digest';
import {
  ZUGFERD_AF_RELATIONSHIP,
  ZUGFERD_EMBEDDED_DESCRIPTION,
  ZUGFERD_EMBEDDED_FILE_NAME,
  ZUGFERD_EMBEDDED_MIME_TYPE,
  ZUGFERD_GENERATOR_VERSION,
} from './zugferdProfile';
import { renderZugferdEn16931Cii, type ZugferdRenderIssue } from './zugferdEn16931Renderer';
import { buildZugferdXmpDescriptions } from './zugferdXmp';
import {
  checkZugferdPdfXmlConsistency,
  type ZugferdConsistencyMismatch,
} from './zugferdPdfXmlConsistency';
import type { CompanyDocument, VorgangInvoice } from '../../../types/models';
import type { DocumentFileRef } from '../../../types/documentFileRef';
import { computeBufferContentHash } from '../../documentFileHashService';
import { getDocumentByLinkedInvoiceId } from '../../documentService';
import {
  getDocumentFileBlob,
  getDocumentFileRefById,
  storeDocumentFileFromCachedPayload,
} from '../../documentFileStoreService';
import { registerDocumentFileRepresentationBinding } from '../../documentFileRepresentationBindingRegistrationService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  replaceDocumentFileRepresentationBindingStore,
} from '../../documentFileRepresentationBindingStoreService';
import { persistAll } from '../../persistenceService';
import { ZUGFERD_BINDING_PART } from '../einvoiceBindingParts';

/* ------------------------------------------------------------------ */
/* Artefaktbeschreibung                                                */
/* ------------------------------------------------------------------ */

/**
 * Was ein erzeugtes ZUGFeRD-Dokument über sich selbst weiss.
 *
 * Bewusst vollständig und versionsgebunden: Ein Beleg, der in fünf Jahren aus
 * dem Archiv kommt, muss ohne Rückfrage sagen können, nach welchem Stand er
 * entstanden ist. `pdfConformance` und `profile` stehen deshalb ausgeschrieben
 * daneben und nicht nur implizit im Dokument.
 */
export interface ZugferdArtifact {
  readonly format: 'zugferd';
  readonly standardVersion: string;
  readonly facturXVersion: string;
  readonly profile: 'EN16931';
  readonly syntax: 'CII';
  readonly pdfConformance: string;
  readonly embeddedFileName: string;
  readonly generatorVersion: string;
  readonly sourceInvoiceId: string;
  readonly sourceInvoiceNumber: string;
  readonly fileName: string;
  readonly mimeType: 'application/pdf';
  readonly sha256: string;
  readonly byteSize: number;
  readonly bytes: Uint8Array;
  /** Die eingebetteten XML-Bytes — für Prüfungen, nicht für die Ablage. */
  readonly xml: string;
}

export type ZugferdBuildResult =
  | { readonly ok: true; readonly artifact: ZugferdArtifact }
  | { readonly ok: false; readonly reason: 'canonical_incomplete'; readonly issues: CanonicalEInvoiceIssue[] }
  | { readonly ok: false; readonly reason: 'render_failed'; readonly issues: ZugferdRenderIssue[] }
  | {
      readonly ok: false;
      readonly reason: 'pdf_xml_mismatch';
      readonly mismatches: readonly ZugferdConsistencyMismatch[];
    }
  | { readonly ok: false; readonly reason: 'pdf_failed'; readonly message: string };

/* ------------------------------------------------------------------ */

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Der Dateiname des Hybriddokuments — erkennbar verschieden vom reinen PDF. */
export function buildZugferdFileName(invoiceNumber: string): string {
  const safe = invoiceNumber
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `ZUGFeRD-${safe || 'Rechnung'}.pdf`;
}

/**
 * Der Zeitstempel des Anhangs.
 *
 * Wie überall in 04E1/04E2: aus dem Beleg, nicht von der Uhr. Ein `ModDate`
 * aus `new Date()` würde jeden Lauf byteverschieden machen und damit den
 * Nachweis unmöglich, dass zweimal derselbe Beleg erzeugt wurde.
 */
function attachmentTimestamp(canonical: CanonicalEInvoice): Date {
  const parsed = new Date(`${canonical.issueDate.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

/**
 * Erzeugt das vollständige ZUGFeRD-2.5.2-EN16931-Dokument zu einer
 * finalisierten Rechnung — oder gar nichts.
 */
export async function buildZugferdInvoice(invoice: VorgangInvoice): Promise<ZugferdBuildResult> {
  /* 1 — die fachliche Wahrheit. */
  const canonical = buildCanonicalEInvoice(invoice);
  if (!canonical.ok) {
    return { ok: false, reason: 'canonical_incomplete', issues: canonical.issues };
  }

  /* 2 — das XML. */
  const rendered = renderZugferdEn16931Cii(canonical.value);
  if (!rendered.ok) {
    return { ok: false, reason: 'render_failed', issues: rendered.issues };
  }

  /*
   * 3 — die Gleichheitsprüfung, **vor** dem Erzeugen.
   *
   * Das Druckmodell wird hier ein zweites Mal gebaut. Das ist kein Versehen:
   * Es ist genau dasselbe Modell, das der PDF-Renderer gleich benutzen wird,
   * und nur so lässt sich vergleichen, was das Papier zeigen *wird*, statt
   * anzunehmen, es zeige schon das Richtige.
   */
  let model;
  try {
    model = buildInvoicePrintModelFromInvoice(invoice);
  } catch (error) {
    return {
      ok: false,
      reason: 'pdf_failed',
      message: error instanceof Error ? error.message : 'print_model_failed',
    };
  }

  const consistency = checkZugferdPdfXmlConsistency(model, canonical.value);
  if (!consistency.ok) {
    return { ok: false, reason: 'pdf_xml_mismatch', mismatches: consistency.mismatches };
  }

  /* 4 — die PDF/A-3U-Hülle mit Anhang und erweitertem XMP. */
  const xmlBytes = new TextEncoder().encode(rendered.xml);
  const pdf = await generateHybridInvoicePdfA3(invoice, {
    attachments: [
      {
        fileName: ZUGFERD_EMBEDDED_FILE_NAME,
        mimeType: ZUGFERD_EMBEDDED_MIME_TYPE,
        relationship: ZUGFERD_AF_RELATIONSHIP,
        bytes: xmlBytes,
        description: ZUGFERD_EMBEDDED_DESCRIPTION,
        modifiedAt: attachmentTimestamp(canonical.value),
      },
    ],
    /*
     * Der Dateiname im XMP kommt aus **derselben** Konstante wie der des
     * Anhangs. Ein XMP, das eine andere Datei nennt als die im Dokument,
     * führt jedes automatisierte Auslesen in die Irre.
     */
    xmpDescriptions: buildZugferdXmpDescriptions({
      documentFileName: ZUGFERD_EMBEDDED_FILE_NAME,
    }),
  });

  if (!pdf.ok) {
    return { ok: false, reason: 'pdf_failed', message: pdf.message ?? pdf.reason };
  }

  return {
    ok: true,
    artifact: {
      format: 'zugferd',
      standardVersion: EINVOICE_STANDARDS.zugferd.version,
      facturXVersion: EINVOICE_STANDARDS.zugferd.facturX,
      profile: 'EN16931',
      syntax: 'CII',
      pdfConformance: `PDF/A-${PDFA_PART}${PDFA_CONFORMANCE}`,
      embeddedFileName: ZUGFERD_EMBEDDED_FILE_NAME,
      generatorVersion: ZUGFERD_GENERATOR_VERSION,
      sourceInvoiceId: canonical.value.sourceInvoiceId,
      sourceInvoiceNumber: canonical.value.sourceInvoiceNumber,
      fileName: buildZugferdFileName(canonical.value.sourceInvoiceNumber),
      mimeType: 'application/pdf',
      sha256: hex(sha256Bytes(pdf.bytes)),
      byteSize: pdf.bytes.byteLength,
      bytes: pdf.bytes,
      xml: rendered.xml,
    },
  };
}

/* ================================================================== */
/* E-RECHNUNG-04E3 — Ablage, Cloud und Wiederverwendung                */
/* ================================================================== */

/**
 * Das fertige ZUGFeRD-Dokument gehört in dieselbe Dateiarchitektur wie alles
 * andere: inhaltsadressierte Datei, Bindung am Archivdokument der Rechnung,
 * bestehender Sync. **Kein zweiter Speicherpfad, keine neue Tabelle, keine
 * Migration.**
 *
 * Der einzige Unterschied zur XRechnung ist die Unterrolle: `structured` mit
 * `part = zugferd-en16931`. Beide hängen damit nebeneinander am selben Beleg,
 * ohne sich zu verdrängen — siehe `einvoiceBindingParts`.
 */
export const ZUGFERD_MIME_TYPE = 'application/pdf';

/** Die Rolle, unter der die ZUGFeRD-Rechnung am Beleg hängt. */
export const ZUGFERD_BINDING_KIND = 'structured' as const;

/** Wo die Bytes gerade nachweislich liegen. */
export type ZugferdDurability = 'local_only' | 'cloud_backed';

/** Was ein abgelegtes ZUGFeRD-Dokument über sich weiss. */
export interface ZugferdStoredArtifact {
  readonly sourceInvoiceId: string;
  readonly sourceInvoiceNumber: string;
  readonly format: 'zugferd';
  readonly standardVersion: string;
  readonly facturXVersion: string;
  readonly profile: 'EN16931';
  readonly syntax: 'CII';
  readonly pdfConformance: string;
  readonly embeddedFileName: string;
  readonly generatorVersion: string;
  readonly fileName: string;
  readonly mimeType: 'application/pdf';
  readonly contentSha256: string;
  readonly byteSize: number;
  readonly createdAt: string;
  /**
   * Der Stand der **internen** Prüfung. Bewusst nicht mehr: Mustang und
   * veraPDF laufen in Entwicklung und Abnahme, nicht im Produkt. Die
   * Oberfläche darf nie behaupten, genau dieser Beleg sei amtlich geprüft.
   */
  readonly internalValidation: 'passed';
  readonly fileRefId: string;
  readonly durability: ZugferdDurability;
  readonly bytes: Uint8Array;
}

export type ZugferdArtifactResult =
  | { readonly ok: true; readonly artifact: ZugferdStoredArtifact; readonly reused: boolean }
  | {
      readonly ok: false;
      readonly reason: 'canonical_incomplete';
      readonly issues: CanonicalEInvoiceIssue[];
    }
  | { readonly ok: false; readonly reason: 'render_failed'; readonly issues: ZugferdRenderIssue[] }
  | {
      readonly ok: false;
      readonly reason: 'pdf_xml_mismatch';
      readonly mismatches: readonly ZugferdConsistencyMismatch[];
    }
  | { readonly ok: false; readonly reason: 'pdf_failed'; readonly message: string }
  | { readonly ok: false; readonly reason: 'no_archive_document' }
  | { readonly ok: false; readonly reason: 'storage_failed' };

function archiveDocumentFor(invoice: VorgangInvoice): CompanyDocument | undefined {
  return getDocumentByLinkedInvoiceId(invoice.id);
}

/**
 * Die Datei, an der die ZUGFeRD-Rechnung dieses Belegs hängt.
 *
 * Ausschliesslich über die ausdrückliche Unterrolle. Es gibt **keinen**
 * Altbestand ohne Unterrolle: ZUGFeRD entsteht erst mit diesem Block. Eine
 * Rückfallsuche wie bei der XRechnung wäre hier nicht Nachsicht, sondern eine
 * offene Tür — sie könnte die XRechnung desselben Belegs erwischen.
 */
function boundZugferdFileRef(document: CompanyDocument): DocumentFileRef | undefined {
  const binding = getDocumentFileRepresentationBindingStoreSnapshot().find(
    (entry) =>
      entry.documentId === document.id &&
      entry.kind === ZUGFERD_BINDING_KIND &&
      entry.part === ZUGFERD_BINDING_PART,
  );
  return binding ? getDocumentFileRefById(binding.fileRefId) : undefined;
}

function describeStored(
  invoice: VorgangInvoice,
  ref: DocumentFileRef,
  bytes: Uint8Array,
): ZugferdStoredArtifact {
  return {
    sourceInvoiceId: invoice.id,
    sourceInvoiceNumber: invoice.number,
    format: 'zugferd',
    standardVersion: EINVOICE_STANDARDS.zugferd.version,
    facturXVersion: EINVOICE_STANDARDS.zugferd.facturX,
    profile: 'EN16931',
    syntax: 'CII',
    pdfConformance: `PDF/A-${PDFA_PART}${PDFA_CONFORMANCE}`,
    embeddedFileName: ZUGFERD_EMBEDDED_FILE_NAME,
    generatorVersion: ZUGFERD_GENERATOR_VERSION,
    fileName: ref.originalFileName || buildZugferdFileName(invoice.number),
    mimeType: 'application/pdf',
    contentSha256: ref.contentHash,
    byteSize: ref.fileSize,
    createdAt: ref.createdAt,
    internalValidation: 'passed',
    fileRefId: ref.id,
    /*
     * „Cloudgesichert" heisst: Der Sync hat die Datei registriert und kennt
     * ihren Ablagepfad. Solange der fehlt, liegt sie nur hier — und die
     * Oberfläche darf nichts anderes behaupten.
     */
    durability: ref.cloud?.storagePath ? 'cloud_backed' : 'local_only',
    bytes,
  };
}

/**
 * Das bereits abgelegte ZUGFeRD-Dokument — oder nichts.
 *
 * Erzeugt ausdrücklich **nichts**. Die Oberfläche braucht diesen Weg, um beim
 * Öffnen einer Rechnung zu wissen, ob es schon eines gibt, ohne ungefragt eines
 * zu erzeugen. Nachsehen ist keine Handlung des Nutzers, Erzeugen schon.
 *
 * Fehlen die Bytes lokal — neues Gerät, geleerter Browser —, holt
 * `getDocumentFileBlob` sie aus der Cloud. Dieser Weg prüft Grösse und Hash,
 * bevor er etwas ablegt; hier wird der Hash danach **erneut** gegen die
 * Dateizeile gehalten. Lieber keine Datei als eine falsche.
 */
export async function readZugferdArtifact(
  invoice: VorgangInvoice,
): Promise<ZugferdStoredArtifact | null> {
  try {
    const document = archiveDocumentFor(invoice);
    if (!document) return null;
    const ref = boundZugferdFileRef(document);
    if (!ref) return null;

    const blob = await getDocumentFileBlob(ref);
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const hash = await computeBufferContentHash(bytes);
    if (!hash || hash !== ref.contentHash.toLowerCase()) return null;

    return describeStored(invoice, ref, bytes);
  } catch {
    return null;
  }
}

/**
 * Das ZUGFeRD-Dokument zu einer freigegebenen Rechnung — vorhandenes zuerst.
 *
 * Reihenfolge mit Absicht: Erst wird nachgesehen, ob es schon eines gibt. Erst
 * wenn nicht, wird geprüft, erzeugt und abgelegt. So kostet der zweite
 * Download nichts und liefert garantiert dieselben Bytes wie der erste — und
 * ein Cloud-Abruf auf einem zweiten Gerät liefert denselben Prüfwert.
 */
export async function ensureZugferdArtifact(
  invoice: VorgangInvoice,
): Promise<ZugferdArtifactResult> {
  const vorhanden = await readZugferdArtifact(invoice);
  if (vorhanden) return { ok: true, artifact: vorhanden, reused: true };

  const document = archiveDocumentFor(invoice);
  if (!document) return { ok: false, reason: 'no_archive_document' };

  const built = await buildZugferdInvoice(invoice);
  if (!built.ok) return built;

  try {
    /*
     * Die Ablage dedupliziert über den Hash: Identische Bytes ergeben dieselbe
     * Datei, egal wie oft erzeugt wird. Weil die Erzeugung deterministisch
     * ist, kann eine zweite Kopie derselben ZUGFeRD-Rechnung gar nicht
     * entstehen.
     */
    const { fileRef } = await storeDocumentFileFromCachedPayload(
      {
        fileName: built.artifact.fileName,
        mimeType: ZUGFERD_MIME_TYPE,
        fileSize: built.artifact.bytes.byteLength,
        bytes: built.artifact.bytes,
      },
      { lifecycleIntent: 'committed' },
    );

    const registration = registerDocumentFileRepresentationBinding({
      binding: {
        documentId: document.id,
        kind: ZUGFERD_BINDING_KIND,
        part: ZUGFERD_BINDING_PART,
        fileRefId: fileRef.id,
      },
      bindings: getDocumentFileRepresentationBindingStoreSnapshot(),
    });
    replaceDocumentFileRepresentationBindingStore([...registration.bindings]);

    /*
     * Speichern reiht Datei und Bindung in den Sync-Ausgang ein. Schlägt der
     * Cloud-Lauf später fehl, bleibt beides lokal bestehen — das erzeugte
     * Dokument geht nicht verloren, es ist nur noch nicht gesichert. Genau das
     * sagt `durability`.
     */
    persistAll();

    return {
      ok: true,
      artifact: describeStored(
        invoice,
        getDocumentFileRefById(fileRef.id) ?? fileRef,
        built.artifact.bytes,
      ),
      reused: false,
    };
  } catch {
    return { ok: false, reason: 'storage_failed' };
  }
}
