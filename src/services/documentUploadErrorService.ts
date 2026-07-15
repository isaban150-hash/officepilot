import type { TranslationKey } from '../i18n';
import type { DocumentIntakeErrorCode } from './documentIntakeService';
import type { DocumentTextErrorCode } from './ocrDocumentService';
import type { DocumentUploadValidationError } from '../types/uploadedDocument';

export type { DocumentIntakeErrorCode };

export type DocumentUploadErrorCode =
  | DocumentUploadValidationError
  | DocumentIntakeErrorCode
  | DocumentTextErrorCode;

export interface UploadErrorView {
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  hintKey?: TranslationKey;
  allowRetry: boolean;
  allowNewPhoto: boolean;
  allowSelectFile: boolean;
}

const INTAKE_ERROR_KEYS: Partial<Record<DocumentIntakeErrorCode, TranslationKey>> = {
  invalid_type: 'document.upload.error.invalidType',
  unsupported_photo_format: 'document.upload.error.unsupportedPhotoFormat',
  file_too_large: 'document.upload.error.fileTooLarge',
  file_read_failed: 'docAssistant.error.fileReadFailed',
  storage_failed: 'docAssistant.error.storageFailed',
  hash_failed: 'docAssistant.error.storageFailed',
  persist_failed: 'docAssistant.error.persistFailed',
  navigation_failed: 'docAssistant.error.navigationFailed',
  blob_storage_unavailable: 'docAssistant.error.blobStorageFailed',
  blob_write_failed: 'docAssistant.error.blobStorageFailed',
  blob_read_failed: 'docAssistant.error.blobStorageFailed',
  blob_delete_failed: 'docAssistant.error.blobStorageFailed',
  blob_missing_after_write: 'docAssistant.error.blobMissingAfterWrite',
  blob_size_mismatch: 'docAssistant.error.blobSizeMismatch',
  blob_hash_mismatch: 'docAssistant.error.blobHashMismatch',
};

const EXTRACTION_ERROR_KEYS: Partial<Record<DocumentTextErrorCode, TranslationKey>> = {
  heic_unsupported: 'document.upload.error.unsupportedPhotoFormat',
  unsupported_format: 'document.upload.error.unsupportedPhotoFormat',
  ocr_failed: 'docAssistant.error.blurryPhoto',
  no_text: 'docAssistant.error.noReadableText',
  password_required: 'document.upload.error.passwordRequired',
  pdf_corrupt: 'document.upload.error.pdfCorrupt',
};

const EXTRACTION_TITLE_KEYS: Partial<Record<DocumentTextErrorCode, TranslationKey>> = {
  heic_unsupported: 'docAssistant.error.title.unsupportedFormat',
  unsupported_format: 'docAssistant.error.title.unsupportedFormat',
  ocr_failed: 'docAssistant.error.title.blurryPhoto',
  no_text: 'docAssistant.error.title.noReadableText',
  password_required: 'docAssistant.error.title.passwordRequired',
  pdf_corrupt: 'docAssistant.error.title.pdfCorrupt',
};

const INTAKE_TITLE_KEYS: Partial<Record<DocumentIntakeErrorCode, TranslationKey>> = {
  invalid_type: 'docAssistant.error.title.unsupportedFormat',
  unsupported_photo_format: 'docAssistant.error.title.unsupportedFormat',
  file_too_large: 'docAssistant.error.title.fileTooLarge',
  file_read_failed: 'docAssistant.error.title.fileReadFailed',
  storage_failed: 'docAssistant.error.title.storageFailed',
  hash_failed: 'docAssistant.error.title.storageFailed',
  persist_failed: 'docAssistant.error.title.persistFailed',
  navigation_failed: 'docAssistant.error.title.navigationFailed',
  blob_storage_unavailable: 'docAssistant.error.title.storageFailed',
  blob_write_failed: 'docAssistant.error.title.storageFailed',
  blob_read_failed: 'docAssistant.error.title.storageFailed',
  blob_delete_failed: 'docAssistant.error.title.storageFailed',
  blob_missing_after_write: 'docAssistant.error.title.integrityFailed',
  blob_size_mismatch: 'docAssistant.error.title.integrityFailed',
  blob_hash_mismatch: 'docAssistant.error.title.integrityFailed',
};

export function resolveIntakeErrorKey(
  error: DocumentIntakeErrorCode,
): TranslationKey {
  return INTAKE_ERROR_KEYS[error] ?? 'docAssistant.error.technicalFailure';
}

export function resolveExtractionErrorKey(
  errorCode?: DocumentTextErrorCode,
): TranslationKey | null {
  if (!errorCode) return null;
  return EXTRACTION_ERROR_KEYS[errorCode] ?? null;
}

export function isBlockingExtractionError(errorCode?: DocumentTextErrorCode): boolean {
  return (
    errorCode === 'heic_unsupported' ||
    errorCode === 'unsupported_format' ||
    errorCode === 'ocr_failed' ||
    errorCode === 'no_text' ||
    errorCode === 'password_required' ||
    errorCode === 'pdf_corrupt'
  );
}

export function isConfirmRetryableIntakeError(error: DocumentIntakeErrorCode): boolean {
  return (
    error === 'storage_failed' ||
    error === 'hash_failed' ||
    error === 'persist_failed' ||
    error === 'navigation_failed' ||
    error === 'blob_storage_unavailable' ||
    error === 'blob_write_failed' ||
    error === 'blob_read_failed' ||
    error === 'blob_delete_failed' ||
    error === 'blob_missing_after_write' ||
    error === 'blob_size_mismatch' ||
    error === 'blob_hash_mismatch'
  );
}

export function resolveUploadErrorView(errorCode: DocumentUploadErrorCode): UploadErrorView {
  const extractionTitle = EXTRACTION_TITLE_KEYS[errorCode as DocumentTextErrorCode];
  const intakeTitle = INTAKE_TITLE_KEYS[errorCode as DocumentIntakeErrorCode];
  const descriptionKey =
    EXTRACTION_ERROR_KEYS[errorCode as DocumentTextErrorCode] ??
    INTAKE_ERROR_KEYS[errorCode as DocumentIntakeErrorCode] ??
    'docAssistant.error.technicalFailure';

  return {
    titleKey:
      extractionTitle ??
      intakeTitle ??
      'docAssistant.error.title.technicalFailure',
    descriptionKey,
    hintKey: 'docAssistant.error.hint',
    allowRetry: true,
    allowNewPhoto: true,
    allowSelectFile: true,
  };
}
