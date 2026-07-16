import type { InboxItem } from '../types/models';

/**
 * Key for heavy workflow/contract analysis on the detail page.
 * Intentionally ignores vorgangId/status so confirm/import does not
 * clear the review UI or re-run BOQ analysis.
 */
export function buildInboxWorkflowAnalysisKey(
  item: Pick<
    InboxItem,
    'id' | 'importedToArchive' | 'markedAsCompanyDocument' | 'recognizedData'
  > | null | undefined,
): string {
  if (!item) return '';
  return [
    item.id,
    item.importedToArchive ? '1' : '0',
    item.markedAsCompanyDocument ? '1' : '0',
    String(item.recognizedData._pageTexts?.length ?? 0),
    String(item.recognizedData._extractedText?.length ?? 0),
  ].join('|');
}

const deferredDecisionCache = new Map<string, boolean>();

/** Clears parse/heuristic cache — tests only. */
export function resetDeferredWorkflowAnalysisCacheForTests(): void {
  deferredDecisionCache.clear();
}

const LARGE_TEXT_THRESHOLD = 50_000;

/**
 * Light multi-page / large-OCR signal without JSON.parse of full `_pageTexts`.
 * Used to defer heavy contract/LV analysis until after first paint.
 */
export function itemNeedsDeferredWorkflowAnalysis(
  item: Pick<InboxItem, 'id' | 'recognizedData'>,
): boolean {
  const raw = item.recognizedData._pageTexts;
  const extracted = item.recognizedData._extractedText;
  const pageLen = typeof raw === 'string' ? raw.length : 0;
  const extractedLen = typeof extracted === 'string' ? extracted.length : 0;

  const cacheKey = `${item.id}:${pageLen}:${extractedLen}`;
  const cached = deferredDecisionCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let needsDeferred = extractedLen >= LARGE_TEXT_THRESHOLD;

  if (!needsDeferred && typeof raw === 'string' && raw.length > 0) {
    // Scan for page markers instead of parsing the whole OCR payload.
    let pageMarkers = 0;
    let from = 0;
    while (pageMarkers <= 2) {
      const next = raw.indexOf('"pageNumber"', from);
      if (next === -1) break;
      pageMarkers += 1;
      from = next + 12;
    }
    needsDeferred = pageMarkers > 2 || raw.length >= LARGE_TEXT_THRESHOLD;
  }

  deferredDecisionCache.set(cacheKey, needsDeferred);
  return needsDeferred;
}
