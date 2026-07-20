import { PDFDict, PDFDocument, PDFName, PDFSignature } from 'pdf-lib';
import {
  PDF_INFO_METADATA_STRIP_KEYS,
  type DocumentFilePdfMetadataStripError,
  type DocumentFilePdfMetadataStripResult,
} from '../types/documentFilePdfMetadataStrip';

export interface StripDocumentFilePdfInfoMetadataInput {
  bytes: Uint8Array;
}

type PdfMetadataStripper = (
  input: StripDocumentFilePdfInfoMetadataInput,
) => Promise<DocumentFilePdfMetadataStripResult>;

let pdfMetadataStripperOverride: PdfMetadataStripper | null = null;

export function setPdfInfoMetadataStripForTests(stripper: PdfMetadataStripper | null): void {
  pdfMetadataStripperOverride = stripper;
}

function stripError(
  code: DocumentFilePdfMetadataStripError['code'],
  message: string,
): DocumentFilePdfMetadataStripError {
  return Object.freeze({ code, message });
}

function assertInput(
  input: StripDocumentFilePdfInfoMetadataInput,
): asserts input is StripDocumentFilePdfInfoMetadataInput & { bytes: Uint8Array } {
  if (input === null || typeof input !== 'object') {
    throw stripError('invalid_input', 'Invalid pdf metadata strip input.');
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw stripError('invalid_input', 'Invalid pdf metadata strip bytes.');
  }
}

function isEncryptedLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes('is encrypted') ||
    lower.includes('encrypted') ||
    lower.includes('password')
  );
}

function isCorruptLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes('invalid pdf') ||
    lower.includes('corrupt') ||
    lower.includes('failed to parse') ||
    lower.includes('unexpected') ||
    lower.includes('xref')
  );
}

/** ASCII search for digital-signature ByteRange markers without mutating bytes. */
function hasSignatureByteRangeMarker(bytes: Uint8Array): boolean {
  const needle = '/ByteRange';
  const n = needle.length;
  outer: for (let i = 0; i <= bytes.byteLength - n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

function lookupInfoDict(pdfDoc: PDFDocument): PDFDict | undefined {
  const infoRef = pdfDoc.context.trailerInfo.Info;
  if (!infoRef) return undefined;
  const info = pdfDoc.context.lookup(infoRef);
  return info instanceof PDFDict ? info : undefined;
}

/**
 * Detect AcroForm signature fields without creating a form when none exists
 * (getForm() would otherwise insert AcroForm).
 */
function hasAcroFormSignatureFields(pdfDoc: PDFDocument): boolean {
  if (!pdfDoc.catalog.getAcroForm()) return false;
  return pdfDoc.getForm().getFields().some((field) => field instanceof PDFSignature);
}

function clearInfoMetadataKeys(pdfDoc: PDFDocument): void {
  const info = lookupInfoDict(pdfDoc);
  if (!info) return;
  for (const key of PDF_INFO_METADATA_STRIP_KEYS) {
    info.delete(PDFName.of(key));
  }
}

/**
 * Clear classic PDF Info dictionary metadata in memory.
 * Loads with `updateMetadata: false`, leaves the caller's input bytes unchanged,
 * rejects encrypted / password-protected / corrupt / signed PDFs, and does not
 * flatten or rewrite forms. Does not remove XMP / Metadata streams.
 */
export async function stripDocumentFilePdfInfoMetadata(
  input: StripDocumentFilePdfInfoMetadataInput,
): Promise<DocumentFilePdfMetadataStripResult> {
  assertInput(input);

  if (pdfMetadataStripperOverride) {
    return pdfMetadataStripperOverride(input);
  }

  if (hasSignatureByteRangeMarker(input.bytes)) {
    throw stripError('signed', 'Signed PDFs cannot be metadata-stripped.');
  }

  let pdfDoc: PDFDocument;
  try {
    // Copy so pdf-lib parsing cannot mutate the caller's buffer.
    pdfDoc = await PDFDocument.load(input.bytes.slice(), {
      updateMetadata: false,
      ignoreEncryption: false,
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      throw error;
    }
    if (isEncryptedLoadError(error)) {
      throw stripError('encrypted', 'Encrypted or password-protected PDFs cannot be metadata-stripped.');
    }
    if (isCorruptLoadError(error)) {
      throw stripError('corrupt', 'Corrupt or unreadable PDFs cannot be metadata-stripped.');
    }
    throw stripError('corrupt', 'Corrupt or unreadable PDFs cannot be metadata-stripped.');
  }

  if (pdfDoc.isEncrypted) {
    throw stripError('encrypted', 'Encrypted or password-protected PDFs cannot be metadata-stripped.');
  }

  if (hasAcroFormSignatureFields(pdfDoc)) {
    throw stripError('signed', 'Signed PDFs cannot be metadata-stripped.');
  }

  try {
    clearInfoMetadataKeys(pdfDoc);
    const pageCount = pdfDoc.getPageCount();
    const bytes = await pdfDoc.save({ updateFieldAppearances: false });

    return Object.freeze({
      bytes,
      mimeType: 'application/pdf' as const,
      pageCount,
      clearedInfoKeys: PDF_INFO_METADATA_STRIP_KEYS,
      xmpFullyRemoved: false as const,
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      throw error;
    }
    throw stripError('strip_failed', 'PDF Info metadata could not be stripped.');
  }
}
