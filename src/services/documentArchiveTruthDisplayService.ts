/**
 * DOCUMENT-ARCHIVE-TRUTH-DISPLAY-01 — read-only archive TruthView presentation model.
 * Maps resolved TruthView via shared structured assist facts + conflict display lines.
 * No marker parsing, no second resolve/merge/workspace logic.
 */
import type { CompanyDocument } from '../types/models';
import {
  buildDocumentWorkTruthConflictDisplayLines,
  listDocumentWorkTruthAssistFacts,
} from './documentWorkResultResolveService';
import { resolveDocumentWorkTruthViewForCompanyDocument } from './documentWorkResultTruthOrchestration';

export type DocumentArchiveTruthFactProvenance = 'confirmed' | 'corrected' | 'analysis';

export type DocumentArchiveTruthDisplayFact = {
  labelValue: string;
  provenance: DocumentArchiveTruthFactProvenance;
};

export type DocumentArchiveTruthDisplayView = {
  facts: DocumentArchiveTruthDisplayFact[];
  conflictLines: string[];
};

function toDisplayProvenance(
  provenance: 'user_confirmed' | 'user_corrected' | 'analysis',
): DocumentArchiveTruthFactProvenance {
  if (provenance === 'user_confirmed') return 'confirmed';
  if (provenance === 'user_corrected') return 'corrected';
  return 'analysis';
}

/**
 * Returns null when no usable TruthView or nothing to show (hide section entirely).
 */
export function buildDocumentArchiveTruthDisplayView(
  document: CompanyDocument,
): DocumentArchiveTruthDisplayView | null {
  const { truthView } = resolveDocumentWorkTruthViewForCompanyDocument({ document });
  if (!truthView) return null;

  const facts = listDocumentWorkTruthAssistFacts(truthView).map((fact) => ({
    labelValue: `${fact.label}: ${fact.value}`,
    provenance: toDisplayProvenance(fact.provenance),
  }));
  const conflictLines = buildDocumentWorkTruthConflictDisplayLines(truthView);

  if (facts.length === 0 && conflictLines.length === 0) {
    return null;
  }

  return { facts, conflictLines };
}
