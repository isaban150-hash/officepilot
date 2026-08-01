/**
 * REFERENZVERTRAG V1 – SPRINT B — compact proof rows for Vorgang UI.
 */
import type { TranslationKey } from '../i18n';
import type { ProofType } from '../types/memory';
import {
  getMemoryRelations,
  getProofsForVorgang,
} from './officePilotMemoryService';
import type { ContractProofRequirementSource } from './contractProofRequirementsFromIntelligence';

export type VorgangProofDisplayStatus = 'vorhanden' | 'fehlt' | 'prüfen';

export interface VorgangProofRequirementRow {
  proofType: ProofType;
  labelKey: TranslationKey;
  status: VorgangProofDisplayStatus;
  statusLabelKey: TranslationKey;
  originLabelKey: TranslationKey;
  source: ContractProofRequirementSource;
  marker: 'ok' | 'missing' | 'review';
}

const PROOF_LABEL_KEYS: Record<ProofType, TranslationKey> = {
  freistellungsbescheinigung: 'vorgang.proofs.type.freistellung',
  bg_bau: 'vorgang.proofs.type.bgBau',
  soka_bau: 'vorgang.proofs.type.sokaBau',
  betriebshaftpflicht: 'vorgang.proofs.type.haftpflicht',
};

function inferSourceFromReason(reason: string | undefined): ContractProofRequirementSource {
  // CI builder uses „Werkvertrag“; legacy analyzeContract uses „Vertrag“.
  if (reason && /Werkvertrag/i.test(reason)) return 'ci';
  return 'fallback';
}

function resolveDisplayStatus(
  proofStatus: string | undefined,
  source: ContractProofRequirementSource,
): VorgangProofDisplayStatus {
  if (proofStatus === 'valid') return 'vorhanden';
  if (proofStatus === 'expiring' || proofStatus === 'expired' || proofStatus === 'unknown') {
    return 'prüfen';
  }
  // missing / absent
  return source === 'ci' ? 'fehlt' : 'prüfen';
}

/**
 * Rows for required proofs on a Vorgang (from memory relations + proof memories).
 * Optional sourceHints override CI vs fallback (from last Accept sync).
 */
export function buildVorgangProofRequirementRows(
  vorgangId: string,
  sourceHints?: Map<ProofType, ContractProofRequirementSource>,
): VorgangProofRequirementRow[] {
  const relations = getMemoryRelations().filter(
    (relation) => relation.fromType === 'vorgang' && relation.fromId === vorgangId,
  );
  if (relations.length === 0) return [];

  const proofs = getProofsForVorgang(vorgangId);
  const proofByType = new Map<ProofType, (typeof proofs)[number]>();
  for (const proof of proofs) {
    const existing = proofByType.get(proof.proofType);
    // Prefer document-backed / non-missing over placeholder missing rows.
    if (!existing || (existing.status === 'missing' && proof.status !== 'missing')) {
      proofByType.set(proof.proofType, proof);
    }
  }

  const rows: VorgangProofRequirementRow[] = [];
  const seen = new Set<ProofType>();

  for (const relation of relations) {
    const proofType = relation.toProofType;
    if (seen.has(proofType)) continue;
    seen.add(proofType);

    const source =
      sourceHints?.get(proofType) ?? inferSourceFromReason(relation.reason);
    const proof = proofByType.get(proofType);
    const status = resolveDisplayStatus(proof?.status, source);

    rows.push({
      proofType,
      labelKey: PROOF_LABEL_KEYS[proofType],
      status,
      statusLabelKey:
        status === 'vorhanden'
          ? 'vorgang.proofs.status.present'
          : status === 'fehlt'
            ? 'vorgang.proofs.status.missing'
            : 'vorgang.proofs.status.review',
      originLabelKey: 'vorgang.proofs.origin.contract',
      source,
      marker: status === 'vorhanden' ? 'ok' : status === 'fehlt' ? 'missing' : 'review',
    });
  }

  const order: ProofType[] = [
    'bg_bau',
    'soka_bau',
    'freistellungsbescheinigung',
    'betriebshaftpflicht',
  ];
  rows.sort((a, b) => order.indexOf(a.proofType) - order.indexOf(b.proofType));
  return rows;
}
