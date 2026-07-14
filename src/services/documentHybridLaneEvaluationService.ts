import {
  hasCustomerCutoverKindTextGuard,
  isAuthorityScoringCutoverKind,
  isCertificateScoringCutoverKind,
  isContractScoringCutoverKind,
  isCustomerScoringCutoverKind,
  isInvoiceScoringCutoverKind,
  isPaymentScoringCutoverKind,
  isReceiptScoringCutoverKind,
} from '../config/documentIntelligenceConfig';
import { clampAnalysisConfidence } from '../types/documentAnalysis';
import type { DocumentCandidate } from '../types/documentAnalysis';
import type { DiCutoverLane, DiLaneShadowEvaluation } from '../types/documentShadowTypes';
import type { ClassifiedDocumentKind } from '../types/models';
import { RECEIPT_CANDIDATE_PROFILES } from '../types/documentCandidateProfiles';
import { evaluateAuthorityCutoverEligibility } from './documentAuthorityCutoverService';
import { evaluateCertificateCutoverEligibility } from './documentCertificateCutoverService';
import { evaluateContractCutoverEligibility } from './documentContractCutoverService';
import { evaluateCustomerCutoverEligibility } from './documentCustomerCutoverService';
import { evaluateInvoiceCutoverEligibility } from './documentInvoiceCutoverService';
import { evaluatePaymentCutoverEligibility } from './documentPaymentCutoverService';
import type { ReceiptAnalysisPipelineResult } from './documentReceiptAnalysisPipelineService';
import { evaluateReceiptCutoverEligibility } from './documentReceiptCutoverService';

type LaneEvaluator = (pipeline: ReceiptAnalysisPipelineResult | null) => {
  eligible: boolean;
  rejectionReason?: string;
};

const LANE_ORDER = [
  'receipt',
  'invoice',
  'payment',
  'authority',
  'certificate',
  'contract',
  'customer',
] as const satisfies readonly Exclude<DiCutoverLane, 'legacy'>[];

const LANE_EVALUATORS: Record<Exclude<DiCutoverLane, 'legacy'>, LaneEvaluator> = {
  receipt: evaluateReceiptCutoverEligibility,
  invoice: evaluateInvoiceCutoverEligibility,
  payment: evaluatePaymentCutoverEligibility,
  authority: evaluateAuthorityCutoverEligibility,
  certificate: evaluateCertificateCutoverEligibility,
  contract: evaluateContractCutoverEligibility,
  customer: evaluateCustomerCutoverEligibility,
};

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

function computeLaneMargin(
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

function computeLaneConfidence(winner: DocumentCandidate | undefined): number {
  if (!winner || winner.score <= 0) {
    return 0;
  }
  const requiredMax = computeRequiredFeatureMaxScore(winner.kind as ClassifiedDocumentKind);
  return clampAnalysisConfidence(winner.score / requiredMax);
}

function countEvidenceRefs(candidate: DocumentCandidate | undefined): number {
  if (!candidate) {
    return 0;
  }
  return candidate.positiveEvidenceRefs.length + candidate.structuralEvidenceRefs.length;
}

function getSortedCandidates(pipeline: ReceiptAnalysisPipelineResult): DocumentCandidate[] {
  return [...pipeline.scoringResult.candidates].sort((left, right) => right.score - left.score);
}

function isLaneAllowedKind(lane: Exclude<DiCutoverLane, 'legacy'>, kind: ClassifiedDocumentKind): boolean {
  switch (lane) {
    case 'receipt':
      return isReceiptScoringCutoverKind(kind);
    case 'invoice':
      return isInvoiceScoringCutoverKind(kind);
    case 'payment':
      return isPaymentScoringCutoverKind(kind);
    case 'authority':
      return isAuthorityScoringCutoverKind(kind);
    case 'certificate':
      return isCertificateScoringCutoverKind(kind);
    case 'contract':
      return isContractScoringCutoverKind(kind);
    case 'customer':
      return isCustomerScoringCutoverKind(kind);
    default:
      return false;
  }
}

function getLaneRankedCandidates(
  lane: Exclude<DiCutoverLane, 'legacy'>,
  pipeline: ReceiptAnalysisPipelineResult,
): DocumentCandidate[] {
  const candidates = getSortedCandidates(pipeline).filter(
    (candidate) =>
      isLaneAllowedKind(lane, candidate.kind as ClassifiedDocumentKind) && candidate.score > 0,
  );

  if (lane === 'customer' && hasCustomerCutoverKindTextGuard('auftragsbestaetigung', pipeline.recognizedText)) {
    return candidates.filter((candidate) => candidate.kind !== 'auftrag');
  }

  return candidates;
}

function buildLaneShadowEvaluation(
  lane: Exclude<DiCutoverLane, 'legacy'>,
  pipeline: ReceiptAnalysisPipelineResult | null,
): DiLaneShadowEvaluation {
  const decision = LANE_EVALUATORS[lane](pipeline);
  if (!pipeline?.valid) {
    return {
      lane,
      eligible: decision.eligible,
      rejectionReason: decision.rejectionReason,
    };
  }

  const rankedCandidates = getLaneRankedCandidates(lane, pipeline);
  const winner = rankedCandidates[0];
  const runnerUp = rankedCandidates[1];

  return {
    lane,
    eligible: decision.eligible,
    rejectionReason: decision.rejectionReason,
    winnerKind: winner?.kind as ClassifiedDocumentKind | undefined,
    laneMargin: computeLaneMargin(winner, runnerUp),
    laneConfidence: computeLaneConfidence(winner),
    evidenceRefCount: countEvidenceRefs(winner),
  };
}

export function buildHybridLaneEvaluations(
  pipeline: ReceiptAnalysisPipelineResult | null,
): DiLaneShadowEvaluation[] {
  return LANE_ORDER.map((lane) => buildLaneShadowEvaluation(lane, pipeline));
}

export function resolveCutoverLaneFromResolution(
  cutoverApplied: boolean,
  productiveReasonKey: string,
): DiCutoverLane {
  if (!cutoverApplied) {
    return 'legacy';
  }

  if (productiveReasonKey.includes('diReceiptScoring')) return 'receipt';
  if (productiveReasonKey.includes('diInvoiceScoring')) return 'invoice';
  if (productiveReasonKey.includes('diPaymentScoring')) return 'payment';
  if (productiveReasonKey.includes('diAuthorityScoring')) return 'authority';
  if (productiveReasonKey.includes('diCertificateScoring')) return 'certificate';
  if (productiveReasonKey.includes('diContractScoring')) return 'contract';
  if (productiveReasonKey.includes('diCustomerScoring')) return 'customer';
  return 'legacy';
}

const LANE_NEAR_MISS_EXCLUSIONS = new Set([
  'cutover:disabled',
  'cutover:no_text',
  'cutover:pipeline_invalid',
  'cutover:payment_excluded',
  'cutover:invoice_excluded',
  'cutover:contract_excluded',
  'cutover:certificate_excluded',
  'cutover:authority_excluded',
  'cutover:receipt_excluded',
  'cutover:mahnung_excluded',
]);

export function hasLaneNearMiss(laneEvaluations: DiLaneShadowEvaluation[]): boolean {
  return laneEvaluations.some((evaluation) => {
    if (evaluation.eligible || !evaluation.rejectionReason) {
      return false;
    }
    return !LANE_NEAR_MISS_EXCLUSIONS.has(evaluation.rejectionReason);
  });
}
