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
