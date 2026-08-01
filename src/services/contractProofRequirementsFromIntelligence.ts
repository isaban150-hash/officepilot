/**
 * REFERENZVERTRAG V1 – SPRINT B
 * Map Contract Intelligence proof fields → RequiredDocument list (CI first, analysis fallback).
 * No new extraction engine — only reads existing CI fields + optional fallback list.
 */
import type { ContractIntelligenceResult } from '../types/documentIntelligence';
import type { RequiredDocument } from '../types/models';
import type { ProofType } from '../types/memory';

export type ContractProofRequirementSource = 'ci' | 'fallback';

export type ResolvedContractProofRequirement = RequiredDocument & {
  proofType: ProofType;
  source: ContractProofRequirementSource;
};

function isConfirmedField(field: { status?: string; value?: string } | undefined): boolean {
  if (!field) return false;
  if (field.status === 'confirmed' || field.status === 'suggested') {
    return Boolean(field.value?.trim() || field.status === 'confirmed');
  }
  return false;
}

const CI_PROOF_FIELD_MAP: Array<{
  fieldKey: string;
  type: string;
  proofType: ProofType;
  priority: RequiredDocument['priority'];
  reason: string;
}> = [
  {
    fieldKey: 'bgBau',
    type: 'bg_bau',
    proofType: 'bg_bau',
    priority: 'hoch',
    reason: 'BG-BAU-Nachweis im Werkvertrag gefordert',
  },
  {
    fieldKey: 'sokaBau',
    type: 'soka_bau',
    proofType: 'soka_bau',
    priority: 'hoch',
    reason: 'SOKA-BAU-Nachweis im Werkvertrag gefordert',
  },
];

const FALLBACK_PROOF_TYPE_MAP: Record<string, ProofType | undefined> = {
  freistellungsbescheinigung: 'freistellungsbescheinigung',
  bg_bau: 'bg_bau',
  soka_bau: 'soka_bau',
  versicherung: 'betriebshaftpflicht',
  aok: undefined,
};

/**
 * CI fields win. Fallback (legacy analyzeContract / inbox) fills gaps only.
 * Dedupes by proof type.
 */
export function buildRequiredDocumentsFromContractIntelligence(
  intelligence: ContractIntelligenceResult | null | undefined,
  fallbackDocuments: RequiredDocument[] = [],
): ResolvedContractProofRequirement[] {
  const byType = new Map<ProofType, ResolvedContractProofRequirement>();
  const fields = intelligence?.contractFields ?? {};

  for (const rule of CI_PROOF_FIELD_MAP) {
    if (!isConfirmedField(fields[rule.fieldKey])) continue;
    byType.set(rule.proofType, {
      type: rule.type,
      priority: rule.priority,
      reason: rule.reason,
      proofType: rule.proofType,
      source: 'ci',
    });
  }

  for (const doc of fallbackDocuments) {
    const proofType = FALLBACK_PROOF_TYPE_MAP[doc.type];
    if (!proofType || byType.has(proofType)) continue;
    byType.set(proofType, {
      type: doc.type,
      priority: doc.priority,
      reason: doc.reason,
      proofType,
      source: 'fallback',
    });
  }

  return Array.from(byType.values());
}

export function toRequiredDocuments(
  resolved: ResolvedContractProofRequirement[],
): RequiredDocument[] {
  return resolved.map(({ type, priority, reason }) => ({ type, priority, reason }));
}

export function proofRequirementSourceByType(
  resolved: ResolvedContractProofRequirement[],
): Map<ProofType, ContractProofRequirementSource> {
  return new Map(resolved.map((entry) => [entry.proofType, entry.source]));
}
