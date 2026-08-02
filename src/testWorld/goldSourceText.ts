/**
 * TestWorld gold harness — extract text layer from gold source.pdf.
 * Same textual basis as 04B PDF intake, without running OCR product code.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

function resolveTestWorldRoot(cwd: string = process.cwd()): string {
  return join(cwd, 'test-world');
}

/**
 * Read the embedded text layer of documents/{id}/source.pdf.
 * Returns '' when the PDF is missing (caller keeps thin-RD behaviour).
 */
export async function extractGoldSourcePdfText(
  documentId: string,
  testWorldRoot: string = resolveTestWorldRoot(),
): Promise<string> {
  const pdfPath = join(testWorldRoot, 'documents', documentId, 'source.pdf');
  if (!existsSync(pdfPath)) return '';

  const bytes = new Uint8Array(readFileSync(pdfPath));
  if (bytes.byteLength < 5) return '';

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: bytes.slice(),
    useSystemFonts: true,
    verbosity: 0,
    isEvalSupported: true,
    useWorkerFetch: false,
  });
  const pdf = await loadingTask.promise;
  try {
    const pages: string[] = [];
    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
      const page = await pdf.getPage(pageIndex);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .filter((part) => part.trim().length > 0)
        .join(' ');
      if (line.trim()) pages.push(line.trim());
    }
    return pages.join('\n').trim();
  } finally {
    await pdf.destroy();
  }
}
