import type {
  DocumentFileTransformPdfPreflightLoadErrorCode,
  DocumentFileTransformPdfPreflightResult,
} from '../types/documentFileTransformPdfPreflight';
import { getPdfPageCount, type PdfDocumentError } from './pdfDocumentService';

const PDF_PREFLIGHT_LOAD_ERROR_CODES = new Set<DocumentFileTransformPdfPreflightLoadErrorCode>([
  'password_required',
  'pdf_corrupt',
]);

function isPdfDocumentError(error: unknown): error is PdfDocumentError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as PdfDocumentError).code === 'string'
  );
}

function isPdfPreflightLoadErrorCode(
  code: string,
): code is DocumentFileTransformPdfPreflightLoadErrorCode {
  return PDF_PREFLIGHT_LOAD_ERROR_CODES.has(code as DocumentFileTransformPdfPreflightLoadErrorCode);
}

/**
 * Inspects PDF bytes via the existing getPdfPageCount path (load + destroy).
 * No OCR, rendering, canvas, capability checks, or persistence.
 */
export async function preflightDocumentFileTransformPdf(
  bytes: Uint8Array,
): Promise<DocumentFileTransformPdfPreflightResult> {
  try {
    const pageCount = await getPdfPageCount(bytes);
    return { ok: true, pageCount };
  } catch (error) {
    if (isPdfDocumentError(error) && isPdfPreflightLoadErrorCode(error.code)) {
      return { ok: false, errorCode: error.code };
    }
    throw error;
  }
}
