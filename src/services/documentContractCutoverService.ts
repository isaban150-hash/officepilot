import {

  CONTRACT_SCORING_CUTOVER,

  DI_CONTRACT_SCORING_REASON_KEY,

  getContractCutoverKindThresholds,

  getContractScoringCutoverEnabled,

  hasContractCutoverAuthorityExclusion,

  hasContractCutoverCertificateExclusion,

  hasContractCutoverInvoiceExclusion,

  hasContractCutoverKindTextGuard,

  hasContractCutoverPaymentExclusion,

  hasContractCutoverReceiptExclusion,

  isContractScoringCutoverKind,

} from '../config/documentIntelligenceConfig';

import { clampAnalysisConfidence } from '../types/documentAnalysis';

import type { DocumentCandidate } from '../types/documentAnalysis';

import type { ClassifiedDocumentKind } from '../types/models';

import { RECEIPT_CANDIDATE_PROFILES } from '../types/documentCandidateProfiles';

import type { ReceiptAnalysisPipelineResult } from './documentReceiptAnalysisPipelineService';



export type ContractCutoverDetection = {

  kind: ClassifiedDocumentKind;

  reasonKey: string;

};



export type ContractCutoverDecision = {

  eligible: boolean;

  detection?: ContractCutoverDetection;

  rejectionReason?: string;

};



const CONTRACT_CANDIDATES_TOO_CLOSE_MARGIN = 0.12;



function hasConflictType(

  pipeline: ReceiptAnalysisPipelineResult,

  type: 'footer_dominates_body' | 'candidates_too_close',

): boolean {

  return pipeline.scoringResult.conflicts.some((conflict) => conflict.type === type);

}



function hasCriticalConflict(pipeline: ReceiptAnalysisPipelineResult): boolean {

  return pipeline.scoringResult.conflicts.some((conflict) => conflict.severity === 'critical');

}



function getRankedContractCandidates(pipeline: ReceiptAnalysisPipelineResult): DocumentCandidate[] {

  return pipeline.scoringResult.candidates.filter(

    (candidate) =>
      isContractScoringCutoverKind(candidate.kind as ClassifiedDocumentKind) && candidate.score > 0,

  );

}



function computeContractMargin(

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



function hasContractKindCandidatesTooClose(

  contractMargin: number,

  contractCandidates: DocumentCandidate[],

): boolean {

  return contractMargin < CONTRACT_CANDIDATES_TOO_CLOSE_MARGIN && contractCandidates.length > 1;

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



export function computeContractCutoverConfidence(

  pipeline: ReceiptAnalysisPipelineResult,

): number {

  const winner = getRankedContractCandidates(pipeline)[0];

  if (!winner || winner.score <= 0) {

    return 0;

  }



  const requiredMax = computeRequiredFeatureMaxScore(winner.kind as ClassifiedDocumentKind);

  return clampAnalysisConfidence(winner.score / requiredMax);

}



export function evaluateContractCutoverEligibility(

  pipeline: ReceiptAnalysisPipelineResult | null,

): ContractCutoverDecision {

  if (!getContractScoringCutoverEnabled()) {

    return { eligible: false, rejectionReason: 'cutover:disabled' };

  }



  if (!pipeline) {

    return { eligible: false, rejectionReason: 'cutover:no_text' };

  }



  if (!pipeline.valid) {

    return { eligible: false, rejectionReason: 'cutover:pipeline_invalid' };

  }



  if (hasContractCutoverPaymentExclusion(pipeline.recognizedText)) {

    return { eligible: false, rejectionReason: 'cutover:payment_excluded' };

  }



  if (hasContractCutoverInvoiceExclusion(pipeline.recognizedText)) {

    return { eligible: false, rejectionReason: 'cutover:invoice_excluded' };

  }



  if (hasContractCutoverReceiptExclusion(pipeline.recognizedText)) {

    return { eligible: false, rejectionReason: 'cutover:receipt_excluded' };

  }



  if (hasContractCutoverCertificateExclusion(pipeline.recognizedText)) {

    return { eligible: false, rejectionReason: 'cutover:certificate_excluded' };

  }



  if (hasContractCutoverAuthorityExclusion(pipeline.recognizedText)) {

    return { eligible: false, rejectionReason: 'cutover:authority_excluded' };

  }



  const { ocrQuality } = pipeline;

  const contractCandidates = getRankedContractCandidates(pipeline);

  const winner = contractCandidates[0];

  const runnerUp = contractCandidates[1];

  const winnerKind = winner?.kind as ClassifiedDocumentKind | undefined;

  const contractMargin = computeContractMargin(winner, runnerUp);

  const cutoverConfidence = computeContractCutoverConfidence(pipeline);

  const kindThresholds = winnerKind ? getContractCutoverKindThresholds(winnerKind) : undefined;



  if (!winnerKind || !kindThresholds) {

    return { eligible: false, rejectionReason: 'cutover:winner_not_allowed' };

  }



  if (!hasContractCutoverKindTextGuard(winnerKind, pipeline.recognizedText)) {

    return { eligible: false, rejectionReason: 'cutover:missing_kind_marker' };

  }



  if (!ocrQuality.readable) {

    return { eligible: false, rejectionReason: 'cutover:ocr_not_readable' };

  }



  if (ocrQuality.score < CONTRACT_SCORING_CUTOVER.minOcrScore) {

    return { eligible: false, rejectionReason: 'cutover:ocr_score_too_low' };

  }



  if (cutoverConfidence < kindThresholds.minConfidence) {

    return { eligible: false, rejectionReason: 'cutover:confidence_too_low' };

  }



  if (contractMargin < kindThresholds.minMargin) {

    return { eligible: false, rejectionReason: 'cutover:margin_too_low' };

  }



  if (!winner || winner.score <= 0) {

    return { eligible: false, rejectionReason: 'cutover:winner_score_not_positive' };

  }



  if (hasCriticalConflict(pipeline)) {

    return { eligible: false, rejectionReason: 'cutover:critical_conflict' };

  }



  if (hasContractKindCandidatesTooClose(contractMargin, contractCandidates)) {

    return { eligible: false, rejectionReason: 'cutover:candidates_too_close' };

  }



  if (hasConflictType(pipeline, 'footer_dominates_body')) {

    return { eligible: false, rejectionReason: 'cutover:footer_dominates_body' };

  }



  if (winner.missingRequiredFeatures.length > 0) {

    return { eligible: false, rejectionReason: 'cutover:missing_required_features' };

  }



  const evidenceCount = winner.positiveEvidenceRefs.length + winner.structuralEvidenceRefs.length;

  if (evidenceCount < CONTRACT_SCORING_CUTOVER.minEvidenceRefs) {

    return { eligible: false, rejectionReason: 'cutover:insufficient_evidence_refs' };

  }



  return {

    eligible: true,

    detection: {

      kind: winnerKind,

      reasonKey: DI_CONTRACT_SCORING_REASON_KEY,

    },

  };

}


