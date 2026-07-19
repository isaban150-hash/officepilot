import { PDFDocument } from 'pdf-lib';
import {
  IMAGE_TO_PDF_PAGE_HEIGHT_PT,
  IMAGE_TO_PDF_PAGE_WIDTH_PT,
  IMAGE_TO_PDF_SOURCE_MIME_TYPES,
  type DocumentFileImageToPdfWriteError,
  type DocumentFileImageToPdfWriteResult,
  type ImageToPdfSourceMimeType,
} from '../types/documentFileImageToPdfWrite';

export interface EncodeDocumentFileImageToPdfInput {
  bytes: Uint8Array;
  sourceMimeType: string;
}

export interface ImageToPdfDrawDimensions {
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
}

function imageToPdfWriteError(
  code: DocumentFileImageToPdfWriteError['code'],
  message: string,
): DocumentFileImageToPdfWriteError {
  return Object.freeze({ code, message });
}

function isImageToPdfSourceMimeType(value: unknown): value is ImageToPdfSourceMimeType {
  return (
    typeof value === 'string' &&
    (IMAGE_TO_PDF_SOURCE_MIME_TYPES as readonly string[]).includes(value.trim().toLowerCase())
  );
}

function normalizeSourceMimeType(sourceMimeType: string): ImageToPdfSourceMimeType {
  return sourceMimeType.trim().toLowerCase() as ImageToPdfSourceMimeType;
}

/**
 * Fit image into the page box without upscaling or distorting aspect ratio.
 * Centers the result on the page.
 */
export function computeImageToPdfDrawDimensions(
  imageWidth: number,
  imageHeight: number,
  pageWidth: number = IMAGE_TO_PDF_PAGE_WIDTH_PT,
  pageHeight: number = IMAGE_TO_PDF_PAGE_HEIGHT_PT,
): ImageToPdfDrawDimensions {
  if (
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    !Number.isFinite(pageWidth) ||
    !Number.isFinite(pageHeight) ||
    imageWidth < 1 ||
    imageHeight < 1 ||
    pageWidth < 1 ||
    pageHeight < 1
  ) {
    throw new TypeError('Invalid image to pdf draw dimensions');
  }

  const scale = Math.min(pageWidth / imageWidth, pageHeight / imageHeight, 1);
  const width = imageWidth * scale;
  const height = imageHeight * scale;

  return Object.freeze({
    width,
    height,
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
  });
}

function assertInput(
  input: EncodeDocumentFileImageToPdfInput,
): asserts input is EncodeDocumentFileImageToPdfInput & {
  bytes: Uint8Array;
  sourceMimeType: ImageToPdfSourceMimeType;
} {
  if (input === null || typeof input !== 'object') {
    throw imageToPdfWriteError('invalid_input', 'Invalid image to pdf write input.');
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw imageToPdfWriteError('invalid_input', 'Invalid image to pdf write bytes.');
  }
  if (!isImageToPdfSourceMimeType(input.sourceMimeType)) {
    throw imageToPdfWriteError(
      'invalid_input',
      'Image to pdf write accepts only image/jpeg or image/png.',
    );
  }
}

/**
 * Embed a JPEG or PNG as a single-page PDF in memory.
 * Fits the image into the documented A4 page without distortion or upscaling.
 * Does not copy image metadata into PDF info; does not persist or bind FileRefs.
 */
export async function encodeDocumentFileImageToPdf(
  input: EncodeDocumentFileImageToPdfInput,
): Promise<DocumentFileImageToPdfWriteResult> {
  assertInput(input);

  const sourceMimeType = normalizeSourceMimeType(input.sourceMimeType);
  // Copy so embedders never observe a live alias of caller-owned bytes.
  const imageBytes = input.bytes.slice();

  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.create();
  } catch {
    throw imageToPdfWriteError('encode_failed', 'PDF document could not be created.');
  }

  // Do not set title/author/subject/keywords — no metadata carry-over.
  let embedded;
  try {
    embedded =
      sourceMimeType === 'image/jpeg'
        ? await pdfDoc.embedJpg(imageBytes)
        : await pdfDoc.embedPng(imageBytes);
  } catch {
    throw imageToPdfWriteError(
      'encode_failed',
      'Raster image could not be embedded into a PDF page.',
    );
  }

  if (
    !Number.isFinite(embedded.width) ||
    !Number.isFinite(embedded.height) ||
    embedded.width < 1 ||
    embedded.height < 1
  ) {
    throw imageToPdfWriteError('encode_failed', 'Embedded image has invalid dimensions.');
  }

  const pageWidth = IMAGE_TO_PDF_PAGE_WIDTH_PT;
  const pageHeight = IMAGE_TO_PDF_PAGE_HEIGHT_PT;
  const draw = computeImageToPdfDrawDimensions(
    embedded.width,
    embedded.height,
    pageWidth,
    pageHeight,
  );

  const page = pdfDoc.addPage([pageWidth, pageHeight]);
  page.drawImage(embedded, {
    x: draw.x,
    y: draw.y,
    width: draw.width,
    height: draw.height,
  });

  let saved: Uint8Array;
  try {
    saved = await pdfDoc.save();
  } catch {
    throw imageToPdfWriteError('encode_failed', 'PDF document could not be serialized.');
  }

  if (!(saved instanceof Uint8Array) || saved.byteLength === 0) {
    throw imageToPdfWriteError('encode_failed', 'PDF encode produced empty output.');
  }

  return Object.freeze({
    bytes: saved,
    mimeType: 'application/pdf',
    pageCount: 1 as const,
    pageWidth,
    pageHeight,
    imageWidth: draw.width,
    imageHeight: draw.height,
  });
}
