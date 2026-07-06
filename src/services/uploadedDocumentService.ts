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

export type UploadDocumentResult =
  | { success: true; document: UploadedDocument }
  | { success: false; error: DocumentUploadValidationError };

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('Datei konnte nicht gelesen werden.'));
    };
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
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

export async function uploadDocumentFromFile(file: File): Promise<UploadDocumentResult> {
  const validation = validateUploadFile(file);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const originalFileDataUrl = await readFileAsDataUrl(file);
  const document = addUploadedDocumentToStore(
    buildUploadedDocument({
      fileName: file.name,
      fileType: file.type || 'application/octet-stream',
      fileSize: file.size,
      originalFileDataUrl,
    }),
  );
  persistAll();
  return { success: true, document };
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
    file_too_large: 'Die Datei ist zu groß (max. 10 MB).',
  };
  return messages[error];
}
