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

/**
 * Light multi-page signal without JSON.parse of full `_pageTexts`.
 * Used to defer heavy contract/LV analysis until after first paint.
 */
export function itemNeedsDeferredWorkflowAnalysis(
  item: Pick<InboxItem, 'id' | 'recognizedData'>,
): boolean {
  const raw = item.recognizedData._pageTexts;
  if (!raw || typeof raw !== 'string') return false;

  const cacheKey = `${item.id}:${raw.length}`;
  const cached = deferredDecisionCache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Scan for page markers instead of parsing the whole OCR payload.
  let pageMarkers = 0;
  let from = 0;
  while (pageMarkers <= 2) {
    const next = raw.indexOf('"pageNumber"', from);
    if (next === -1) break;
    pageMarkers += 1;
    from = next + 12;
  }

  // Large OCR blobs are also deferred even with few markers.
  const needsDeferred = pageMarkers > 2 || raw.length >= 50_000;
  deferredDecisionCache.set(cacheKey, needsDeferred);
  return needsDeferred;
}
