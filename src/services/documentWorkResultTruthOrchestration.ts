/**
 * Document-scoped orchestration for TruthView (store read + resolve).
 * Keep UI free of overlay rules — only call this helper.
 */
import type { DocumentFieldFillConfirmRow } from '../types/documentFieldFillConfirm';
import type { InboxItem, WorkflowResult } from '../types/models';
import type { DocumentWorkTruthView } from '../types/documentWorkTruth';
import { mapFillConfirmRowsToSessionTruthOverlay } from './documentFieldFillConfirmTruthBridge';
import {
  getDocumentWorkResultForItem,
  isDocumentWorkResultUsableForDisplay,
} from './documentWorkResultService';
import { resolveDocumentWorkResult } from './documentWorkResultResolveService';

export function buildDocumentWorkTruthViewForInboxItem(input: {
  item: InboxItem;
  liveWorkflow?: WorkflowResult | null;
  /** Session Fill-Confirm rows — ephemeral overlay into the same TruthView. */
  sessionFillConfirmRows?: readonly DocumentFieldFillConfirmRow[] | null;
}): DocumentWorkTruthView | null {
  const { item, liveWorkflow, sessionFillConfirmRows } = input;
  if (liveWorkflow && liveWorkflow.inboxItemId !== item.id) {
    return null;
  }

  const stored = getDocumentWorkResultForItem(item.id);
  const usableStored =
    stored && isDocumentWorkResultUsableForDisplay(stored, item) ? stored : null;

  const bridge = mapFillConfirmRowsToSessionTruthOverlay(sessionFillConfirmRows);

  const liveBi = liveWorkflow?.businessInterpretation ?? null;
  if (liveBi) {
    return resolveDocumentWorkResult({
      documentWorkResult: usableStored,
      liveBusinessInterpretation: liveBi,
      inboxItemId: item.id,
      sessionOverlayEntries: bridge.sessionOverlayEntries,
      sessionConfirmedExtraFacts: bridge.sessionConfirmedExtraFacts,
    });
  }

  if (usableStored) {
    return resolveDocumentWorkResult({
      documentWorkResult: usableStored,
      liveBusinessInterpretation: null,
      inboxItemId: item.id,
      sessionOverlayEntries: bridge.sessionOverlayEntries,
      sessionConfirmedExtraFacts: bridge.sessionConfirmedExtraFacts,
    });
  }

  // No live BI and no stored DWR — still allow session-only truth when Fill-Confirm
  // has confirmed values: need a minimal BI shell is not available → null.
  // Session overlay alone cannot synthesize BI without a base.
  return null;
}
