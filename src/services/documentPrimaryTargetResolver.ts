import type { DocumentCaseMatch, DocumentCaseMatchStatus } from '../types/documentCaseMatch';
import type { InboxItem, SuggestedVorgangLink, WorkflowActionId } from '../types/models';
import { buildDocumentCaseMatch } from './documentCaseMatchService';
import { getVorgangById } from './vorgangService';

export type PrimaryTargetWorkflowAction = Extract<
  WorkflowActionId,
  'link_vorgang' | 'select_vorgang' | 'create_vorgang'
>;

export type PrimaryTargetResolution = {
  caseMatch: DocumentCaseMatch;
  status: DocumentCaseMatchStatus;
  action: PrimaryTargetWorkflowAction;
  suggestedVorgang: SuggestedVorgangLink | null;
  hasUsableCaseMatch: boolean;
};

export function resolveWorkflowActionForCaseMatch(
  status: DocumentCaseMatchStatus,
): PrimaryTargetWorkflowAction {
  switch (status) {
    case 'exact':
      return 'link_vorgang';
    case 'likely':
      return 'select_vorgang';
    case 'multiple':
      return 'select_vorgang';
    case 'none':
    default:
      return 'create_vorgang';
  }
}

function resolveSuggestedFromExactCaseMatch(
  match: DocumentCaseMatch,
): SuggestedVorgangLink | null {
  if (match.matchStatus !== 'exact' || !match.matchedCaseId) return null;
  const vorgang = getVorgangById(match.matchedCaseId);
  if (!vorgang) return null;
  return {
    vorgangId: vorgang.id,
    vorgangTitle: vorgang.title,
    customer: vorgang.customer,
    confidence: 'high',
    reasonKey: 'classification.vorgang.reason.explicit',
  };
}

/**
 * Primary workflow target resolution from existing DocumentCaseMatch only.
 * No new matching logic, no side effects.
 */
export function resolvePrimaryTargetForInboxItem(
  item: InboxItem,
): PrimaryTargetResolution {
  const caseMatch = buildDocumentCaseMatch(item);
  const action = resolveWorkflowActionForCaseMatch(caseMatch.matchStatus);
  const suggestedFromExact = resolveSuggestedFromExactCaseMatch(caseMatch);
  const hasUsableCaseMatch = caseMatch.matchStatus !== 'none';
  return {
    caseMatch,
    status: caseMatch.matchStatus,
    action,
    suggestedVorgang: action === 'link_vorgang' ? suggestedFromExact : null,
    hasUsableCaseMatch,
  };
}