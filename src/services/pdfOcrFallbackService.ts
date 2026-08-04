import type { TextQualityReport } from './textQualityService';
import { assessTextQuality, sanitizeExtractedText } from './textQualityService';
import {
  loadPdfDocument,
  releaseCanvas,
  renderPdfPageToCanvas,
  resolveOcrPageLimit,
  type PdfDocumentError,
} from './pdfDocumentService';
import { buildPageMarker } from './documentSegmentationService';
import { withSharedOcrWorker } from './tesseractOcrService';

export interface PdfOcrResult {
  text: string;
  confidence: number;
  pagesProcessed: number;
  pageCount?: number;
  pageTexts?: Array<{ pageNumber: number; text: string }>;
  errorCode?: PdfDocumentError['code'];
  message?: string;
}

export interface PdfOcrOptions {
  pageCount?: number;
  maxPages?: number;
  directTextQuality?: TextQualityReport;
  onProgress?: (processed: number, total: number) => void;
}

type PdfOcrExtractor = (file: File, options?: PdfOcrOptions) => Promise<PdfOcrResult>;

let pdfOcrExtractorOverride: PdfOcrExtractor | null = null;

export function setPdfOcrExtractorForTests(extractor: PdfOcrExtractor | null): void {
  pdfOcrExtractorOverride = extractor;
}

function normalizeOptions(pageCountOrOptions?: number | PdfOcrOptions): PdfOcrOptions {
  if (typeof pageCountOrOptions === 'number') {
    return { pageCount: pageCountOrOptions };
  }
  return pageCountOrOptions ?? {};
}

export function shouldRunPdfOcr(directQuality: TextQualityReport): boolean {
  if (!directQuality.sanitizedText.trim()) return true;
  if (!directQuality.readable) return true;
  return directQuality.score < 55;
}

async function ocrPdfPages(bytes: Uint8Array, options: PdfOcrOptions): Promise<PdfOcrResult> {
  try {
    const loaded = await loadPdfDocument(bytes);
    const pdf = loaded.pdf;
    const pageLimit = resolveOcrPageLimit(loaded.pageCount, options.maxPages);
    const pageTexts: Array<{ pageNumber: number; text: string }> = [];
    const textParts: string[] = [];
    let totalConfidence = 0;
    let recognizedPages = 0;

    try {
      return await withSharedOcrWorker(async (recognize) => {
        for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
          options.onProgress?.(pageNumber - 1, pageLimit);
          const rendered = await renderPdfPageToCanvas(pdf, pageNumber);
          const ocr = await recognize(rendered.canvas);
          releaseCanvas(rendered.canvas);
          const sanitized = ocr.text.trim();
          pageTexts.push({ pageNumber, text: sanitized });
          if (sanitized) {
            textParts.push(`${buildPageMarker(pageNumber)}${sanitized}`);
            totalConfidence += ocr.confidence;
            recognizedPages += 1;
          }
        }

        options.onProgress?.(pageLimit, pageLimit);
        const mergedText = textParts.join('');
        const quality = assessTextQuality(mergedText);

        return {
          text: quality.sanitizedText || sanitizeExtractedText(mergedText),
          confidence: recognizedPages > 0 ? totalConfidence / recognizedPages : 0,
          pagesProcessed: pageTexts.length,
          pageCount: loaded.pageCount,
          pageTexts,
        };
      });
    } finally {
      await pdf.destroy();
    }
  } catch (error) {
    const mapped = error as PdfDocumentError;
    if (mapped?.code && mapped?.message) {
      return {
        text: '',
        confidence: 0,
        pagesProcessed: 0,
        pageCount: options.pageCount,
        errorCode: mapped.code,
        message: mapped.message,
      };
    }

    return {
      text: '',
      confidence: 0,
      pagesProcessed: 0,
      pageCount: options.pageCount,
      errorCode: 'render_failed',
      message: 'Die PDF konnte nicht per OCR gelesen werden.',
    };
  }
}

export async function extractPdfTextViaOcr(
  file: File,
  pageCountOrOptions?: number | PdfOcrOptions,
): Promise<PdfOcrResult> {
  const options = normalizeOptions(pageCountOrOptions);

  if (pdfOcrExtractorOverride) {
    return pdfOcrExtractorOverride(file, options);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  return ocrPdfPages(bytes, options);
}
