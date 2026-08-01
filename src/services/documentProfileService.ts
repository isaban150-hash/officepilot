import {
  hasEmploymentBaSignals,
  hasStrongPaymentDemandEvidence,
} from '../config/documentIntelligenceConfig';
import type { DocumentConflict } from '../types/documentAnalysis';
import type { ExtractedDocumentFeature } from '../types/documentFeatures';
import type {
  DocumentActionType,
  DocumentFunction,
  DocumentProfile,
  DocumentProfileCandidate,
  DocumentProfileConflictType,
  DocumentSenderCategory,
} from '../types/documentProfile';
import type { ClassifiedDocumentKind } from '../types/models';
import { inferUnlabeledSenderFromText } from './documentFieldExtractionService';
import type { ReceiptAnalysisPipelineResult } from './documentReceiptAnalysisPipelineService';

export type ProfileDetectionResult = {
  kind: ClassifiedDocumentKind;
  reasonKey: string;
};

const HEALTH_INSURANCE_KINDS = new Set<ClassifiedDocumentKind>([
  'krankenkasse',
  'aok',
  'barmer',
  'tk',
  'dak',
  'ikk',
  'knappschaft',
  'pflegekasse',
]);

const REMINDER_KINDS = new Set<ClassifiedDocumentKind>(['mahnung', 'zahlungserinnerung']);

const CONTRACT_KINDS = new Set<ClassifiedDocumentKind>([
  'werkvertrag',
  'subunternehmervertrag',
  'nachunternehmervertrag',
]);

const INVOICE_KINDS = new Set<ClassifiedDocumentKind>([
  'eingangsrechnung',
  'rechnung',
  'ausgangsrechnung',
]);

const CANDIDATES_TOO_CLOSE_MARGIN = 0.12;

const BA_AUTHORITY_NAME_PATTERN =
  /\b(?:bundesagentur(?:\s+für\s+arbeit)?|(?:bundes)?agentur\s+für\s+arbeit|arbeitsagentur)\b/i;

const STRONG_HEALTH_INSURANCE_CORRESPONDENCE_PATTERN =
  /\bkrankenkasse\b|\bgesetzliche\s+krankenversicherung\b|(?:\baok\b|\bbarmer\b|\bdak\b|\bikk\b|techniker\s+kranken)(?:[\s\S]{0,220})(?:beitrag(?:snachweis)?|mitglied|bescheid|mahnung|zahlungsaufforderung)|\bbeitragsnachweis\b(?:[\s\S]{0,220})(?:\baok\b|\bbarmer\b|\bdak\b|\bikk\b|krankenkasse)/i;

const EMPLOYMENT_FORM_PATTERN =
  /arbeitsbescheinigung|arbeitgeberbescheinigung|§\s*312|sgb\s*iii|beschäftigungsverhältnis/i;

const KUENDIGUNG_ONLY_PATTERN = /\bkündigung\b|\bkuendigung\b/i;

function hasFeature(features: ExtractedDocumentFeature[], id: string): boolean {
  return features.some((feature) => feature.id === id);
}

function collectEvidenceRefs(features: ExtractedDocumentFeature[], ids: string[]): string[] {
  return features
    .filter((feature) => ids.includes(feature.id))
    .flatMap((feature) => feature.evidenceRefs)
    .slice(0, 12);
}

/**
 * Krankenkasse / Knappschaft tokens alone must not win on BA employment forms.
 * Strong KK correspondence needs explicit KK org language or insurer+contribution context.
 */
export function hasStrongHealthInsuranceCorrespondence(recognizedText: string): boolean {
  if (EMPLOYMENT_FORM_PATTERN.test(recognizedText) && hasEmploymentBaSignals(recognizedText)) {
    return (
      /\bkrankenkasse\b/i.test(recognizedText) &&
      /beitrag|mitglied|bescheid|mahnung|zahlungsaufforderung/i.test(recognizedText)
    );
  }
  return STRONG_HEALTH_INSURANCE_CORRESPONDENCE_PATTERN.test(recognizedText);
}

export function shouldBlockHealthInsuranceKind(
  kind: ClassifiedDocumentKind,
  recognizedText: string,
): boolean {
  if (!HEALTH_INSURANCE_KINDS.has(kind)) return false;
  if (!hasEmploymentBaSignals(recognizedText)) return false;
  if (hasStrongHealthInsuranceCorrespondence(recognizedText)) return false;
  return true;
}

function derivePaymentDemand(
  features: ExtractedDocumentFeature[],
  recognizedText: string,
): boolean {
  if (hasStrongPaymentDemandEvidence(recognizedText)) return true;
  const hasMarker =
    hasFeature(features, 'structure.mahnung_marker') ||
    hasFeature(features, 'structure.zahlungserinnerung_marker');
  const hasRequest = hasFeature(features, 'structure.payment_request');
  return hasMarker && hasRequest;
}

function deriveSenderCategory(
  features: ExtractedDocumentFeature[],
  recognizedText: string,
  paymentDemand: boolean,
): DocumentSenderCategory {
  if (
    hasFeature(features, 'structure.agentur_fuer_arbeit_marker') ||
    EMPLOYMENT_FORM_PATTERN.test(recognizedText) ||
    BA_AUTHORITY_NAME_PATTERN.test(recognizedText)
  ) {
    return 'authority';
  }
  if (
    hasStrongHealthInsuranceCorrespondence(recognizedText) ||
    (hasFeature(features, 'structure.krankenkasse_marker') &&
      !hasEmploymentBaSignals(recognizedText))
  ) {
    return 'health_insurance';
  }
  if (hasFeature(features, 'structure.finanzamt_marker') || hasFeature(features, 'structure.steuerbescheid_marker')) {
    return 'tax_advisor';
  }
  if (
    hasFeature(features, 'structure.bg_bau_marker') ||
    hasFeature(features, 'structure.soka_bau_marker') ||
    hasFeature(features, 'structure.authority_letter')
  ) {
    return 'authority';
  }
  if (/\b(?:amtsgericht|landgericht|arbeitsgericht)\b/i.test(recognizedText)) {
    return 'court';
  }
  if (/\b(?:kontoauszug|sparkasse|volksbank|commerzbank|deutsche\s+bank)\b/i.test(recognizedText)) {
    return 'bank';
  }
  if (
    hasFeature(features, 'structure.werkvertrag_marker') ||
    hasFeature(features, 'structure.auftrag_marker') ||
    hasFeature(features, 'structure.angebot_marker')
  ) {
    return 'customer';
  }
  if (
    hasFeature(features, 'reference.invoice_number') ||
    paymentDemand ||
    hasFeature(features, 'structure.receipt_layout')
  ) {
    return 'supplier';
  }
  if (
    /\b(?:arbeitsvertrag|lohnabrechnung|kündigung|kuendigung)\b/i.test(recognizedText) &&
    !paymentDemand
  ) {
    return 'employee_related';
  }
  if (/\b(?:haftpflicht|versicherungsschreiben|allianz|huk)\b/i.test(recognizedText)) {
    return 'insurer';
  }
  return 'unknown';
}

function deriveDocumentFunction(
  features: ExtractedDocumentFeature[],
  recognizedText: string,
  paymentDemand: boolean,
): DocumentFunction {
  if (paymentDemand) return 'reminder';
  if (
    hasFeature(features, 'structure.freistellung_marker') ||
    hasFeature(features, 'structure.unbedenklichkeit_marker')
  ) {
    return 'certificate';
  }
  if (EMPLOYMENT_FORM_PATTERN.test(recognizedText)) {
    return /arbeitsbescheinigung|arbeitgeberbescheinigung/i.test(recognizedText) ? 'form' : 'certificate';
  }
  if (
    hasFeature(features, 'structure.werkvertrag_marker') ||
    hasFeature(features, 'structure.subunternehmer_marker') ||
    hasFeature(features, 'structure.nachunternehmer_marker')
  ) {
    return 'contract';
  }
  if (
    hasFeature(features, 'reference.invoice_number') &&
    !hasFeature(features, 'structure.mahnung_marker')
  ) {
    return 'invoice';
  }
  if (hasFeature(features, 'structure.angebot_marker')) return 'correspondence';
  if (hasFeature(features, 'structure.auftrag_marker')) return 'confirmation';
  if (hasFeature(features, 'structure.steuerbescheid_marker')) return 'notice';
  if (hasFeature(features, 'structure.receipt_layout')) return 'statement';
  if (KUENDIGUNG_ONLY_PATTERN.test(recognizedText) && !paymentDemand) return 'notice';
  if (hasFeature(features, 'structure.authority_letter')) return 'correspondence';
  return 'unknown';
}

function deriveActionType(
  paymentDemand: boolean,
  documentFunction: DocumentFunction,
  deadlineEvidence: boolean,
  recognizedText: string,
): DocumentActionType {
  if (paymentDemand) return 'pay';
  if (/bitte\s+(?:reichen|einreichen|übersenden|nachreichen)/i.test(recognizedText)) {
    return 'submit_documents';
  }
  if (/bitte\s+(?:antworten|rückmeldung|stellungnahme)/i.test(recognizedText)) {
    return 'respond';
  }
  if (documentFunction === 'contract' || /\bunterschrift\b|\bunterzeichnen\b/i.test(recognizedText)) {
    return 'sign';
  }
  if (documentFunction === 'form' || documentFunction === 'certificate') {
    return 'archive';
  }
  if (documentFunction === 'invoice') return 'assign';
  if (deadlineEvidence && documentFunction === 'notice') return 'review';
  if (documentFunction === 'correspondence' || documentFunction === 'notice') return 'review';
  if (documentFunction === 'unknown') return 'unknown';
  return 'information_only';
}

function deriveSubjectArea(
  senderCategory: DocumentSenderCategory,
  documentFunction: DocumentFunction,
  recognizedText: string,
): string | undefined {
  if (EMPLOYMENT_FORM_PATTERN.test(recognizedText) || senderCategory === 'employee_related') {
    return 'employment';
  }
  if (senderCategory === 'health_insurance') return 'health_insurance';
  if (senderCategory === 'tax_advisor' || documentFunction === 'invoice') return 'finance';
  if (documentFunction === 'contract') return 'contracts';
  if (senderCategory === 'authority') return 'authority';
  return undefined;
}

function deriveFilingDomain(
  senderCategory: DocumentSenderCategory,
  documentFunction: DocumentFunction,
  paymentDemand: boolean,
): string | undefined {
  if (paymentDemand) return 'mahnungen';
  if (documentFunction === 'invoice') return 'rechnungen';
  if (documentFunction === 'contract') return 'vertraege';
  if (senderCategory === 'health_insurance') return 'krankenkassen';
  if (senderCategory === 'authority' || documentFunction === 'form' || documentFunction === 'certificate') {
    return 'behoerden';
  }
  if (senderCategory === 'employee_related') return 'mitarbeiter';
  return 'eingang';
}

function deriveSenderEntity(
  features: ExtractedDocumentFeature[],
  recognizedText: string,
  senderCategory: DocumentSenderCategory,
): string | undefined {
  if (senderCategory === 'authority' && BA_AUTHORITY_NAME_PATTERN.test(recognizedText)) {
    return 'Bundesagentur für Arbeit';
  }
  const authorityLetter = features.find((feature) => feature.id === 'structure.authority_letter');
  const raw = authorityLetter?.rawValue?.trim();
  if (raw && BA_AUTHORITY_NAME_PATTERN.test(raw)) {
    return 'Bundesagentur für Arbeit';
  }
  if (raw && !/seite\s+\d+|von\s+\d+|arbeitsbescheinigung/i.test(raw) && raw.length <= 80) {
    return raw;
  }
  const labeled = features.find((feature) => feature.id === 'identity.sender_labeled');
  if (typeof labeled?.value === 'string' && labeled.value.trim()) {
    return labeled.value.trim();
  }
  // Unlabeled letterhead / issuer line (same general heuristic as field extraction).
  return inferUnlabeledSenderFromText(recognizedText);
}

function buildTopCandidates(
  pipeline: ReceiptAnalysisPipelineResult | null,
): DocumentProfileCandidate[] {
  if (!pipeline?.scoringResult.candidates.length) return [];
  return pipeline.scoringResult.candidates
    .filter((candidate) => candidate.score > 0 && candidate.kind !== 'unknown')
    .slice(0, 3)
    .map((candidate) => ({
      kind: candidate.kind as ClassifiedDocumentKind,
      score: candidate.score,
      confidence: candidate.confidence,
    }));
}

function detectProfileConflicts(input: {
  features: ExtractedDocumentFeature[];
  recognizedText: string;
  paymentDemand: boolean;
  documentFunction: DocumentFunction;
  senderCategory: DocumentSenderCategory;
  scoringConflicts: DocumentConflict[];
  margin: number;
  topCandidates: DocumentProfileCandidate[];
}): DocumentProfileConflictType[] {
  const conflicts: DocumentProfileConflictType[] = [];
  const { recognizedText, paymentDemand, documentFunction, senderCategory, topCandidates, margin } =
    input;

  const employmentBa =
    hasEmploymentBaSignals(recognizedText) || EMPLOYMENT_FORM_PATTERN.test(recognizedText);
  const healthNoise =
    /\b(?:knappschaft|krankenkasse|aok|barmer|pflegekasse)\b/i.test(recognizedText) ||
    hasFeature(input.features, 'structure.krankenkasse_marker');

  if (employmentBa && healthNoise && !hasStrongHealthInsuranceCorrespondence(recognizedText)) {
    conflicts.push('authority_employment_vs_health_insurance');
  }

  if (
    (documentFunction === 'form' || documentFunction === 'certificate' || employmentBa) &&
    !paymentDemand &&
    (hasFeature(input.features, 'structure.mahnung_marker') ||
      hasFeature(input.features, 'structure.weak_payment_signal') ||
      /\bmahnung\b/i.test(recognizedText))
  ) {
    conflicts.push('form_certificate_vs_reminder');
  }

  if (
    hasFeature(input.features, 'reference.invoice_number') &&
    hasFeature(input.features, 'structure.mahnung_marker') &&
    !paymentDemand
  ) {
    conflicts.push('invoice_vs_reminder');
  }

  if (
    (hasFeature(input.features, 'structure.werkvertrag_marker') ||
      documentFunction === 'contract') &&
    (paymentDemand || hasFeature(input.features, 'structure.payment_request'))
  ) {
    conflicts.push('contract_vs_payment');
  }

  const scoringTooClose = input.scoringConflicts.some((c) => c.type === 'candidates_too_close');
  if (
    scoringTooClose ||
    (margin < CANDIDATES_TOO_CLOSE_MARGIN &&
      topCandidates.length >= 2 &&
      topCandidates[0]!.kind !== topCandidates[1]!.kind)
  ) {
    const a = topCandidates[0]?.kind;
    const b = topCandidates[1]?.kind;
    if (a && b) {
      const conflictingFamilies =
        (HEALTH_INSURANCE_KINDS.has(a) && (b === 'agentur_fuer_arbeit' || employmentBa)) ||
        (HEALTH_INSURANCE_KINDS.has(b) && (a === 'agentur_fuer_arbeit' || employmentBa)) ||
        (REMINDER_KINDS.has(a) && (documentFunction === 'form' || documentFunction === 'certificate')) ||
        (REMINDER_KINDS.has(b) && (documentFunction === 'form' || documentFunction === 'certificate')) ||
        (INVOICE_KINDS.has(a) && REMINDER_KINDS.has(b)) ||
        (INVOICE_KINDS.has(b) && REMINDER_KINDS.has(a)) ||
        (CONTRACT_KINDS.has(a) && REMINDER_KINDS.has(b)) ||
        (CONTRACT_KINDS.has(b) && REMINDER_KINDS.has(a));
      if (conflictingFamilies || scoringTooClose) {
        conflicts.push('candidates_too_close');
      }
    }
  }

  if (
    topCandidates[0] &&
    pipelineMissingRequired(topCandidates[0], input.features) &&
    senderCategory === 'unknown'
  ) {
    conflicts.push('missing_required_evidence');
  }

  return [...new Set(conflicts)];
}

function pipelineMissingRequired(
  candidate: DocumentProfileCandidate,
  _features: ExtractedDocumentFeature[],
): boolean {
  return candidate.confidence < 0.55;
}

function resolveKindHint(
  senderCategory: DocumentSenderCategory,
  documentFunction: DocumentFunction,
  paymentDemand: boolean,
  recognizedText: string,
  topCandidates: DocumentProfileCandidate[],
): ClassifiedDocumentKind | undefined {
  if (paymentDemand && hasStrongPaymentDemandEvidence(recognizedText)) {
    if (/\bzahlungserinnerung\b/i.test(recognizedText)) return 'zahlungserinnerung';
    return 'mahnung';
  }
  if (
    EMPLOYMENT_FORM_PATTERN.test(recognizedText) ||
    BA_AUTHORITY_NAME_PATTERN.test(recognizedText) ||
    senderCategory === 'authority'
  ) {
    if (EMPLOYMENT_FORM_PATTERN.test(recognizedText) || BA_AUTHORITY_NAME_PATTERN.test(recognizedText)) {
      return 'agentur_fuer_arbeit';
    }
  }
  if (documentFunction === 'contract') {
    if (/subunternehmer/i.test(recognizedText)) return 'subunternehmervertrag';
    if (/nachunternehmer/i.test(recognizedText)) return 'nachunternehmervertrag';
    return 'werkvertrag';
  }
  if (documentFunction === 'invoice') return 'eingangsrechnung';
  if (hasStrongHealthInsuranceCorrespondence(recognizedText)) return 'krankenkasse';
  return topCandidates[0]?.kind;
}

function shouldForceKindReview(conflicts: DocumentProfileConflictType[]): boolean {
  return (
    conflicts.includes('candidates_too_close') &&
    (conflicts.includes('authority_employment_vs_health_insurance') ||
      conflicts.includes('form_certificate_vs_reminder') ||
      conflicts.includes('invoice_vs_reminder') ||
      conflicts.includes('contract_vs_payment'))
  );
}

export function buildDocumentProfile(input: {
  pipeline: ReceiptAnalysisPipelineResult | null;
  recognizedText: string;
  sourceFileName?: string;
}): DocumentProfile {
  const features = input.pipeline?.featureResult.features ?? [];
  const scoring = input.pipeline?.scoringResult;
  const recognizedText = input.recognizedText || '';
  const paymentDemand = derivePaymentDemand(features, recognizedText);
  const deadlineEvidence = hasFeature(features, 'date.deadline_date');
  const documentDateEvidence = hasFeature(features, 'date.document_date');
  const senderCategory = deriveSenderCategory(features, recognizedText, paymentDemand);
  const documentFunction = deriveDocumentFunction(features, recognizedText, paymentDemand);
  const actionType = deriveActionType(
    paymentDemand,
    documentFunction,
    deadlineEvidence,
    recognizedText,
  );
  const topCandidates = buildTopCandidates(input.pipeline);
  const margin = scoring?.margin ?? 1;
  const confidence = scoring?.confidence ?? (topCandidates[0]?.confidence ?? 0.35);
  const conflicts = detectProfileConflicts({
    features,
    recognizedText,
    paymentDemand,
    documentFunction,
    senderCategory,
    scoringConflicts: scoring?.conflicts ?? [],
    margin,
    topCandidates,
  });

  const warnings: string[] = [];
  if (input.sourceFileName && /mahnung|krankenkasse|rechnung/i.test(input.sourceFileName)) {
    warnings.push('profile:filename_only_weak_signal');
  }
  if (KUENDIGUNG_ONLY_PATTERN.test(recognizedText) && !paymentDemand) {
    warnings.push('profile:kuendigung_without_payment_demand');
  }

  const needsKindReview = shouldForceKindReview(conflicts);
  const reviewReasonKeys: string[] = [];
  if (needsKindReview) {
    reviewReasonKeys.push('document.profile.reviewKind');
    reviewReasonKeys.push('document.profile.multipleKindsPossible');
  }
  if (conflicts.includes('authority_employment_vs_health_insurance')) {
    reviewReasonKeys.push('document.profile.assignmentUncertain');
  }

  const classifiedKindHint = resolveKindHint(
    senderCategory,
    documentFunction,
    paymentDemand,
    recognizedText,
    topCandidates,
  );

  return {
    senderEntity: deriveSenderEntity(features, recognizedText, senderCategory),
    senderCategory,
    documentFunction,
    subjectArea: deriveSubjectArea(senderCategory, documentFunction, recognizedText),
    actionType,
    paymentDemand,
    deadlineEvidence,
    documentDateEvidence,
    affectedParty: undefined,
    linkedCustomerOrOrder: undefined,
    filingDomain: deriveFilingDomain(senderCategory, documentFunction, paymentDemand),
    confidence,
    margin,
    evidenceRefs: collectEvidenceRefs(features, [
      'structure.agentur_fuer_arbeit_marker',
      'structure.krankenkasse_marker',
      'structure.mahnung_marker',
      'structure.payment_request',
      'structure.authority_letter',
      'structure.werkvertrag_marker',
      'reference.invoice_number',
      'date.deadline_date',
      'identity.sender_labeled',
    ]),
    conflicts,
    warnings,
    topCandidates,
    classifiedKindHint,
    needsKindReview,
    reviewReasonKeys: [...new Set(reviewReasonKeys)],
  };
}

export type ProfileGuardedDetection = {
  detection: ProfileDetectionResult;
  cutoverApplied: boolean;
  profileForcedReview: boolean;
};

/**
 * Apply runtime profile guards after lane/legacy preliminary detection.
 * Prefer honest review or BA employment kind over contradictory health/payment kinds.
 */
export function applyDocumentProfileToDetection(input: {
  detection: ProfileDetectionResult;
  cutoverApplied: boolean;
  profile: DocumentProfile;
  recognizedText: string;
}): ProfileGuardedDetection {
  const { profile, recognizedText } = input;
  let { detection, cutoverApplied } = input;
  let profileForcedReview = false;

  if (shouldBlockHealthInsuranceKind(detection.kind, recognizedText)) {
    if (profile.classifiedKindHint === 'agentur_fuer_arbeit' || EMPLOYMENT_FORM_PATTERN.test(recognizedText)) {
      detection = {
        kind: 'agentur_fuer_arbeit',
        reasonKey: cutoverApplied
          ? 'classification.detect.diAuthorityScoring'
          : 'classification.detect.agenturArbeit',
      };
      // Keep cutoverApplied only if we already came from a cutover path; otherwise legacy agentur reason.
    } else if (profile.needsKindReview) {
      detection = {
        kind: 'sonstiges',
        reasonKey: 'classification.detect.kindReviewRequired',
      };
      cutoverApplied = false;
      profileForcedReview = true;
    }
  }

  if (
    REMINDER_KINDS.has(detection.kind) &&
    !profile.paymentDemand &&
    (profile.documentFunction === 'form' ||
      profile.documentFunction === 'certificate' ||
      profile.conflicts.includes('form_certificate_vs_reminder'))
  ) {
    if (profile.classifiedKindHint === 'agentur_fuer_arbeit') {
      detection = {
        kind: 'agentur_fuer_arbeit',
        reasonKey: 'classification.detect.agenturArbeit',
      };
      cutoverApplied = false;
    } else {
      detection = {
        kind: 'sonstiges',
        reasonKey: 'classification.detect.kindReviewRequired',
      };
      cutoverApplied = false;
      profileForcedReview = true;
    }
  }

  if (profile.needsKindReview && !profileForcedReview) {
    const top = profile.topCandidates[0];
    const second = profile.topCandidates[1];
    const ambiguousSpecific =
      top &&
      second &&
      top.kind !== second.kind &&
      top.kind !== 'sonstiges' &&
      second.kind !== 'sonstiges';
    if (ambiguousSpecific && profile.conflicts.includes('candidates_too_close')) {
      // Prefer strong BA hint over blank review when employment form is clear.
      if (
        profile.classifiedKindHint === 'agentur_fuer_arbeit' &&
        EMPLOYMENT_FORM_PATTERN.test(recognizedText) &&
        !profile.paymentDemand
      ) {
        detection = {
          kind: 'agentur_fuer_arbeit',
          reasonKey: 'classification.detect.agenturArbeit',
        };
        cutoverApplied = false;
      } else if (
        !INVOICE_KINDS.has(detection.kind) &&
        !CONTRACT_KINDS.has(detection.kind) &&
        detection.kind !== 'agentur_fuer_arbeit'
      ) {
        detection = {
          kind: 'sonstiges',
          reasonKey: 'classification.detect.kindReviewRequired',
        };
        cutoverApplied = false;
        profileForcedReview = true;
      }
    }
  }

  return { detection, cutoverApplied, profileForcedReview };
}
