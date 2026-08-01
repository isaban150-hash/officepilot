/**
 * TESTWORLD-04B — Vitest/happy-dom environment bridge for pdf.js.
 *
 * Product OCR still runs (extractTextFromPdfPages → getTextContent, quality,
 * OCR fallback decision, classification, intake). Only the pdf.js *entry*
 * is swapped to the Node-safe legacy build, because the modern worker URL
 * from pdfDocumentService fails under Vitest and maps to pdf_corrupt.
 *
 * Does not change OfficePilot OCR / Workflow / Summary / Matching / UI code.
 */
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import {
  setPdfDocumentLoaderForTests,
  setPdfPageRendererForTests,
} from '../services/pdfDocumentService';

const require = createRequire(import.meta.url);

export async function installGoldPdfJsVitestBridge(): Promise<() => void> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;

  setPdfDocumentLoaderForTests(async (bytes, password) => {
    if (!bytes || bytes.byteLength < 5) {
      throw new Error('goldPdfJsVitestBridge: empty PDF bytes');
    }
    const loadingTask = pdfjs.getDocument({
      data: bytes.slice(),
      password,
      useSystemFonts: true,
      verbosity: 0,
      // Happy-DOM Worker is unreliable; run pdf.js on the main thread.
      isEvalSupported: true,
      useWorkerFetch: false,
    });
    const pdf = await loadingTask.promise;
    return {
      pdf,
      pageCount: pdf.numPages,
    };
  });

  return () => {
    setPdfDocumentLoaderForTests(null);
    setPdfPageRendererForTests(null);
  };
}
