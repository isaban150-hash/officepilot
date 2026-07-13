import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import {
  loadCachedDocumentFileFromUpload,
  releaseCachedDocumentFile,
} from './cachedDocumentFileService';
import type { DocumentFileRef } from '../types/documentFileRef';
import type { InboxItem } from '../types/models';
import { validateUploadFile } from './documentUploadValidation';
import { findDuplicateByContentHash } from './documentDuplicateService';
import { extractDocumentTextFromCache } from './ocrDocumentService';
import { createMockInboxItemFromUpload, type CreateInboxFromUploadOptions } from './inboxUploadFactory';
import { stageInboxItem, removeStagedInboxItemById } from './inboxService';
import {
  storeDocumentFileFromCachedPayload,
  removeDocumentFileStoreEntry,
  DocumentBlobStorageError,
} from './documentFileStoreService';
import type { DocumentBlobStorageErrorCode } from './storage/documentBlobIndexedDbService';
import * as persistenceService from './persistenceService';
import type { DocumentUploadValidationError } from '../types/uploadedDocument';

export type DocumentIntakeErrorCode =
  | DocumentUploadValidationError
  | 'file_read_failed'
  | 'storage_failed'
  | 'hash_failed'
  | 'persist_failed'
  | 'navigation_failed'
  | DocumentBlobStorageErrorCode;

export type DocumentIntakeResult =
  | {
      success: true;
      duplicate: false;
      inboxItem: InboxItem;
      fileRef: DocumentFileRef;
    }
  | {
      success: true;
      duplicate: true;
      fileRef: DocumentFileRef;
      existing: ReturnType<typeof findDuplicateByContentHash>;
    }
  | {
      success: false;
      error: DocumentIntakeErrorCode;
    };

function mapStorageError(error: unknown): DocumentIntakeErrorCode {
  if (error instanceof DocumentBlobStorageError) {
    return error.code;
  }
  if (error instanceof Error) {
    if (error.message === 'hash_failed') return 'hash_failed';
    if (error.message === 'storage_failed') return 'storage_failed';
  }
  return 'storage_failed';
}

async function rollbackFailedIntakeAttempt(input: {
  inboxItemId: string;
  createdFileRef: boolean;
  fileRefId: string;
  localDataKey: string;
}): Promise<void> {
  removeStagedInboxItemById(input.inboxItemId);
  if (input.createdFileRef) {
    await removeDocumentFileStoreEntry(input.fileRefId, input.localDataKey);
  }
}

export async function intakeCachedDocumentFile(
  payload: CachedDocumentFilePayload,
  options: CreateInboxFromUploadOptions = {},
): Promise<DocumentIntakeResult> {
  const validation = validateUploadFile(
    new File([payload.bytes], payload.fileName, { type: payload.mimeType }),
  );
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  let fileRef: DocumentFileRef;
  let createdFileRef = false;
  try {
    const stored = await storeDocumentFileFromCachedPayload(payload);
    fileRef = stored.fileRef;
    createdFileRef = stored.created;
  } catch (error) {
    return { success: false, error: mapStorageError(error) };
  }

  const duplicate = findDuplicateByContentHash(fileRef.contentHash);
  if (duplicate) {
    return { success: true, duplicate: true, fileRef, existing: duplicate };
  }

  let recognizedText = options.recognizedText;
  let pageTextsJson: string | undefined;
  if (recognizedText === undefined) {
    try {
      const extraction = await extractDocumentTextFromCache(payload);
      recognizedText = extraction.recognizedText.trim() || undefined;
      if (extraction.pageTexts?.length) {
        pageTextsJson = JSON.stringify(extraction.pageTexts);
      }
    } catch {
      recognizedText = undefined;
    }
  }

  const classified = createMockInboxItemFromUpload({
    ...options,
    sourceFileName: options.sourceFileName ?? payload.fileName,
    recognizedText,
  });

  const inboxItem = stageInboxItem({
    ...classified,
    recognizedData: {
      ...classified.recognizedData,
      ...(pageTextsJson ? { _pageTexts: pageTextsJson } : {}),
    },
    isNewUpload: true,
    importSource: options.importSource ?? 'upload',
    fileRefId: fileRef.id,
    sourceFileHash: fileRef.contentHash,
    sourceFileName: fileRef.originalFileName,
  });

  const persistResult = persistenceService.persistAll();
  if (!persistResult.success) {
    await rollbackFailedIntakeAttempt({
      inboxItemId: inboxItem.id,
      createdFileRef,
      fileRefId: fileRef.id,
      localDataKey: fileRef.localDataKey,
    });
    return { success: false, error: 'persist_failed' };
  }

  releaseCachedDocumentFile(payload);
  return { success: true, duplicate: false, inboxItem, fileRef };
}

export async function intakeDocumentFile(
  file: File,
  options: CreateInboxFromUploadOptions = {},
): Promise<DocumentIntakeResult> {
  const loaded = await loadCachedDocumentFileFromUpload(file);
  if (!loaded.success) {
    return { success: false, error: loaded.error };
  }
  return intakeCachedDocumentFile(loaded.payload, options);
}
