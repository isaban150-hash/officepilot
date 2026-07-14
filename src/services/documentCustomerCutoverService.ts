import {
  CUSTOMER_SCORING_CUTOVER,
  DI_CUSTOMER_SCORING_REASON_KEY,
  getCustomerCutoverKindThresholds,
  getCustomerScoringCutoverEnabled,
  hasCustomerCutoverAuthorityExclusion,
  hasCustomerCutoverCertificateExclusion,
  hasCustomerCutoverContractExclusion,
  hasCustomerCutoverInvoiceExclusion,
  hasCustomerCutoverKindTextGuard,
  hasCustomerCutoverPaymentExclusion,
  hasCustomerCutoverReceiptExclusion,
  isCustomerScoringCutoverKind,
} from '../config/documentIntelligenceConfig';
import { clampAnalysisConfidence } from '../types/documentAnalysis';
import type { DocumentCandidate } from '../types/documentAnalysis';
import type { ClassifiedDocumentKind } from '../types/models';
import { RECEIPT_CANDIDATE_PROFILES } from '../types/documentCandidateProfiles';
import type { ReceiptAnalysisPipelineResult } from './documentReceiptAnalysisPipelineService';

export type CustomerCutoverDetection = {
  kind: ClassifiedDocumentKind;
  reasonKey: string;
};

export type CustomerCutoverDecision = {
  eligible: boolean;
  detection?: CustomerCutoverDetection;
  rejectionReason?: string;
};

const CUSTOMER_CANDIDATES_TOO_CLOSE_MARGIN = 0.12;

function hasConflictType(
  pipeline: ReceiptAnalysisPipelineResult,
  type: 'footer_dominates_body' | 'candidates_too_close',
): boolean {
  return pipeline.scoringResult.conflicts.some((conflict) => conflict.type === type);
}

function hasCriticalConflict(pipeline: ReceiptAnalysisPipelineResult): boolean {
  return pipeline.scoringResult.conflicts.some((conflict) => conflict.severity === 'critical');
}

function getRankedCustomerCandidates(pipeline: ReceiptAnalysisPipelineResult): DocumentCandidate[] {
  const candidates = pipeline.scoringResult.candidates.filter(
    (candidate) =>
      isCustomerScoringCutoverKind(candidate.kind as ClassifiedDocumentKind) && candidate.score > 0,
  );

  if (hasCustomerCutoverKindTextGuard('auftragsbestaetigung', pipeline.recognizedText)) {
    return candidates.filter((candidate) => candidate.kind !== 'auftrag');
  }

  return candidates;
}

function computeCustomerMargin(
  winner: DocumentCandidate | undefined,
  runnerUp: DocumentCandidate | undefined,
): number {
  if (!winner || winner.score <= 0) {
    return 0;
  }
  if (!runnerUp) {
    return 1;
  }
  return clampAnalysisConfidence(
    (winner.score - runnerUp.score) / Math.max(winner.score, 0.01),
  );
}

function hasCustomerKindCandidatesTooClose(
  customerMargin: number,
  customerCandidates: DocumentCandidate[],
): boolean {
  return customerMargin < CUSTOMER_CANDIDATES_TOO_CLOSE_MARGIN && customerCandidates.length > 1;
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

export function computeCustomerCutoverConfidence(pipeline: ReceiptAnalysisPipelineResult): number {
  const winner = getRankedCustomerCandidates(pipeline)[0];
  if (!winner || winner.score <= 0) {
    return 0;
  }

  const requiredMax = computeRequiredFeatureMaxScore(winner.kind as ClassifiedDocumentKind);
  return clampAnalysisConfidence(winner.score / requiredMax);
}

export function evaluateCustomerCutoverEligibility(
  pipeline: ReceiptAnalysisPipelineResult | null,
): CustomerCutoverDecision {
  if (!getCustomerScoringCutoverEnabled()) {
    return { eligible: false, rejectionReason: 'cutover:disabled' };
  }

  if (!pipeline) {
    return { eligible: false, rejectionReason: 'cutover:no_text' };
  }

  if (!pipeline.valid) {
    return { eligible: false, rejectionReason: 'cutover:pipeline_invalid' };
  }

  if (hasCustomerCutoverPaymentExclusion(pipeline.recognizedText)) {
    return { eligible: false, rejectionReason: 'cutover:payment_excluded' };
  }

  if (hasCustomerCutoverInvoiceExclusion(pipeline.recognizedText)) {
    return { eligible: false, rejectionReason: 'cutover:invoice_excluded' };
  }

  if (hasCustomerCutoverContractExclusion(pipeline.recognizedText)) {
    return { eligible: false, rejectionReason: 'cutover:contract_excluded' };
  }

  if (hasCustomerCutoverCertificateExclusion(pipeline.recognizedText)) {
    return { eligible: false, rejectionReason: 'cutover:certificate_excluded' };
  }

  if (hasCustomerCutoverAuthorityExclusion(pipeline.recognizedText)) {
    return { eligible: false, rejectionReason: 'cutover:authority_excluded' };
  }

  if (hasCustomerCutoverReceiptExclusion(pipeline.recognizedText)) {
    return { eligible: false, rejectionReason: 'cutover:receipt_excluded' };
  }

  const { ocrQuality } = pipeline;
  const customerCandidates = getRankedCustomerCandidates(pipeline);
  const winner = customerCandidates[0];
  const runnerUp = customerCandidates[1];
  const winnerKind = winner?.kind as ClassifiedDocumentKind | undefined;
  const customerMargin = computeCustomerMargin(winner, runnerUp);
  const cutoverConfidence = computeCustomerCutoverConfidence(pipeline);
  const kindThresholds = winnerKind ? getCustomerCutoverKindThresholds(winnerKind) : undefined;

  if (!winnerKind || !kindThresholds) {
    return { eligible: false, rejectionReason: 'cutover:winner_not_allowed' };
  }

  if (!hasCustomerCutoverKindTextGuard(winnerKind, pipeline.recognizedText)) {
    return { eligible: false, rejectionReason: 'cutover:missing_kind_marker' };
  }

  if (!ocrQuality.readable) {
    return { eligible: false, rejectionReason: 'cutover:ocr_not_readable' };
  }

  if (ocrQuality.score < CUSTOMER_SCORING_CUTOVER.minOcrScore) {
    return { eligible: false, rejectionReason: 'cutover:ocr_score_too_low' };
  }

  if (cutoverConfidence < kindThresholds.minConfidence) {
    return { eligible: false, rejectionReason: 'cutover:confidence_too_low' };
  }

  if (customerMargin < kindThresholds.minMargin) {
    return { eligible: false, rejectionReason: 'cutover:margin_too_low' };
  }

  if (!winner || winner.score <= 0) {
    return { eligible: false, rejectionReason: 'cutover:winner_score_not_positive' };
  }

  if (hasCriticalConflict(pipeline)) {
    return { eligible: false, rejectionReason: 'cutover:critical_conflict' };
  }

  if (hasCustomerKindCandidatesTooClose(customerMargin, customerCandidates)) {
    return { eligible: false, rejectionReason: 'cutover:candidates_too_close' };
  }

  if (hasConflictType(pipeline, 'footer_dominates_body')) {
    return { eligible: false, rejectionReason: 'cutover:footer_dominates_body' };
  }

  if (winner.missingRequiredFeatures.length > 0) {
    return { eligible: false, rejectionReason: 'cutover:missing_required_features' };
  }

  const evidenceCount = winner.positiveEvidenceRefs.length + winner.structuralEvidenceRefs.length;
  if (evidenceCount < CUSTOMER_SCORING_CUTOVER.minEvidenceRefs) {
    return { eligible: false, rejectionReason: 'cutover:insufficient_evidence_refs' };
  }

  return {
    eligible: true,
    detection: {
      kind: winnerKind,
      reasonKey: DI_CUSTOMER_SCORING_REASON_KEY,
    },
  };
}
