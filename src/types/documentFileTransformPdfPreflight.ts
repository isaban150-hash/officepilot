import type { PdfDocumentErrorCode } from '../services/pdfDocumentService';

/**
 * Load-related PDF error codes that may appear as preflight Result data.
 * Rendering-only codes (render_failed, too_large) are not preflight outcomes.
 */
export type DocumentFileTransformPdfPreflightLoadErrorCode = Extract<
  PdfDocumentErrorCode,
  'password_required' | 'pdf_corrupt'
>;

/**
 * PDF-specific source preflight result.
 * Success: actual PDF page count. Failure: existing load-related PDF error code.
 */
export type DocumentFileTransformPdfPreflightResult =
  | {
      readonly ok: true;
      readonly pageCount: number;
    }
  | {
      readonly ok: false;
      readonly errorCode: DocumentFileTransformPdfPreflightLoadErrorCode;
    };
