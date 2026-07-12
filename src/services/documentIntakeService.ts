import type { DocumentFileRef } from '../types/documentFileRef';
import type { InboxItem } from '../types/models';
import { validateUploadFile } from './documentUploadValidation';
import { findDuplicateByContentHash } from './documentDuplicateService';
import { extractDocumentText } from './ocrDocumentService';
import { createMockInboxItemFromUpload, type CreateInboxFromUploadOptions } from './inboxUploadFactory';
import { addInboxItem } from './inboxService';
import { storeDocumentFileFromUpload } from './documentFileStoreService';
import { persistAll } from './persistenceService';
import type { DocumentUploadValidationError } from '../types/uploadedDocument';

export type DocumentIntakeErrorCode =
  | DocumentUploadValidationError
  | 'hash_failed'
  | 'read_failed'
  | 'persist_failed';

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

export async function intakeDocumentFile(
  file: File,
  options: CreateInboxFromUploadOptions = {},
): Promise<DocumentIntakeResult> {
  const validation = validateUploadFile(file);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  let fileRef: DocumentFileRef;
  try {
    const stored = await storeDocumentFileFromUpload(file);
    fileRef = stored.fileRef;
  } catch {
    return { success: false, error: 'read_failed' };
  }

  const duplicate = findDuplicateByContentHash(fileRef.contentHash);
  if (duplicate) {
    return { success: true, duplicate: true, fileRef, existing: duplicate };
  }

  let recognizedText = options.recognizedText;
  let pageTextsJson: string | undefined;
  if (recognizedText === undefined) {
    try {
      const extraction = await extractDocumentText(file);
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
    sourceFileName: options.sourceFileName ?? file.name,
    recognizedText,
  });

  const inboxItem = addInboxItem({
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

  persistAll();
  return { success: true, duplicate: false, inboxItem, fileRef };
}
