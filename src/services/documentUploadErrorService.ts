import type { TranslationKey } from '../i18n';
import type { DocumentIntakeErrorCode } from './documentIntakeService';
import type { DocumentTextErrorCode } from './ocrDocumentService';
import type { DocumentUploadValidationError } from '../types/uploadedDocument';

export type DocumentUploadErrorCode =
  | DocumentUploadValidationError
  | DocumentIntakeErrorCode
  | DocumentTextErrorCode;

const INTAKE_ERROR_KEYS: Partial<Record<DocumentIntakeErrorCode, TranslationKey>> = {
  invalid_type: 'document.upload.error.invalidType',
  unsupported_photo_format: 'document.upload.error.unsupportedPhotoFormat',
  file_too_large: 'document.upload.error.fileTooLarge',
  read_failed: 'document.upload.error.processFailed',
  hash_failed: 'document.upload.error.processFailed',
  persist_failed: 'document.upload.error.processFailed',
};

const EXTRACTION_ERROR_KEYS: Partial<Record<DocumentTextErrorCode, TranslationKey>> = {
  heic_unsupported: 'document.upload.error.unsupportedPhotoFormat',
  unsupported_format: 'document.upload.error.unsupportedPhotoFormat',
  ocr_failed: 'scan.ocr.failed',
  password_required: 'document.upload.error.passwordRequired',
  pdf_corrupt: 'document.upload.error.pdfCorrupt',
};

export function resolveIntakeErrorKey(
  error: DocumentIntakeErrorCode,
): TranslationKey {
  return INTAKE_ERROR_KEYS[error] ?? 'document.upload.error.processFailed';
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
    errorCode === 'password_required' ||
    errorCode === 'pdf_corrupt'
  );
}
