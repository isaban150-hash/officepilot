import { isLikelyPdfGarbageChunk } from './textQualityService';

type PdfTextExtractor = (bytes: Uint8Array) => string;

let pdfTextExtractorOverride: PdfTextExtractor | null = null;

export function setPdfTextExtractorForTests(extractor: PdfTextExtractor | null): void {
  pdfTextExtractorOverride = extractor;
}

function decodePdfLiteralValue(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

function collectLiteralMatches(decoded: string): string[] {
  const chunks: string[] = [];
  const parenRegex = /\(([^()\r\n\\]*(?:\\.[^()\r\n\\]*)*)\)/g;
  let match: RegExpExecArray | null;

  while ((match = parenRegex.exec(decoded)) !== null) {
    const text = decodePdfLiteralValue(match[1]).trim();
    if (text.length >= 2 && /[\p{L}\p{N}]/u.test(text) && !isLikelyPdfGarbageChunk(text)) {
      chunks.push(text);
    }
  }

  return chunks;
}

function collectAngleBracketText(decoded: string): string[] {
  const chunks: string[] = [];
  const angleRegex = /<([0-9A-Fa-f\s]+)>/g;
  let match: RegExpExecArray | null;

  while ((match = angleRegex.exec(decoded)) !== null) {
    const hex = match[1].replace(/\s/g, '');
    if (hex.length < 4 || hex.length % 2 !== 0) continue;

    const bytes: number[] = [];
    for (let index = 0; index < hex.length; index += 2) {
      bytes.push(parseInt(hex.slice(index, index + 2), 16));
    }

    const text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes)).trim();
    if (text.length >= 2 && /[\p{L}\p{N}]/u.test(text) && !isLikelyPdfGarbageChunk(text)) {
      chunks.push(text);
    }
  }

  return chunks;
}

export function extractTextFromPdfBytes(bytes: Uint8Array): string {
  if (pdfTextExtractorOverride) {
    return pdfTextExtractorOverride(bytes);
  }

  const decoded = new TextDecoder('latin1').decode(bytes);
  const chunks = [...collectLiteralMatches(decoded), ...collectAngleBracketText(decoded)];

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const key = chunk.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(chunk);
  }

  return unique.join('\n').trim();
}

export async function extractTextFromUploadFile(file: File): Promise<string> {
  const { extractDocumentText } = await import('./ocrDocumentService');
  const result = await extractDocumentText(file);
  return result.recognizedText;
}

export { decodePdfLiteralValue as decodePdfLiteral };
