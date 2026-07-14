import {
  DI_RECEIPT_SCORING_REASON_KEY,
  getReceiptCutoverKindThresholds,
  getReceiptScoringCutoverEnabled,
  hasReceiptCutoverInvoiceExclusion,
  hasReceiptCutoverKindTextGuard,
  hasReceiptCutoverPaymentExclusion,
  isReceiptScoringCutoverKind,
  RECEIPT_SCORING_CUTOVER,
} from '../config/documentIntelligenceConfig';
import { clampAnalysisConfidence } from '../types/documentAnalysis';
import type { ClassifiedDocumentKind } from '../types/models';
import { RECEIPT_CANDIDATE_PROFILES } from '../types/documentCandidateProfiles';
import type { ReceiptAnalysisPipelineResult } from './documentReceiptAnalysisPipelineService';

export type ReceiptCutoverDetection = {
  kind: ClassifiedDocumentKind;
  reasonKey: string;
};

export type ReceiptCutoverDecision = {
  eligible: boolean;
  detection?: ReceiptCutoverDetection;
  rejectionReason?: string;
};

function hasConflictType(
  pipeline: ReceiptAnalysisPipelineResult,
  type: 'footer_dominates_body' | 'candidates_too_close',
): boolean {
  return pipeline.scoringResult.conflicts.some((conflict) => conflict.type === type);
}

function hasCriticalConflict(pipeline: ReceiptAnalysisPipelineResult): boolean {
  return pipeline.scoringResult.conflicts.some((conflict) => conflict.severity === 'critical');
}

function computeRequiredFeatureMaxScore(kind: ClassifiedDocumentKind): number {
  const profile = RECEIPT_CANDIDATE_PROFILES.find((entry) => entry.kind === kind);
  if (!profile) {
    return 0.01;
  }

  const requiredRules = [...profile.structural, ...profile.positive].filter((rule) => rule.required);
  return Math.max(
    requiredRules.reduce((sum, rule) => sum + rule.weight * 1.5 * 0.7, 0),
    0.01,
  );
}

export function computeReceiptCutoverConfidence(pipeline: ReceiptAnalysisPipelineResult): number {
  const winner = pipeline.scoringResult.candidates[0];
  if (!winner || winner.score <= 0) {
    return 0;
  }

  const requiredMax = computeRequiredFeatureMaxScore(winner.kind as ClassifiedDocumentKind);
  return clampAnalysisConfidence(winner.score / requiredMax);
}

export function evaluateReceiptCutoverEligibility(
  pipeline: ReceiptAnalysisPipelineResult | null,
): ReceiptCutoverDecision {
  if (!getReceiptScoringCutoverEnabled()) {
    return { eligible: false, rejectionReason: 'cutover:disabled' };
  }

  if (!pipeline) {
    return { eligible: false, rejectionReason: 'cutover:no_text' };
  }

  if (!pipeline.valid) {
    return { eligible: false, rejectionReason: 'cutover:pipeline_invalid' };
  }

  if (hasReceiptCutoverPaymentExclusion(pipeline.recognizedText)) {
    return { eligible: false, rejectionReason: 'cutover:payment_excluded' };
  }

  if (hasReceiptCutoverInvoiceExclusion(pipeline.recognizedText)) {
    return { eligible: false, rejectionReason: 'cutover:invoice_excluded' };
  }

  const { scoringResult, ocrQuality } = pipeline;
  const winner = scoringResult.candidates[0];
  const winnerKind = scoringResult.winnerKind as ClassifiedDocumentKind;
  const cutoverConfidence = computeReceiptCutoverConfidence(pipeline);
  const kindThresholds = getReceiptCutoverKindThresholds(winnerKind);

  if (!isReceiptScoringCutoverKind(winnerKind) || !kindThresholds) {
    return { eligible: false, rejectionReason: 'cutover:winner_not_allowed' };
  }

  if (!hasReceiptCutoverKindTextGuard(winnerKind, pipeline.recognizedText)) {
    return { eligible: false, rejectionReason: 'cutover:missing_kind_marker' };
  }

  if (!ocrQuality.readable) {
    return { eligible: false, rejectionReason: 'cutover:ocr_not_readable' };
  }

  if (ocrQuality.score < RECEIPT_SCORING_CUTOVER.minOcrScore) {
    return { eligible: false, rejectionReason: 'cutover:ocr_score_too_low' };
  }

  if (cutoverConfidence < kindThresholds.minConfidence) {
    return { eligible: false, rejectionReason: 'cutover:confidence_too_low' };
  }

  if (scoringResult.margin < kindThresholds.minMargin) {
    return { eligible: false, rejectionReason: 'cutover:margin_too_low' };
  }

  if (!winner || winner.score <= 0) {
    return { eligible: false, rejectionReason: 'cutover:winner_score_not_positive' };
  }

  if (hasCriticalConflict(pipeline)) {
    return { eligible: false, rejectionReason: 'cutover:critical_conflict' };
  }

  if (hasConflictType(pipeline, 'candidates_too_close')) {
    return { eligible: false, rejectionReason: 'cutover:candidates_too_close' };
  }

  if (hasConflictType(pipeline, 'footer_dominates_body')) {
    return { eligible: false, rejectionReason: 'cutover:footer_dominates_body' };
  }

  if (winner.missingRequiredFeatures.length > 0) {
    return { eligible: false, rejectionReason: 'cutover:missing_required_features' };
  }

  const evidenceCount = winner.positiveEvidenceRefs.length + winner.structuralEvidenceRefs.length;
  if (evidenceCount < RECEIPT_SCORING_CUTOVER.minEvidenceRefs) {
    return { eligible: false, rejectionReason: 'cutover:insufficient_evidence_refs' };
  }

  return {
    eligible: true,
    detection: {
      kind: winnerKind,
      reasonKey: DI_RECEIPT_SCORING_REASON_KEY,
    },
  };
}
