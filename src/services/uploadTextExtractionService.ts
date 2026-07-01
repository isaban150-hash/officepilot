type PdfTextExtractor = (bytes: Uint8Array) => string;

let pdfTextExtractorOverride: PdfTextExtractor | null = null;

export function setPdfTextExtractorForTests(extractor: PdfTextExtractor | null): void {
  pdfTextExtractorOverride = extractor;
}

function decodePdfLiteral(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

export function extractTextFromPdfBytes(bytes: Uint8Array): string {
  if (pdfTextExtractorOverride) {
    return pdfTextExtractorOverride(bytes);
  }

  const decoded = new TextDecoder('latin1').decode(bytes);
  const chunks: string[] = [];
  const parenRegex = /\(([^()\r\n\\]*(?:\\.[^()\r\n\\]*)*)\)/g;
  let match: RegExpExecArray | null;

  while ((match = parenRegex.exec(decoded)) !== null) {
    const text = decodePdfLiteral(match[1]).trim();
    if (text.length >= 2 && /[\p{L}\p{N}]/u.test(text)) {
      chunks.push(text);
    }
  }

  return chunks.join('\n').trim();
}

export async function extractTextFromUploadFile(file: File): Promise<string> {
  const lowerName = file.name.toLowerCase();
  const isPdf = file.type === 'application/pdf' || lowerName.endsWith('.pdf');
  if (!isPdf) {
    return '';
  }

  const buffer = await file.arrayBuffer();
  return extractTextFromPdfBytes(new Uint8Array(buffer));
}
