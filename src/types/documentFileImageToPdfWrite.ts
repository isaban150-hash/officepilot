/**
 * Pure in-memory raster image → single-page PDF write result.
 * Does not persist bytes, create FileRefs, or assert transform capabilities.
 */

/** Accepted source MIME types for the image→PDF write core (no WebP, no PDF rewrite). */
export const IMAGE_TO_PDF_SOURCE_MIME_TYPES = ['image/jpeg', 'image/png'] as const;

export type ImageToPdfSourceMimeType = (typeof IMAGE_TO_PDF_SOURCE_MIME_TYPES)[number];

/**
 * Documented target page size in PDF points (1/72 inch).
 * A4 portrait — STORAGE-PDF-WRITE-IMAGE-CORE-01. Not a policy knob.
 */
export const IMAGE_TO_PDF_PAGE_WIDTH_PT = 595.28;
export const IMAGE_TO_PDF_PAGE_HEIGHT_PT = 841.89;

export interface DocumentFileImageToPdfWriteResult {
  readonly bytes: Uint8Array;
  readonly mimeType: 'application/pdf';
  readonly pageCount: 1;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
}

export type DocumentFileImageToPdfWriteErrorCode = 'invalid_input' | 'encode_failed';

export interface DocumentFileImageToPdfWriteError {
  readonly code: DocumentFileImageToPdfWriteErrorCode;
  readonly message: string;
}
