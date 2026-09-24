/**
 * E-RECHNUNG-04D — die erzeugte XRechnung als unveränderliches Artefakt.
 *
 * Eine E-Rechnung darf nicht bei jedem Klick neu entstehen. Nicht weil das
 * langsam wäre, sondern weil sonst niemand mehr sagen kann, welche Bytes der
 * Betrieb tatsächlich verschickt hat. Deshalb: einmal erzeugen, ablegen,
 * danach ausliefern — und nie überschreiben.
 *
 * E-RECHNUNG-04D3 — und zwar nicht nur in diesem Browser.
 *
 * Bis hierher lag das Artefakt allein in der lokalen Blob-Ablage. Ein
 * versendbarer Beleg, der an einem Gerät hängt, ist kein auditierbarer Beleg:
 * Nach einem Gerätewechsel wäre er weg, und niemand könnte nachweisen, welche
 * Datei den Betrieb verlassen hat.
 *
 * Es entsteht dafür **kein zweiter Dateispeicher**. Die XRechnung wird eine
 * gewöhnliche Datei der vorhandenen Architektur:
 *
 *   `DocumentFileRef`  — inhaltsadressiert, über den Hash dedupliziert
 *   Bindung `structured` / `derived` an das Archivdokument der Rechnung
 *
 * Damit erledigt der bestehende Sync alles Weitere: `pushFile` lädt die Bytes
 * inhaltsadressiert hoch (`ws/sha256`, `upsert:false`, Hash **vor** dem Upload
 * geprüft) und registriert die Zeile in `workspace_files`; die Bindung landet
 * in `workspace_document_file_bindings`. Der Rückweg (`getDocumentFileBlob` →
 * `materializeCloudDocumentFile`) prüft Grösse und Hash, bevor er Bytes lokal
 * ablegt. Keine Migration, keine neue Tabelle, kein eigener Upload-Pfad.
 *
 * Die Bindung hängt am Archivdokument der Rechnung, weil dieses den Beleg in
 * der Ablage repräsentiert — dieselbe Rechnung, eine weitere Darstellung.
 *
 * **Unveränderlichkeit** folgt aus der Inhaltsadressierung: Andere Bytes
 * ergeben einen anderen Hash und damit eine andere Datei. Ändert sich später
 * die Generator-, Standard- oder Bundle-Fassung, entsteht eine **neue** Datei;
 * die alte bleibt unter ihrem Hash liegen und wird von nichts überschrieben.
 */
import type { CompanyDocument, VorgangInvoice } from '../../types/models';
import type { DocumentFileRef } from '../../types/documentFileRef';
import { computeBufferContentHash } from '../documentFileHashService';
import { getDocumentByLinkedInvoiceId } from '../documentService';
import {
  getDocumentFileBlob,
  getDocumentFileRefById,
  storeDocumentFileFromCachedPayload,
} from '../documentFileStoreService';
import { registerDocumentFileRepresentationBinding } from '../documentFileRepresentationBindingRegistrationService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  replaceDocumentFileRepresentationBindingStore,
} from '../documentFileRepresentationBindingStoreService';
import { persistAll } from '../persistenceService';
import { XRECHNUNG_BINDING_PART, looksLikeLegacyXRechnungFile } from './einvoiceBindingParts';
import { buildCanonicalEInvoice } from './canonicalEInvoiceBuilder';
import type { CanonicalEInvoiceIssue } from './canonicalEInvoice';
import { EINVOICE_STANDARDS } from './einvoiceStandards';
import {
  XRECHNUNG_GENERATOR_VERSION,
  renderXRechnungCii,
  type XRechnungRenderIssue,
} from './xrechnungCiiRenderer';

export const XRECHNUNG_MIME_TYPE = 'application/xml';

/** Die Rolle, unter der die XRechnung am Beleg hängt. */
export const XRECHNUNG_BINDING_KIND = 'structured' as const;

/** Wo die Bytes gerade nachweislich liegen. */
export type XRechnungDurability =
  /** Nur in diesem Browser — die Cloud-Sicherung steht noch aus. */
  | 'local_only'
  /** In der Cloud registriert; der Beleg hängt nicht mehr an einem Gerät. */
  | 'cloud_backed';

/** Was ein abgelegtes Artefakt über sich weiss. */
export interface XRechnungArtifact {
  sourceInvoiceId: string;
  sourceInvoiceNumber: string;
  format: 'xrechnung';
  syntax: 'cii';
  standardVersion: string;
  bundleVersion: string;
  generatorVersion: string;
  fileName: string;
  contentSha256: string;
  byteSize: number;
  createdAt: string;
  /**
   * Der Stand der **internen** Prüfung.
   *
   * Bewusst nicht mehr: Der offizielle KoSIT-Validator läuft in Entwicklung
   * und Abnahme, nicht im Produkt. Eine Oberfläche darf deshalb nie behaupten,
   * genau diese Rechnung sei offiziell geprüft worden.
   */
  internalValidation: 'passed';
  /** Die Datei in der gemeinsamen Ablage — Grundlage von Sync und Audit. */
  fileRefId: string;
  durability: XRechnungDurability;
  bytes: Uint8Array;
}

export type XRechnungArtifactResult =
  | { ok: true; artifact: XRechnungArtifact; reused: boolean }
  | { ok: false; reason: 'canonical_incomplete'; issues: CanonicalEInvoiceIssue[] }
  | { ok: false; reason: 'render_failed'; issues: XRechnungRenderIssue[] }
  | { ok: false; reason: 'no_archive_document' }
  | { ok: false; reason: 'storage_failed' };

/**
 * Der Dateiname.
 *
 * Ausschliesslich aus der Rechnungsnummer und einem festen Wort. Kein Kunden-
 * und kein Projekttext: Beides ist Freitext und hätte in einem Dateinamen
 * nichts zu suchen. Alles, was kein Buchstabe, keine Ziffer, kein Bindestrich
 * und kein Unterstrich ist, wird ersetzt — damit kann weder ein Pfad noch ein
 * Verzeichniswechsel entstehen.
 */
export function buildXRechnungFileName(invoiceNumber: string): string {
  const safe = invoiceNumber.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `XRechnung-${safe || 'Rechnung'}.xml`;
}

/* ------------------------------------------------------------------ */
/* Lesen                                                               */
/* ------------------------------------------------------------------ */

function archiveDocumentFor(invoice: VorgangInvoice): CompanyDocument | undefined {
  return getDocumentByLinkedInvoiceId(invoice.id);
}

/**
 * Die Datei, an der die XRechnung dieses Belegs hängt.
 *
 * E-RECHNUNG-04E3 — zwei Wege, in dieser Reihenfolge:
 *
 *  1. Die Bindung mit der ausdrücklichen Unterrolle `xrechnung-cii`. So
 *     entstehen alle neuen Artefakte.
 *  2. Eine Altbindung aus 04D3: `structured` **ohne** Unterrolle. Sie zählt
 *     nur, wenn die dahinterliegende Datei auch wirklich XML ist — siehe
 *     `looksLikeLegacyXRechnungFile`. Ohne diese zweite Bedingung würde das
 *     ZUGFeRD-PDF desselben Belegs hier hereinrutschen.
 *
 * Bereits erzeugte XRechnungen bleiben damit auffindbar, und es entsteht kein
 * zweites Artefakt neben einem vorhandenen.
 */
function boundFileRef(document: CompanyDocument): DocumentFileRef | undefined {
  const bindings = getDocumentFileRepresentationBindingStoreSnapshot().filter(
    (entry) => entry.documentId === document.id && entry.kind === XRECHNUNG_BINDING_KIND,
  );

  const explicit = bindings.find((entry) => entry.part === XRECHNUNG_BINDING_PART);
  if (explicit) return getDocumentFileRefById(explicit.fileRefId);

  for (const entry of bindings) {
    if (entry.part) continue;
    const ref = getDocumentFileRefById(entry.fileRefId);
    if (ref && looksLikeLegacyXRechnungFile(ref.mimeType)) return ref;
  }
  return undefined;
}

function describe(
  invoice: VorgangInvoice,
  ref: DocumentFileRef,
  bytes: Uint8Array,
): XRechnungArtifact {
  return {
    sourceInvoiceId: invoice.id,
    sourceInvoiceNumber: invoice.number,
    format: 'xrechnung',
    syntax: 'cii',
    standardVersion: EINVOICE_STANDARDS.xrechnung.specification,
    bundleVersion: EINVOICE_STANDARDS.xrechnung.bundle,
    generatorVersion: XRECHNUNG_GENERATOR_VERSION,
    fileName: ref.originalFileName || buildXRechnungFileName(invoice.number),
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
 * Das bereits abgelegte Artefakt zu einer Rechnung — oder nichts.
 *
 * Erzeugt ausdrücklich **nichts**. Die Oberfläche braucht diesen Weg, um beim
 * Öffnen einer Rechnung zu wissen, ob es schon eine XRechnung gibt, ohne
 * ungefragt eine zu erzeugen. Confirm-first bleibt erhalten: Nachsehen ist
 * keine Handlung des Nutzers, Erzeugen schon.
 *
 * Fehlen die Bytes lokal — neues Gerät, geleerter Browser —, holt
 * `getDocumentFileBlob` sie aus der Cloud. Dieser Weg prüft Grösse und Hash,
 * bevor er etwas ablegt; hier wird der Hash danach **erneut** gegen die
 * Dateizeile gehalten.
 */
export async function readXRechnungArtifact(
  invoice: VorgangInvoice,
): Promise<XRechnungArtifact | null> {
  try {
    const document = archiveDocumentFor(invoice);
    if (!document) return null;
    const ref = boundFileRef(document);
    if (!ref) return null;

    const blob = await getDocumentFileBlob(ref);
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());

    /*
     * Die letzte Kontrolle vor der Auslieferung, bewusst doppelt: Der
     * Cloud-Download prüft bereits, aber ein lokal beschädigter Blob käme
     * daran vorbei. Manipulierte Bytes werden nicht ausgeliefert — lieber
     * keine Datei als eine falsche.
     */
    const hash = await computeBufferContentHash(bytes);
    if (!hash || hash !== ref.contentHash.toLowerCase()) return null;

    return describe(invoice, ref, bytes);
  } catch {
    // Eine unlesbare Ablage ist kein Grund, ein zweites Artefakt zu erfinden.
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Erzeugen                                                            */
/* ------------------------------------------------------------------ */

/**
 * Das Artefakt zu einer freigegebenen Rechnung — vorhandenes zuerst.
 *
 * Reihenfolge mit Absicht: Erst wird nachgesehen, ob es schon eines gibt. Erst
 * wenn nicht, wird geprüft, erzeugt und abgelegt. So kostet der zweite
 * Download nichts und liefert garantiert dieselben Bytes wie der erste.
 */
export async function ensureXRechnungArtifact(
  invoice: VorgangInvoice,
): Promise<XRechnungArtifactResult> {
  const vorhanden = await readXRechnungArtifact(invoice);
  if (vorhanden) return { ok: true, artifact: vorhanden, reused: true };

  const document = archiveDocumentFor(invoice);
  if (!document) {
    /*
     * Ohne Archivdokument gibt es nichts, woran die Datei hängen könnte. Das
     * trifft nur Belege, die nie archiviert wurden; eine Ersatzablage dafür zu
     * erfinden hiesse, genau den zweiten Dateispeicher zu bauen, den dieser
     * Block vermeiden soll.
     */
    return { ok: false, reason: 'no_archive_document' };
  }

  const canonical = buildCanonicalEInvoice(invoice);
  if (!canonical.ok) return { ok: false, reason: 'canonical_incomplete', issues: canonical.issues };

  const rendered = renderXRechnungCii(canonical.value);
  if (!rendered.ok) return { ok: false, reason: 'render_failed', issues: rendered.issues };

  const bytes = new TextEncoder().encode(rendered.xml);
  try {
    /*
     * Die Ablage dedupliziert über den Hash: Identische Bytes ergeben dieselbe
     * Datei, egal wie oft erzeugt wird. Eine zweite Kopie derselben XRechnung
     * kann damit gar nicht entstehen.
     */
    const { fileRef } = await storeDocumentFileFromCachedPayload(
      {
        fileName: buildXRechnungFileName(invoice.number),
        mimeType: XRECHNUNG_MIME_TYPE,
        fileSize: bytes.byteLength,
        bytes,
      },
      { lifecycleIntent: 'committed' },
    );

    const registration = registerDocumentFileRepresentationBinding({
      binding: {
        documentId: document.id,
        kind: XRECHNUNG_BINDING_KIND,
        // E-RECHNUNG-04E3 — neue Artefakte tragen die Unterrolle ausdruecklich.
        part: XRECHNUNG_BINDING_PART,
        fileRefId: fileRef.id,
      },
      bindings: getDocumentFileRepresentationBindingStoreSnapshot(),
    });
    replaceDocumentFileRepresentationBindingStore([...registration.bindings]);

    /*
     * Speichern reiht Datei und Bindung in den Sync-Ausgang ein. Schlägt der
     * Cloud-Lauf später fehl, bleibt beides lokal bestehen — die erzeugte
     * XRechnung geht dadurch nicht verloren, sie ist nur noch nicht gesichert.
     * Genau das sagt `durability`.
     */
    persistAll();

    return {
      ok: true,
      artifact: describe(invoice, getDocumentFileRefById(fileRef.id) ?? fileRef, bytes),
      reused: false,
    };
  } catch {
    return { ok: false, reason: 'storage_failed' };
  }
}
