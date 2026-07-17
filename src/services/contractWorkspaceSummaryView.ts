import type { ContractOrderProposal, ExtractedContractField } from '../types/documentIntelligence';
import type { TranslationKey } from '../i18n';

export type ContractWorkspaceSummaryRow = {
  id: string;
  labelKey: TranslationKey;
  value: string;
  needsReview: boolean;
};

export type ContractWorkspaceSummaryView = {
  titleKey: TranslationKey;
  disclaimerKey: TranslationKey;
  contractKindLabelKey: TranslationKey;
  rows: ContractWorkspaceSummaryRow[];
  reviewHintKeys: string[];
};

const POSITION_SUM_SOURCE = 'Summe der erkannten Positionen';

function readField(field?: ExtractedContractField): { value: string; needsReview: boolean } | null {
  if (!field || field.status === 'not_found') return null;
  const value = field.value?.trim();
  if (!value) return null;
  return {
    value,
    needsReview: field.status === 'review_required' || field.confidence === 'low',
  };
}

function pushRow(
  rows: ContractWorkspaceSummaryRow[],
  id: string,
  labelKey: TranslationKey,
  value: string | undefined,
  needsReview = false,
): void {
  const trimmed = value?.trim();
  if (!trimmed) return;
  rows.push({ id, labelKey, value: trimmed, needsReview });
}

/**
 * Reiner View-Adapter: bildet nur bestehende Proposal-/Intelligence-Werte ab.
 * Keine neue Extraktion, keine Betragsberechnung, keine fachliche Wahrheit.
 */
export function buildContractWorkspaceSummaryView(
  proposal: ContractOrderProposal,
): ContractWorkspaceSummaryView {
  const fields = proposal.intelligence.contractFields;
  const rows: ContractWorkspaceSummaryRow[] = [];

  const kindKey = (proposal.intelligence.documentLabelKey ||
    'documentIntelligence.label.unknown') as TranslationKey;

  const auftraggeber = readField(fields.auftraggeber);
  pushRow(
    rows,
    'customer',
    'documentIntelligence.field.customer',
    auftraggeber?.value,
    auftraggeber?.needsReview ?? false,
  );

  const auftragnehmer = readField(fields.auftragnehmer);
  pushRow(
    rows,
    'contractor',
    'documentIntelligence.field.contractor',
    auftragnehmer?.value,
    auftragnehmer?.needsReview ?? false,
  );

  // Baustelle nur aus belastbarem Intelligence-Feld — nicht aus Proposal-Fallback/Anhang.
  const baustelle = readField(fields.baustelle);
  pushRow(
    rows,
    'constructionSite',
    'documentIntelligence.field.constructionSite',
    baustelle?.value,
    baustelle?.needsReview ?? false,
  );

  const vertragsdatum = readField(fields.vertragsdatum);
  pushRow(
    rows,
    'contractDate',
    'documentIntelligence.field.contractDate',
    vertragsdatum?.value ?? proposal.contractDate,
    vertragsdatum?.needsReview ?? false,
  );

  // Ausführungszeitraum: nur wenn Intelligence das Feld bereits führt (heute i. d. R. nicht).
  const zeitraum = readField(fields.leistungszeitraum ?? fields.ausfuehrungszeitraum);
  pushRow(
    rows,
    'performancePeriod',
    'documentIntelligence.field.performancePeriod',
    zeitraum?.value,
    zeitraum?.needsReview ?? false,
  );

  const totalField = proposal.intelligence.contractTotalNet;
  const totalFromPositionSum = totalField?.sourceText?.trim() === POSITION_SUM_SOURCE;
  if (totalField?.value != null && !totalFromPositionSum && totalField.status !== 'not_found') {
    const formatted = proposal.contractTotalNet?.trim();
    if (formatted) {
      pushRow(
        rows,
        'contractTotal',
        'documentIntelligence.field.contractTotal',
        formatted,
        totalField.status === 'review_required' || totalField.confidence === 'low',
      );
    }
  }

  const zahlung = readField(fields.zahlungsbedingungen);
  pushRow(
    rows,
    'paymentTerms',
    'documentIntelligence.field.paymentTerms',
    zahlung?.value || proposal.paymentTermsSummary,
    zahlung?.needsReview ?? false,
  );

  if (proposal.positionCount > 0) {
    pushRow(
      rows,
      'positions',
      'documentIntelligence.field.positions',
      String(proposal.positionCount),
      false,
    );
  }

  return {
    titleKey: 'documentIntelligence.workspace.summaryTitle',
    disclaimerKey: 'documentIntelligence.workspace.summaryDisclaimer',
    contractKindLabelKey: kindKey,
    rows,
    reviewHintKeys: proposal.reviewHints.slice(),
  };
}
