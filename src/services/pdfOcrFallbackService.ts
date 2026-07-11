export interface PdfOcrResult {
  text: string;
  confidence: number;
}

type PdfOcrExtractor = (file: File, pageCount?: number) => Promise<PdfOcrResult>;

let pdfOcrExtractorOverride: PdfOcrExtractor | null = null;

export function setPdfOcrExtractorForTests(extractor: PdfOcrExtractor | null): void {
  pdfOcrExtractorOverride = extractor;
}

export async function extractPdfTextViaOcr(file: File, pageCount?: number): Promise<PdfOcrResult> {
  if (pdfOcrExtractorOverride) {
    return pdfOcrExtractorOverride(file, pageCount);
  }

  return { text: '', confidence: 0 };
}
