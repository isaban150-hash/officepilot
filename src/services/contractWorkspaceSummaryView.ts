import type { ContractOrderProposal, ExtractedContractField } from '../types/documentIntelligence';
import type { DetectedOrderPosition, InboxItem, Vorgang } from '../types/models';
import type { TranslationKey } from '../i18n';
import { isImportableLvPosition } from './contractPositionImportService';
import { hasSchlussrechnung } from './orderBillingRules';

export type ContractWorkspaceSummaryRow = {
  id: string;
  labelKey: TranslationKey;
  value: string;
  needsReview: boolean;
};

export type ContractWorkspaceStatusRow = {
  id: string;
  labelKey: TranslationKey;
  valueKey: TranslationKey;
  valueParams?: Record<string, string | number>;
};

export type ContractWorkspaceSummaryView = {
  titleKey: TranslationKey;
  disclaimerKey: TranslationKey;
  contractKindLabelKey: TranslationKey;
  rows: ContractWorkspaceSummaryRow[];
  statusRows: ContractWorkspaceStatusRow[];
  positionInsightRows: ContractWorkspaceStatusRow[];
  reviewHintKeys: string[];
};

export type ContractWorkspaceSummaryContext = {
  item?: InboxItem;
  vorgang?: Vorgang | null;
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

function isLinkedToVorgang(item: InboxItem): boolean {
  if (item.vorgangId) return true;
  return item.vorgangLinkStatus === 'linked' || item.vorgangLinkStatus === 'created';
}

function isArchived(item: InboxItem): boolean {
  return Boolean(item.importedToArchive) || Boolean(item.archiveDocumentId) || item.status === 'abgelegt';
}

function buildStatusRows(context?: ContractWorkspaceSummaryContext): ContractWorkspaceStatusRow[] {
  const item = context?.item;
  if (!item) return [];

  const statusRows: ContractWorkspaceStatusRow[] = [
    {
      id: 'vorgang',
      labelKey: 'documentIntelligence.workspace.status.vorgang',
      valueKey: isLinkedToVorgang(item)
        ? 'documentIntelligence.workspace.status.vorgangLinked'
        : 'documentIntelligence.workspace.status.vorgangUnlinked',
    },
    {
      id: 'archive',
      labelKey: 'documentIntelligence.workspace.status.archive',
      valueKey: isArchived(item)
        ? 'documentIntelligence.workspace.status.archived'
        : 'documentIntelligence.workspace.status.notArchived',
    },
  ];

  // Rechnungszeilen nur, wenn ein Vorgang existiert.
  const vorgang = context?.vorgang ?? null;
  const hasVorgang = Boolean(item.vorgangId) || Boolean(vorgang);
  if (!hasVorgang) {
    return statusRows;
  }

  const invoiceCount = vorgang?.invoices.length ?? 0;
  let invoicesValueKey: TranslationKey = 'documentIntelligence.workspace.status.invoicesNone';
  let valueParams: Record<string, string | number> | undefined;
  if (invoiceCount === 1) {
    invoicesValueKey = 'documentIntelligence.workspace.status.invoicesOne';
  } else if (invoiceCount > 1) {
    invoicesValueKey = 'documentIntelligence.workspace.status.invoicesMany';
    valueParams = { count: invoiceCount };
  }

  statusRows.push({
    id: 'invoices',
    labelKey: 'documentIntelligence.workspace.status.invoices',
    valueKey: invoicesValueKey,
    valueParams,
  });

  if (vorgang && hasSchlussrechnung(vorgang)) {
    statusRows.push({
      id: 'schlussrechnung',
      labelKey: 'documentIntelligence.workspace.status.schlussrechnung',
      valueKey: 'documentIntelligence.workspace.status.schlussPresent',
    });
  }

  return statusRows;
}

/** Field absence uses the same finite/>0 convention as isImportableLvPosition. */
function lacksRecognizedQuantity(position: DetectedOrderPosition): boolean {
  return !(Number.isFinite(position.quantity) && position.quantity > 0);
}

function lacksRecognizedUnitPrice(position: DetectedOrderPosition): boolean {
  return !(Number.isFinite(position.unitPrice) && position.unitPrice > 0);
}

function lacksRecognizedUnit(position: DetectedOrderPosition): boolean {
  return !(position.unit?.trim());
}

/**
 * Faktenzähler aus der aktuellen Proposal-Positionsliste.
 * Kein Import-Vergleich, keine Historie, keine Heuristik.
 */
function buildPositionInsightRows(proposal: ContractOrderProposal): ContractWorkspaceStatusRow[] {
  const positions = proposal.positions;
  if (!positions.length) return [];

  let importable = 0;
  let withoutQuantity = 0;
  let withoutUnitPrice = 0;
  let withoutUnit = 0;

  for (const position of positions) {
    if (isImportableLvPosition(position)) importable += 1;
    if (lacksRecognizedQuantity(position)) withoutQuantity += 1;
    if (lacksRecognizedUnitPrice(position)) withoutUnitPrice += 1;
    if (lacksRecognizedUnit(position)) withoutUnit += 1;
  }

  const notImportable = positions.length - importable;
  const rows: ContractWorkspaceStatusRow[] = [
    {
      id: 'positionsImportable',
      labelKey: 'documentIntelligence.workspace.positions.importable',
      valueKey: 'documentIntelligence.workspace.positions.importableCount',
      valueParams: { count: importable },
    },
    {
      id: 'positionsNotImportable',
      labelKey: 'documentIntelligence.workspace.positions.notImportable',
      valueKey: 'documentIntelligence.workspace.positions.notImportableCount',
      valueParams: { count: notImportable },
    },
  ];

  if (withoutQuantity > 0) {
    rows.push({
      id: 'positionsWithoutQuantity',
      labelKey: 'documentIntelligence.workspace.positions.withoutQuantity',
      valueKey: 'documentIntelligence.workspace.positions.withoutQuantityCount',
      valueParams: { count: withoutQuantity },
    });
  }
  if (withoutUnitPrice > 0) {
    rows.push({
      id: 'positionsWithoutUnitPrice',
      labelKey: 'documentIntelligence.workspace.positions.withoutUnitPrice',
      valueKey: 'documentIntelligence.workspace.positions.withoutUnitPriceCount',
      valueParams: { count: withoutUnitPrice },
    });
  }
  if (withoutUnit > 0) {
    rows.push({
      id: 'positionsWithoutUnit',
      labelKey: 'documentIntelligence.workspace.positions.withoutUnit',
      valueKey: 'documentIntelligence.workspace.positions.withoutUnitCount',
      valueParams: { count: withoutUnit },
    });
  }

  return rows;
}

/**
 * Reiner View-Adapter: bildet nur bestehende Proposal-/Intelligence-/Inbox-/Vorgang-Werte ab.
 * Keine neue Extraktion, keine Betragsberechnung, keine fachliche Wahrheit.
 */
export function buildContractWorkspaceSummaryView(
  proposal: ContractOrderProposal,
  context?: ContractWorkspaceSummaryContext,
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
    statusRows: buildStatusRows(context),
    positionInsightRows: buildPositionInsightRows(proposal),
    reviewHintKeys: proposal.reviewHints.slice(),
  };
}
