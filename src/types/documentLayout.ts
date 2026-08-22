/**
 * SCAN-OCR-EVIDENCE-01B — small, engine independent layout model.
 *
 * Raw Tesseract objects must never travel through the app or into storage:
 * `Block.page` points back at the page (cyclic), and symbols/choices multiply
 * the volume. Everything is converted right after recognition into these plain,
 * serialisable records with normalised coordinates.
 */

export const DOCUMENT_LAYOUT_VERSION = 1;

/** Hard caps — a photo of a dense page must never blow up a draft record. */
export const DOCUMENT_LAYOUT_MAX_TOKENS_PER_PAGE = 3000;
export const DOCUMENT_LAYOUT_MAX_SERIALIZED_BYTES = 1024 * 1024;

export interface DocumentLayoutToken {
  /** Stable within the page: `p<page>-t<index>`. */
  id: string;
  text: string;
  /** Normalised to the page box, 0…1. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** OCR confidence 0…100. */
  confidence: number;
  blockId: string;
  lineId: string;
}

export interface DocumentLayoutPage {
  version: number;
  pageNumber: number;
  /** Source pixel size the coordinates were normalised against. */
  width: number;
  height: number;
  /** True when tokens were dropped: never derive "missing" from such a page. */
  truncated: boolean;
  tokens: DocumentLayoutToken[];
}

export function isDocumentLayoutPage(value: unknown): value is DocumentLayoutPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as Partial<DocumentLayoutPage>;
  return (
    typeof page.version === 'number' &&
    typeof page.pageNumber === 'number' &&
    typeof page.width === 'number' &&
    typeof page.height === 'number' &&
    Array.isArray(page.tokens)
  );
}

/** Vertical centre — used to rebuild visual lines regardless of OCR order. */
export function tokenCenterY(token: DocumentLayoutToken): number {
  return (token.y0 + token.y1) / 2;
}

export function tokenHeight(token: DocumentLayoutToken): number {
  return Math.max(0, token.y1 - token.y0);
}
