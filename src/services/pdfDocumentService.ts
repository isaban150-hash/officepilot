import type { PDFDocumentProxy } from 'pdfjs-dist';

export type PdfDocumentErrorCode =
  | 'password_required'
  | 'pdf_corrupt'
  | 'render_failed'
  | 'too_large';

export interface PdfDocumentLoadResult {
  pdf: PDFDocumentProxy;
  pageCount: number;
}

export interface PdfPageRenderResult {
  canvas: HTMLCanvasElement;
  scale: number;
}

export interface PdfDocumentError {
  code: PdfDocumentErrorCode;
  message: string;
}

type PdfLoader = (bytes: Uint8Array, password?: string) => Promise<PdfDocumentLoadResult>;
type PdfPageRenderer = (
  pdf: PDFDocumentProxy,
  pageNumber: number,
) => Promise<PdfPageRenderResult>;

let pdfLoaderOverride: PdfLoader | null = null;
let pdfPageRendererOverride: PdfPageRenderer | null = null;
let workerConfigured = false;

export const PDF_OCR_MAX_PAGES = 12;
export const PDF_RENDER_MAX_WIDTH = 1800;
export const PDF_RENDER_MIN_SCALE = 1;
export const PDF_RENDER_MAX_SCALE = 2;

export function setPdfDocumentLoaderForTests(loader: PdfLoader | null): void {
  pdfLoaderOverride = loader;
}

export function setPdfPageRendererForTests(renderer: PdfPageRenderer | null): void {
  pdfPageRendererOverride = renderer;
}

async function configurePdfWorker(): Promise<void> {
  if (workerConfigured || typeof window === 'undefined') return;

  const pdfjs = await import('pdfjs-dist');
  const workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  workerConfigured = true;
}

function mapPdfJsError(error: unknown): PdfDocumentError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('password') || lower.includes('encrypted')) {
    return {
      code: 'password_required',
      message: 'Die PDF ist passwortgeschützt. Bitte laden Sie eine ungeschützte Version hoch.',
    };
  }

  if (
    lower.includes('invalid pdf') ||
    lower.includes('corrupt') ||
    lower.includes('missing pdf') ||
    lower.includes('format error')
  ) {
    return {
      code: 'pdf_corrupt',
      message: 'Die PDF konnte nicht gelesen werden. Bitte prüfen Sie die Datei.',
    };
  }

  return {
    code: 'pdf_corrupt',
    message: 'Die PDF konnte nicht gelesen werden. Bitte prüfen Sie die Datei.',
  };
}

export async function loadPdfDocument(
  bytes: Uint8Array,
  password?: string,
): Promise<PdfDocumentLoadResult> {
  if (pdfLoaderOverride) {
    return pdfLoaderOverride(bytes, password);
  }

  await configurePdfWorker();
  const { getDocument } = await import('pdfjs-dist');

  try {
    const loadingTask = getDocument({
      data: bytes.slice(),
      password,
      useSystemFonts: true,
      verbosity: 0,
    });
    const pdf = await loadingTask.promise;
    return {
      pdf,
      pageCount: pdf.numPages,
    };
  } catch (error) {
    throw mapPdfJsError(error);
  }
}

export async function getPdfPageCount(bytes: Uint8Array): Promise<number> {
  const { pdf, pageCount } = await loadPdfDocument(bytes);
  await pdf.destroy();
  return pageCount;
}

function resolveRenderScale(pageWidth: number): number {
  if (pageWidth <= 0) return PDF_RENDER_MIN_SCALE;
  const fitScale = PDF_RENDER_MAX_WIDTH / pageWidth;
  return Math.max(PDF_RENDER_MIN_SCALE, Math.min(PDF_RENDER_MAX_SCALE, fitScale));
}

export async function renderPdfPageToCanvas(
  pdf: PDFDocumentProxy,
  pageNumber: number,
): Promise<PdfPageRenderResult> {
  if (pdfPageRendererOverride) {
    return pdfPageRendererOverride(pdf, pageNumber);
  }

  if (pageNumber < 1 || pageNumber > pdf.numPages) {
    throw {
      code: 'render_failed' as const,
      message: 'PDF-Seite konnte nicht gerendert werden.',
    } satisfies PdfDocumentError;
  }

  const page = await pdf.getPage(pageNumber);
  const viewportAtOne = page.getViewport({ scale: 1 });
  const scale = resolveRenderScale(viewportAtOne.width);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) {
    releaseCanvas(canvas);
    await page.cleanup();
    throw {
      code: 'render_failed' as const,
      message: 'PDF-Seite konnte nicht gerendert werden.',
    } satisfies PdfDocumentError;
  }

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  try {
    await page.render({
      canvasContext: context,
      viewport,
    }).promise;
  } catch {
    releaseCanvas(canvas);
    throw {
      code: 'render_failed' as const,
      message: 'PDF-Seite konnte nicht gerendert werden.',
    } satisfies PdfDocumentError;
  } finally {
    await page.cleanup();
  }

  return { canvas, scale };
}

export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}

export function resolveOcrPageLimit(pageCount: number, maxPages = PDF_OCR_MAX_PAGES): number {
  return Math.max(1, Math.min(pageCount, maxPages));
}

export interface PdfPageTextEntry {
  pageNumber: number;
  text: string;
  items?: Array<{ str?: string }>;
}

export interface PdfPageTextExtraction {
  text: string;
  pageTexts: PdfPageTextEntry[];
  pageCount: number;
}

function textItemsToPageText(items: Array<{ str?: string }>): string {
  const parts: string[] = [];
  for (const item of items) {
    if (typeof item.str === 'string' && item.str.trim()) {
      parts.push(item.str);
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export async function extractTextFromPdfPages(
  bytes: Uint8Array,
  maxPages = PDF_OCR_MAX_PAGES,
): Promise<PdfPageTextExtraction> {
  const { pdf, pageCount } = await loadPdfDocument(bytes);
  const pageLimit = resolveOcrPageLimit(pageCount, maxPages);
  const pageTexts: PdfPageTextEntry[] = [];
  const mergedParts: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const textContent = await page.getTextContent();
        const pageText = textItemsToPageText(textContent.items as Array<{ str?: string }>);
        pageTexts.push({
          pageNumber,
          text: pageText,
          items: textContent.items as Array<{ str?: string }>,
        });
        if (pageText) {
          mergedParts.push(pageText);
        }
      } finally {
        await page.cleanup();
      }
    }
  } finally {
    await pdf.destroy();
  }

  return {
    text: mergedParts.join('\n').trim(),
    pageTexts,
    pageCount,
  };
}
