/**
 * OFFICEPILOT-GENERATED-INVOICE-DOCUMENT-CLOUD-05C1 — Payload, Merge, Projektion.
 *
 * Drei Aufgaben, bewusst getrennt gehalten:
 *
 *   1. Aus einem lokalen `CompanyDocument` den Cloud-Payload bauen — nur
 *      Metadaten, kein Blob, keine Dateireferenz.
 *   2. Cloud-Zeilen in den lokalen Bestand einrechnen — **fachlich** über
 *      `linkedInvoiceId`, nicht über die lokale Kennung.
 *   3. Aus den zusammengeführten Dokumenten den lokalen Komfort-Verweis
 *      `invoice.archiveDocumentId` neu herstellen.
 *
 * Punkt 2 ist der heikle: Zwei Geräte erzeugen für dieselbe Rechnung lokal
 * verschiedene `doc-<uuid>`. Die Cloud kennt genau eine kanonische Zeile. Ohne
 * fachlichen Abgleich entstünden zwei Karten für dieselbe Ausgangsrechnung.
 */
import {
  commitDocumentStoreMerge,
  getDocumentStoreSnapshot,
} from '../documentService';
import { getAllVorgaenge, updateInvoiceArchiveDocumentId } from '../vorgangService';
import { isEntitySyncActive, withTombstonedEntity } from '../sync/syncMetaService';
import {
  GENERATED_INVOICE_DOCUMENT_KIND,
  pullDocumentsFromCloud,
  type DocumentCloudOutcome,
  type WorkspaceDocumentRow,
} from './workspaceDocumentCloudService';
import type { CompanyDocument, Vorgang } from '../../types/models';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Erkennt ein selbst erzeugtes Ausgangsrechnungs-Dokument.
 *
 * Beide Bedingungen zusammen: Die Kategorie allein reicht nicht — eine
 * eingescannte fremde Ausgangsrechnung hätte keine `linkedInvoiceId` und darf
 * nicht in die Cloud.
 */
export function isCloudEligibleGeneratedInvoiceDocument(document: CompanyDocument): boolean {
  return (
    document.category === 'ausgangsrechnung' &&
    document.classifiedKind === 'ausgangsrechnung' &&
    Boolean(document.linkedInvoiceId?.trim())
  );
}

/**
 * Baut den Cloud-Payload.
 *
 * Enthalten ist ausschliesslich, was ein anderes Gerät braucht, um dasselbe
 * Dokument zu zeigen, zu finden und zu verstehen.
 *
 * **Nicht enthalten:** `fileRefId`, `sourceFileHash`, `fileSize` — sie
 * beschreiben eine Datei, die auf der fremden Origin nicht existiert. Eine
 * mitgereiste Referenz würde eine Datei vortäuschen, die niemand öffnen kann.
 *
 * **`recognizedText` ist enthalten** — und nur hier. Für dieses Dokument ist er
 * kein fremder Belegtext, sondern deterministisch aus der Rechnung gebaut
 * (Nummer, Firma, Kunde, Vorgang, Datum, Betrag). Er trägt nichts, was nicht
 * ohnehin schon in `workspace_invoices` steht, und die Suche lebt von ihm.
 * Für Fremddokumente gilt das ausdrücklich **nicht**; sie reisen gar nicht.
 */
export function buildGeneratedInvoiceDocumentPayload(
  document: CompanyDocument,
): Record<string, unknown> {
  return {
    id: document.id,
    title: document.title,
    category: document.category,
    classifiedKind: document.classifiedKind ?? null,
    issuer: document.issuer,
    recognizedText: document.recognizedText,
    issueDate: document.issueDate ?? null,
    documentDate: document.documentDate ?? null,
    validUntil: document.validUntil ?? null,
    tags: [...document.tags],
    digitalFolder: { ...document.digitalFolder },
    paperFolder: { ...document.paperFolder },
    archived: document.archived,
    linkedCompany: document.linkedCompany,
    linkedVorgang: document.linkedVorgang ? { ...document.linkedVorgang } : null,
    linkedInvoiceId: document.linkedInvoiceId ?? null,
    imagePreview: document.imagePreview ?? null,
    createdAt: document.createdAt,
  };
}

/**
 * 05C1B — die fachliche Vergleichsprojektion für erzeugte Rechnungsdokumente.
 *
 * Zwei Geräte, die dieselbe Rechnung archivieren, erzeugen zwangsläufig eine
 * andere `id` und ein anderes `createdAt` — das ist der Zeitpunkt des Klicks,
 * keine fachliche Wahrheit. Beides muss abweichen dürfen, ohne dass daraus ein
 * Konflikt wird.
 *
 * Alles Übrige ist deterministisch aus der Rechnung abgeleitet und muss
 * übereinstimmen. Weichen Titel, Kategorie, Vorgang, Aussteller, Datum, Ablage
 * oder der erkannte Text ab, behaupten zwei Geräte Verschiedenes über
 * denselben Beleg — und das wird nicht still übernommen.
 */
export function buildGeneratedInvoiceCompatibilityProjection(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { id: _id, createdAt: _createdAt, ...rest } = payload;
  return rest;
}

/**
 * Vergleichbar machen, was PostgreSQL umsortiert hat.
 *
 * `jsonb` bewahrt die Schlüsselreihenfolge nicht. Ein roher
 * `JSON.stringify`-Vergleich würde denselben Payload für verschieden halten,
 * sobald er einmal durch die Datenbank gelaufen ist.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      // `undefined` und JSON-`null` bedeuten hier beide „nicht gesetzt".
      .filter(([, entry]) => entry !== undefined && entry !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Zwei Payloads sind fachlich dasselbe Dokument. */
export function isGeneratedInvoicePayloadCompatible(
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
): boolean {
  return (
    stableStringify(buildGeneratedInvoiceCompatibilityProjection(mine)) ===
    stableStringify(buildGeneratedInvoiceCompatibilityProjection(theirs))
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Baut aus einer Cloud-Zeile ein lokales Dokument — ohne jede Dateireferenz. */
export function buildDocumentFromCloudRow(row: WorkspaceDocumentRow): CompanyDocument | null {
  const payload = row.payload;
  const title = optionalString(payload.title);
  const digitalFolder = payload.digitalFolder;
  const paperFolder = payload.paperFolder;

  if (!title || typeof digitalFolder !== 'object' || digitalFolder === null) return null;
  if (typeof paperFolder !== 'object' || paperFolder === null) return null;

  return {
    id: row.clientDocumentId,
    title,
    category: 'ausgangsrechnung',
    classifiedKind: 'ausgangsrechnung',
    issuer: optionalString(payload.issuer) ?? '',
    recognizedText: optionalString(payload.recognizedText) ?? '',
    issueDate: stringOrNull(payload.issueDate),
    documentDate: stringOrNull(payload.documentDate),
    validUntil: stringOrNull(payload.validUntil),
    digitalFolder: { ...(digitalFolder as CompanyDocument['digitalFolder']) },
    paperFolder: { ...(paperFolder as CompanyDocument['paperFolder']) },
    tags: Array.isArray(payload.tags) ? payload.tags.filter((t): t is string => typeof t === 'string') : [],
    linkedCompany: optionalString(payload.linkedCompany) ?? '',
    linkedVorgang:
      typeof payload.linkedVorgang === 'object' && payload.linkedVorgang !== null
        ? { ...(payload.linkedVorgang as CompanyDocument['linkedVorgang'] & object) }
        : null,
    linkedInvoiceId: row.linkedInvoiceId,
    archived: payload.archived === false ? false : true,
    createdAt: optionalString(payload.createdAt) ?? row.createdAt,
    imagePreview: optionalString(payload.imagePreview) ?? '🧾',
    sync: {
      updatedAt: row.updatedAt,
      version: row.rowVersion,
      deleted: false,
      deviceId: 'cloud',
      workspaceId: row.workspaceId,
    },
  };
}

/**
 * Rechnet Cloud-Zeilen in einen lokalen Bestand ein. Rein, ohne Seiteneffekt.
 *
 * Die Regel, kurz gefasst:
 *
 *   * Fachlicher Schlüssel ist `linkedInvoiceId`, nicht die Dokumentkennung.
 *   * Trägt ein lokales Dokument dieselbe Rechnung unter anderer Kennung, wird
 *     es durch die kanonische Cloud-Zeile **ersetzt** — nicht danebengestellt.
 *   * Ein Grabstein gewinnt immer, auch gegen eine aktive lokale Kopie.
 *   * Fremde Dokumentarten werden nicht angefasst.
 */
export function mergeCloudDocuments(
  local: readonly CompanyDocument[],
  rows: readonly WorkspaceDocumentRow[],
): CompanyDocument[] {
  const relevant = rows.filter((row) => row.documentKind === GENERATED_INVOICE_DOCUMENT_KIND);
  const tombstonedInvoiceIds = new Set(
    relevant.filter((row) => row.deletedAt).map((row) => row.linkedInvoiceId),
  );
  const activeRows = relevant.filter((row) => !row.deletedAt);
  const activeByInvoice = new Map(activeRows.map((row) => [row.linkedInvoiceId, row]));

  const next: CompanyDocument[] = [];
  const consumedInvoiceIds = new Set<string>();

  for (const document of local) {
    const invoiceId = document.linkedInvoiceId?.trim();
    const generated = isCloudEligibleGeneratedInvoiceDocument(document);

    // Fremde Dokumentarten bleiben unberührt — sie sind gar nicht Teil dieses Pfads.
    if (!generated || !invoiceId) {
      next.push(document);
      continue;
    }

    const cloudRow = activeByInvoice.get(invoiceId);

    if (!cloudRow) {
      /*
       * Kein aktives Cloud-Dokument. Gibt es einen Grabstein für diese
       * Rechnung, gewinnt er — auch dann, wenn die lokale Kennung eine andere
       * ist. Sonst bleibt das Dokument, wie es ist: Es ist schlicht noch nicht
       * gesichert, und das wird hier nicht als Löschung missdeutet.
       */
      if (tombstonedInvoiceIds.has(invoiceId) && isEntitySyncActive(document)) {
        next.push(withTombstonedEntity({ ...document }, 'document'));
      } else {
        next.push(document);
      }
      continue;
    }

    const canonical = buildDocumentFromCloudRow(cloudRow);
    if (!canonical) {
      // Unbrauchbare Zeile: nicht reparieren, nichts zerstören.
      next.push(document);
      continue;
    }

    /*
     * Die kanonische Zeile ersetzt das lokale Dokument — auch wenn dessen
     * Kennung abweicht. Genau das verhindert zwei Karten für dieselbe
     * Ausgangsrechnung.
     */
    consumedInvoiceIds.add(invoiceId);
    next.push(canonical);
  }

  // Cloud-Dokumente, die lokal noch gar nicht existieren.
  for (const row of activeRows) {
    if (consumedInvoiceIds.has(row.linkedInvoiceId)) continue;
    if (next.some((doc) => doc.id === row.clientDocumentId)) continue;
    const created = buildDocumentFromCloudRow(row);
    if (created) next.unshift(created);
  }

  return next;
}

export interface DocumentCloudPullApplyResult {
  outcome: DocumentCloudOutcome;
  /** Wie viele erzeugte Rechnungsdokumente die Cloud kennt (inkl. Grabsteine). */
  rowCount?: number;
  /** Wie viele lokale `archiveDocumentId` daraus wiederhergestellt wurden. */
  relinked?: number;
  /** Gesetzt, wenn der lokale Commit des Merges fehlgeschlagen ist. */
  persistFailed?: boolean;
}

/**
 * Stellt `invoice.archiveDocumentId` aus den Dokumenten wieder her.
 *
 * Das Feld ist **Projektion, nicht Wahrheit**: Cloudseitig wird die Beziehung
 * ausschliesslich über `workspace_documents.linked_invoice_id` geführt. Hier
 * wird sie in die lokale Bequemlichkeit zurückübersetzt — über den in 05B
 * gehärteten Vertrag, damit auch dieser Schritt den Reload überlebt.
 */
export function buildArchiveDocumentIdByInvoice(
  documents: readonly CompanyDocument[],
): Map<string, string> {
  const active = documents.filter(
    (doc) => isEntitySyncActive(doc) && isCloudEligibleGeneratedInvoiceDocument(doc),
  );
  return new Map(active.map((doc) => [doc.linkedInvoiceId!.trim(), doc.id]));
}

/**
 * Rein: rechnet die Projektion auf einer Vorgangsliste aus, ohne Speicher.
 *
 * Zwei Richtungen, und die zweite ist die neue: Ein Verweis wird gesetzt, wenn
 * es ein aktives Dokument gibt — und **gelöscht**, wenn es keines mehr gibt.
 * Ohne das Löschen bliebe nach einem Cloud-Grabstein ein toter Link stehen.
 */
export function reconcileArchiveLinksOnVorgaenge(
  vorgaenge: readonly Vorgang[],
  documents: readonly CompanyDocument[],
): { vorgaenge: Vorgang[]; changed: number } {
  const byInvoiceId = buildArchiveDocumentIdByInvoice(documents);
  let changed = 0;

  const next = vorgaenge.map((vorgang) => {
    let touched = false;
    const invoices = vorgang.invoices.map((invoice) => {
      const documentId = byInvoiceId.get(invoice.id);

      if (documentId) {
        if (invoice.archiveDocumentId === documentId) return invoice;
        touched = true;
        changed += 1;
        return { ...invoice, archiveDocumentId: documentId };
      }

      // Kein aktives Dokument mehr — ein bestehender Verweis wäre tot.
      if (!invoice.archiveDocumentId) return invoice;
      touched = true;
      changed += 1;
      const cleared = { ...invoice };
      delete cleared.archiveDocumentId;
      return cleared;
    });

    return touched ? { ...vorgang, invoices } : vorgang;
  });

  return { vorgaenge: next, changed };
}

export function reconcileArchiveDocumentLinks(): number {
  const documents = getDocumentStoreSnapshot();
  const byInvoiceId = buildArchiveDocumentIdByInvoice(documents);
  let relinked = 0;

  for (const vorgang of getAllVorgaenge()) {
    for (const invoice of vorgang.invoices) {
      const documentId = byInvoiceId.get(invoice.id) ?? null;
      if ((invoice.archiveDocumentId ?? null) === documentId) continue;

      const result = updateInvoiceArchiveDocumentId(vorgang.id, invoice.id, documentId);
      if (result.ok) relinked += 1;
    }
  }

  return relinked;
}

/**
 * Holt die Cloud-Dokumente und rechnet sie ein.
 *
 * Ein gescheiterter Pull ändert **nichts** — weder am Bestand noch an den
 * Verknüpfungen. Unbekannt ist nicht leer.
 */
export async function applyDocumentCloudPull(
  override?: { client?: SupabaseClient | null; workspaceId?: string; since?: string | null },
): Promise<DocumentCloudPullApplyResult> {
  const pulled = await pullDocumentsFromCloud(override);
  if (pulled.outcome !== 'synced') {
    return { outcome: pulled.outcome };
  }

  const local = getDocumentStoreSnapshot();
  const merged = mergeCloudDocuments(local, pulled.rows);

  if (!commitDocumentStoreMerge(merged)) {
    return { outcome: 'failed', rowCount: pulled.rows.length, persistFailed: true };
  }

  return {
    outcome: 'synced',
    rowCount: pulled.rows.length,
    relinked: reconcileArchiveDocumentLinks(),
  };
}

export interface DocumentPullStateResult {
  documents: CompanyDocument[];
  vorgaenge: Vorgang[];
  documentRpcFailed: boolean;
}

/**
 * GENERATED-DOCUMENT-CLOUD-WIRING-05C1B — der produktive Bootstrap-Pull.
 *
 * Arbeitet auf dem Zustand, nicht auf den Stores: Der Sync-Adapter baut den
 * neuen `AppPersistedState` zusammen und persistiert ihn **einmal** am Ende.
 * Würde hier direkt in die Stores geschrieben, gäbe es zwei Wahrheiten
 * innerhalb desselben Durchgangs.
 *
 * Ein Fehlschlag lässt Dokumente **und** Vorgänge unverändert. Ein leerer
 * erfolgreicher Pull ist ein bekannter Stand — aber kein Grund, lokale
 * Dokumente zu löschen: „noch nicht gesichert" ist nicht „gelöscht".
 *
 * Es wird ausschliesslich gelesen. Kein Upload historischer Dokumente.
 */
export async function applyDocumentPullToState(input: {
  workspaceId: string;
  documents: readonly CompanyDocument[];
  vorgaenge: readonly Vorgang[];
  report?: { errorCount: number; errors: { outboxId: string; message: string }[] };
  client?: SupabaseClient | null;
  since?: string | null;
}): Promise<DocumentPullStateResult> {
  const pulled = await pullDocumentsFromCloud({
    client: input.client,
    workspaceId: input.workspaceId,
    since: input.since,
  });

  if (pulled.outcome !== 'synced') {
    /*
     * Ohne konfigurierte Cloud ist nichts zu holen und nichts zu melden —
     * das ist der bewusst lokale Betrieb, kein Fehler.
     */
    if (input.report && pulled.outcome !== 'supabase_not_configured') {
      input.report.errorCount += 1;
      input.report.errors.push({
        outboxId: 'document-pull',
        message: pulled.detail ?? `Dokument-Pull fehlgeschlagen (${pulled.outcome})`,
      });
    }
    return {
      documents: [...input.documents],
      vorgaenge: [...input.vorgaenge],
      documentRpcFailed: pulled.outcome !== 'supabase_not_configured',
    };
  }

  const documents = mergeCloudDocuments(input.documents, pulled.rows);
  const { vorgaenge } = reconcileArchiveLinksOnVorgaenge(input.vorgaenge, documents);

  return { documents, vorgaenge, documentRpcFailed: false };
}
