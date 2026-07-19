import type { DocumentFileRasterEncodeJpegResult } from '../types/documentFileRasterEncode';
import {
  RASTER_ENCODE_JPEG_QUALITY,
  RASTER_ENCODE_MAX_EDGE_PX,
} from '../types/documentFileRasterEncode';
import { encodeDocumentFileDrawableSourceToJpeg } from './documentFileRasterEncodeService';
import {
  loadPdfDocument,
  releaseCanvas,
  renderPdfPageToCanvas,
} from './pdfDocumentService';

export interface EncodeDocumentFilePdfPageToJpegInput {
  bytes: Uint8Array;
  pageNumber: number;
  /** Optional JPEG quality (0..1). Defaults to archive RASTER_ENCODE_JPEG_QUALITY. */
  quality?: number;
  /** Optional longest output edge in pixels. Defaults to archive RASTER_ENCODE_MAX_EDGE_PX. */
  maxEdge?: number;
}

type PdfPageJpegEncoder = (
  input: EncodeDocumentFilePdfPageToJpegInput,
) => Promise<DocumentFileRasterEncodeJpegResult>;

let pdfPageJpegEncoderOverride: PdfPageJpegEncoder | null = null;

export function setPdfPageJpegEncodeForTests(encoder: PdfPageJpegEncoder | null): void {
  pdfPageJpegEncoderOverride = encoder;
}

function assertInput(
  input: EncodeDocumentFilePdfPageToJpegInput,
): asserts input is EncodeDocumentFilePdfPageToJpegInput & {
  bytes: Uint8Array;
  pageNumber: number;
} {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid pdf page jpeg encode input');
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw new TypeError('Invalid pdf page jpeg encode bytes');
  }
  if (
    typeof input.pageNumber !== 'number' ||
    !Number.isInteger(input.pageNumber) ||
    input.pageNumber < 1
  ) {
    throw new TypeError('Invalid pdf page jpeg encode pageNumber');
  }
  if (input.quality !== undefined) {
    if (typeof input.quality !== 'number' || !Number.isFinite(input.quality)) {
      throw new TypeError('Invalid pdf page jpeg encode quality');
    }
    if (input.quality <= 0 || input.quality > 1) {
      throw new TypeError('Invalid pdf page jpeg encode quality');
    }
  }
  if (input.maxEdge !== undefined) {
    if (typeof input.maxEdge !== 'number' || !Number.isFinite(input.maxEdge) || input.maxEdge < 1) {
      throw new TypeError('Invalid pdf page jpeg encode maxEdge');
    }
  }
}

/**
 * Load PDF bytes, render one page to canvas, scale, and JPEG-encode in memory.
 * Releases the render canvas and destroys the PDF document. Does not persist or bind.
 */
export async function encodeDocumentFilePdfPageToJpeg(
  input: EncodeDocumentFilePdfPageToJpegInput,
): Promise<DocumentFileRasterEncodeJpegResult> {
  assertInput(input);

  if (pdfPageJpegEncoderOverride) {
    return pdfPageJpegEncoderOverride(input);
  }

  const { pdf } = await loadPdfDocument(input.bytes.slice());
  let canvas: HTMLCanvasElement | null = null;

  try {
    const rendered = await renderPdfPageToCanvas(pdf, input.pageNumber);
    canvas = rendered.canvas;

    return await encodeDocumentFileDrawableSourceToJpeg({
      source: canvas,
      quality: input.quality ?? RASTER_ENCODE_JPEG_QUALITY,
      maxEdge: input.maxEdge ?? RASTER_ENCODE_MAX_EDGE_PX,
    });
  } finally {
    if (canvas) {
      releaseCanvas(canvas);
    }
    await pdf.destroy();
  }
}
