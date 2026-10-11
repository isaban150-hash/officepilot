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
import type { DocumentFileRepresentationBinding } from '../../types/documentFileRepresentationBinding';
import { computeBufferContentHash } from '../documentFileHashService';
import { getGeneratedInvoiceDocument } from '../documentService';
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
import type { ServicePeriodOutputCode } from './einvoiceOutputRule';
import { checkInvoiceOutput } from '../invoice/invoiceOutputGuard';
import {
  isUntrustedEInvoiceBinding,
  mayStoreEInvoiceArtifact,
  replaceUntrustedEInvoiceBinding,
} from './einvoiceBindingTrust';
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
  | 'cloud_backed'
  /**
   * GO-LIVE-SECURITY-01 / FINALISIERUNG — nicht abgelegt: frisch erzeugt, nur zum
   * Herunterladen. So erhält ein Mitglied die E-Rechnung; ablegen dürfen nur Inhaber
   * und Admin (siehe `einvoiceBindingTrust`).
   */
  | 'not_stored';

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
  | { ok: false; reason: 'storage_failed' }
  /** GO-LIVE-SECURITY-01 — Leistungszeitraum fehlt, ist ungültig oder unbestätigt; nichts wurde ausgegeben. */
  | { ok: false; reason: 'service_period_unconfirmed'; codes: ServicePeriodOutputCode[] }
  /** GO-LIVE-SECURITY-01 — Mitglied ohne Cloud-Nachweis der Bestätigung; nichts wurde ausgegeben. */
  | { ok: false; reason: 'service_period_unverified' };

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

/** GO-LIVE-SECURITY-01 / ABSCHLUSS — nur der erzeugte Rechnungsbeleg, wie serverseitig (generated_invoice). */
function archiveDocumentFor(invoice: VorgangInvoice): CompanyDocument | undefined {
  return getGeneratedInvoiceDocument(invoice.id);
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
 *
 * GO-LIVE-SECURITY-01 / FINALISIERUNG — mit der Bindung, damit der Lesepfad ihre
 * Vertrauensmarke sieht.
 */
function boundXRechnung(
  document: CompanyDocument,
): { binding: DocumentFileRepresentationBinding; ref: DocumentFileRef } | undefined {
  const bindings = getDocumentFileRepresentationBindingStoreSnapshot().filter(
    (entry) => entry.documentId === document.id && entry.kind === XRECHNUNG_BINDING_KIND,
  );

  const explicit = bindings.find((entry) => entry.part === XRECHNUNG_BINDING_PART);
  if (explicit) {
    const ref = getDocumentFileRefById(explicit.fileRefId);
    return ref ? { binding: explicit, ref } : undefined;
  }

  for (const entry of bindings) {
    if (entry.part) continue;
    const ref = getDocumentFileRefById(entry.fileRefId);
    if (ref && looksLikeLegacyXRechnungFile(ref.mimeType)) return { binding: entry, ref };
  }
  return undefined;
}

type XRechnungRendering =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'canonical_incomplete'; issues: CanonicalEInvoiceIssue[] }
  | { ok: false; reason: 'render_failed'; issues: XRechnungRenderIssue[] };

/** Die XRechnung aus der festgeschriebenen Rechnung — deterministisch, ohne Ablage. */
function renderXRechnungBytes(invoice: VorgangInvoice): XRechnungRendering {
  const canonical = buildCanonicalEInvoice(invoice);
  if (!canonical.ok) return { ok: false, reason: 'canonical_incomplete', issues: canonical.issues };

  const rendered = renderXRechnungCii(canonical.value);
  if (!rendered.ok) return { ok: false, reason: 'render_failed', issues: rendered.issues };

  return { ok: true, bytes: new TextEncoder().encode(rendered.xml) };
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

/** GO-LIVE-SECURITY-01 / FINALISIERUNG — frisch erzeugt und nicht abgelegt (Mitglied). */
function describeUngespeichert(invoice: VorgangInvoice, bytes: Uint8Array, contentSha256: string): XRechnungArtifact {
  return {
    sourceInvoiceId: invoice.id,
    sourceInvoiceNumber: invoice.number,
    format: 'xrechnung',
    syntax: 'cii',
    standardVersion: EINVOICE_STANDARDS.xrechnung.specification,
    bundleVersion: EINVOICE_STANDARDS.xrechnung.bundle,
    generatorVersion: XRECHNUNG_GENERATOR_VERSION,
    fileName: buildXRechnungFileName(invoice.number),
    contentSha256,
    byteSize: bytes.byteLength,
    createdAt: new Date().toISOString(),
    internalValidation: 'passed',
    fileRefId: '',
    durability: 'not_stored',
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
 *
 * GO-LIVE-SECURITY-01 — der Lesezugriff gibt die Bytes heraus und steht deshalb
 * hinter derselben Ausgabegrenze wie das Erzeugen (`invoiceOutputGuard`).
 */
export async function readXRechnungArtifact(
  invoice: VorgangInvoice,
): Promise<XRechnungArtifact | null> {
  if (await checkInvoiceOutput(invoice)) return null;
  return leseAbgelegteXRechnung(invoice);
}

/** Der Lesepfad ohne Grenze — nur nach einer bestandenen Prüfung aufrufen. */
async function leseAbgelegteXRechnung(invoice: VorgangInvoice): Promise<XRechnungArtifact | null> {
  try {
    const document = archiveDocumentFor(invoice);
    if (!document) return null;
    const gebunden = boundXRechnung(document);
    if (!gebunden) return null;
    const { binding, ref } = gebunden;

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

    /*
     * GO-LIVE-SECURITY-01 / FINALISIERUNG — eine Datei mit Vertrauensmarke kann von
     * einem Mitglied stammen. Ausgeliefert wird sie nur, wenn die frische Erzeugung
     * aus der festgeschriebenen Rechnung genau dieselben Bytes ergibt; sonst gar nicht.
     */
    if (isUntrustedEInvoiceBinding(binding)) {
      const frisch = renderXRechnungBytes(invoice);
      if (!frisch.ok) return null;
      if ((await computeBufferContentHash(frisch.bytes)) !== hash) return null;
    }

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
  /*
   * GO-LIVE-SECURITY-01 — die gemeinsame Ausgabegrenze, und zwar **vor** der
   * Wiederverwendung: Ohne bestätigten Leistungszeitraum (jede Rolle) oder ohne
   * Cloud-Nachweis (Mitglied) wird weder erzeugt noch eine früher abgelegte Datei
   * ausgeliefert. Die Datei selbst bleibt unangetastet liegen.
   */
  const ausgabe = await checkInvoiceOutput(invoice);
  if (ausgabe?.reason === 'service_period_unconfirmed') {
    return { ok: false, reason: 'service_period_unconfirmed', codes: ausgabe.codes };
  }
  if (ausgabe) return { ok: false, reason: 'service_period_unverified' };

  const vorhanden = await leseAbgelegteXRechnung(invoice);
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

  const gerendert = renderXRechnungBytes(invoice);
  if (!gerendert.ok) return gerendert;
  const bytes = gerendert.bytes;

  /*
   * GO-LIVE-SECURITY-01 / FINALISIERUNG — ablegen dürfen nur Inhaber, Admin und der
   * lokale Betrieb. Ein Mitglied (oder eine ungeklärte Rolle) bekommt die frisch
   * erzeugte Datei zum Herunterladen; es entsteht weder Datei noch Bindung noch
   * Sync-Auftrag — und damit nie ein Versuch, den der Server abweisen müsste.
   */
  if (!(await mayStoreEInvoiceArtifact())) {
    return {
      ok: true,
      artifact: describeUngespeichert(invoice, bytes, await computeBufferContentHash(bytes)),
      reused: false,
    };
  }

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

    const bindings = getDocumentFileRepresentationBindingStoreSnapshot();
    const registration = registerDocumentFileRepresentationBinding({
      binding: {
        documentId: document.id,
        kind: XRECHNUNG_BINDING_KIND,
        // E-RECHNUNG-04E3 — neue Artefakte tragen die Unterrolle ausdruecklich.
        part: XRECHNUNG_BINDING_PART,
        fileRefId: fileRef.id,
      },
      bindings,
    });
    /*
     * GO-LIVE-SECURITY-01 / FINALISIERUNG — eine markierte Altbindung mit anderen
     * Bytes wird durch die eigene Erzeugung ersetzt (der Server prüft und entfernt die
     * Marke). Eine vertrauenswürdige Bindung bleibt, wie sie ist: nie überschreiben.
     */
    replaceDocumentFileRepresentationBindingStore(
      registration.kind === 'conflict' && isUntrustedEInvoiceBinding(registration.existingBinding)
        ? replaceUntrustedEInvoiceBinding(bindings, registration.existingBinding, fileRef.id)
        : [...registration.bindings],
    );

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
