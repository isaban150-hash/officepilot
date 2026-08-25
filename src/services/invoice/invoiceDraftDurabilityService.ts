/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P1 — lokaler, dauerhafter Kern
 * für unfertige Rechnungsentwürfe.
 *
 * Bewusste Grenzen dieses Sprints:
 *  - kein React, kein Autosave, keine Lifecycle-Ereignisse
 *  - keine Cloud, keine Outbox, keine Migration
 *  - keine automatische Bereinigung, kein TTL, kein Löschen beim Laden
 *  - keine Ermittlung des aktiven Scopes: die Identität kommt vollständig vom
 *    Aufrufer
 *
 * Eigene Datenbank in eigener Version — die Upload- und Dokument-Stores
 * bleiben unangetastet.
 */
import { computeBufferContentHash } from '../documentFileHashService';
import { buildDocumentBlobScopeKey } from '../storage/documentBlobScopeService';
import { INVOICE_DOCUMENT_TYPES } from '../invoiceTypeService';
import {
  INVOICE_DRAFT_FORMAT_VERSION,
  INVOICE_DRAFT_PREPARATION_FORMAT_VERSION,
  INVOICE_DRAFT_PREPARATION_KIND,
  INVOICE_DRAFT_RECORD_KIND,
  type BeginInvoiceDraftFinalizationInput,
  type InvoiceDraftFinalizationPreparation,
  type InvoiceDraftFinalizationRequest,
  type CompleteInvoiceDraftFinalizationInput,
  type CreateInvoiceDraftRecordInput,
  type DeleteInvoiceDraftRecordInput,
  type InvoiceDraftFinalizationResult,
  type InvoiceDraftRecordStatus,
  type InvoiceDraftCreateResult,
  type InvoiceDraftDeleteResult,
  type InvoiceDraftIdentity,
  type InvoiceDraftLocator,
  type InvoiceDraftLoadResult,
  type InvoiceDraftPreparationLoadResult,
  type InvoiceDraftRecord,
  type InvoiceDraftSaveResult,
  type LoadInvoiceDraftFinalizationPreparationInput,
  type ResolveInvoiceDraftFinalizationToExistingInput,
  type SaveInvoiceDraftRecordInput,
} from '../../types/invoiceDraftDurability';
import type { InvoiceDraft } from '../../types/models';

export const INVOICE_DRAFT_DB_NAME = 'officepilot-invoice-drafts';
export const INVOICE_DRAFT_DB_VERSION = 1;
export const INVOICE_DRAFT_STORE_NAME = 'invoice_drafts';

/**
 * Kanonische Array-Kodierung statt freier Verkettung: JSON entkommt jedes
 * Trennzeichen, deshalb kann keine andere Feldaufteilung denselben Schlüssel
 * erzeugen.
 */
export function buildInvoiceDraftRecordKey(
  identity: Pick<InvoiceDraftIdentity, 'sourceScopeKey' | 'vorgangId' | 'invoiceType'>,
): string {
  return JSON.stringify([
    INVOICE_DRAFT_RECORD_KIND,
    INVOICE_DRAFT_FORMAT_VERSION,
    identity.sourceScopeKey,
    identity.vorgangId,
    identity.invoiceType,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Datenbankzugang                                                            */
/* -------------------------------------------------------------------------- */

class InvoiceDraftStorageError extends Error {
  constructor(
    readonly reason: 'storage_unavailable' | 'storage_failed' | 'transaction_failed',
    cause?: unknown,
  ) {
    super(reason);
    this.name = 'InvoiceDraftStorageError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;
let activeDb: IDBDatabase | null = null;

function resolveIndexedDb(): IDBFactory | null {
  return typeof indexedDB !== 'undefined' ? indexedDB : null;
}

async function openDatabase(): Promise<IDBDatabase> {
  const factory = resolveIndexedDb();
  if (!factory) throw new InvoiceDraftStorageError('storage_unavailable');
  if (activeDb) return activeDb;

  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(INVOICE_DRAFT_DB_NAME, INVOICE_DRAFT_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(INVOICE_DRAFT_STORE_NAME)) {
          const store = db.createObjectStore(INVOICE_DRAFT_STORE_NAME, { keyPath: 'recordKey' });
          store.createIndex('sourceScopeKey', 'sourceScopeKey', { unique: false });
          store.createIndex('workspaceId', 'workspaceId', { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Eine fremde Versionsänderung darf nie blockieren.
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            /* ignore */
          }
          activeDb = null;
          dbPromise = null;
        };
        db.onclose = () => {
          activeDb = null;
          dbPromise = null;
        };
        activeDb = db;
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(new InvoiceDraftStorageError('storage_unavailable', request.error));
      };
      request.onblocked = () => {
        dbPromise = null;
        reject(new InvoiceDraftStorageError('storage_unavailable'));
      };
    });
  }

  try {
    return await dbPromise;
  } catch (error) {
    dbPromise = null;
    if (error instanceof InvoiceDraftStorageError) throw error;
    throw new InvoiceDraftStorageError('storage_unavailable', error);
  }
}

/**
 * Führt Lesen, Prüfen und Schreiben in EINER Transaktion aus und löst erst bei
 * `oncomplete` auf — nur eine abgeschlossene Transaktion ist dauerhaft.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, finish: (value: T) => void) => void,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let outcome: T | undefined;
    let hasOutcome = false;
    let settled = false;

    const finish = (value: T) => {
      outcome = value;
      hasOutcome = true;
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(
        error instanceof InvoiceDraftStorageError
          ? error
          : new InvoiceDraftStorageError('transaction_failed', error),
      );
    };

    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(INVOICE_DRAFT_STORE_NAME, mode);
    } catch (error) {
      fail(error);
      return;
    }

    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      if (!hasOutcome) {
        reject(new InvoiceDraftStorageError('transaction_failed'));
        return;
      }
      resolve(outcome as T);
    };
    transaction.onerror = () => fail(transaction.error);
    transaction.onabort = () => fail(transaction.error);

    try {
      work(transaction.objectStore(INVOICE_DRAFT_STORE_NAME), finish);
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* ignore */
      }
      fail(error);
    }
  });
}

function storageReason(
  error: unknown,
): 'storage_unavailable' | 'storage_failed' | 'transaction_failed' {
  return error instanceof InvoiceDraftStorageError ? error.reason : 'storage_failed';
}

/* -------------------------------------------------------------------------- */
/* Prüfungen                                                                  */
/* -------------------------------------------------------------------------- */

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 01P4E2B — nicht leer und ohne führenden oder folgenden Whitespace. */
function isCanonicalText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

/** 01P4E2B — ganze Zahl grösser null; keine Coercion, kein Default. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isSupportedInvoiceType(value: unknown): boolean {
  return typeof value === 'string' && INVOICE_DOCUMENT_TYPES.includes(value as never);
}

/**
 * Scope und Workspace müssen zusammenpassen. Der Scope-Schlüssel wird mit dem
 * vorhandenen kanonischen Builder gebildet — keine zweite Scope-Syntax.
 * Entwürfe sind in diesem Sprint ausdrücklich workspace-gebunden.
 */
function isConsistentScope(sourceScopeKey: unknown, workspaceId: unknown): boolean {
  if (!isNonEmptyString(sourceScopeKey) || !isNonEmptyString(workspaceId)) return false;
  return sourceScopeKey === buildDocumentBlobScopeKey({ type: 'workspace', workspaceId });
}

function isCompleteLocator(locator: InvoiceDraftLocator): boolean {
  if (!locator || typeof locator !== 'object') return false;
  if (!isNonEmptyString(locator.vorgangId)) return false;
  if (!isSupportedInvoiceType(locator.invoiceType)) return false;
  return isConsistentScope(locator.sourceScopeKey, locator.workspaceId);
}

function isCompleteIdentity(identity: InvoiceDraftIdentity): boolean {
  if (!identity || typeof identity !== 'object') return false;
  if (!isNonEmptyString(identity.draftId)) return false;
  return isCompleteLocator(identity);
}

/** Mindestprüfung der Identitätsfelder des Entwurfs gegen den Umschlag. */
function draftMatchesIdentity(draft: InvoiceDraft, identity: InvoiceDraftIdentity): boolean {
  if (!draft || typeof draft !== 'object') return false;
  if (!Array.isArray(draft.positions)) return false;
  return (
    draft.id === identity.draftId &&
    draft.vorgangId === identity.vorgangId &&
    draft.type === identity.invoiceType
  );
}

function recordMatchesIdentity(
  record: InvoiceDraftRecord,
  identity: InvoiceDraftIdentity,
): boolean {
  return (
    record.sourceScopeKey === identity.sourceScopeKey &&
    record.workspaceId === identity.workspaceId &&
    record.vorgangId === identity.vorgangId &&
    record.invoiceType === identity.invoiceType &&
    record.draftId === identity.draftId
  );
}

/**
 * Statusabhängige Pflichtfelder. Ein `active`-Datensatz darf keine
 * Finalisierungsdaten tragen, ein `finalizing`-Datensatz noch keinen Abschluss
 * und ein `finalized`-Datensatz muss vollständig sein.
 */
function isValidStatusShape(record: InvoiceDraftRecord): boolean {
  const final = record.finalization;
  const hasRaw = record.preparationRawJson !== undefined;
  const hasSha = record.preparationSha256 !== undefined;

  if (record.status === 'active') {
    // Ein aktiver Entwurf trägt weder Finalisierungs- noch Vorbereitungsdaten.
    return final === undefined && !hasRaw && !hasSha;
  }

  if (record.status === 'finalizing' || record.status === 'finalized') {
    // Beide Vorbereitungsfelder gelten nur gemeinsam; keines = Legacy-Bestand.
    if (hasRaw !== hasSha) return false;
    if (!final || typeof final !== 'object') return false;
    if (!isNonEmptyString(final.clientInvoiceId)) return false;
    if (!isNonEmptyString(final.contentFingerprint)) return false;
    if (!isNonEmptyString(final.startedAt)) return false;

    if (record.status === 'finalizing') {
      return (
        final.finalizedAt === undefined &&
        final.finalizedInvoiceId === undefined &&
        final.archiveWarning === undefined &&
        // 01P4E2B — Abschlussfelder gehören ausschließlich zum Grabstein.
        final.resolution === undefined &&
        final.canonicalCloudInvoiceId === undefined &&
        final.canonicalRowVersion === undefined &&
        // Der Zeitstempel des Datensatzes gehört zum Beginn der Freigabe.
        record.updatedAt === final.startedAt
      );
    }
    if (
      !isNonEmptyString(final.finalizedAt) ||
      !isNonEmptyString(final.finalizedInvoiceId) ||
      typeof final.archiveWarning !== 'boolean' ||
      record.updatedAt !== final.finalizedAt
    ) {
      return false;
    }

    /*
     * 01P4E2B — Art des Abschlusses. Fehlend bedeutet `own`; dort war
     * `finalizedInvoiceId === clientInvoiceId` bereits erzwungen, weshalb
     * Bestandsdatensätze unverändert gültig bleiben.
     */
    const resolution = final.resolution ?? 'own';
    if (resolution === 'own') {
      return (
        final.finalizedInvoiceId === final.clientInvoiceId &&
        final.canonicalCloudInvoiceId === undefined &&
        final.canonicalRowVersion === undefined
      );
    }
    if (resolution === 'resolved_to_existing') {
      return (
        final.finalizedInvoiceId !== final.clientInvoiceId &&
        isCanonicalText(final.canonicalCloudInvoiceId) &&
        isPositiveInteger(final.canonicalRowVersion)
      );
    }
    // Unbekannter Auflösungswert.
    return false;
  }

  // Unbekannter Status.
  return false;
}

/**
 * Vollständige Umschlagprüfung: jedes Feld muss vorhanden und plausibel sein,
 * und der `recordKey` muss exakt zu den Umschlagfeldern passen. Es wird nichts
 * ergänzt, nichts repariert und nichts gelöscht.
 */
function isSupportedRecord(record: unknown): record is InvoiceDraftRecord {
  if (!record || typeof record !== 'object') return false;
  const value = record as InvoiceDraftRecord;

  if (value.kind !== INVOICE_DRAFT_RECORD_KIND) return false;
  if (value.formatVersion !== INVOICE_DRAFT_FORMAT_VERSION) return false;
  if (!isNonEmptyString(value.recordKey)) return false;
  if (!isNonEmptyString(value.workspaceId)) return false;
  if (!isNonEmptyString(value.vorgangId)) return false;
  if (!isNonEmptyString(value.draftId)) return false;
  if (!isNonEmptyString(value.createdAt)) return false;
  if (!isNonEmptyString(value.updatedAt)) return false;
  if (typeof value.draftRawJson !== 'string' || value.draftRawJson.length === 0) return false;
  if (!isNonEmptyString(value.draftSha256) || !SHA256_HEX.test(value.draftSha256)) return false;
  if (!isValidStatusShape(value)) return false;
  // Die Vorbereitung ist optional (Bestand aus 01P1/01P2), aber wenn sie da
  // ist, muss sie formal tragfähig sein.
  if (
    value.preparationRawJson !== undefined &&
    (typeof value.preparationRawJson !== 'string' || value.preparationRawJson.length === 0)
  ) {
    return false;
  }
  if (
    value.preparationSha256 !== undefined &&
    (!isNonEmptyString(value.preparationSha256) || !SHA256_HEX.test(value.preparationSha256))
  ) {
    return false;
  }
  if (!Number.isInteger(value.revision) || value.revision < 1) return false;
  if (!isSupportedInvoiceType(value.invoiceType)) return false;
  if (!isConsistentScope(value.sourceScopeKey, value.workspaceId)) return false;

  // Der Schlüssel muss aus genau diesen Feldern hervorgehen.
  return (
    value.recordKey ===
    buildInvoiceDraftRecordKey({
      sourceScopeKey: value.sourceScopeKey,
      vorgangId: value.vorgangId,
      invoiceType: value.invoiceType,
    })
  );
}

function recordMatchesLocator(record: InvoiceDraftRecord, locator: InvoiceDraftLocator): boolean {
  return (
    record.sourceScopeKey === locator.sourceScopeKey &&
    record.workspaceId === locator.workspaceId &&
    record.vorgangId === locator.vorgangId &&
    record.invoiceType === locator.invoiceType
  );
}

/** Nie ungeprüft werfen: Serialisierung kann an zyklischen Werten scheitern. */
function safeStringify(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * Liefert ausschließlich einen formal gültigen SHA-256-Wert oder `null`.
 * Ein Hash-Dienst, der ohne Wurf etwas anderes zurückgibt, darf niemals einen
 * Datensatz erzeugen — die Prüfung greift deshalb einheitlich für `create`,
 * `save` und beide Finalisierungsübergänge.
 */
async function hashText(text: string): Promise<string | null> {
  try {
    const hash = await computeBufferContentHash(new TextEncoder().encode(text));
    return typeof hash === 'string' && SHA256_HEX.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

/** Liest den geschriebenen Datensatz erneut und prüft Identität, Revision und Hash. */
async function verifyWrittenRecord(
  identity: InvoiceDraftIdentity,
  expected: InvoiceDraftRecord,
): Promise<boolean> {
  try {
    return await verifyWrittenRecordUnsafe(identity, expected);
  } catch {
    // Auch ein Fehler der Nachprüfung selbst gilt als nicht bewiesener Schreibvorgang.
    return false;
  }
}

async function verifyWrittenRecordUnsafe(
  identity: InvoiceDraftIdentity,
  expected: InvoiceDraftRecord,
): Promise<boolean> {
  const stored = await withStore<InvoiceDraftRecord | undefined>('readonly', (store, finish) => {
    const request = store.get(expected.recordKey);
    request.onsuccess = () => finish(request.result as InvoiceDraftRecord | undefined);
  });
  if (!stored || !isSupportedRecord(stored)) return false;
  if (!recordMatchesIdentity(stored, identity)) return false;
  if (stored.revision !== expected.revision) return false;
  if (stored.draftRawJson !== expected.draftRawJson) return false;
  if (stored.draftSha256 !== expected.draftSha256) return false;

  // Status und sämtliche Finalisierungswerte müssen exakt übereinstimmen —
  // ein teilweise geschriebener Abschluss darf nie als Erfolg gelten.
  if (stored.status !== expected.status) return false;
  const a = stored.finalization;
  const b = expected.finalization;
  if ((a === undefined) !== (b === undefined)) return false;
  if (a && b) {
    if (a.clientInvoiceId !== b.clientInvoiceId) return false;
    if (a.contentFingerprint !== b.contentFingerprint) return false;
    if (a.startedAt !== b.startedAt) return false;
    if (a.finalizedAt !== b.finalizedAt) return false;
    if (a.finalizedInvoiceId !== b.finalizedInvoiceId) return false;
    if (a.archiveWarning !== b.archiveWarning) return false;
    // 01P4E2B — der Auflösungsbeweis gehört zum Abschluss und wird mitgeprüft.
    if (a.resolution !== b.resolution) return false;
    if (a.canonicalCloudInvoiceId !== b.canonicalCloudInvoiceId) return false;
    if (a.canonicalRowVersion !== b.canonicalRowVersion) return false;
  }

  // Die Vorbereitung muss bytegleich und hashtreu vorliegen.
  if (stored.preparationRawJson !== expected.preparationRawJson) return false;
  if (stored.preparationSha256 !== expected.preparationSha256) return false;
  if (stored.preparationRawJson !== undefined) {
    const preparationHash = await hashText(stored.preparationRawJson);
    if (preparationHash === null || preparationHash !== stored.preparationSha256) return false;
  }

  const hash = await hashText(stored.draftRawJson);
  return hash !== null && hash === stored.draftSha256;
}

/* -------------------------------------------------------------------------- */
/* Finalisierungsvorbereitung (01P4A)                                         */
/* -------------------------------------------------------------------------- */

type PreparationIssueReason =
  | 'invalid_preparation'
  | 'unsupported_preparation'
  | 'identity_mismatch'
  | 'corrupt';

type PreparationIssue = { reason: PreparationIssueReason; detail?: string } | null;

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface PreparationBinding {
  workspaceId: string;
  vorgangId: string;
  invoiceType: string;
  clientInvoiceId: string;
  contentFingerprint: string;
  draftSha256: string;
  /**
   * Die Revisionskette ist exakt: `active` = `preparedFromRevision`,
   * `finalizing` = +1, `finalized` = +2. Eine bloße obere Schranke wäre zu
   * schwach — ein manipulierter Datensatz könnte sonst beliebig weit von
   * seiner Vorbereitung entfernt sein.
   */
  exactFromRevision: number;
  /** Muss exakt `finalization.startedAt` sein. */
  startedAt: string;
}

/**
 * Vollständige Struktur- und Bindungsprüfung einer Vorbereitung. Der Kern baut
 * dabei nichts fachlich neu — er prüft ausschließlich die übergebenen Werte.
 */
function checkPreparation(parsed: unknown, binding: PreparationBinding): PreparationIssue {
  const invalid = (detail: string): PreparationIssue => ({
    reason: 'invalid_preparation',
    detail,
  });
  if (!isPlainJsonObject(parsed)) return invalid('shape');
  const preparation = parsed as unknown as InvoiceDraftFinalizationPreparation;

  if (
    preparation.kind !== INVOICE_DRAFT_PREPARATION_KIND ||
    preparation.formatVersion !== INVOICE_DRAFT_PREPARATION_FORMAT_VERSION
  ) {
    return { reason: 'unsupported_preparation', detail: 'version' };
  }
  if (!isNonEmptyString(preparation.preparedAt)) return invalid('preparedAt');
  if (!Number.isInteger(preparation.preparedFromRevision) || preparation.preparedFromRevision < 1) {
    return invalid('preparedFromRevision');
  }
  if (
    !isNonEmptyString(preparation.sourceDraftSha256) ||
    !SHA256_HEX.test(preparation.sourceDraftSha256)
  ) {
    return invalid('sourceDraftSha256');
  }
  if (!isNonEmptyString(preparation.contentFingerprint)) return invalid('contentFingerprint');
  if (!isPlainJsonObject(preparation.approvalContext)) return invalid('approvalContext');

  if (!isPlainJsonObject(preparation.request)) return invalid('request');
  const request = preparation.request as unknown as InvoiceDraftFinalizationRequest;
  if (!isNonEmptyString(request.workspaceId)) return invalid('request.workspaceId');
  if (!isNonEmptyString(request.vorgangId)) return invalid('request.vorgangId');
  if (!isNonEmptyString(request.clientInvoiceId)) return invalid('request.clientInvoiceId');
  if (!isPlainJsonObject(request.invoice)) return invalid('request.invoice');
  if (!isNonEmptyString(request.invoice.id)) return invalid('request.invoice.id');
  if (!isSupportedInvoiceType(request.invoice.type)) return invalid('request.invoice.type');

  const mismatch = (detail: string): PreparationIssue => ({
    reason: 'identity_mismatch',
    detail,
  });
  if (request.workspaceId !== binding.workspaceId) return mismatch('workspaceId');
  if (request.vorgangId !== binding.vorgangId) return mismatch('vorgangId');
  if (request.clientInvoiceId !== binding.clientInvoiceId) return mismatch('clientInvoiceId');
  if (request.invoice.id !== binding.clientInvoiceId) return mismatch('invoice.id');
  if (request.invoice.type !== binding.invoiceType) return mismatch('invoice.type');
  if (preparation.contentFingerprint !== binding.contentFingerprint) {
    return mismatch('contentFingerprint');
  }
  if (preparation.sourceDraftSha256 !== binding.draftSha256) return mismatch('sourceDraftSha256');

  // Lebenszyklusbindung: exakte Revisionskette und exakter Startzeitpunkt.
  if (preparation.preparedFromRevision !== binding.exactFromRevision) {
    return { reason: 'corrupt', detail: 'revision' };
  }
  if (preparation.preparedAt !== binding.startedAt) {
    return { reason: 'corrupt', detail: 'preparedAt' };
  }
  return null;
}

type StoredPreparationResult =
  | { ok: true; preparation: InvoiceDraftFinalizationPreparation }
  | {
      ok: false;
      reason: PreparationIssueReason | 'storage_failed';
      detail?: string;
    };

/**
 * Liest, hasht, parst und bindet die gespeicherte Vorbereitung. Es wird nichts
 * repariert, nichts ersetzt und nichts gelöscht.
 */
async function readStoredPreparation(
  record: InvoiceDraftRecord,
  binding: PreparationBinding,
): Promise<StoredPreparationResult> {
  if (record.preparationRawJson === undefined && record.preparationSha256 === undefined) {
    // Bestandsdatensatz aus 01P2 — gültig lesbar, aber blockiert.
    return { ok: false, reason: 'unsupported_preparation', detail: 'missing' };
  }
  if (typeof record.preparationRawJson !== 'string' || record.preparationRawJson.length === 0) {
    return { ok: false, reason: 'corrupt', detail: 'raw' };
  }
  if (!isNonEmptyString(record.preparationSha256) || !SHA256_HEX.test(record.preparationSha256)) {
    return { ok: false, reason: 'corrupt', detail: 'sha' };
  }

  const hash = await hashText(record.preparationRawJson);
  if (hash === null) return { ok: false, reason: 'storage_failed', detail: 'hash' };
  if (hash !== record.preparationSha256) return { ok: false, reason: 'corrupt', detail: 'hash' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(record.preparationRawJson);
  } catch {
    return { ok: false, reason: 'corrupt', detail: 'json' };
  }

  const issue = checkPreparation(parsed, binding);
  if (issue) return { ok: false, reason: issue.reason, detail: issue.detail };
  return { ok: true, preparation: parsed as InvoiceDraftFinalizationPreparation };
}

/* -------------------------------------------------------------------------- */
/* Öffentliche API                                                            */
/* -------------------------------------------------------------------------- */

export async function createInvoiceDraftRecord(
  input: CreateInvoiceDraftRecordInput,
): Promise<InvoiceDraftCreateResult> {
  const { identity, draft } = input;
  if (!isCompleteIdentity(identity)) return { ok: false, reason: 'invalid_identity' };
  if (!draftMatchesIdentity(draft, identity)) return { ok: false, reason: 'invalid_draft' };

  const now = input.now ?? new Date().toISOString();
  const draftRawJson = safeStringify(draft);
  if (draftRawJson === null) return { ok: false, reason: 'invalid_draft', detail: 'serialize' };
  const draftSha256 = await hashText(draftRawJson);
  if (draftSha256 === null) return { ok: false, reason: 'storage_failed', detail: 'hash' };

  const record: InvoiceDraftRecord = {
    kind: INVOICE_DRAFT_RECORD_KIND,
    formatVersion: INVOICE_DRAFT_FORMAT_VERSION,
    recordKey: buildInvoiceDraftRecordKey(identity),
    sourceScopeKey: identity.sourceScopeKey,
    workspaceId: identity.workspaceId,
    vorgangId: identity.vorgangId,
    invoiceType: identity.invoiceType,
    draftId: identity.draftId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    draftRawJson,
    draftSha256,
    status: 'active',
  };

  try {
    const outcome = await withStore<'created' | 'exists'>('readwrite', (store, finish) => {
      const read = store.get(record.recordKey);
      read.onsuccess = () => {
        if (read.result) {
          finish('exists');
          return;
        }
        store.put(record);
        finish('created');
      };
    });
    if (outcome === 'exists') return { ok: false, reason: 'already_exists' };
  } catch (error) {
    return { ok: false, reason: storageReason(error) };
  }

  if (!(await verifyWrittenRecord(identity, record))) {
    // Die Transaktion war bereits abgeschlossen — siehe Post-Commit-Vertrag.
    return { ok: false, reason: 'committed_but_unverified' };
  }
  return { ok: true, record: { ...record } };
}

export async function loadInvoiceDraftRecord(
  identity: InvoiceDraftIdentity,
): Promise<InvoiceDraftLoadResult> {
  if (!isCompleteIdentity(identity)) return { ok: false, reason: 'invalid_identity' };

  let stored: InvoiceDraftRecord | undefined;
  try {
    stored = await withStore<InvoiceDraftRecord | undefined>('readonly', (store, finish) => {
      const request = store.get(buildInvoiceDraftRecordKey(identity));
      request.onsuccess = () => finish(request.result as InvoiceDraftRecord | undefined);
    });
  } catch (error) {
    return { ok: false, reason: storageReason(error) };
  }

  if (!stored) return { ok: false, reason: 'not_found' };
  return verifyStoredRecord(stored, identity);
}

/**
 * Findet den Entwurf ohne bekannte `draftId` — der Fall nach einem Reload.
 * Die `draftId` stammt ausschließlich aus dem vollständig geprüften Umschlag.
 */
export async function loadInvoiceDraftRecordByLocator(
  locator: InvoiceDraftLocator,
): Promise<InvoiceDraftLoadResult> {
  if (!isCompleteLocator(locator)) return { ok: false, reason: 'invalid_identity' };

  let stored: InvoiceDraftRecord | undefined;
  try {
    stored = await withStore<InvoiceDraftRecord | undefined>('readonly', (store, finish) => {
      const request = store.get(buildInvoiceDraftRecordKey(locator));
      request.onsuccess = () => finish(request.result as InvoiceDraftRecord | undefined);
    });
  } catch (error) {
    return { ok: false, reason: storageReason(error) };
  }

  if (!stored) return { ok: false, reason: 'not_found' };
  if (!isSupportedRecord(stored)) return { ok: false, reason: 'unsupported_format' };
  if (!recordMatchesLocator(stored, locator)) return { ok: false, reason: 'identity_mismatch' };

  // Die Identität wird erst jetzt vervollständigt — aus dem Umschlag.
  return verifyStoredRecord(stored, { ...locator, draftId: stored.draftId });
}

/** Gemeinsame Endprüfung: Umschlag, Identität, Hash, JSON, Draft-Identität. */
async function verifyStoredRecord(
  stored: InvoiceDraftRecord,
  identity: InvoiceDraftIdentity,
): Promise<InvoiceDraftLoadResult> {
  if (!isSupportedRecord(stored)) return { ok: false, reason: 'unsupported_format' };
  if (!recordMatchesIdentity(stored, identity)) return { ok: false, reason: 'identity_mismatch' };

  // Vollständiger Rohtext wird erneut gehasht — nichts wird repariert.
  const hash = await hashText(stored.draftRawJson);
  if (hash === null) return { ok: false, reason: 'storage_failed', detail: 'hash' };
  if (hash !== stored.draftSha256) return { ok: false, reason: 'corrupt', detail: 'hash' };

  let draft: InvoiceDraft;
  try {
    draft = JSON.parse(stored.draftRawJson) as InvoiceDraft;
  } catch {
    return { ok: false, reason: 'corrupt', detail: 'json' };
  }
  if (!draftMatchesIdentity(draft, identity)) {
    return { ok: false, reason: 'identity_mismatch', detail: 'draft' };
  }

  // Jeder Aufruf liefert ein frisches Objekt — nie eine Referenz auf internen Zustand.
  return { ok: true, record: { ...stored }, draft };
}

export async function saveInvoiceDraftRecord(
  input: SaveInvoiceDraftRecordInput,
): Promise<InvoiceDraftSaveResult> {
  const { identity, draft, expectedRevision } = input;
  if (!isCompleteIdentity(identity)) return { ok: false, reason: 'invalid_identity' };
  if (!draftMatchesIdentity(draft, identity)) return { ok: false, reason: 'invalid_draft' };
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return { ok: false, reason: 'invalid_identity', detail: 'expectedRevision' };
  }

  const now = input.now ?? new Date().toISOString();
  const draftRawJson = safeStringify(draft);
  if (draftRawJson === null) return { ok: false, reason: 'invalid_draft', detail: 'serialize' };
  const draftSha256 = await hashText(draftRawJson);
  if (draftSha256 === null) return { ok: false, reason: 'storage_failed', detail: 'hash' };
  const recordKey = buildInvoiceDraftRecordKey(identity);

  type SaveOutcome =
    | { kind: 'saved'; record: InvoiceDraftRecord }
    | { kind: 'not_found' }
    | { kind: 'identity_mismatch' }
    | { kind: 'unsupported_format' }
    | { kind: 'status_conflict' }
    | { kind: 'conflict'; currentRevision: number };

  let outcome: SaveOutcome;
  try {
    /**
     * Lesen, Prüfen und Schreiben liegen in EINER readwrite-Transaktion. Zwei
     * gleichzeitige Saves mit derselben erwarteten Revision können deshalb
     * nicht beide gewinnen: IndexedDB führt readwrite-Transaktionen auf
     * demselben Store nacheinander aus, der zweite sieht bereits die erhöhte
     * Revision.
     */
    outcome = await withStore<SaveOutcome>('readwrite', (store, finish) => {
      const read = store.get(recordKey);
      read.onsuccess = () => {
        const current = read.result as InvoiceDraftRecord | undefined;
        if (!current) {
          finish({ kind: 'not_found' });
          return;
        }
        if (!isSupportedRecord(current)) {
          finish({ kind: 'unsupported_format' });
          return;
        }
        if (!recordMatchesIdentity(current, identity)) {
          finish({ kind: 'identity_mismatch' });
          return;
        }
        // Eine begonnene oder abgeschlossene Finalisierung ist unantastbar.
        if (current.status !== 'active') {
          finish({ kind: 'status_conflict' });
          return;
        }
        if (current.revision !== expectedRevision) {
          finish({ kind: 'conflict', currentRevision: current.revision });
          return;
        }
        const next: InvoiceDraftRecord = {
          ...current,
          revision: current.revision + 1,
          updatedAt: now,
          draftRawJson,
          draftSha256,
          status: 'active',
        };
        store.put(next);
        finish({ kind: 'saved', record: next });
      };
    });
  } catch (error) {
    return { ok: false, reason: storageReason(error) };
  }

  if (outcome.kind === 'not_found') return { ok: false, reason: 'not_found' };
  if (outcome.kind === 'identity_mismatch') return { ok: false, reason: 'identity_mismatch' };
  if (outcome.kind === 'status_conflict') return { ok: false, reason: 'status_conflict' };
  if (outcome.kind === 'unsupported_format') {
    return { ok: false, reason: 'identity_mismatch', detail: 'unsupported_format' };
  }
  if (outcome.kind === 'conflict') {
    return { ok: false, reason: 'conflict', currentRevision: outcome.currentRevision };
  }

  if (!(await verifyWrittenRecord(identity, outcome.record))) {
    // Die Transaktion war bereits abgeschlossen — siehe Post-Commit-Vertrag.
    return { ok: false, reason: 'committed_but_unverified' };
  }
  return { ok: true, record: { ...outcome.record } };
}

export async function deleteInvoiceDraftRecord(
  input: DeleteInvoiceDraftRecordInput,
): Promise<InvoiceDraftDeleteResult> {
  const { identity, expectedRevision } = input;
  if (!isCompleteIdentity(identity)) return { ok: false, reason: 'invalid_identity' };
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return { ok: false, reason: 'invalid_identity', detail: 'expectedRevision' };
  }

  const recordKey = buildInvoiceDraftRecordKey(identity);

  type DeleteOutcome =
    | { kind: 'deleted'; revision: number }
    | { kind: 'not_found' }
    | { kind: 'identity_mismatch' }
    | { kind: 'status_conflict' }
    | { kind: 'conflict'; currentRevision: number };

  let outcome: DeleteOutcome;
  try {
    outcome = await withStore<DeleteOutcome>('readwrite', (store, finish) => {
      const read = store.get(recordKey);
      read.onsuccess = () => {
        const current = read.result as InvoiceDraftRecord | undefined;
        if (!current) {
          finish({ kind: 'not_found' });
          return;
        }
        if (!isSupportedRecord(current) || !recordMatchesIdentity(current, identity)) {
          finish({ kind: 'identity_mismatch' });
          return;
        }
        /**
         * Nur ein aktiver Entwurf darf verworfen werden. Eine begonnene
         * Finalisierung und ein Grabstein bleiben vollständig erhalten.
         */
        if (current.status !== 'active') {
          finish({ kind: 'status_conflict' });
          return;
        }
        if (current.revision !== expectedRevision) {
          finish({ kind: 'conflict', currentRevision: current.revision });
          return;
        }
        store.delete(recordKey);
        finish({ kind: 'deleted', revision: current.revision });
      };
    });
  } catch (error) {
    return { ok: false, reason: storageReason(error) };
  }

  if (outcome.kind === 'not_found') return { ok: false, reason: 'not_found' };
  if (outcome.kind === 'identity_mismatch') return { ok: false, reason: 'identity_mismatch' };
  if (outcome.kind === 'status_conflict') return { ok: false, reason: 'status_conflict' };
  if (outcome.kind === 'conflict') {
    return { ok: false, reason: 'conflict', currentRevision: outcome.currentRevision };
  }
  return { ok: true, deletedRevision: outcome.revision };
}

/**
 * OFFICEPILOT-INVOICE-DRAFT-ROLLOVER-03B — gibt den aktiven Locator nach einer
 * abgeschlossenen Rechnung wieder frei.
 *
 * Bewusst ein **eigener** Einstieg statt einer Lockerung von
 * `deleteInvoiceDraftRecord`: dessen `active`-Regel ist die Invariante, die
 * laufende Entwürfe und begonnene Abschlüsse vor Verlust schützt. Sie bleibt
 * ausnahmslos bestehen; die Ausnahme steht hier sichtbar und einzeln prüfbar.
 *
 * Freigegeben wird nur, wenn der Grabstein zur genannten fertigen Rechnung
 * gehört. **Der Aufrufer muss zuvor nachgewiesen haben, dass diese Rechnung
 * dauerhaft vorliegt** — dieser Kern liest keinen Vorgangsspeicher. Ohne
 * diesen Nachweis wäre `finalized` allein kein Grund, einen gespeicherten
 * Entwurf zu vernichten.
 *
 * `active` und `finalizing` werden nie berührt.
 */
export async function releaseFinalizedInvoiceDraftRecord(
  input: DeleteInvoiceDraftRecordInput & { finalizedInvoiceId: string },
): Promise<InvoiceDraftDeleteResult> {
  const { identity, expectedRevision, finalizedInvoiceId } = input;
  if (!isCompleteIdentity(identity)) return { ok: false, reason: 'invalid_identity' };
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return { ok: false, reason: 'invalid_identity', detail: 'expectedRevision' };
  }
  if (!isNonEmptyString(finalizedInvoiceId)) {
    return { ok: false, reason: 'invalid_identity', detail: 'finalizedInvoiceId' };
  }

  const recordKey = buildInvoiceDraftRecordKey(identity);

  type ReleaseOutcome =
    | { kind: 'deleted'; revision: number }
    | { kind: 'not_found' }
    | { kind: 'identity_mismatch' }
    | { kind: 'status_conflict' }
    | { kind: 'finalization_mismatch' }
    | { kind: 'conflict'; currentRevision: number };

  let outcome: ReleaseOutcome;
  try {
    outcome = await withStore<ReleaseOutcome>('readwrite', (store, finish) => {
      const read = store.get(recordKey);
      read.onsuccess = () => {
        const current = read.result as InvoiceDraftRecord | undefined;
        if (!current) {
          finish({ kind: 'not_found' });
          return;
        }
        if (!isSupportedRecord(current) || !recordMatchesIdentity(current, identity)) {
          finish({ kind: 'identity_mismatch' });
          return;
        }
        // Ausschliesslich ein abgeschlossener Grabstein — nichts anderes.
        if (current.status !== 'finalized' || !current.finalization) {
          finish({ kind: 'status_conflict' });
          return;
        }
        if (current.finalization.finalizedInvoiceId !== finalizedInvoiceId) {
          finish({ kind: 'finalization_mismatch' });
          return;
        }
        if (current.revision !== expectedRevision) {
          finish({ kind: 'conflict', currentRevision: current.revision });
          return;
        }
        store.delete(recordKey);
        finish({ kind: 'deleted', revision: current.revision });
      };
    });
  } catch (error) {
    return { ok: false, reason: storageReason(error) };
  }

  if (outcome.kind === 'not_found') return { ok: false, reason: 'not_found' };
  if (outcome.kind === 'identity_mismatch') return { ok: false, reason: 'identity_mismatch' };
  if (outcome.kind === 'status_conflict') return { ok: false, reason: 'status_conflict' };
  if (outcome.kind === 'finalization_mismatch') {
    return { ok: false, reason: 'identity_mismatch', detail: 'finalizedInvoiceId' };
  }
  if (outcome.kind === 'conflict') {
    return { ok: false, reason: 'conflict', currentRevision: outcome.currentRevision };
  }
  return { ok: true, deletedRevision: outcome.revision };
}

/* -------------------------------------------------------------------------- */
/* Finalisierungsübergänge                                                    */
/* -------------------------------------------------------------------------- */

type FinalizationOutcome =
  | { kind: 'written'; record: InvoiceDraftRecord }
  | { kind: 'not_found' }
  | { kind: 'identity_mismatch' }
  | { kind: 'unsupported_format' }
  | { kind: 'status_conflict'; currentStatus: InvoiceDraftRecordStatus }
  | { kind: 'finalization_mismatch' }
  | { kind: 'conflict'; currentRevision: number };

function mapFinalizationOutcome(
  outcome: Exclude<FinalizationOutcome, { kind: 'written' }>,
): InvoiceDraftFinalizationResult {
  switch (outcome.kind) {
    case 'not_found':
      return { ok: false, reason: 'not_found' };
    case 'identity_mismatch':
      return { ok: false, reason: 'identity_mismatch' };
    case 'unsupported_format':
      return { ok: false, reason: 'unsupported_format' };
    case 'status_conflict':
      return { ok: false, reason: 'status_conflict', currentStatus: outcome.currentStatus };
    case 'finalization_mismatch':
      return { ok: false, reason: 'finalization_mismatch' };
    default:
      return { ok: false, reason: 'conflict', currentRevision: outcome.currentRevision };
  }
}

/**
 * Wechselt einen aktiven Entwurf auf `finalizing`. Der Kern ruft dabei nichts
 * in der Cloud auf — `clientInvoiceId` und `contentFingerprint` werden als
 * ausdrücklich übergebene, unveränderliche Finalisierungsidentität abgelegt.
 * Ein neuer Datensatz entsteht dabei nie.
 */
export async function beginInvoiceDraftFinalization(
  input: BeginInvoiceDraftFinalizationInput,
): Promise<InvoiceDraftFinalizationResult> {
  const { identity, expectedRevision, clientInvoiceId, contentFingerprint, request, approvalContext } =
    input;
  if (!isCompleteIdentity(identity)) return { ok: false, reason: 'invalid_identity' };
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return { ok: false, reason: 'invalid_identity', detail: 'expectedRevision' };
  }
  if (!isNonEmptyString(clientInvoiceId) || !isNonEmptyString(contentFingerprint)) {
    return { ok: false, reason: 'invalid_finalization' };
  }

  const startedAt = input.now ?? new Date().toISOString();
  if (!isNonEmptyString(startedAt)) return { ok: false, reason: 'invalid_finalization' };
  const recordKey = buildInvoiceDraftRecordKey(identity);

  /*
   * Schritt 1: Ausgangsdatensatz vollständig lesen und prüfen. Der Hash wird
   * ausdrücklich **vor** der CAS-Transaktion gebildet — ein `await` auf
   * WebCrypto innerhalb einer offenen IndexedDB-Transaktion könnte sie
   * inaktiv werden lassen.
   */
  let source: InvoiceDraftRecord | undefined;
  try {
    source = await withStore<InvoiceDraftRecord | undefined>('readonly', (store, finish) => {
      const read = store.get(recordKey);
      read.onsuccess = () => finish(read.result as InvoiceDraftRecord | undefined);
    });
  } catch (error) {
    return { ok: false, reason: storageReason(error) };
  }
  if (!source) return { ok: false, reason: 'not_found' };
  if (!isSupportedRecord(source)) return { ok: false, reason: 'unsupported_format' };
  if (!recordMatchesIdentity(source, identity)) return { ok: false, reason: 'identity_mismatch' };
  if (source.status !== 'active') {
    return { ok: false, reason: 'status_conflict', currentStatus: source.status };
  }
  if (source.revision !== expectedRevision) {
    return { ok: false, reason: 'conflict', currentRevision: source.revision };
  }
  const draftHash = await hashText(source.draftRawJson);
  if (draftHash === null) return { ok: false, reason: 'storage_failed', detail: 'hash' };
  if (draftHash !== source.draftSha256) return { ok: false, reason: 'corrupt', detail: 'hash' };

  // Schritt 2: genau eine Hülle — Request und Freigabekontext gemeinsam.
  const preparation: InvoiceDraftFinalizationPreparation = {
    kind: INVOICE_DRAFT_PREPARATION_KIND,
    formatVersion: INVOICE_DRAFT_PREPARATION_FORMAT_VERSION,
    preparedAt: startedAt,
    preparedFromRevision: expectedRevision,
    sourceDraftSha256: source.draftSha256,
    contentFingerprint,
    request,
    approvalContext,
  };
  const preparationRawJson = safeStringify(preparation);
  if (preparationRawJson === null) {
    return { ok: false, reason: 'invalid_preparation', detail: 'serialize' };
  }

  // Schritt 3: SHA-256 über genau diesen vollständigen Rohtext.
  const preparationSha256 = await hashText(preparationRawJson);
  if (preparationSha256 === null) return { ok: false, reason: 'storage_failed', detail: 'hash' };

  /*
   * Geprüft wird die **gespeicherte** Form, nicht die Eingabe: nur was den
   * JSON-Weg unbeschadet übersteht, darf später ausgeführt werden.
   */
  const binding: PreparationBinding = {
    workspaceId: source.workspaceId,
    vorgangId: source.vorgangId,
    invoiceType: source.invoiceType,
    clientInvoiceId,
    contentFingerprint,
    draftSha256: source.draftSha256,
    exactFromRevision: expectedRevision,
    startedAt,
  };
  let parsedPreparation: unknown;
  try {
    parsedPreparation = JSON.parse(preparationRawJson);
  } catch {
    return { ok: false, reason: 'invalid_preparation', detail: 'json' };
  }
  const issue = checkPreparation(parsedPreparation, binding);
  if (issue) return { ok: false, reason: issue.reason, detail: issue.detail };

  let outcome: FinalizationOutcome;
  try {
    outcome = await withStore<FinalizationOutcome>('readwrite', (store, finish) => {
      const read = store.get(recordKey);
      read.onsuccess = () => {
        const current = read.result as InvoiceDraftRecord | undefined;
        if (!current) {
          finish({ kind: 'not_found' });
          return;
        }
        if (!isSupportedRecord(current)) {
          finish({ kind: 'unsupported_format' });
          return;
        }
        if (!recordMatchesIdentity(current, identity)) {
          finish({ kind: 'identity_mismatch' });
          return;
        }
        if (current.status !== 'active') {
          finish({ kind: 'status_conflict', currentStatus: current.status });
          return;
        }
        if (current.revision !== expectedRevision) {
          finish({ kind: 'conflict', currentRevision: current.revision });
          return;
        }
        /*
         * Der geprüfte Ausgangsstand muss noch exakt derselbe sein — sonst
         * gehörte die Vorbereitung zu einem anderen Entwurfsstand.
         */
        if (
          current.draftRawJson !== source.draftRawJson ||
          current.draftSha256 !== source.draftSha256
        ) {
          finish({ kind: 'conflict', currentRevision: current.revision });
          return;
        }
        const next: InvoiceDraftRecord = {
          ...current,
          revision: current.revision + 1,
          updatedAt: startedAt,
          status: 'finalizing',
          finalization: { clientInvoiceId, contentFingerprint, startedAt },
          preparationRawJson,
          preparationSha256,
        };
        store.put(next);
        finish({ kind: 'written', record: next });
      };
    });
  } catch (error) {
    return { ok: false, reason: storageReason(error) };
  }

  if (outcome.kind !== 'written') return mapFinalizationOutcome(outcome);
  if (!(await verifyWrittenRecord(identity, outcome.record))) {
    // Die Transaktion war bereits abgeschlossen — siehe Post-Commit-Vertrag.
    return { ok: false, reason: 'committed_but_unverified' };
  }
  return { ok: true, record: { ...outcome.record } };
}

/**
 * Schließt eine begonnene Finalisierung ab. Der Datensatz bleibt als
 * Grabstein bestehen — er wird ausdrücklich **nicht** gelöscht.
 */
export async function completeInvoiceDraftFinalization(
  input: CompleteInvoiceDraftFinalizationInput,
): Promise<InvoiceDraftFinalizationResult> {
  const {
    identity,
    expectedRevision,
    clientInvoiceId,
    contentFingerprint,
    finalizedInvoiceId,
    archiveWarning,
  } = input;
  if (!isCompleteIdentity(identity)) return { ok: false, reason: 'invalid_identity' };
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return { ok: false, reason: 'invalid_identity', detail: 'expectedRevision' };
  }
  if (
    !isNonEmptyString(clientInvoiceId) ||
    !isNonEmptyString(contentFingerprint) ||
    !isNonEmptyString(finalizedInvoiceId) ||
    typeof archiveWarning !== 'boolean'
  ) {
    return { ok: false, reason: 'invalid_finalization' };
  }

  /*
   * Produktionsvertrag: die lokale Rechnung trägt die Client-Kennung
   * (`invoice.id = intent.clientInvoiceId` im Cloud-Orchestrator). Eine
   * Abweichung ist deshalb kein gültiger Abschluss.
   */
  if (finalizedInvoiceId !== clientInvoiceId) {
    return { ok: false, reason: 'finalization_mismatch', detail: 'finalizedInvoiceId' };
  }

  const finalizedAt = input.now ?? new Date().toISOString();
  if (!isNonEmptyString(finalizedAt)) return { ok: false, reason: 'invalid_finalization' };
  const recordKey = buildInvoiceDraftRecordKey(identity);

  /*
   * Vorprüfung außerhalb der Transaktion: die Hashbildung ist asynchron und
   * dürfte eine offene IndexedDB-Transaktion nicht überdauern.
   */
  let source: InvoiceDraftRecord | undefined;
  try {
    source = await withStore<InvoiceDraftRecord | undefined>('readonly', (store, finish) => {
      const read = store.get(recordKey);
      read.onsuccess = () => finish(read.result as InvoiceDraftRecord | undefined);
    });
  } catch (error) {
    return { ok: false, reason: storageReason(error) };
  }
  if (!source) return { ok: false, reason: 'not_found' };
  if (!isSupportedRecord(source)) return { ok: false, reason: 'unsupported_format' };
  if (!recordMatchesIdentity(source, identity)) return { ok: false, reason: 'identity_mismatch' };
  if (source.status !== 'finalizing' || !source.finalization) {
    return { ok: false, reason: 'status_conflict', currentStatus: source.status };
  }
  if (
    source.finalization.clientInvoiceId !== clientInvoiceId ||
    source.finalization.contentFingerprint !== contentFingerprint
  ) {
    return { ok: false, reason: 'finalization_mismatch' };
  }
  if (source.revision !== expectedRevision) {
    return { ok: false, reason: 'conflict', currentRevision: source.revision };
  }

  // Ohne vollständig geprüfte Vorbereitung wird nichts abgeschlossen.
  const stored = await readStoredPreparation(source, {
    workspaceId: source.workspaceId,
    vorgangId: source.vorgangId,
    invoiceType: source.invoiceType,
    clientInvoiceId,
    contentFingerprint,
    draftSha256: source.draftSha256,
    // finalizing: die Vorbereitung stammt aus genau der Revision davor.
    exactFromRevision: source.revision - 1,
    startedAt: source.finalization.startedAt,
  });
  if (!stored.ok) return { ok: false, reason: stored.reason, detail: stored.detail };

  let outcome: FinalizationOutcome;
  try {
    outcome = await withStore<FinalizationOutcome>('readwrite', (store, finish) => {
      const read = store.get(recordKey);
      read.onsuccess = () => {
        const current = read.result as InvoiceDraftRecord | undefined;
        if (!current) {
          finish({ kind: 'not_found' });
          return;
        }
        if (!isSupportedRecord(current)) {
          finish({ kind: 'unsupported_format' });
          return;
        }
        if (!recordMatchesIdentity(current, identity)) {
          finish({ kind: 'identity_mismatch' });
          return;
        }
        if (current.status !== 'finalizing' || !current.finalization) {
          finish({ kind: 'status_conflict', currentStatus: current.status });
          return;
        }
        // Die Finalisierungsidentität muss exakt zum begonnenen Vorgang passen.
        if (
          current.finalization.clientInvoiceId !== clientInvoiceId ||
          current.finalization.contentFingerprint !== contentFingerprint
        ) {
          finish({ kind: 'finalization_mismatch' });
          return;
        }
        if (current.revision !== expectedRevision) {
          finish({ kind: 'conflict', currentRevision: current.revision });
          return;
        }
        /*
         * Der geprüfte Stand muss exakt derselbe sein — Entwurf **und**
         * Vorbereitung bleiben beim Abschluss bytegleich erhalten.
         */
        if (
          current.draftRawJson !== source.draftRawJson ||
          current.draftSha256 !== source.draftSha256 ||
          current.preparationRawJson !== source.preparationRawJson ||
          current.preparationSha256 !== source.preparationSha256 ||
          current.finalization.startedAt !== source.finalization?.startedAt
        ) {
          finish({ kind: 'conflict', currentRevision: current.revision });
          return;
        }
        const next: InvoiceDraftRecord = {
          ...current,
          revision: current.revision + 1,
          updatedAt: finalizedAt,
          status: 'finalized',
          finalization: {
            ...current.finalization,
            finalizedAt,
            finalizedInvoiceId,
            archiveWarning,
          },
        };
        store.put(next);
        finish({ kind: 'written', record: next });
      };
    });
  } catch (error) {
    return { ok: false, reason: storageReason(error) };
  }

  if (outcome.kind !== 'written') return mapFinalizationOutcome(outcome);
  if (!(await verifyWrittenRecord(identity, outcome.record))) {
    // Die Transaktion war bereits abgeschlossen — siehe Post-Commit-Vertrag.
    return { ok: false, reason: 'committed_but_unverified' };
  }
  return { ok: true, record: { ...outcome.record } };
}

/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4E2B — schliesst eine
 * begonnene Finalisierung terminal ab, indem sie auf eine **bereits
 * vorhandene kanonische Rechnung** eines anderen Geräts aufgelöst wird.
 *
 * Bewusst ein **eigener** Einstieg statt einer Erweiterung von
 * `completeInvoiceDraftFinalization`: dessen Kennungsprüfung ist die schärfste
 * Invariante dieses Strangs und bleibt ausnahmslos bestehen. Die Ausnahme ist
 * hier im Code sichtbar und einzeln prüfbar.
 *
 * Unverändert bleiben Entwurf, Vorbereitung, beide Hashes, die eigene
 * Operationskennung, der Geschäfts-Fingerprint und `startedAt`. Es wird
 * ausschliesslich der `finalization`-Block ergänzt und die Revision genau
 * einmal erhöht.
 *
 * **Vorbedingung des Aufrufers:** die kanonische Rechnung muss zuvor
 * nachweislich lokal dauerhaft persistiert worden sein. Der Kern liest dafür
 * weder einen Vorgangsspeicher noch einen Persistenzdienst und nimmt kein
 * bedeutungsloses Zusicherungs-Boolean entgegen — eine Behauptung wäre kein
 * Beweis. Die Reihenfolge „erst A persistieren, dann Grabstein" wird im
 * späteren Coordinator-Sprint end-to-end geprüft.
 */
export async function resolveInvoiceDraftFinalizationToExisting(
  input: ResolveInvoiceDraftFinalizationToExistingInput,
): Promise<InvoiceDraftFinalizationResult> {
  const {
    identity,
    expectedRevision,
    clientInvoiceId,
    contentFingerprint,
    finalizedInvoiceId,
    canonicalCloudInvoiceId,
    canonicalRowVersion,
    archiveWarning,
  } = input;

  if (!isCompleteIdentity(identity)) return { ok: false, reason: 'invalid_identity' };
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return { ok: false, reason: 'invalid_identity', detail: 'expectedRevision' };
  }
  if (
    !isNonEmptyString(clientInvoiceId) ||
    !isNonEmptyString(contentFingerprint) ||
    !isCanonicalText(finalizedInvoiceId) ||
    !isCanonicalText(canonicalCloudInvoiceId) ||
    !isPositiveInteger(canonicalRowVersion) ||
    typeof archiveWarning !== 'boolean'
  ) {
    return { ok: false, reason: 'invalid_finalization' };
  }
  /*
   * Die kanonische Rechnung muss eine **andere** sein — andernfalls ist der
   * eigene Complete-Pfad zuständig und wird hier nicht umgangen.
   */
  if (finalizedInvoiceId === clientInvoiceId) {
    return { ok: false, reason: 'finalization_mismatch', detail: 'finalizedInvoiceId' };
  }

  const finalizedAt = input.now ?? new Date().toISOString();
  if (!isNonEmptyString(finalizedAt)) return { ok: false, reason: 'invalid_finalization' };
  const recordKey = buildInvoiceDraftRecordKey(identity);

  let source: InvoiceDraftRecord | undefined;
  try {
    source = await withStore<InvoiceDraftRecord | undefined>('readonly', (store, finish) => {
      const read = store.get(recordKey);
      read.onsuccess = () => finish(read.result as InvoiceDraftRecord | undefined);
    });
  } catch (error) {
    return { ok: false, reason: storageReason(error) };
  }
  if (!source) return { ok: false, reason: 'not_found' };
  if (!isSupportedRecord(source)) return { ok: false, reason: 'unsupported_format' };
  if (!recordMatchesIdentity(source, identity)) return { ok: false, reason: 'identity_mismatch' };

  /*
   * Idempotente Wiederholung: nur wenn der bereits geschriebene Grabstein
   * **vollständig** gelesen und in **jedem** Beweisfeld identisch ist. Ein
   * Erfolg wird nie erfunden.
   */
  if (source.status === 'finalized' && source.finalization) {
    const stored = source.finalization;
    const identical =
      stored.resolution === 'resolved_to_existing' &&
      stored.clientInvoiceId === clientInvoiceId &&
      stored.contentFingerprint === contentFingerprint &&
      stored.finalizedInvoiceId === finalizedInvoiceId &&
      stored.canonicalCloudInvoiceId === canonicalCloudInvoiceId &&
      stored.canonicalRowVersion === canonicalRowVersion;
    if (identical) return { ok: true, record: { ...source } };
    return { ok: false, reason: 'status_conflict', currentStatus: source.status };
  }
  if (source.status !== 'finalizing' || !source.finalization) {
    return { ok: false, reason: 'status_conflict', currentStatus: source.status };
  }
  if (
    source.finalization.clientInvoiceId !== clientInvoiceId ||
    source.finalization.contentFingerprint !== contentFingerprint
  ) {
    return { ok: false, reason: 'finalization_mismatch' };
  }
  if (source.revision !== expectedRevision) {
    return { ok: false, reason: 'conflict', currentRevision: source.revision };
  }

  // Dieselbe Vorbereitungsbindung wie beim eigenen Abschluss.
  const stored = await readStoredPreparation(source, {
    workspaceId: identity.workspaceId,
    vorgangId: identity.vorgangId,
    invoiceType: identity.invoiceType,
    clientInvoiceId,
    contentFingerprint,
    draftSha256: source.draftSha256,
    exactFromRevision: source.revision - 1,
    startedAt: source.finalization.startedAt,
  });
  if (!stored.ok) return { ok: false, reason: stored.reason, detail: stored.detail };

  let outcome: FinalizationOutcome;
  try {
    outcome = await withStore<FinalizationOutcome>('readwrite', (store, finish) => {
      const read = store.get(recordKey);
      read.onsuccess = () => {
        const current = read.result as InvoiceDraftRecord | undefined;
        if (!current) {
          finish({ kind: 'not_found' });
          return;
        }
        if (!isSupportedRecord(current)) {
          finish({ kind: 'unsupported_format' });
          return;
        }
        if (!recordMatchesIdentity(current, identity)) {
          finish({ kind: 'identity_mismatch' });
          return;
        }
        if (current.status !== 'finalizing' || !current.finalization) {
          finish({ kind: 'status_conflict', currentStatus: current.status });
          return;
        }
        if (
          current.finalization.clientInvoiceId !== clientInvoiceId ||
          current.finalization.contentFingerprint !== contentFingerprint
        ) {
          finish({ kind: 'finalization_mismatch' });
          return;
        }
        if (current.revision !== expectedRevision) {
          finish({ kind: 'conflict', currentRevision: current.revision });
          return;
        }
        // Entwurf und Vorbereitung müssen bytegleich derselbe Stand sein.
        if (
          current.draftRawJson !== source!.draftRawJson ||
          current.draftSha256 !== source!.draftSha256 ||
          current.preparationRawJson !== source!.preparationRawJson ||
          current.preparationSha256 !== source!.preparationSha256 ||
          current.finalization.startedAt !== source!.finalization?.startedAt
        ) {
          finish({ kind: 'conflict', currentRevision: current.revision });
          return;
        }
        const next: InvoiceDraftRecord = {
          ...current,
          revision: current.revision + 1,
          updatedAt: finalizedAt,
          status: 'finalized',
          finalization: {
            ...current.finalization,
            finalizedAt,
            finalizedInvoiceId,
            archiveWarning,
            resolution: 'resolved_to_existing',
            canonicalCloudInvoiceId,
            canonicalRowVersion,
          },
        };
        store.put(next);
        finish({ kind: 'written', record: next });
      };
    });
  } catch (error) {
    return { ok: false, reason: storageReason(error) };
  }

  if (outcome.kind !== 'written') return mapFinalizationOutcome(outcome);
  if (!(await verifyWrittenRecord(identity, outcome.record))) {
    // Die Transaktion war bereits abgeschlossen — siehe Post-Commit-Vertrag.
    return { ok: false, reason: 'committed_but_unverified' };
  }
  return { ok: true, record: { ...outcome.record } };
}

/**
 * Lädt die bestätigte Vorbereitung ausschließlich aus IndexedDB — kein
 * LocalStorage, kein Neubau des Requests, keine Cloud. Sie ist sowohl für
 * `finalizing` als auch für `finalized` verfügbar: Wiederaufnahme, Prüfung und
 * Archivnachholung brauchen denselben unveränderlichen Stand.
 */
export async function loadInvoiceDraftFinalizationPreparation(
  input: LoadInvoiceDraftFinalizationPreparationInput,
): Promise<InvoiceDraftPreparationLoadResult> {
  const { identity, expectedRevision } = input;
  if (!isCompleteIdentity(identity)) return { ok: false, reason: 'invalid_identity' };
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return { ok: false, reason: 'invalid_identity', detail: 'expectedRevision' };
  }

  let stored: InvoiceDraftRecord | undefined;
  try {
    stored = await withStore<InvoiceDraftRecord | undefined>('readonly', (store, finish) => {
      const read = store.get(buildInvoiceDraftRecordKey(identity));
      read.onsuccess = () => finish(read.result as InvoiceDraftRecord | undefined);
    });
  } catch (error) {
    return { ok: false, reason: storageReason(error) };
  }

  if (!stored) return { ok: false, reason: 'not_found' };
  if (!isSupportedRecord(stored)) return { ok: false, reason: 'unsupported_format' };
  if (!recordMatchesIdentity(stored, identity)) return { ok: false, reason: 'identity_mismatch' };
  if (stored.status === 'active' || !stored.finalization) {
    return { ok: false, reason: 'status_conflict', currentStatus: stored.status };
  }
  if (stored.revision !== expectedRevision) {
    return { ok: false, reason: 'conflict', currentRevision: stored.revision };
  }

  const preparation = await readStoredPreparation(stored, {
    workspaceId: stored.workspaceId,
    vorgangId: stored.vorgangId,
    invoiceType: stored.invoiceType,
    clientInvoiceId: stored.finalization.clientInvoiceId,
    contentFingerprint: stored.finalization.contentFingerprint,
    draftSha256: stored.draftSha256,
    // finalizing = Ausgangsrevision + 1, finalized = Ausgangsrevision + 2.
    exactFromRevision: stored.revision - (stored.status === 'finalized' ? 2 : 1),
    startedAt: stored.finalization.startedAt,
  });
  if (!preparation.ok) {
    return { ok: false, reason: preparation.reason, detail: preparation.detail };
  }

  // Jeder Aufruf liefert ein frisch geparstes, vom Speicher getrenntes Objekt.
  return { ok: true, record: { ...stored }, preparation: preparation.preparation };
}

export async function resetInvoiceDraftDurabilityDatabaseForTests(): Promise<void> {
  if (activeDb) {
    try {
      activeDb.close();
    } catch {
      /* ignore */
    }
  }
  activeDb = null;
  dbPromise = null;

  const factory = resolveIndexedDb();
  if (!factory) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const request = factory.deleteDatabase(INVOICE_DRAFT_DB_NAME);
    request.onsuccess = finish;
    request.onerror = finish;
    request.onblocked = finish;
    // Ein blockierendes Fremdfenster darf den Testlauf nie anhalten.
    setTimeout(finish, 100);
  });
}
