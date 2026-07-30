import type { CompanyRelevanceInput, ContractAnalysisInput } from '../types/models';
import type { StorageRecommendation } from '../types/storageRecommendation';
import type { UserStorageDecision } from '../types/userStorageDecision';
import { isPersistingUserStorageDecision } from '../types/userStorageDecision';
import { checkCompanyRelevance } from './companyRelevanceService';
import { analyzeContract } from './contractAnalysisService';
import { analyzeContractIntelligenceFromText } from './contractIntelligenceService';
import { getDocumentById } from './documentService';
import type { CreateInboxFromUploadOptions } from './inboxUploadFactory';
import type { DocumentIntakeResult } from './documentIntakeService';
import {
  confirmPendingDocumentIntake,
  discardPendingDocumentIntake,
  type PendingDocumentIntake,
} from './pendingDocumentIntakeService';
import {
  resolveAvailableUserStorageDecisions,
  resolvePrimarySuggestedUserStorageDecision,
  validateUserStorageDecision,
} from './userStorageDecisionService';
import {
  applyOcrFastPathPrimaryLabels,
  buildStorageDecisionActionSpecs,
  isOcrStorageFastPathLevel,
} from './userStorageDecisionPresentationService';
import type { StorageDecisionActionSpec } from './userStorageDecisionPresentationService';

export type ExecutePendingDocumentDecisionResult =
  | { outcome: 'discarded' }
  | {
      outcome: 'navigate_existing';
      match: NonNullable<StorageRecommendation['duplicateMatch']>;
    }
  | DocumentIntakeResult;

export async function executePendingDocumentDecision(
  pending: PendingDocumentIntake,
  decision: UserStorageDecision,
  intakeOptions: CreateInboxFromUploadOptions & { saveTraceId?: string } = {},
): Promise<ExecutePendingDocumentDecisionResult> {
  const validation = validateUserStorageDecision({
    decision,
    recommendation: pending.storageRecommendation,
    storagePolicy: pending.storagePolicy,
  });

  if (!validation.valid) {
    return { success: false, error: 'navigation_failed' };
  }

  if (decision === 'discard') {
    discardPendingDocumentIntake(pending);
    return { outcome: 'discarded' };
  }

  if (decision === 'use_existing') {
    const match = pending.storageRecommendation.duplicateMatch;
    // Only a resolvable, active CompanyDocument may complete this path.
    if (!match || match.type !== 'document') {
      return { success: false, error: 'existing_document_missing' };
    }
    const document = getDocumentById(match.id);
    if (!document) {
      return { success: false, error: 'existing_document_missing' };
    }
    discardPendingDocumentIntake(pending);
    return {
      outcome: 'navigate_existing',
      match: {
        type: 'document',
        id: document.id,
        title: document.title,
      },
    };
  }

  if (!isPersistingUserStorageDecision(decision)) {
    return { success: false, error: 'navigation_failed' };
  }

  return confirmPendingDocumentIntake(pending, {
    ...intakeOptions,
    userDecision: decision,
    saveTraceId: intakeOptions.saveTraceId,
  });
}

export function isPendingDocumentDecisionResultIntake(
  result: ExecutePendingDocumentDecisionResult,
): result is DocumentIntakeResult {
  return !('outcome' in result);
}

export function isDiscardedPendingDocumentDecision(
  result: ExecutePendingDocumentDecisionResult,
): result is { outcome: 'discarded' } {
  return 'outcome' in result && result.outcome === 'discarded';
}

export function isNavigateExistingPendingDocumentDecision(
  result: ExecutePendingDocumentDecisionResult,
): result is {
  outcome: 'navigate_existing';
  match: NonNullable<StorageRecommendation['duplicateMatch']>;
} {
  return 'outcome' in result && result.outcome === 'navigate_existing';
}

function buildCompanyRelevanceInputFromPending(
  pending: PendingDocumentIntake,
): CompanyRelevanceInput {
  const classification = pending.previewClassification;
  const dataValues = Object.entries(classification.recognizedData ?? {})
    .filter(([key]) => !key.startsWith('_'))
    .map(([, value]) => value);

  const text = [
    classification.title,
    classification.sender,
    classification.officePilotSuggestion,
    classification.recognizedData?._vertragstext ?? '',
    pending.extraction.recognizedText,
    ...dataValues,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    text,
    recognizedData: classification.recognizedData,
    sender: classification.sender,
    title: classification.title,
    vorgangId: classification.suggestedVorgang?.vorgangId,
    vorgangTitle: classification.suggestedVorgang?.vorgangTitle,
  };
}

function buildContractAnalysisInputFromPending(
  pending: PendingDocumentIntake,
): ContractAnalysisInput {
  return {
    recognizedText: pending.extraction.recognizedText,
    sourceFileName: pending.cachedFile.fileName,
    titleHint: pending.previewClassification.title,
    senderHint: pending.previewClassification.sender,
    kindHint: pending.previewClassification.classifiedKind,
    recognizedData: pending.previewClassification.recognizedData,
  };
}

/**
 * OCR Fast Path presentation may only surface when the storage level is clear
 * and existing Smart-Intake safety gates would not still require attention.
 * Reuses companyRelevance + contract/LV analysis — no parallel rules.
 */
export function isOcrStorageFastPathAllowedForPending(
  pending: PendingDocumentIntake,
): boolean {
  const level = pending.storageRecommendation.level;
  if (!isOcrStorageFastPathLevel(level)) {
    return false;
  }

  // duplicate / discard Fast Path stays level-based (ads are often not companyRelevant).
  if (level !== 'archive_required' && level !== 'archive_recommended') {
    return true;
  }

  // Same relevance gate Smart Intake uses before analysis/apply.
  if (!checkCompanyRelevance(buildCompanyRelevanceInputFromPending(pending)).isRelevant) {
    return false;
  }

  // Same contract detector that feeds Smart Intake contract handling.
  if (analyzeContract(buildContractAnalysisInputFromPending(pending)).isContract) {
    return false;
  }

  // Same LV/positions signal that creates ContractOrderProposal (confirm UI).
  const intelligence = analyzeContractIntelligenceFromText(
    pending.extraction.recognizedText,
    pending.extraction.pageTexts,
  );
  if (intelligence && intelligence.positions.length > 0) {
    return false;
  }

  return true;
}

export function buildPendingDocumentDecisionActions(
  pending: PendingDocumentIntake,
): StorageDecisionActionSpec[] {
  const available = resolveAvailableUserStorageDecisions(
    pending.storageRecommendation,
    pending.storagePolicy,
  );
  const primary = resolvePrimarySuggestedUserStorageDecision(pending.storageRecommendation);
  const actions = buildStorageDecisionActionSpecs(available, primary);
  if (!isOcrStorageFastPathAllowedForPending(pending)) {
    return actions;
  }
  return applyOcrFastPathPrimaryLabels(actions, pending.storageRecommendation.level);
}
