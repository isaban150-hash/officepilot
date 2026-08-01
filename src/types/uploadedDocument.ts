export type UploadedDocumentStatus = 'uploaded' | 'needs_review';
export type UploadedDocumentSource = 'upload';

export interface UploadedDocument {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  uploadedAt: string;
  status: UploadedDocumentStatus;
  source: UploadedDocumentSource;
  /** Runtime preview – derived from originalFileDataUrl on hydrate. */
  previewUrl?: string;
  /** Persisted file payload as data URL (local foundation). */
  originalFileDataUrl?: string;
  documentType?: string;
  customerId?: string;
  projectId?: string;
  notes?: string;
}

export interface UploadedDocumentInput {
  fileName: string;
  fileType: string;
  fileSize: number;
  originalFileDataUrl: string;
  status?: UploadedDocumentStatus;
  notes?: string;
}

export type DocumentUploadValidationError =
  | 'invalid_type'
  | 'unsupported_photo_format'
  | 'heic_conversion_failed'
  | 'file_too_large';
