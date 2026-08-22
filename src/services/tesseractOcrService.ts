import {
  DOCUMENT_LAYOUT_MAX_SERIALIZED_BYTES,
  DOCUMENT_LAYOUT_MAX_TOKENS_PER_PAGE,
  DOCUMENT_LAYOUT_VERSION,
  type DocumentLayoutPage,
  type DocumentLayoutToken,
} from '../types/documentLayout';

type OcrRecognizer = (input: File | HTMLCanvasElement) => Promise<{ text: string; confidence: number }>;

/**
 * SCAN-OCR-EVIDENCE-01B — image recognition may additionally return layout.
 * Only the converted, plain model leaves this module.
 */
export interface OcrImageResult {
  text: string;
  confidence: number;
  layout?: DocumentLayoutPage;
}

type OcrImageRecognizer = (
  input: File | HTMLCanvasElement,
) => Promise<OcrImageResult>;

let ocrRecognizerOverride: OcrRecognizer | null = null;
let ocrImageRecognizerOverride: OcrImageRecognizer | null = null;

export function setOcrRecognizerForTests(recognizer: OcrRecognizer | null): void {
  ocrRecognizerOverride = recognizer;
}

/** Test seam for the layout-aware image path. */
export function setOcrImageRecognizerForTests(recognizer: OcrImageRecognizer | null): void {
  ocrImageRecognizerOverride = recognizer;
}

type RawBbox = { x0: number; y0: number; x1: number; y1: number };
type RawWord = { text?: string; confidence?: number; bbox?: RawBbox };
type RawLine = { words?: RawWord[] };
type RawParagraph = { lines?: RawLine[] };
type RawBlock = { paragraphs?: RawParagraph[]; bbox?: RawBbox };

/**
 * Converts Tesseract blocks into the plain layout model.
 *
 * Page size comes from the recognised image itself (naturalWidth/height or the
 * canvas), never from the largest token: UI overlay text or a partial scan would
 * otherwise distort every coordinate.
 */
export function buildLayoutPageFromBlocks(
  blocks: unknown,
  pageSize: { width: number; height: number },
  pageNumber = 1,
): DocumentLayoutPage | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const width = pageSize.width > 0 ? pageSize.width : 0;
  const height = pageSize.height > 0 ? pageSize.height : 0;
  if (!width || !height) return undefined;

  const tokens: DocumentLayoutToken[] = [];
  let truncated = false;
  let blockIndex = 0;

  for (const rawBlock of blocks as RawBlock[]) {
    const blockId = `b${blockIndex}`;
    blockIndex += 1;
    let lineIndex = 0;
    for (const paragraph of rawBlock?.paragraphs ?? []) {
      for (const line of paragraph?.lines ?? []) {
        const lineId = `${blockId}-l${lineIndex}`;
        lineIndex += 1;
        for (const word of line?.words ?? []) {
          const text = (word?.text ?? '').trim();
          const bbox = word?.bbox;
          if (!text || !bbox) continue;
          if (tokens.length >= DOCUMENT_LAYOUT_MAX_TOKENS_PER_PAGE) {
            truncated = true;
            break;
          }
          tokens.push({
            id: `p${pageNumber}-t${tokens.length}`,
            text,
            x0: bbox.x0 / width,
            y0: bbox.y0 / height,
            x1: bbox.x1 / width,
            y1: bbox.y1 / height,
            confidence: typeof word.confidence === 'number' ? word.confidence : 0,
            blockId,
            lineId,
          });
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  if (tokens.length === 0) return undefined;
  return enforceSerializedLimit({
    version: DOCUMENT_LAYOUT_VERSION,
    pageNumber,
    width,
    height,
    truncated,
    tokens,
  });
}

function serializedBytes(page: DocumentLayoutPage): number {
  // UTF-8 byte length, not character count.
  return new TextEncoder().encode(JSON.stringify(page)).length;
}

/**
 * Keeps the stored layout under the byte cap. Document order is preserved — a
 * confidence based cut would destroy the spatial sequence the resolver needs.
 * Binary search instead of repeated trimming.
 */
export function enforceSerializedLimit(page: DocumentLayoutPage): DocumentLayoutPage {
  if (serializedBytes(page) <= DOCUMENT_LAYOUT_MAX_SERIALIZED_BYTES) return page;

  let low = 0;
  let high = page.tokens.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate: DocumentLayoutPage = {
      ...page,
      truncated: true,
      tokens: page.tokens.slice(0, mid),
    };
    if (serializedBytes(candidate) <= DOCUMENT_LAYOUT_MAX_SERIALIZED_BYTES) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return { ...page, truncated: true, tokens: page.tokens.slice(0, best) };
}

async function resolvePageSize(
  input: File | HTMLCanvasElement,
): Promise<{ width: number; height: number } | null> {
  if (typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) {
    return { width: input.width, height: input.height };
  }
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(input as File);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return size;
  } catch {
    return null;
  }
}

/** One Tesseract worker for the whole run — used by the PDF OCR page loop. */
export async function withSharedOcrWorker<T>(
  run: (recognize: OcrRecognizer) => Promise<T>,
): Promise<T> {
  if (ocrRecognizerOverride) {
    return run(ocrRecognizerOverride);
  }

  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('deu', 1, {
    logger: () => {},
  });

  try {
    const recognize: OcrRecognizer = async (input) => {
      const { data } = await worker.recognize(input);
      return {
        text: data.text ?? '',
        confidence: data.confidence ?? 0,
      };
    };
    return await run(recognize);
  } finally {
    await worker.terminate();
  }
}

/**
 * Image OCR — the only path that requests blocks. Tesseract's default output is
 * `{ text: true }`, so layout has to be asked for explicitly. The PDF paths keep
 * their text-only calls untouched.
 */
export async function recognizeImageOrCanvas(
  input: File | HTMLCanvasElement,
): Promise<OcrImageResult> {
  if (ocrImageRecognizerOverride) {
    return ocrImageRecognizerOverride(input);
  }
  if (ocrRecognizerOverride) {
    return ocrRecognizerOverride(input);
  }

  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('deu', 1, {
    logger: () => {},
  });

  try {
    const pageSize = await resolvePageSize(input);
    const { data } = await worker.recognize(input, {}, { text: true, blocks: true });
    // Convert immediately: raw blocks carry cyclic page references.
    const layout = pageSize
      ? buildLayoutPageFromBlocks(data.blocks, pageSize)
      : undefined;
    return {
      text: data.text ?? '',
      confidence: data.confidence ?? 0,
      layout,
    };
  } finally {
    await worker.terminate();
  }
}

export async function recognizeMultipleCanvases(
  canvases: HTMLCanvasElement[],
): Promise<{ text: string; confidence: number }> {
  if (canvases.length === 0) {
    return { text: '', confidence: 0 };
  }

  if (ocrRecognizerOverride) {
    const parts: string[] = [];
    let totalConfidence = 0;
    for (const canvas of canvases) {
      const result = await ocrRecognizerOverride(canvas);
      if (result.text.trim()) parts.push(result.text.trim());
      totalConfidence += result.confidence;
    }
    return {
      text: parts.join('\n\n').trim(),
      confidence: parts.length > 0 ? totalConfidence / canvases.length : 0,
    };
  }

  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('deu', 1, {
    logger: () => {},
  });

  try {
    const parts: string[] = [];
    let totalConfidence = 0;
    let recognizedPages = 0;

    for (const canvas of canvases) {
      const { data } = await worker.recognize(canvas);
      const text = data.text?.trim() ?? '';
      if (text) {
        parts.push(text);
        totalConfidence += data.confidence ?? 0;
        recognizedPages += 1;
      }
    }

    return {
      text: parts.join('\n\n').trim(),
      confidence: recognizedPages > 0 ? totalConfidence / recognizedPages : 0,
    };
  } finally {
    await worker.terminate();
  }
}
