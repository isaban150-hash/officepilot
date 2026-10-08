import { MOCK_COMPANY_DOCUMENTS } from '../data/documentMockData';
import { PAPER_FOLDERS } from '../data/mockData';
import { persistAll } from './persistenceService';
import { resolvePaperFilingFromInbox } from './paperFolderService';
import { getDocumentFileRefById } from './documentFileStoreService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  removeDocumentFileRepresentationBindingsForDocument,
  replaceDocumentFileRepresentationBindingStore,
} from './documentFileRepresentationBindingStoreService';
import {
  getDocumentFileDerivativeStepOutcomeStoreSnapshot,
  removeDocumentFileDerivativeStepOutcomesForDocument,
  replaceDocumentFileDerivativeStepOutcomeStore,
} from './documentFileDerivativeStepOutcomeStoreService';
import {
  getDocumentFileDerivativeRecoveryContextStoreSnapshot,
  removeDocumentFileDerivativeRecoveryContextsForDocument,
  replaceDocumentFileDerivativeRecoveryContextStore,
} from './documentFileDerivativeRecoveryContextStoreService';
import { getAllExpensesFromStore } from './expenseStore';
import { getEmployeePaymentStoreSnapshot } from './employee/employeeStore';
import { toCanonicalIsoDay } from '../utils/documentDateDisplay';
import { buildDocumentSemanticCore } from './document/documentSemanticCoreService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import { listInvoices } from './invoice/invoiceRegistryService';
import {
  getAllVorgaenge,
  restoreStagedVorgangDocumentDetach,
  stageVorgangDocumentDetach,
} from './vorgangService';
import { persistDocumentFileDerivativeRecoveryContextAfterImport } from './documentFileDerivativeRecoveryContextService';
import { documentMatchesArea } from './documentAreaCatalog';
import type { DocumentAreaFilterId } from '../types/documentArea';
import {
  isContractProofSyncHardFailure,
  syncContractProofRequirementsAfterVorgangLink,
} from './contractProofSyncAfterVorgangLinkService';
import {
  getOfficePilotMemorySnapshot,
  hydrateMemory,
  isContractInboxItem,
  recordArchivedDocumentMemory,
  syncContractProofRequirementsFromInbox,
  tombstoneMemoryForDocument,
} from './officePilotMemoryService';
import {
  getInboxItemById,
  markInboxImportedToArchive,
  restoreStagedInboxItemTombstone,
  stageInboxItemTombstone,
} from './inboxService';
import {
  filterSyncActive,
  generateEntityId,
  isEntitySyncActive,
  withNewEntitySync,
  withTombstonedCloudEntityPreservingRemoteVersion,
} from './sync/syncMetaService';
import type {
  CompanyDocument,
  CompanyDocumentCategory,
  CompanyDocumentInput,
  CompanyDocumentVorgangLink,
  DigitalFolder,
  DocumentType,
  InboxItem,
  PaperFilingRule,
  Vorgang,
} from '../types/models';
import {
  buildDocumentArchiveTruthSnapshotFromInbox,
  cloneDocumentArchiveTruthSnapshot,
  preferExistingArchiveTruthSnapshot,
} from './documentArchiveTruthSnapshotService';
import { resolveConfirmedFilingDecisionForInboxArchive } from './documentFilingDecisionService';
import {
  resolvePrimaryTargetObjectForDocumentType,
  resolvePrimaryTargetObjectForKind,
} from './documentPrimaryTargetService';

export const COMPANY_DOCUMENT_CATEGORIES: CompanyDocumentCategory[] = [
  'vertrag',
  'versicherung',
  'zertifikat',
  'steuer',
  'ausgangsrechnung',
  'behoerde',
  'personal',
  'geschaeftsschreiben',
  'sonstiges',
];

export type DocumentMutationResult =
  | { success: true; document: CompanyDocument }
  | { success: false; errorKey: string };

let documents: CompanyDocument[] = [];

function cloneDocument(doc: CompanyDocument): CompanyDocument {
  return {
    ...doc,
    digitalFolder: { ...doc.digitalFolder },
    paperFolder: { ...doc.paperFolder },
    tags: [...doc.tags],
    linkedVorgang: doc.linkedVorgang ? { ...doc.linkedVorgang } : null,
    linkedInvoiceId: doc.linkedInvoiceId ?? null,
    linkedLetterId: doc.linkedLetterId ?? null,
    linkedOfferId: doc.linkedOfferId ?? null,
    archiveTruthSnapshot: doc.archiveTruthSnapshot
      ? cloneDocumentArchiveTruthSnapshot(doc.archiveTruthSnapshot)
      : undefined,
  };
}

function fileFieldsFromInput(input: CompanyDocumentInput): Pick<
  CompanyDocument,
  | 'fileRefId'
  | 'sourceFileHash'
  | 'originalFileName'
  | 'mimeType'
  | 'fileSize'
  | 'classifiedKind'
  | 'sourceInboxItemId'
  | 'documentDate'
  | 'uploadedAt'
> {
  return {
    fileRefId: input.fileRefId,
    sourceFileHash: input.sourceFileHash,
    originalFileName: input.originalFileName,
    mimeType: input.mimeType,
    fileSize: input.fileSize,
    classifiedKind: input.classifiedKind,
    sourceInboxItemId: input.sourceInboxItemId,
    documentDate: input.documentDate ?? null,
    uploadedAt: input.uploadedAt,
  };
}

function defaultDigitalFolder(): DigitalFolder {
  return {
    id: generateEntityId('dig-doc'),
    name: 'Firmendokumente',
    path: '/Firma/Dokumente/',
  };
}

function defaultPaperFolder(): PaperFilingRule {
  const folder = PAPER_FOLDERS[4] ?? PAPER_FOLDERS[0];
  return {
    folderId: folder.id,
    register: folder.registers[0] ?? 'A',
    label: folder.name,
  };
}

function normalizeTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTags(tags?: string[]): string[] {
  if (!tags) return [];
  return tags.map((t) => t.trim()).filter(Boolean);
}

function validateInput(input: CompanyDocumentInput): string | null {
  if (!normalizeTitle(input.title)) return 'document.titleRequired';
  if (!input.category) return 'document.categoryRequired';
  return null;
}

function buildDocumentFromInput(
  input: CompanyDocumentInput,
  id: string,
  createdAt: string,
): CompanyDocument {
  return {
    id,
    title: normalizeTitle(input.title)!,
    category: input.category,
    issuer: input.issuer?.trim() ?? '',
    recognizedText: input.recognizedText?.trim() ?? '',
    issueDate: input.issueDate ?? null,
    validUntil: input.validUntil ?? null,
    digitalFolder: input.digitalFolder ? { ...input.digitalFolder } : defaultDigitalFolder(),
    paperFolder: input.paperFolder ? { ...input.paperFolder } : defaultPaperFolder(),
    tags: normalizeTags(input.tags),
    linkedCompany: input.linkedCompany?.trim() ?? '',
    linkedVorgang: input.linkedVorgang ? { ...input.linkedVorgang } : null,
    archived: input.archived ?? true,
    createdAt,
    imagePreview: input.imagePreview ?? '📄',
    linkedInvoiceId: input.linkedInvoiceId ?? null,
    linkedLetterId: input.linkedLetterId ?? null,
    linkedOfferId: input.linkedOfferId ?? null,
    // CLOUD-SYNC S4 — Nacharbeit 1: nur ein Dokument mit Lösungs-Geschichte trägt das Feld.
    ...(input.vorgangLinkReleasedAt !== undefined
      ? { vorgangLinkReleasedAt: input.vorgangLinkReleasedAt }
      : {}),
    ...fileFieldsFromInput(input),
    ...(input.archiveTruthSnapshot
      ? {
          archiveTruthSnapshot: cloneDocumentArchiveTruthSnapshot(input.archiveTruthSnapshot),
        }
      : {}),
  };
}

export function getDocumentStoreSnapshot(): CompanyDocument[] {
  return documents.map(cloneDocument);
}

export function hydrateDocumentStore(items: CompanyDocument[]): void {
  documents = items.map(cloneDocument);
}

/**
 * GENERATED-INVOICE-DOCUMENT-CLOUD-05C1 — atomarer Austausch nach einem Merge.
 *
 * Der Cloud-Merge rechnet den neuen Bestand ausserhalb aus und übergibt ihn
 * hier in einem Stück. Ein `persistAll()`, bei Fehlschlag der vorherige
 * Bestand zurück — derselbe Vertrag wie bei `commitVorgangMutation`.
 *
 * Bewusst kein zweiter Schreibweg neben `addDocument`/`updateDocument`: Diese
 * Funktion setzt keine SyncMeta und validiert keine Eingabe, weil sie fertige
 * Dokumente entgegennimmt. Sie ist ausschliesslich für den Cloud-Merge gedacht.
 */
export function commitDocumentStoreMerge(next: CompanyDocument[]): boolean {
  const previous = documents;
  documents = next.map(cloneDocument);
  const result = persistAll();
  if (!result.success) {
    documents = previous;
    return false;
  }
  return true;
}

export function resetDocuments(): void {
  documents = MOCK_COMPANY_DOCUMENTS.map(cloneDocument);
}

export function getAllDocuments(): CompanyDocument[] {
  return filterSyncActive(documents).map(cloneDocument);
}

export function getDocumentById(id: string): CompanyDocument | undefined {
  const doc = documents.find((d) => d.id === id && isEntitySyncActive(d));
  return doc ? cloneDocument(doc) : undefined;
}

/**
 * NORMAL-INVOICE-CANCELLATION-01B — welches der beiden Rechnungsdokumente
 * gemeint ist. Eine Rechnung kann gleichzeitig ihr Original-Archivdokument
 * und einen Korrekturbeleg besitzen; beide tragen dieselbe `linkedInvoiceId`.
 */
export type LinkedInvoiceDocumentKind = 'original' | 'correction';

export function isInvoiceCorrectionDocument(document: Pick<CompanyDocument, 'classifiedKind'>): boolean {
  return document.classifiedKind === 'rechnungskorrektur';
}

export function getDocumentByLinkedInvoiceId(
  invoiceId: string,
  kind: LinkedInvoiceDocumentKind = 'original',
): CompanyDocument | undefined {
  const doc = documents.find(
    (d) =>
      d.linkedInvoiceId === invoiceId &&
      isEntitySyncActive(d) &&
      isInvoiceCorrectionDocument(d) === (kind === 'correction'),
  );
  return doc ? cloneDocument(doc) : undefined;
}

/**
 * BRIEFE-01D — das Archivdokument zu einem Geschäftsschreiben.
 *
 * Grundlage der Idempotenz: Vor dem Anlegen wird hier nachgesehen, ob es das
 * Dokument schon gibt. Ein zweites Öffnen, Neuladen oder Herunterladen darf
 * keinen zweiten Eintrag erzeugen.
 */
export function getDocumentByLinkedLetterId(letterId: string): CompanyDocument | undefined {
  const gesucht = letterId.trim();
  if (!gesucht) return undefined;
  const doc = documents.find((d) => d.linkedLetterId === gesucht && isEntitySyncActive(d));
  return doc ? cloneDocument(doc) : undefined;
}

/** ANGEBOT-01B — der Rückweg vom Angebot zur Ablage; derselbe Zweck wie bei Briefen. */
export function getDocumentByLinkedOfferId(offerId: string): CompanyDocument | undefined {
  const gesucht = offerId.trim();
  if (!gesucht) return undefined;
  const doc = documents.find((d) => d.linkedOfferId === gesucht && isEntitySyncActive(d));
  return doc ? cloneDocument(doc) : undefined;
}

export function getDocumentsByCategory(category: CompanyDocumentCategory): CompanyDocument[] {
  return filterSyncActive(documents).filter((d) => d.category === category).map(cloneDocument);
}

export function searchDocuments(
  query: string,
  filter:
    | CompanyDocumentCategory
    | 'all'
    | {
        category?: CompanyDocumentCategory | 'all';
        area?: DocumentAreaFilterId;
      } = 'all',
): CompanyDocument[] {
  const normalizedQuery = query.trim().toLowerCase();
  const categoryFilter = typeof filter === 'string' ? filter : (filter.category ?? 'all');
  const areaFilter = typeof filter === 'string' ? 'alle' : (filter.area ?? 'alle');

  return documents
    .filter((doc) => isEntitySyncActive(doc))
    .filter((doc) => {
      if (categoryFilter && categoryFilter !== 'all' && doc.category !== categoryFilter) {
        return false;
      }
      if (!documentMatchesArea(doc, areaFilter)) {
        return false;
      }
      if (!normalizedQuery) return true;

      const haystack = [
        doc.title,
        doc.issuer,
        doc.recognizedText,
        doc.linkedCompany,
        doc.linkedVorgang?.vorgangTitle ?? '',
        ...doc.tags,
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    })
    .map(cloneDocument);
}

export function addDocument(input: CompanyDocumentInput): DocumentMutationResult {
  return insertNewDocument(input, generateEntityId('doc'));
}

/**
 * P1 MITARBEITERZAHLUNGEN — Ablage unter einer festen, vom Aufrufer
 * abgeleiteten Kennung (etwa `emp-receipt-<payment-id>`).
 *
 * Damit erzeugen zwei Geräte für dieselbe Zahlung nie zwei Originale: Beide
 * landen auf derselben Dokumentkennung. Eine bereits vergebene Kennung — auch
 * die eines gelöschten Dokuments — wird nie überschrieben.
 */
export function addDocumentWithId(input: CompanyDocumentInput, id: string): DocumentMutationResult {
  const kennung = id.trim();
  if (!kennung) return { success: false, errorKey: 'document.idInvalid' };
  if (documents.some((d) => d.id === kennung)) return { success: false, errorKey: 'document.idTaken' };
  return insertNewDocument(input, kennung);
}

function insertNewDocument(input: CompanyDocumentInput, id: string): DocumentMutationResult {
  const validationError = validateInput(input);
  if (validationError) return { success: false, errorKey: validationError };

  const previousDocuments = documents;
  const now = new Date().toISOString();
  const document = withNewEntitySync(
    buildDocumentFromInput(input, id, now),
    'document',
  );
  documents = [document, ...documents];
  recordArchivedDocumentMemory(document);
  const persistResult = persistAll();
  if (!persistResult.success) {
    documents = previousDocuments;
    tombstoneMemoryForDocument(document.id);
    return { success: false, errorKey: 'document.persistFailed' };
  }
  return { success: true, document: cloneDocument(document) };
}

/**
 * CLOUD-SYNC S4 — Nacharbeit 1: Wird eine bestehende Vorgangszuordnung am
 * Dokument entfernt, hält das Dokument fest, dass sie ausdrücklich gelöst
 * wurde — sonst stellte die ältere Bindung des Eingangs sie im
 * Firmen-Gedächtnis wieder her. Eine neue Zuordnung hebt das auf: `null`
 * statt Weglassen, damit das Aufheben auf jedes Gerät reist (der Abzug führt
 * die Dokumentfelder zusammen). Ein Dokument ohne Lösungs-Geschichte bleibt
 * unverändert ohne das Feld.
 */
function nextVorgangLinkReleasedAt(
  current: CompanyDocument,
  changes: Partial<CompanyDocumentInput>,
): string | null | undefined {
  if (changes.vorgangLinkReleasedAt !== undefined) return changes.vorgangLinkReleasedAt;
  if (changes.linkedVorgang === undefined) return current.vorgangLinkReleasedAt;
  if (changes.linkedVorgang) return current.vorgangLinkReleasedAt === undefined ? undefined : null;
  return current.linkedVorgang ? new Date().toISOString() : current.vorgangLinkReleasedAt;
}

/**
 * CUSTOMER-FACHOBJEKT-03B2 — same merge, validation and SyncMeta bump as
 * updateDocument, but without persisting. The caller owns persist and rollback.
 */
export function stageDocumentUpdate(
  id: string,
  changes: Partial<CompanyDocumentInput>,
): DocumentMutationResult {
  const index = documents.findIndex((d) => d.id === id);
  if (index === -1) return { success: false, errorKey: 'document.notFound' };

  const current = documents[index];
  const merged: CompanyDocumentInput = {
    title: changes.title ?? current.title,
    category: changes.category ?? current.category,
    issuer: changes.issuer ?? current.issuer,
    recognizedText: changes.recognizedText ?? current.recognizedText,
    issueDate: changes.issueDate !== undefined ? changes.issueDate : current.issueDate,
    validUntil: changes.validUntil !== undefined ? changes.validUntil : current.validUntil,
    digitalFolder: changes.digitalFolder ?? current.digitalFolder,
    paperFolder: changes.paperFolder ?? current.paperFolder,
    tags: changes.tags ?? current.tags,
    linkedCompany: changes.linkedCompany ?? current.linkedCompany,
    linkedVorgang:
      changes.linkedVorgang !== undefined ? changes.linkedVorgang : current.linkedVorgang,
    vorgangLinkReleasedAt: nextVorgangLinkReleasedAt(current, changes),
    archived: changes.archived ?? current.archived,
    imagePreview: changes.imagePreview ?? current.imagePreview,
    linkedInvoiceId:
      changes.linkedInvoiceId !== undefined ? changes.linkedInvoiceId : current.linkedInvoiceId,
    linkedLetterId:
      changes.linkedLetterId !== undefined ? changes.linkedLetterId : current.linkedLetterId,
    linkedOfferId:
      changes.linkedOfferId !== undefined ? changes.linkedOfferId : current.linkedOfferId,
    fileRefId: changes.fileRefId ?? current.fileRefId,
    sourceFileHash: changes.sourceFileHash ?? current.sourceFileHash,
    originalFileName: changes.originalFileName ?? current.originalFileName,
    mimeType: changes.mimeType ?? current.mimeType,
    fileSize: changes.fileSize ?? current.fileSize,
    classifiedKind: changes.classifiedKind ?? current.classifiedKind,
    sourceInboxItemId: changes.sourceInboxItemId ?? current.sourceInboxItemId,
    documentDate: changes.documentDate !== undefined ? changes.documentDate : current.documentDate,
    uploadedAt: changes.uploadedAt ?? current.uploadedAt,
    archiveTruthSnapshot: preferExistingArchiveTruthSnapshot(
      current.archiveTruthSnapshot,
      changes.archiveTruthSnapshot,
    ),
  };

  const validationError = validateInput(merged);
  if (validationError) return { success: false, errorKey: validationError };

  /*
   * 07B-FIX2 — lokale Fachänderung: `sync` bleibt unangetastet (wie bei Brief,
   * Notiz, Vorgang — SYNC-VERSION-CONTRACT-02). Archivdokumente gehen seit
   * 20260916 über `upsert_workspace_intake_entity`, und dort muss die
   * erwartete Version **exakt** die zuletzt vom Server bestätigte sein. Das
   * frühere `withUpdatedEntitySync` erhöhte sie lokal um 1; jede Änderung an
   * einem bereits gesyncten Dokument endete damit als „Versionskonflikt
   * archived_document" (blocked) — sichtbar geworden bei der Brief-PDF-
   * Nachrüstung. Die Änderung erkennt der Change-Tracker am Inhalt
   * (`contentKey`), nicht an der Version.
   */
  const built = buildDocumentFromInput(merged, current.id, current.createdAt);
  const updated: CompanyDocument = current.sync ? { ...built, sync: current.sync } : built;
  documents = [...documents.slice(0, index), updated, ...documents.slice(index + 1)];
  return { success: true, document: cloneDocument(updated) };
}

export function updateDocument(
  id: string,
  changes: Partial<CompanyDocumentInput>,
): DocumentMutationResult {
  const previousDocuments = documents;
  const staged = stageDocumentUpdate(id, changes);
  if (!staged.success) return staged;

  const persistResult = persistAll();
  if (!persistResult.success) {
    documents = previousDocuments;
    return { success: false, errorKey: 'document.persistFailed' };
  }
  return staged;
}

/**
 * GENERATED-INVOICE-UNDERSTANDING-02B — ein von OfficePilot selbst erzeugtes
 * Ausgangsrechnungsdokument.
 *
 * Erkannt an vorhandenen autoritativen Feldern, nicht an einer neuen Markierung:
 * die Kategorie sagt, *was* es ist, die Rechnungsverknüpfung, *dass* es aus
 * einer eigenen Rechnung entstand. Fremdpost hat nie beides zugleich.
 *
 * Dient den Lesern, die sonst Fremddokument-Heuristik anwenden würden.
 */
export function isGeneratedOutgoingInvoiceDocument(document: CompanyDocument): boolean {
  return document.category === 'ausgangsrechnung' && Boolean(document.linkedInvoiceId?.trim());
}

/**
 * BROWSER-ACCEPTANCE-FIX 01 / A1 — der archivierte Beleg einer
 * festgeschriebenen Ausgangsrechnung (vorbereitet/versendet).
 *
 * Er ist Teil der Rechnungswahrheit und wird nie gelöscht. Die verbindliche
 * Regel steht serverseitig in `tombstone_workspace_document`; diese lokale
 * Spiegelung verhindert nur, dass die Oberfläche einen Weg anbietet, den der
 * Server ohnehin ablehnt. Erkannt über die autoritative Verknüpfung in beide
 * Richtungen (Dokument → Rechnung, Rechnung → Archivdokument).
 */
export function isFinalizedInvoiceArchiveDocument(document: CompanyDocument): boolean {
  const invoiceId = document.linkedInvoiceId?.trim();
  const isInvoiceDocument =
    document.category === 'ausgangsrechnung' || isInvoiceCorrectionDocument(document);
  if (!isInvoiceDocument) return false;
  return listInvoices().some(
    (invoice) =>
      (invoice.status === 'vorbereitet' || invoice.status === 'versendet') &&
      ((Boolean(invoiceId) && invoice.id === invoiceId) ||
        invoice.archiveDocumentId === document.id),
  );
}

export const DOCUMENT_DELETE_FINALIZED_INVOICE_KEY = 'document.delete.blocked.finalizedInvoice';

/** Why an archive document may not be deleted — null when it may. */
export type DocumentDeleteBlockReason =
  | 'confirmed_order'
  | 'expense'
  /** BARZAHLUNG-V1 NACHTRAG 1 — Nachweis einer Zahlung, aktiv oder storniert. */
  | 'payment_proof'
  | 'vorgang';

const DOCUMENT_DELETE_BLOCK_ERROR_KEYS: Record<DocumentDeleteBlockReason, string> = {
  confirmed_order: 'document.delete.blocked.confirmedOrder',
  expense: 'document.delete.blocked.expense',
  payment_proof: 'document.delete.blocked.paymentProof',
  vorgang: 'document.delete.blocked.vorgang',
};

/**
 * BARZAHLUNG-V1 NACHTRAG 1 — führt irgendeine Zahlung dieses Dokument als
 * Nachweis?
 *
 * Nur die **lokal sichtbaren** Zahlungen; stornierte fallen aus der
 * Projektion heraus. Das ist Absicht und kein Versehen: Die verbindliche
 * Prüfung sitzt serverseitig in `assert_document_not_payment_proof`, die
 * auch die stornierten Zeilen sieht. Hier geht es nur darum, den
 * häufigsten Fall sofort zu beantworten, statt den Nutzer auf eine
 * Netzwerkantwort warten zu lassen.
 */
function isPaymentProofDocument(documentId: string): boolean {
  return (
    getAllExpensesFromStore().some((expense) =>
      (expense.payments ?? []).some((payment) => payment.proofDocumentId === documentId),
    ) ||
    /*
     * P1 MITARBEITERZAHLUNGEN — erzeugte Quittung und Nachweis. Anders als bei
     * den Ausgaben bleiben stornierte Mitarbeiterzahlungen lokal sichtbar; ihr
     * Beleg ist Prüfspur und bleibt geschützt.
     */
    getEmployeePaymentStoreSnapshot().some(
      (payment) => payment.receiptDocumentId === documentId || payment.proofDocumentId === documentId,
    )
  );
}

/** Active Vorgänge that still list this document in their document section. */
function vorgaengeListingDocument(documentId: string): Vorgang[] {
  return getAllVorgaenge().filter((vorgang) =>
    (vorgang.documents ?? []).some((doc) => doc.companyDocumentId === documentId),
  );
}

/**
 * DOCUMENT-DELETE-SEMANTICS-01I — the one state that still stops a final delete.
 *
 * A receipt behind a booked expense is not the user's to drop as a side effect
 * of tidying the archive; the expense has to go first. Evaluated on its own
 * rather than through the ordered reason below, because a document can be both
 * a confirmed order's contract and an expense receipt — and then the expense
 * must win.
 */
function isExpenseReceipt(document: CompanyDocument): boolean {
  const origin = document.sourceInboxItemId?.trim();
  return getAllExpensesFromStore().some(
    (expense) =>
      expense.archiveDocumentId === document.id ||
      (Boolean(origin) && expense.linkedInboxId === origin),
  );
}

/**
 * Describes what the document is still involved in — a diagnosis, not a veto.
 *
 * Since 01I only `expense` stops the final delete (see `deleteDocument`); the
 * Vorgang states are reported so the UI can explain a document's role, and the
 * ordering is unchanged so existing readers keep seeing the same answer.
 *
 * `sourceInboxItemId` alone never blocks — provenance is not an active claim.
 */
export function getDocumentDeleteBlockReason(
  document: CompanyDocument,
): DocumentDeleteBlockReason | null {
  const origin = document.sourceInboxItemId?.trim();

  // 1. Confirmed order via the active document reference.
  if (vorgaengeListingDocument(document.id).some((vorgang) => vorgang.contractConfirmation)) {
    return 'confirmed_order';
  }

  // 2. Confirmed order via origin — survives a completed unlink.
  if (
    origin &&
    getAllVorgaenge().some(
      (vorgang) => vorgang.createdFromInboxId === origin && vorgang.contractConfirmation,
    )
  ) {
    return 'confirmed_order';
  }

  // 3. Receipt of an expense — via its own reference or the shared origin.
  if (isExpenseReceipt(document)) return 'expense';

  /*
   * 3b. NACHTRAG 1 — Zahlungsnachweis. Steht bewusst neben dem Belegschutz
   * und nicht in ihm: „Beleg einer Ausgabe" und „Nachweis einer Zahlung"
   * sind zwei verschiedene Aussagen, und der Nutzer soll die richtige
   * lesen.
   */
  if (isPaymentProofDocument(document.id)) return 'payment_proof';

  // 4. Active Vorgang link.
  if (document.linkedVorgang?.vorgangId?.trim()) return 'vorgang';

  // 5. Defense in depth: the counter-reference alone is enough.
  if (vorgaengeListingDocument(document.id).length > 0) return 'vorgang';

  return null;
}

export function deleteDocument(id: string): DocumentMutationResult {
  const index = documents.findIndex((d) => d.id === id && isEntitySyncActive(d));
  if (index === -1) return { success: false, errorKey: 'document.notFound' };

  const document = documents[index];

  /**
   * DOCUMENT-DELETE-SEMANTICS-01I — the user confirmed twice; this deletes.
   *
   * A Vorgang link or a confirmed order no longer stands in the way: the user
   * should not have to release technical references by hand before being
   * allowed to remove a file. Those references are cleaned up below, as part of
   * this same commit. Only a booked expense still says no.
   */
  if (isExpenseReceipt(document)) {
    return { success: false, errorKey: DOCUMENT_DELETE_BLOCK_ERROR_KEYS.expense };
  }
  /*
   * NACHTRAG 1 — ein Zahlungsnachweis wird nicht gelöscht, auch nicht
   * lokal. Die Referenz wird dabei **nicht** gelöst: Eine Auditspur still
   * abzuschneiden wäre schlimmer als eine Löschung, die nicht geht.
   */
  if (isPaymentProofDocument(document.id)) {
    return { success: false, errorKey: DOCUMENT_DELETE_BLOCK_ERROR_KEYS.payment_proof };
  }
  /*
   * NORMAL-INVOICE-CANCELLATION-01B — der Korrekturbeleg ist Teil der
   * Stornowahrheit einer Rechnung. Er wird nie gelöscht; die Cloud-Zeile
   * bliebe ohnehin bestehen und käme beim nächsten Pull zurück.
   */
  if (isInvoiceCorrectionDocument(document)) {
    return { success: false, errorKey: 'document.delete.blocked.correction' };
  }
  // BROWSER-ACCEPTANCE-FIX 01 / A1 — Beleg einer festgeschriebenen Rechnung.
  if (isFinalizedInvoiceArchiveDocument(document)) {
    return { success: false, errorKey: DOCUMENT_DELETE_FINALIZED_INVOICE_KEY };
  }
  // Capture original + binding FileRefs before bindings are removed.
  const heldFileRefIds = new Set<string>();
  if (document.fileRefId) {
    heldFileRefIds.add(document.fileRefId);
  }
  for (const binding of getDocumentFileRepresentationBindingStoreSnapshot()) {
    if (binding.documentId === id) {
      heldFileRefIds.add(binding.fileRefId);
    }
  }

  /**
   * Everything below is staged in memory and committed by the single
   * persistAll() further down. A failed persist restores all of it, so a
   * half-deleted document can no longer survive.
   */
  const previousDocuments = documents;
  const previousMemory = getOfficePilotMemorySnapshot();
  const previousBindings = getDocumentFileRepresentationBindingStoreSnapshot();
  const previousStepOutcomes = getDocumentFileDerivativeStepOutcomeStoreSnapshot();
  const previousRecoveryContexts = getDocumentFileDerivativeRecoveryContextStoreSnapshot();

  /**
   * The tombstone must not carry an active-looking relation, so the link is
   * dropped before it is written. The provenance field stays — it is history.
   */
  // 07B-FIX2 — dieselbe Versionsregel wie beim Ändern: die bestätigte Serverversion bleibt die Erwartung.
  const tombstoned = withTombstonedCloudEntityPreservingRemoteVersion(
    cloneDocument({ ...document, linkedVorgang: null }),
    'document',
  );
  documents = [...documents.slice(0, index), tombstoned, ...documents.slice(index + 1)];
  tombstoneMemoryForDocument(id);
  removeDocumentFileRepresentationBindingsForDocument(id);
  removeDocumentFileDerivativeStepOutcomesForDocument(id);
  removeDocumentFileDerivativeRecoveryContextsForDocument(id);

  // Every Vorgang that still lists this document loses exactly that entry.
  const stagedDetach = stageVorgangDocumentDetach(id);

  /**
   * The invisible intake row goes with it. Clearing single fields would not be
   * enough: an active row still counts as a holder of the shared FileRef, so
   * the original file would silently survive a delete the user just confirmed.
   * Only ever the row that actually refers to this document.
   */
  const origin = document.sourceInboxItemId?.trim();
  const originItem = origin ? getInboxItemById(origin) : undefined;
  const ownsThisDocument = Boolean(originItem && originItem.archiveDocumentId === id);
  const stagedOriginTombstone =
    origin && ownsThisDocument
      ? stageInboxItemTombstone(origin, {
          archiveDocumentId: undefined,
          vorgangId: undefined,
          vorgangTitle: undefined,
          vorgangLinkStatus: undefined,
          vorgangAssignment: undefined,
        })
      : null;

  const persistResult = persistAll();
  if (!persistResult.success) {
    documents = previousDocuments;
    hydrateMemory(previousMemory);
    replaceDocumentFileRepresentationBindingStore(previousBindings);
    replaceDocumentFileDerivativeStepOutcomeStore(previousStepOutcomes);
    replaceDocumentFileDerivativeRecoveryContextStore(previousRecoveryContexts);
    restoreStagedVorgangDocumentDetach(stagedDetach);
    if (stagedOriginTombstone) {
      restoreStagedInboxItemTombstone(stagedOriginTombstone);
    }
    return { success: false, errorKey: 'document.persistFailed' };
  }

  // Only after the commit — a failed delete must never release the file.
  queueMicrotask(() => {
    void import('./documentFileReferenceService')
      .then(async ({ releaseDocumentFileIfUnreferenced }) => {
        for (const fileRefId of heldFileRefIds) {
          await releaseDocumentFileIfUnreferenced(fileRefId);
        }
      })
      .then(() => persistAll());
  });
  return { success: true, document: cloneDocument(tombstoned) };
}

export function linkDocumentToVorgang(
  id: string,
  link: CompanyDocumentVorgangLink | null,
): DocumentMutationResult {
  /*
   * CLOUD-SYNC S4 — Nacharbeit 1: „kein Vorgang" ist hier eine ausdrückliche
   * Entscheidung auf Dokumentebene — auch wenn die Zuordnung nur noch am
   * Eingang hing (Altbestand). Ein schon gelöstes Dokument behält seinen Zeitpunkt.
   */
  const result = updateDocument(id, {
    linkedVorgang: link,
    ...(link
      ? {}
      : { vorgangLinkReleasedAt: getDocumentById(id)?.vorgangLinkReleasedAt ?? new Date().toISOString() }),
  });
  if (!result.success) return result;

  const vorgangId = link?.vorgangId?.trim();
  if (!vorgangId) return result;

  const inboxItem = result.document.sourceInboxItemId
    ? getInboxItemById(result.document.sourceInboxItemId)
    : null;

  const syncResult = syncContractProofRequirementsAfterVorgangLink({
    vorgangId,
    document: result.document,
    inboxItem,
  });

  if (isContractProofSyncHardFailure(syncResult)) {
    return {
      success: false,
      errorKey:
        syncResult.status === 'persist_failed'
          ? 'document.persistFailed'
          : syncResult.status === 'workspace_rejected' || syncResult.status === 'vorgang_not_found'
            ? 'document.contractProofWorkspaceRejected'
            : 'document.contractProofSourceUnavailable',
    };
  }

  return result;
}

function normalizeDuplicateKey(title: string, issuer: string): string {
  return `${title.trim().toLowerCase()}|${issuer.trim().toLowerCase()}`;
}

function buildRecognizedTextFromInbox(item: InboxItem): string {
  const lines = Object.entries(item.recognizedData).map(([key, value]) => `${key}: ${value}`);
  if (item.officePilotSuggestion) {
    lines.push('', item.officePilotSuggestion);
  }
  return lines.join('\n').trim();
}

function buildTagsFromInbox(item: InboxItem): string[] {
  const tags = [`Inbox:${item.documentType}`];
  if (item.sourceFileName) tags.push(item.sourceFileName);
  if (item.vorgangTitle) tags.push(item.vorgangTitle);
  return tags;
}

function mapDocumentCategory(item: InboxItem): CompanyDocumentCategory {
  const text = `${item.sender} ${item.title} ${JSON.stringify(item.recognizedData)}`.toLowerCase();
  const primaryTarget = item.classifiedKind
    ? resolvePrimaryTargetObjectForKind(item.classifiedKind)
    : resolvePrimaryTargetObjectForDocumentType(item.documentType);

  if (primaryTarget === 'expense') return 'steuer';
  if (primaryTarget === 'vorgangInvoice') return 'ausgangsrechnung';
  if (primaryTarget === 'vorgang') return 'vertrag';
  if (primaryTarget === 'proofMemory') {
    if (/versicherung|allianz|haftpflicht|policy/.test(text)) return 'versicherung';
    return 'behoerde';
  }

  switch (item.documentType) {
    case 'behoerde':
      if (/versicherung|allianz|haftpflicht|policy/.test(text)) return 'versicherung';
      return 'behoerde';
    case 'eingangsrechnung':
      return 'steuer';
    case 'ausgangsrechnung':
      return 'ausgangsrechnung';
    case 'kundenauftrag':
      return 'vertrag';
    case 'brief':
      return 'sonstiges';
    default:
      return 'sonstiges';
  }
}

function imagePreviewForDocumentType(type: DocumentType): string {
  switch (type) {
    case 'behoerde':
      return '🏛️';
    case 'brief':
      return '✉️';
    case 'eingangsrechnung':
    case 'ausgangsrechnung':
      return '🧾';
    case 'kundenauftrag':
      return '📋';
    default:
      return '📄';
  }
}

function linkedVorgangFromInbox(item: InboxItem): CompanyDocumentVorgangLink | null {
  if (!item.vorgangId || !item.vorgangTitle) return null;
  return { vorgangId: item.vorgangId, vorgangTitle: item.vorgangTitle };
}

function fileMetaFromInbox(item: InboxItem): Pick<
  CompanyDocumentInput,
  | 'fileRefId'
  | 'sourceFileHash'
  | 'originalFileName'
  | 'mimeType'
  | 'fileSize'
  | 'classifiedKind'
  | 'sourceInboxItemId'
  | 'documentDate'
  | 'uploadedAt'
> {
  const ref = item.fileRefId ? getDocumentFileRefById(item.fileRefId) : undefined;
  return {
    fileRefId: item.fileRefId ?? ref?.id,
    sourceFileHash: item.sourceFileHash ?? ref?.contentHash,
    originalFileName: ref?.originalFileName ?? item.sourceFileName,
    mimeType: ref?.mimeType,
    fileSize: ref?.fileSize,
    classifiedKind: item.classifiedKind,
    sourceInboxItemId: item.id,
    documentDate: item.receivedAt || null,
    uploadedAt: ref?.createdAt ?? item.receivedAt,
  };
}

/**
 * EINGANG-01A — das Gültigkeitsende eines Eingangs: das erkannte Feld, sonst
 * ein eindeutiges Gültigkeitsende, das der semantische Kern im gespeicherten
 * Text findet (ältere Eingänge tragen das Feld noch nicht). Nie die
 * Handlungsfrist.
 */
function resolveInboxValidUntil(item: InboxItem): string | null {
  const recognized = toCanonicalIsoDay(item.recognizedData.Gültig_bis);
  if (recognized) return recognized;
  const text = getInboxExtractedDocumentText(item);
  if (!text) return resolveLegacyExemptionValidUntil(item);
  const ends = buildDocumentSemanticCore({ text, companyProfile: null }).deadlines.filter(
    (frist) => frist.type === 'validity_period_end',
  );
  return ends.length === 1 ? toCanonicalIsoDay(ends[0].date) : null;
}

/**
 * Wartungsfix nach 01C-1 — Rückwärtskompatibilität für Freistellungen vor 01A.
 *
 * Vor EINGANG-01A landete das „gültig bis" einer Freistellungsbescheinigung
 * in `deadline`; `Gültig_bis` und gespeicherter Text fehlen bei diesem
 * Altbestand. Nur hier — Dokumentart sicher Freistellung, kein neues
 * Gültigkeitsfeld, kein Text (sonst gilt der Weg über den Text) — wird die
 * alte `deadline` als Gültigkeitsende gelesen, und nur als eindeutiger Tag.
 * Für jedes andere Dokument bleibt `deadline` eine Handlungsfrist (01A).
 *
 * Positives Altbestands-Merkmal: Vor 01A stand die `deadline` roh als
 * TT.MM.JJJJ im Datensatz; seit 01A schreiben Klassifikation und Bearbeitung
 * sie nur noch kanonisch (JJJJ-MM-TT). Eine ISO-`deadline` ohne Text ist
 * deshalb eine moderne Handlungsfrist — etwa auf einem Zweitgerät, auf das
 * der Text nicht synchronisiert wird — und nie ein Gültigkeitsende.
 */
const LEGACY_RAW_DEADLINE = /^\d{1,2}\.\d{1,2}\.\d{4}$/;

function resolveLegacyExemptionValidUntil(item: InboxItem): string | null {
  if (item.classifiedKind !== 'freistellungsbescheinigung') return null;
  const raw = item.deadline?.trim();
  if (!raw || !LEGACY_RAW_DEADLINE.test(raw)) return null;
  return toCanonicalIsoDay(raw);
}

export function mapInboxItemToDocumentInput(
  item: InboxItem,
  linkedCompany: string,
): CompanyDocumentInput {
  const filing = resolvePaperFilingFromInbox(item);
  const paperFolder: PaperFilingRule = filing.skipPhysicalFiling
    ? item.paperFiling
    : filing.rule ?? item.paperFiling;

  const archiveTruthSnapshot = buildDocumentArchiveTruthSnapshotFromInbox({ item });

  return {
    title: item.title,
    category: mapDocumentCategory(item),
    issuer: item.sender,
    recognizedText: buildRecognizedTextFromInbox(item),
    issueDate: item.receivedAt || null,
    /*
     * EINGANG-01A — die Gültigkeit kommt aus dem erkannten Gültigkeitsende,
     * nie aus der Handlungsfrist (`deadline`). Eine Zahlungsfrist ist kein
     * Ablaufdatum des Dokuments.
     */
    validUntil: resolveInboxValidUntil(item),
    digitalFolder: { ...item.digitalFolder },
    paperFolder: { ...paperFolder },
    tags: buildTagsFromInbox(item),
    linkedCompany,
    linkedVorgang: linkedVorgangFromInbox(item),
    archived: true,
    imagePreview: imagePreviewForDocumentType(item.documentType),
    ...fileMetaFromInbox(item),
    ...(archiveTruthSnapshot ? { archiveTruthSnapshot } : {}),
  };
}

export function findDocumentByContentHash(contentHash: string): CompanyDocument | null {
  if (!contentHash) return null;
  const doc = documents.find(
    (entry) => entry.sourceFileHash === contentHash && isEntitySyncActive(entry),
  );
  return doc ? cloneDocument(doc) : null;
}

export function isDuplicateDocument(
  item: InboxItem,
  linkedCompany: string,
  options?: { excludeDocumentId?: string },
): CompanyDocument | null {
  if (item.sourceFileHash) {
    const hashMatch = findDocumentByContentHash(item.sourceFileHash);
    if (hashMatch && hashMatch.id !== options?.excludeDocumentId) {
      return hashMatch;
    }
  }

  const input = mapInboxItemToDocumentInput(item, linkedCompany);
  const candidateKey = normalizeDuplicateKey(input.title, input.issuer ?? '');

  const match = documents.find((doc) => {
    if (options?.excludeDocumentId && doc.id === options.excludeDocumentId) return false;
    return normalizeDuplicateKey(doc.title, doc.issuer) === candidateKey;
  });

  return match ? cloneDocument(match) : null;
}

import { linkArchivedDocumentToVorgang } from './vorgangDocumentLinkService';
import type { DocumentFileTransformPlan } from '../types/documentFileTransformPlan';
import type { DocumentFileDerivativeRecoveryContextOrigin } from '../types/documentFileDerivativeRecoveryContext';
import { orchestrateSourceReuseArchiveBindingAfterImport } from './documentFileSourceReuseArchiveOrchestrationService';
import { orchestratePostImportDerivativesAfterImport } from './documentFilePostImportDerivativeOrchestrationService';
import { recordPostImportDerivativeStepOutcome } from './documentFileDerivativeStepOutcomeService';

export interface ImportInboxDocumentOptions {
  /** Pre-built transform plan for post-import archive/preview/thumbnail encode. */
  transformPlan?: DocumentFileTransformPlan | null;
  /**
   * Optional plan provenance. Stored only when provided with a transformPlan —
   * never inferred from MIME, document type, or outcomes.
   */
  transformPlanOrigin?: DocumentFileDerivativeRecoveryContextOrigin;
}

export function importInboxDocument(
  item: InboxItem,
  linkedCompany: string,
  options?: ImportInboxDocumentOptions,
): DocumentMutationResult {
  const gate = resolveConfirmedFilingDecisionForInboxArchive(item.id);
  if (!gate.ok) {
    return { success: false, errorKey: gate.errorKey };
  }
  const authoritativeItem = gate.item;

  const input = mapInboxItemToDocumentInput(authoritativeItem, linkedCompany);
  const result = addDocument(input);
  if (!result.success) {
    return result;
  }

  recordArchivedDocumentMemory(result.document, { inboxItem: authoritativeItem });
  if (isContractInboxItem(authoritativeItem)) {
    syncContractProofRequirementsFromInbox(authoritativeItem);
  }
  if (authoritativeItem.vorgangId) {
    linkArchivedDocumentToVorgang(result.document, authoritativeItem);
  }
  persistAll();

  const transformPlan = options?.transformPlan;
  if (transformPlan) {
    persistDocumentFileDerivativeRecoveryContextAfterImport({
      documentId: result.document.id,
      transformPlan,
      origin: options?.transformPlanOrigin,
    });
  }

  const sourceReuseResult = orchestrateSourceReuseArchiveBindingAfterImport({
    documentId: result.document.id,
    transformPlan,
  });
  recordPostImportDerivativeStepOutcome({
    documentId: result.document.id,
    stepId: 'source_reuse_archive',
    result: sourceReuseResult,
    sourceFileRefId: result.document.fileRefId ?? '',
    sourceMimeType: result.document.fileRefId
      ? (getDocumentFileRefById(result.document.fileRefId)?.mimeType ?? '')
      : '',
  });
  // Derived encode is async and serialized; failures must not fail import.
  // Does not include source_reuse_archive (already executed synchronously above).
  void orchestratePostImportDerivativesAfterImport({
    documentId: result.document.id,
    transformPlan,
  });
  return result;
}

export type ArchiveHandoffResult =
  | {
      success: true;
      document: CompanyDocument;
      item: InboxItem;
      /** True when an existing archive document for this inbox item was reused. */
      reusedExistingDocument: boolean;
    }
  | { success: false; errorKey: string; document?: CompanyDocument };

/**
 * R02 — single archive handoff for both productive entry points.
 *
 * The archive write and the inbox marking sit behind separate persist boundaries.
 * When the marking fails, the archive document stays and the inbox row keeps no
 * archiveDocumentId. Re-running this function must therefore repair that state
 * instead of creating a second document: an active CompanyDocument carrying
 * sourceInboxItemId === item.id is the unique proof of an existing archive origin.
 *
 * Confirm-first is untouched — the filing gate inside importInboxDocument /
 * updateDocumentFromInbox still decides, and no Vorgang link is created here.
 */
export function handoffInboxItemToArchive(
  item: InboxItem,
  linkedCompany: string,
  options?: ImportInboxDocumentOptions & { existingDocumentId?: string },
): ArchiveHandoffResult {
  const existing =
    (options?.existingDocumentId
      ? documents.find(
          (doc) => doc.id === options.existingDocumentId && isEntitySyncActive(doc),
        )
      : undefined) ??
    documents.find((doc) => isEntitySyncActive(doc) && doc.sourceInboxItemId === item.id);

  const importOptions = options
    ? { transformPlan: options.transformPlan, transformPlanOrigin: options.transformPlanOrigin }
    : undefined;

  const result = existing
    ? updateDocumentFromInbox(existing.id, item, linkedCompany)
    : importInboxDocument(item, linkedCompany, importOptions);

  if (!result.success) {
    return { success: false, errorKey: result.errorKey };
  }

  const marked = markInboxImportedToArchive(item.id, result.document.id);
  if (!marked?.item) {
    // Archive document stays — getInboxDeleteBlockReason now protects it from a
    // delete that would drop the DWR, and a repeated handoff reuses this document.
    return {
      success: false,
      errorKey: 'inbox.importToArchive.markFailed',
      document: result.document,
    };
  }

  return {
    success: true,
    document: result.document,
    item: marked.item,
    reusedExistingDocument: Boolean(existing),
  };
}

export function updateDocumentFromInbox(
  documentId: string,
  item: InboxItem,
  linkedCompany: string,
): DocumentMutationResult {
  const gate = resolveConfirmedFilingDecisionForInboxArchive(item.id);
  if (!gate.ok) {
    return { success: false, errorKey: gate.errorKey };
  }
  const input = mapInboxItemToDocumentInput(gate.item, linkedCompany);
  return updateDocument(documentId, input);
}
