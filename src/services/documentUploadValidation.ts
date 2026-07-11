import type { DocumentUploadValidationError } from '../types/uploadedDocument';

export const MAX_UPLOAD_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const ACCEPTED_UPLOAD_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const ACCEPTED_UPLOAD_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'] as const;

export type AcceptedUploadMimeType = (typeof ACCEPTED_UPLOAD_MIME_TYPES)[number];

export function isAcceptedUploadMimeType(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase();
  return (ACCEPTED_UPLOAD_MIME_TYPES as readonly string[]).includes(normalized);
}

function extensionFromFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return '';
  return fileName.slice(dot).toLowerCase();
}

export function isAcceptedUploadFileName(fileName: string): boolean {
  const ext = extensionFromFileName(fileName);
  return (ACCEPTED_UPLOAD_EXTENSIONS as readonly string[]).includes(ext);
}

export function isHeicUploadFile(file: File): boolean {
  const ext = extensionFromFileName(file.name);
  const mime = file.type.trim().toLowerCase();
  return ext === '.heic' || ext === '.heif' || mime === 'image/heic' || mime === 'image/heif';
}

export function validateUploadFile(file: File): {
  valid: true;
} | {
  valid: false;
  error: DocumentUploadValidationError;
} {
  if (isHeicUploadFile(file)) {
    return { valid: false, error: 'unsupported_photo_format' };
  }

  if (file.size > MAX_UPLOAD_FILE_SIZE_BYTES) {
    return { valid: false, error: 'file_too_large' };
  }
  const mimeOk = file.type ? isAcceptedUploadMimeType(file.type) : false;
  const extOk = isAcceptedUploadFileName(file.name);
  if (!mimeOk && !extOk) {
    return { valid: false, error: 'invalid_type' };
  }
  if (!mimeOk && extOk) {
    return { valid: true };
  }
  if (mimeOk) {
    return { valid: true };
  }
  return { valid: false, error: 'invalid_type' };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImageUpload(fileType: string, fileName: string): boolean {
  const mime = fileType.toLowerCase();
  if (mime.startsWith('image/')) return true;
  const ext = extensionFromFileName(fileName);
  return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
}

export function isPdfUpload(fileType: string, fileName: string): boolean {
  if (fileType.toLowerCase() === 'application/pdf') return true;
  return extensionFromFileName(fileName) === '.pdf';
}
