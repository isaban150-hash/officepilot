/**
 * UPLOAD-DRAFT-RESUME-01B1 — save, restore and discard an unconfirmed upload draft.
 *
 * Confirm-first: a draft is a purely local, clearly temporary artefact. It creates
 * no InboxItem, no Document, no customer, Vorgang, order or invoice, and it is
 * never synchronised. The bytes live in the existing document blob store; this
 * service only adds metadata plus the lifecycle rules around them.
 */
import type { PendingDocumentIntake } from '../pendingDocumentIntakeService';
import type { CachedDocumentFilePayload } from '../cachedDocumentFileService';
import {
  getDocumentFileRefById,
  getOriginalDocumentFileBytes,
  removeDocumentFileStoreEntry,
  storeDocumentFileFromCachedPayload,
  verifyStoredBlobMatchesExpected,
} from '../documentFileStoreService';
import { DocumentBlobStorageError } from '../storage/documentBlobIndexedDbService';
import { countActiveReferencesToFileRef } from '../documentFileReferenceService';
import * as persistenceService from '../persistenceService';
import {
  buildUploadDraftScopeFields,
  deleteUploadDraftRecordById,
  getUploadDraftRecordById,
  listUploadDraftRecordsForActiveScope,
  saveUploadDraftRecord,
  UPLOAD_DRAFT_SCHEMA_VERSION,
  UPLOAD_DRAFT_TTL_MS,
  type UploadDraftRecord,
} from '../storage/uploadDraftIndexedDbService';

export type SaveUploadDraftResult =
  | { success: true; draftId: string; fileRefId: string }
  | { success: false; error: 'persist_failed' | 'draft_write_failed' | 'file_store_failed' };

export type LoadUploadDraftResult =
  | { success: true; draftId: string; pending: PendingDocumentIntake }
  | {
      success: false;
      reason: 'missing' | 'schema' | 'expired' | 'lifecycle' | 'file_missing' | 'mismatch';
    };

function newDraftId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `updr-${crypto.randomUUID()}`;
  }
  return `updr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * A file may only be removed when it is temporary, unreferenced by any domain
 * object and not held by another draft. A committed ref is never touched.
 */
async function canRemoveFileRefForDraft(
  fileRefId: string,
  excludeDraftId: string | null,
): Promise<boolean> {
  const ref = getDocumentFileRefById(fileRefId);
  if (!ref) return false;
  if (ref.lifecycleStatus !== 'temp') return false;
  if (countActiveReferencesToFileRef(fileRefId) > 0) return false;

  const remaining = await listUploadDraftRecordsForActiveScope();
  return !remaining.some(
    (record) => record.fileRefId === fileRefId && record.id !== excludeDraftId,
  );
}

/**
 * Store bytes as a temporary file, flush so the ref survives a reload, then write
 * the draft metadata. Only a ref created by this very attempt is rolled back.
 */
export async function savePendingDocumentIntakeDraft(
  pending: PendingDocumentIntake,
): Promise<SaveUploadDraftResult> {
  let fileRefId: string;
  let contentHash: string;
  let createdFileRef = false;

  try {
    const stored = await storeDocumentFileFromCachedPayload(pending.cachedFile, {
      lifecycleIntent: 'temp',
    });
    fileRefId = stored.fileRef.id;
    contentHash = stored.fileRef.contentHash;
    createdFileRef = stored.created;
  } catch {
    return { success: false, error: 'file_store_failed' };
  }

  // A new temp ref only survives a reload once its metadata is persisted.
  const persistResult = persistenceService.persistAll();
  if (!persistResult.success) {
    if (createdFileRef) {
      const ref = getDocumentFileRefById(fileRefId);
      if (ref) {
        try {
          await removeDocumentFileStoreEntry(ref.id, ref.localDataKey);
        } catch {
          /* best effort */
        }
      }
    }
    return { success: false, error: 'persist_failed' };
  }

  const now = new Date();
  const draftId = newDraftId();
  const record: UploadDraftRecord = {
    id: draftId,
    schemaVersion: UPLOAD_DRAFT_SCHEMA_VERSION,
    ...buildUploadDraftScopeFields(),
    source: 'upload',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + UPLOAD_DRAFT_TTL_MS).toISOString(),
    fileRefId,
    fileName: pending.cachedFile.fileName,
    mimeType: pending.cachedFile.mimeType,
    fileSize: pending.cachedFile.bytes.byteLength,
    contentHash,
    extraction: pending.extraction,
    preview: pending.preview,
    previewClassification: pending.previewClassification,
    storageRecommendation: pending.storageRecommendation,
    storagePolicy: pending.storagePolicy,
  };

  try {
    await saveUploadDraftRecord(record);
  } catch {
    if (createdFileRef && (await canRemoveFileRefForDraft(fileRefId, draftId))) {
      const ref = getDocumentFileRefById(fileRefId);
      if (ref) {
        try {
          await removeDocumentFileStoreEntry(ref.id, ref.localDataKey);
          persistenceService.persistAll();
        } catch {
          /* best effort */
        }
      }
    }
    return { success: false, error: 'draft_write_failed' };
  }

  return { success: true, draftId, fileRefId };
}

function isExpired(record: UploadDraftRecord, nowMs: number): boolean {
  const expires = Date.parse(record.expiresAt);
  if (!Number.isFinite(expires)) return true;
  return expires <= nowMs;
}

/**
 * Rebuilds the PendingDocumentIntake from stored metadata and stored bytes.
 * No OCR, no classification, no preview pipeline runs here.
 */
export async function loadPendingDocumentIntakeDraft(
  draftId: string,
  options: { nowMs?: number } = {},
): Promise<LoadUploadDraftResult> {
  const record = await getUploadDraftRecordById(draftId);
  if (!record) return { success: false, reason: 'missing' };
  if (record.schemaVersion !== UPLOAD_DRAFT_SCHEMA_VERSION) {
    return { success: false, reason: 'schema' };
  }
  if (isExpired(record, options.nowMs ?? Date.now())) {
    return { success: false, reason: 'expired' };
  }

  const ref = getDocumentFileRefById(record.fileRefId);
  if (!ref) return { success: false, reason: 'file_missing' };
  // temp is the normal draft case; an already committed ref of the same hash is
  // legitimate and stays untouched. staged/trashed are never resumable.
  if (ref.lifecycleStatus !== 'temp' && ref.lifecycleStatus !== 'committed') {
    return { success: false, reason: 'lifecycle' };
  }
  if (ref.contentHash !== record.contentHash) {
    return { success: false, reason: 'mismatch' };
  }

  // Real integrity check on the stored bytes — the existing verify gate, not a
  // second hashing architecture. Same length with different content fails here.
  try {
    await verifyStoredBlobMatchesExpected({
      fileRefId: ref.id,
      expectedHash: record.contentHash,
      expectedByteLength: record.fileSize,
    });
  } catch (error) {
    if (error instanceof DocumentBlobStorageError && error.code === 'blob_read_failed') {
      return { success: false, reason: 'file_missing' };
    }
    return { success: false, reason: 'mismatch' };
  }

  let bytes: Uint8Array | null = null;
  try {
    bytes = await getOriginalDocumentFileBytes(ref);
  } catch {
    bytes = null;
  }
  if (!bytes) return { success: false, reason: 'file_missing' };
  if (bytes.byteLength !== record.fileSize || bytes.byteLength !== ref.fileSize) {
    return { success: false, reason: 'mismatch' };
  }

  const cachedFile: CachedDocumentFilePayload = {
    fileName: record.fileName,
    mimeType: record.mimeType,
    fileSize: record.fileSize,
    bytes,
  };

  return {
    success: true,
    draftId: record.id,
    pending: {
      cachedFile,
      extraction: record.extraction,
      preview: record.preview,
      previewClassification: record.previewClassification,
      storageRecommendation: record.storageRecommendation,
      storagePolicy: record.storagePolicy,
    },
  };
}

/**
 * Discard order: the file goes first, the metadata last.
 *
 * The draft record is the only pointer to its fileRefId — deleting it first
 * would hide an orphan temp file from every later cleanup. It therefore stays
 * until the file is gone and that state is persisted; a crash in between leaves
 * a retry pointer, not a leak.
 *
 * Returns true when the draft record was removed.
 */
export async function discardPendingDocumentIntakeDraft(draftId: string): Promise<boolean> {
  if (!draftId) return false;
  const record = await getUploadDraftRecordById(draftId);
  // Foreign scope or unknown id: nothing of ours, nothing to delete.
  if (!record) return false;

  const ref = getDocumentFileRefById(record.fileRefId);
  if (!ref) {
    // Retry path: a previous attempt removed the ref in memory but failed to
    // persist, so the old ref may still sit in storage. Flush first — the draft
    // record stays as pointer until that succeeds.
    const retryPersist = persistenceService.persistAll();
    if (!retryPersist.success) return false;
    return deleteUploadDraftRecordById(draftId);
  }

  // Committed, shared with a domain object or held by another draft: keep the file.
  if (!(await canRemoveFileRefForDraft(record.fileRefId, draftId))) {
    return deleteUploadDraftRecordById(draftId);
  }

  try {
    await removeDocumentFileStoreEntry(ref.id, ref.localDataKey);
  } catch {
    // File removal failed — keep the draft as retry pointer.
    return false;
  }

  const persistResult = persistenceService.persistAll();
  if (!persistResult.success) {
    return false;
  }

  return deleteUploadDraftRecordById(draftId);
}

export type DiscardUploadDraftOutcome = 'discarded' | 'not_found' | 'retry';

/**
 * UPLOAD-DRAFT-RESUME-01C2 — typed variant for the Continue Working card.
 *
 * Same safety rules as discardPendingDocumentIntakeDraft; only the result is
 * richer so the caller can tell "already gone" from "try again". A draft of a
 * foreign scope reads as not_found and is never touched.
 */
export async function discardUploadDraftForRecovery(
  draftId: string,
): Promise<DiscardUploadDraftOutcome> {
  if (!draftId) return 'not_found';
  const record = await getUploadDraftRecordById(draftId);
  if (!record) return 'not_found';
  return (await discardPendingDocumentIntakeDraft(draftId)) ? 'discarded' : 'retry';
}

/**
 * Removes the draft metadata but keeps the file — used after a successful intake,
 * a duplicate navigation or a switch to an existing document. Scope-safe.
 */
export async function forgetUploadDraftMetadata(draftId: string): Promise<boolean> {
  if (!draftId) return false;
  return deleteUploadDraftRecordById(draftId);
}

/**
 * Removes expired drafts of the active scope. Only upload draft records and their
 * safely removable temp files are touched — never keep_temporarily inbox items and
 * never temp refs that belong to a domain object or another draft.
 */
export async function cleanupExpiredUploadDrafts(
  options: { nowMs?: number } = {},
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  let records: UploadDraftRecord[];
  try {
    records = await listUploadDraftRecordsForActiveScope();
  } catch {
    return 0;
  }

  let removed = 0;
  for (const record of records) {
    if (!isExpired(record, nowMs)) continue;
    // Counts only records that were really removed; a kept retry pointer does not.
    if (await discardPendingDocumentIntakeDraft(record.id)) removed += 1;
  }
  return removed;
}
