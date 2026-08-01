import { generateEntityId } from './sync/syncMetaService';
import { persistAll } from './persistenceService';
import { validateUploadFile } from './documentUploadValidation';
import type {
  DocumentUploadValidationError,
  UploadedDocument,
  UploadedDocumentInput,
} from '../types/uploadedDocument';
import {
  addUploadedDocumentToStore,
  getAllUploadedDocuments,
  getUploadedDocumentById,
} from './uploadedDocumentStore';
import { intakeDocumentFile, type DocumentIntakeErrorCode } from './documentIntakeService';

export type UploadDocumentResult =
  | { success: true; inboxItemId: string; duplicate: false }
  | {
      success: true;
      duplicate: true;
      existingType: 'inbox' | 'document';
      existingId: string;
      existingTitle: string;
    }
  | { success: false; error: DocumentUploadValidationError | 'duplicate' | DocumentIntakeErrorCode | 'read_failed' };

/**
 * @deprecated Legacy-Hülle – leitet neue Uploads in die zentrale Intake-Pipeline um.
 */
export async function uploadDocumentFromFile(file: File): Promise<UploadDocumentResult> {
  const result = await intakeDocumentFile(file, { importSource: 'upload' });
  if (!result.success) {
    return { success: false, error: result.error };
  }
  if (result.duplicate) {
    return {
      success: true,
      duplicate: true,
      existingType: result.existing?.type ?? 'inbox',
      existingId: result.existing?.id ?? '',
      existingTitle: result.existing?.title ?? '',
    };
  }
  return { success: true, duplicate: false, inboxItemId: result.inboxItem.id };
}

function buildUploadedDocument(input: UploadedDocumentInput): UploadedDocument {
  const now = new Date().toISOString();
  return {
    id: generateEntityId('upl-doc'),
    fileName: input.fileName,
    fileType: input.fileType,
    fileSize: input.fileSize,
    uploadedAt: now,
    status: input.status ?? 'uploaded',
    source: 'upload',
    originalFileDataUrl: input.originalFileDataUrl,
    previewUrl: input.originalFileDataUrl,
    documentType: undefined,
    notes: input.notes,
  };
}

export function createUploadedDocumentForTests(
  input: UploadedDocumentInput & { id?: string; uploadedAt?: string },
): UploadedDocument {
  const document = buildUploadedDocument(input);
  if (input.id) document.id = input.id;
  if (input.uploadedAt) document.uploadedAt = input.uploadedAt;
  return addUploadedDocumentToStore(document);
}

export { getAllUploadedDocuments, getUploadedDocumentById };

export function getUploadErrorMessage(error: DocumentUploadValidationError): string {
  const messages: Record<DocumentUploadValidationError, string> = {
    invalid_type: 'Nur PDF, JPG, PNG und WEBP sind erlaubt.',
    unsupported_photo_format:
      'Dieses Fotoformat wird noch nicht unterstützt. Bitte als JPG, PNG oder PDF hochladen.',
    heic_conversion_failed:
      'Dieses iPhone-Foto (HEIC) konnte nicht verarbeitet werden. Bitte erneut versuchen oder als JPG speichern.',
    file_too_large: 'Die Datei ist zu groß (max. 10 MB).',
  };
  return messages[error];
}

/** Nur für Legacy-Tests – schreibt weiterhin in UploadedDocument-Store. */
export async function uploadLegacyUploadedDocumentForTests(file: File): Promise<UploadDocumentResult> {
  const validation = validateUploadFile(file);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }
  const reader = new FileReader();
  const originalFileDataUrl = await new Promise<string>((resolve, reject) => {
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('read_failed'));
    };
    reader.onerror = () => reject(new Error('read_failed'));
    reader.readAsDataURL(file);
  }).catch(() => null);
  if (!originalFileDataUrl) {
    return { success: false, error: 'read_failed' };
  }
  addUploadedDocumentToStore(
    buildUploadedDocument({
      fileName: file.name,
      fileType: file.type || 'application/octet-stream',
      fileSize: file.size,
      originalFileDataUrl,
    }),
  );
  persistAll();
  return { success: true, duplicate: false, inboxItemId: '' };
}
