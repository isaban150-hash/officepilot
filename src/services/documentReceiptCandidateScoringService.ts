import type { ClassifiedDocumentKind } from '../types/models';
import type {
  DocumentConflict,
  DocumentConflictType,
  DocumentCandidate,
  ReviewStatus,
} from '../types/documentAnalysis';
import { clampAnalysisConfidence } from '../types/documentAnalysis';
import type {
  DocumentFeatureCategory,
  DocumentFeatureStrength,
  ExtractedDocumentFeature,
} from '../types/documentFeatures';
import type { DocumentZone } from '../types/documentAnalysis';
import {
  RECEIPT_CANDIDATE_PROFILES,
  type CandidateFeatureRule,
  type ReceiptCandidateProfile,
} from '../types/documentCandidateProfiles';

const STRENGTH_MULTIPLIER: Record<DocumentFeatureStrength, number> = {
  strong: 1.5,
  medium: 1,
  weak: 0.4,
};

const STRENGTH_RANK: Record<DocumentFeatureStrength, number> = {
  weak: 1,
  medium: 2,
  strong: 3,
};

const RECEIPT_KINDS = new Set<ClassifiedDocumentKind>([
  'tankbeleg',
  'kassenbeleg',
  'ec_beleg',
  'kreditkartenbeleg',
  'quittung',
]);

const MARGIN_AUTO_ACCEPT = 0.2;
const MARGIN_NEEDS_REVIEW = 0.12;
const CONFIDENCE_AUTO_ACCEPT = 0.75;
const CONFIDENCE_NEEDS_REVIEW = 0.55;

export type ReceiptScoringResult = {
  candidates: DocumentCandidate[];
  winnerKind: ClassifiedDocumentKind | 'unknown';
  margin: number;
  confidence: number;
  needsReview: boolean;
  reviewStatus: ReviewStatus;
  conflicts: DocumentConflict[];
  warnings: string[];
};

export function zoneMultiplier(
  zone: DocumentZone,
  category: DocumentFeatureCategory,
): number {
  if (zone === 'unknown' || zone === 'table') {
    return 0;
  }

  if (category === 'register') {
    if (zone === 'footer') return 0.25;
    if (zone === 'body') return 0.5;
    return 0.4;
  }

  if (zone === 'body') return 1;
  if (zone === 'header') return 0.7;
  return 0.4;
}

function meetsMinStrength(
  strength: DocumentFeatureStrength,
  minStrength?: DocumentFeatureStrength,
): boolean {
  if (!minStrength) {
    return true;
  }
  return STRENGTH_RANK[strength] >= STRENGTH_RANK[minStrength];
}

function matchesRule(
  feature: ExtractedDocumentFeature,
  rule: CandidateFeatureRule,
): boolean {
  if (feature.id !== rule.featureId) {
    return false;
  }
  if (rule.zones && !rule.zones.includes(feature.zone)) {
    return false;
  }
  if (!meetsMinStrength(feature.strength, rule.minStrength)) {
    return false;
  }
  return true;
}

function featureContribution(feature: ExtractedDocumentFeature, ruleWeight: number): number {
  return (
    ruleWeight *
    zoneMultiplier(feature.zone, feature.category) *
    STRENGTH_MULTIPLIER[feature.strength] *
    feature.confidence
  );
}

function estimateProfileMaxScore(profile: ReceiptCandidateProfile): number {
  const rules = [...profile.positive, ...profile.structural];
  if (rules.length === 0) {
    return 0.01;
  }
  return rules.reduce((sum, rule) => sum + rule.weight * 1.5 * 1, 0);
}

function scoreProfile(
  profile: ReceiptCandidateProfile,
  features: ExtractedDocumentFeature[],
): {
  score: number;
  confidence: number;
  positiveEvidenceRefs: string[];
  negativeEvidenceRefs: string[];
  structuralEvidenceRefs: string[];
  missingRequiredFeatures: string[];
} {
  let positiveScore = 0;
  let negativeScore = 0;
  let structuralScore = 0;
  const positiveEvidenceRefs: string[] = [];
  const negativeEvidenceRefs: string[] = [];
  const structuralEvidenceRefs: string[] = [];
  const missingRequiredFeatures: string[] = [];

  const applyRules = (
    rules: CandidateFeatureRule[],
    bucket: 'positive' | 'negative' | 'structural',
  ) => {
    for (const rule of rules) {
      const matched = features.filter((feature) => matchesRule(feature, rule));
      if (rule.required && matched.length === 0) {
        missingRequiredFeatures.push(rule.featureId);
      }
      for (const feature of matched) {
        const contribution = featureContribution(feature, rule.weight);
        if (bucket === 'negative') {
          negativeScore += contribution;
          negativeEvidenceRefs.push(...feature.evidenceRefs);
        } else if (bucket === 'structural') {
          structuralScore += contribution;
          structuralEvidenceRefs.push(...feature.evidenceRefs);
        } else {
          positiveScore += contribution;
          positiveEvidenceRefs.push(...feature.evidenceRefs);
        }
      }
    }
  };

  applyRules(profile.structural, 'structural');
  applyRules(profile.positive, 'positive');
  applyRules(profile.negative, 'negative');

  const rawScore = Math.max(0, positiveScore + structuralScore - negativeScore);
  const requiredPenalty = missingRequiredFeatures.length > 0 ? 0.55 : 1;
  const score = rawScore * requiredPenalty;
  const maxScore = estimateProfileMaxScore(profile);
  const confidence = clampAnalysisConfidence(score / Math.max(maxScore, 0.01));

  return {
    score,
    confidence,
    positiveEvidenceRefs: [...new Set(positiveEvidenceRefs)],
    negativeEvidenceRefs: [...new Set(negativeEvidenceRefs)],
    structuralEvidenceRefs: [...new Set(structuralEvidenceRefs)],
    missingRequiredFeatures,
  };
}

function sumFeatureContributions(
  features: ExtractedDocumentFeature[],
  predicate: (feature: ExtractedDocumentFeature) => boolean,
): number {
  return features
    .filter(predicate)
    .reduce(
      (sum, feature) =>
        sum +
        zoneMultiplier(feature.zone, feature.category) *
          STRENGTH_MULTIPLIER[feature.strength] *
          feature.confidence,
      0,
    );
}

function detectFooterDominatesBody(
  features: ExtractedDocumentFeature[],
): DocumentConflict | undefined {
  const footerRegisterScore = sumFeatureContributions(
    features,
    (feature) => feature.category === 'register' && feature.zone === 'footer',
  );
  const bodyReceiptScore = sumFeatureContributions(
    features,
    (feature) =>
      feature.zone === 'body' &&
      (feature.id === 'structure.receipt_layout' ||
        feature.id === 'amount.monetary_value' ||
        feature.id === 'payment.card_payment' ||
        feature.id === 'structure.fuel_marker'),
  );

  const hasReceiptLayout = features.some((feature) => feature.id === 'structure.receipt_layout');
  if (!hasReceiptLayout || footerRegisterScore <= bodyReceiptScore) {
    return undefined;
  }

  const evidenceRefs = features
    .filter(
      (feature) =>
        (feature.category === 'register' && feature.zone === 'footer') ||
        (feature.zone === 'body' &&
          (feature.id === 'structure.receipt_layout' || feature.id === 'amount.monetary_value')),
    )
    .flatMap((feature) => feature.evidenceRefs);

  return {
    type: 'footer_dominates_body',
    severity: footerRegisterScore > bodyReceiptScore * 1.5 ? 'warning' : 'info',
    evidenceRefs: [...new Set(evidenceRefs)],
  };
}

function deriveReview(
  margin: number,
  confidence: number,
  conflicts: DocumentConflict[],
): { needsReview: boolean; reviewStatus: ReviewStatus } {
  const hasCriticalConflict = conflicts.some((conflict) => conflict.severity === 'critical');
  const tooClose = margin < MARGIN_NEEDS_REVIEW;
  const lowConfidence = confidence < CONFIDENCE_NEEDS_REVIEW;

  if (hasCriticalConflict || tooClose || lowConfidence) {
    return { needsReview: true, reviewStatus: 'needs_review' };
  }

  if (margin >= MARGIN_AUTO_ACCEPT && confidence >= CONFIDENCE_AUTO_ACCEPT) {
    return { needsReview: false, reviewStatus: 'auto_accepted' };
  }

  return { needsReview: true, reviewStatus: 'needs_review' };
}

export function scoreReceiptCandidates(
  features: ExtractedDocumentFeature[],
): ReceiptScoringResult {
  const warnings: string[] = [];
  const conflicts: DocumentConflict[] = [];

  const scored = RECEIPT_CANDIDATE_PROFILES.map((profile) => {
    const result = scoreProfile(profile, features);
    const candidateConflicts: DocumentConflictType[] = [];
    if (result.missingRequiredFeatures.length > 0) {
      candidateConflicts.push('insufficient_evidence');
    }

    return {
      profile,
      ...result,
      candidateConflicts,
    };
  });

  const ranked = [...scored].sort((left, right) => right.score - left.score);
  const winner = ranked[0];
  const runnerUp = ranked[1];

  let margin = 1;
  if (winner && runnerUp && winner.score > 0) {
    margin = clampAnalysisConfidence((winner.score - runnerUp.score) / Math.max(winner.score, 0.01));
  } else if (!winner || winner.score <= 0) {
    margin = 0;
  }

  const footerConflict = detectFooterDominatesBody(features);
  if (footerConflict) {
    conflicts.push(footerConflict);
  }

  if (margin < MARGIN_NEEDS_REVIEW && ranked.filter((entry) => entry.score > 0).length > 1) {
    conflicts.push({
      type: 'candidates_too_close',
      severity: 'warning',
      evidenceRefs: ranked
        .slice(0, 2)
        .flatMap((entry) => [
          ...entry.positiveEvidenceRefs,
          ...entry.structuralEvidenceRefs,
        ])
        .slice(0, 6),
    });
  }

  const winnerKind = winner?.profile.kind ?? 'sonstiges';
  const winnerConfidence = winner?.confidence ?? 0;
  const review = deriveReview(margin, winnerConfidence, conflicts);

  if (winnerKind !== 'sonstiges' && RECEIPT_KINDS.has(winnerKind) && footerConflict) {
    warnings.push('shadow:footer_register_present_on_receipt');
  }

  const candidates: DocumentCandidate[] = ranked.map((entry) => ({
    kind: entry.profile.kind,
    family: entry.profile.family,
    score: entry.score,
    confidence: entry.confidence,
    positiveEvidenceRefs: entry.positiveEvidenceRefs,
    negativeEvidenceRefs: entry.negativeEvidenceRefs,
    structuralEvidenceRefs: entry.structuralEvidenceRefs,
    missingRequiredFeatures: entry.missingRequiredFeatures,
    conflicts: entry.candidateConflicts,
  }));

  if (winner && winner.score <= 0) {
    warnings.push('shadow:no_positive_receipt_evidence');
  }

  return {
    candidates,
    winnerKind,
    margin,
    confidence: winnerConfidence,
    needsReview: review.needsReview,
    reviewStatus: review.reviewStatus,
    conflicts,
    warnings,
  };
}
