/**
 * Document-scoped orchestration for TruthView (store read + resolve).
 * Keep UI free of overlay rules — only call this helper.
 */
import type { InboxItem, WorkflowResult } from '../types/models';
import type { DocumentWorkTruthView } from '../types/documentWorkTruth';
import {
  getDocumentWorkResultForItem,
  isDocumentWorkResultUsableForDisplay,
} from './documentWorkResultService';
import { resolveDocumentWorkResult } from './documentWorkResultResolveService';

export function buildDocumentWorkTruthViewForInboxItem(input: {
  item: InboxItem;
  liveWorkflow?: WorkflowResult | null;
}): DocumentWorkTruthView | null {
  const { item, liveWorkflow } = input;
  if (liveWorkflow && liveWorkflow.inboxItemId !== item.id) {
    return null;
  }

  const stored = getDocumentWorkResultForItem(item.id);
  const usableStored =
    stored && isDocumentWorkResultUsableForDisplay(stored, item) ? stored : null;

  const liveBi = liveWorkflow?.businessInterpretation ?? null;
  if (liveBi) {
    return resolveDocumentWorkResult({
      documentWorkResult: usableStored,
      liveBusinessInterpretation: liveBi,
      inboxItemId: item.id,
    });
  }

  if (usableStored) {
    return resolveDocumentWorkResult({
      documentWorkResult: usableStored,
      liveBusinessInterpretation: null,
      inboxItemId: item.id,
    });
  }

  return null;
}
