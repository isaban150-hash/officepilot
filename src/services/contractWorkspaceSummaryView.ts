import type {
  ContractFamily,
  ContractOrderProposal,
  ContractPartyRole,
  DetectedContractClause,
  ExtractedContractField,
} from '../types/documentIntelligence';
import type { DetectedOrderPosition, InboxItem, Vorgang } from '../types/models';
import type { TranslationKey } from '../i18n';
import { isImportableLvPosition } from './contractPositionImportService';
import { hasAbschlagsrechnung, hasSchlussrechnung } from './orderBillingRules';

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

export type ContractWorkspaceClauseRow = {
  id: string;
  labelKey: TranslationKey;
  value: string;
};

export type ContractWorkspacePartyRow = {
  id: string;
  roleLabelKey: TranslationKey;
  name: string;
};

export type ContractWorkspaceSummaryView = {
  titleKey: TranslationKey;
  disclaimerKey: TranslationKey;
  contractKindLabelKey: TranslationKey;
  contractKindNeedsReview: boolean;
  overviewRows: ContractWorkspaceSummaryRow[];
  partyRows: ContractWorkspacePartyRow[];
  generalRows: ContractWorkspaceSummaryRow[];
  typeSpecificRows: ContractWorkspaceSummaryRow[];
  /** @deprecated use generalRows — kept for older tests expecting rows */
  rows: ContractWorkspaceSummaryRow[];
  clauseRows: ContractWorkspaceClauseRow[];
  statusRows: ContractWorkspaceStatusRow[];
  positionInsightRows: ContractWorkspaceStatusRow[];
  reviewHintKeys: string[];
  family: ContractFamily;
};

export type ContractWorkspaceSummaryContext = {
  item?: InboxItem;
  vorgang?: Vorgang | null;
};

const POSITION_SUM_SOURCE = 'Summe der erkannten Positionen';

/** Party-name fields are shown in the parties section — not again under type-specific. */
const PARTY_FIELD_KEYS = new Set([
  'auftraggeber',
  'auftragnehmer',
  'subunternehmer',
  'nachunternehmer',
  'kunde',
  'dienstleister',
  'vermieter',
  'mieter',
  'leasinggeber',
  'leasingnehmer',
  'verkaeufer',
  'kaeufer',
  'versicherer',
  'versicherungsnehmer',
  'arbeitgeber',
  'arbeitnehmer',
]);

const CLAUSE_LABEL_KEYS: Record<DetectedContractClause['id'], TranslationKey> = {
  nachtraege: 'documentIntelligence.clause.nachtraege',
  behinderungsanzeige: 'documentIntelligence.clause.behinderungsanzeige',
  materialbereitstellung: 'documentIntelligence.clause.materialbereitstellung',
  baustrom: 'documentIntelligence.clause.baustrom',
  bauwasser: 'documentIntelligence.clause.bauwasser',
  geruest: 'documentIntelligence.clause.geruest',
  kran: 'documentIntelligence.clause.kran',
  entsorgung: 'documentIntelligence.clause.entsorgung',
  stundenlohnarbeiten: 'documentIntelligence.clause.stundenlohnarbeiten',
  wartezeit: 'documentIntelligence.clause.wartezeit',
  kuendigung: 'documentIntelligence.clause.kuendigung',
  abnahme: 'documentIntelligence.clause.abnahme',
};

const PARTY_ROLE_LABEL_KEYS: Record<ContractPartyRole, TranslationKey> = {
  auftraggeber: 'documentIntelligence.party.auftraggeber',
  auftragnehmer: 'documentIntelligence.party.auftragnehmer',
  subunternehmer: 'documentIntelligence.party.subunternehmer',
  nachunternehmer: 'documentIntelligence.party.nachunternehmer',
  kunde: 'documentIntelligence.party.kunde',
  dienstleister: 'documentIntelligence.party.dienstleister',
  vermieter: 'documentIntelligence.party.vermieter',
  mieter: 'documentIntelligence.party.mieter',
  leasinggeber: 'documentIntelligence.party.leasinggeber',
  leasingnehmer: 'documentIntelligence.party.leasingnehmer',
  verkaeufer: 'documentIntelligence.party.verkaeufer',
  kaeufer: 'documentIntelligence.party.kaeufer',
  versicherer: 'documentIntelligence.party.versicherer',
  versicherungsnehmer: 'documentIntelligence.party.versicherungsnehmer',
  arbeitgeber: 'documentIntelligence.party.arbeitgeber',
  arbeitnehmer: 'documentIntelligence.party.arbeitnehmer',
  unknown: 'documentIntelligence.party.unknown',
};

const FIELD_LABEL_KEYS: Record<string, TranslationKey> = {
  ansprechpartner: 'documentIntelligence.field.contact',
  vertragsnummer: 'documentIntelligence.field.contractNumber',
  vertragsdatum: 'documentIntelligence.field.contractDate',
  beginn: 'documentIntelligence.field.startDate',
  laufzeit: 'documentIntelligence.field.term',
  ende: 'documentIntelligence.field.endDate',
  kuendigungsfrist: 'documentIntelligence.field.noticePeriod',
  verlaengerung: 'documentIntelligence.field.renewal',
  vertragsgegenstand: 'documentIntelligence.field.subject',
  leistungsort: 'documentIntelligence.field.placeOfPerformance',
  zahlungsbedingungen: 'documentIntelligence.field.paymentTerms',
  gewaehrleistung: 'documentIntelligence.field.warranty',
  haftung: 'documentIntelligence.field.liability',
  bauvorhaben: 'documentIntelligence.field.project',
  baustelle: 'documentIntelligence.field.constructionSite',
  stundenlohn: 'documentIntelligence.field.hourlyRate',
  wartezeitregelung: 'documentIntelligence.field.waitingTime',
  sicherheitseinbehalt: 'documentIntelligence.field.retention',
  vertragsstrafe: 'documentIntelligence.field.penalty',
  bgBau: 'documentIntelligence.field.bgBau',
  sokaBau: 'documentIntelligence.field.sokaBau',
  leistungsbeschreibung: 'documentIntelligence.field.serviceDescription',
  leistungsintervall: 'documentIntelligence.field.serviceInterval',
  reaktionszeit: 'documentIntelligence.field.responseTime',
  servicezeit: 'documentIntelligence.field.serviceHours',
  pauschale: 'documentIntelligence.field.flatRate',
  stundenverrechnungssatz: 'documentIntelligence.field.billingRate',
  vermieter: 'documentIntelligence.party.vermieter',
  mieter: 'documentIntelligence.party.mieter',
  mietobjekt: 'documentIntelligence.field.rentalObject',
  mietbeginn: 'documentIntelligence.field.rentStart',
  kaltmiete: 'documentIntelligence.field.coldRent',
  nebenkosten: 'documentIntelligence.field.additionalCosts',
  kaution: 'documentIntelligence.field.deposit',
  leasinggeber: 'documentIntelligence.party.leasinggeber',
  leasingnehmer: 'documentIntelligence.party.leasingnehmer',
  leasingobjekt: 'documentIntelligence.field.leasingObject',
  leasingrate: 'documentIntelligence.field.leasingRate',
  sonderzahlung: 'documentIntelligence.field.specialPayment',
  restwert: 'documentIntelligence.field.residualValue',
  verkaeufer: 'documentIntelligence.party.verkaeufer',
  kaeufer: 'documentIntelligence.party.kaeufer',
  liefergegenstand: 'documentIntelligence.field.deliveryItem',
  liefertermin: 'documentIntelligence.field.deliveryDate',
  lieferort: 'documentIntelligence.field.deliveryPlace',
  eigentumsvorbehalt: 'documentIntelligence.field.retentionOfTitle',
  versicherer: 'documentIntelligence.party.versicherer',
  versicherungsnehmer: 'documentIntelligence.party.versicherungsnehmer',
  versicherungsart: 'documentIntelligence.field.insuranceType',
  beitrag: 'documentIntelligence.field.premium',
  selbstbeteiligung: 'documentIntelligence.field.deductible',
  arbeitgeber: 'documentIntelligence.party.arbeitgeber',
  arbeitnehmer: 'documentIntelligence.party.arbeitnehmer',
  taetigkeit: 'documentIntelligence.field.jobTitle',
  eintrittsdatum: 'documentIntelligence.field.startDate',
  arbeitsort: 'documentIntelligence.field.workPlace',
  arbeitszeit: 'documentIntelligence.field.workingTime',
  probezeit: 'documentIntelligence.field.probation',
  urlaub: 'documentIntelligence.field.vacation',
};

function readField(field?: ExtractedContractField): { value: string; needsReview: boolean } | null {
  if (!field || field.status === 'not_found') return null;
  const value = field.value?.trim();
  if (!value) return null;
  return {
    value,
    needsReview: field.status === 'review_required' || field.confidence === 'low',
  };
}

function pushFieldRows(
  rows: ContractWorkspaceSummaryRow[],
  fields: Record<string, ExtractedContractField> | undefined,
  keys: string[],
): void {
  if (!fields) return;
  for (const key of keys) {
    const parsed = readField(fields[key]);
    const labelKey = FIELD_LABEL_KEYS[key];
    if (!parsed || !labelKey) continue;
    rows.push({
      id: key,
      labelKey,
      value: parsed.value,
      needsReview: parsed.needsReview,
    });
  }
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

  const vorgang = context?.vorgang ?? null;
  const hasVorgang = Boolean(item.vorgangId) || Boolean(vorgang);
  if (!hasVorgang) return statusRows;

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

  if (vorgang && hasAbschlagsrechnung(vorgang)) {
    statusRows.push({
      id: 'abschlagsrechnung',
      labelKey: 'documentIntelligence.workspace.status.abschlagsrechnung',
      valueKey: 'documentIntelligence.workspace.status.abschlagPresent',
    });
  }

  if (vorgang && hasSchlussrechnung(vorgang)) {
    statusRows.push({
      id: 'schlussrechnung',
      labelKey: 'documentIntelligence.workspace.status.schlussrechnung',
      valueKey: 'documentIntelligence.workspace.status.schlussPresent',
    });
  }

  return statusRows;
}

function lacksRecognizedQuantity(position: DetectedOrderPosition): boolean {
  return !(Number.isFinite(position.quantity) && position.quantity > 0);
}

function lacksRecognizedUnitPrice(position: DetectedOrderPosition): boolean {
  return !(Number.isFinite(position.unitPrice) && position.unitPrice > 0);
}

function lacksRecognizedUnit(position: DetectedOrderPosition): boolean {
  return !(position.unit?.trim());
}

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

function buildClauseRows(proposal: ContractOrderProposal): ContractWorkspaceClauseRow[] {
  return (proposal.intelligence.clauses ?? [])
    .filter((clause) => clause.status !== 'not_found')
    .map((clause) => ({
      id: clause.id,
      labelKey: CLAUSE_LABEL_KEYS[clause.id],
      value: clause.summary?.trim() || clause.sourceText?.trim() || '—',
    }));
}

/**
 * Reiner View-Adapter: bildet nur bestehende Proposal-/Intelligence-/Inbox-/Vorgang-Werte ab.
 */
export function buildContractWorkspaceSummaryView(
  proposal: ContractOrderProposal,
  context?: ContractWorkspaceSummaryContext,
): ContractWorkspaceSummaryView {
  const intelligence = proposal.intelligence;
  const family = intelligence.contractType?.family ?? 'unknown';
  const kindKey = (intelligence.documentLabelKey ||
    intelligence.contractType?.labelKey ||
    'documentIntelligence.label.unknown') as TranslationKey;

  const overviewRows: ContractWorkspaceSummaryRow[] = [];
  const totalField = intelligence.contractTotalNet;
  const totalFromPositionSum = totalField?.sourceText?.trim() === POSITION_SUM_SOURCE;
  if (totalField?.value != null && !totalFromPositionSum && totalField.status !== 'not_found') {
    const formatted = proposal.contractTotalNet?.trim();
    if (formatted) {
      overviewRows.push({
        id: 'contractTotal',
        labelKey: 'documentIntelligence.field.contractTotal',
        value: formatted,
        needsReview: totalField.status === 'review_required' || totalField.confidence === 'low',
      });
    }
  }
  const date = readField(intelligence.commonFields?.vertragsdatum ?? intelligence.contractFields.vertragsdatum);
  if (date || proposal.contractDate) {
    overviewRows.push({
      id: 'contractDate',
      labelKey: 'documentIntelligence.field.contractDate',
      value: date?.value ?? proposal.contractDate!,
      needsReview: date?.needsReview ?? false,
    });
  }

  const partyRows: ContractWorkspacePartyRow[] = (intelligence.parties ?? []).map((party) => ({
    id: `${party.role}-${party.name}`,
    roleLabelKey: PARTY_ROLE_LABEL_KEYS[party.role],
    name: party.name,
  }));

  // Fallback parties from legacy fields when parties array absent.
  if (partyRows.length === 0) {
    const ag = readField(intelligence.contractFields.auftraggeber);
    const an = readField(intelligence.contractFields.auftragnehmer);
    if (ag) {
      partyRows.push({
        id: 'legacy-ag',
        roleLabelKey: 'documentIntelligence.party.auftraggeber',
        name: ag.value,
      });
    }
    if (an) {
      partyRows.push({
        id: 'legacy-an',
        roleLabelKey: 'documentIntelligence.party.auftragnehmer',
        name: an.value,
      });
    }
  }

  const generalRows: ContractWorkspaceSummaryRow[] = [];
  pushFieldRows(generalRows, intelligence.commonFields ?? intelligence.contractFields, [
    'ansprechpartner',
    'vertragsnummer',
    'vertragsgegenstand',
    'leistungsort',
    'beginn',
    'laufzeit',
    'ende',
    'kuendigungsfrist',
    'verlaengerung',
    'zahlungsbedingungen',
    'gewaehrleistung',
    'haftung',
  ]);
  if (!generalRows.some((row) => row.id === 'zahlungsbedingungen') && proposal.paymentTermsSummary) {
    generalRows.push({
      id: 'paymentTerms',
      labelKey: 'documentIntelligence.field.paymentTerms',
      value: proposal.paymentTermsSummary,
      needsReview: false,
    });
  }

  const typeSpecificRows: ContractWorkspaceSummaryRow[] = [];
  const typeFields = intelligence.typeSpecificFields ?? {};
  const typeKeys = Object.keys(typeFields).filter((key) => !PARTY_FIELD_KEYS.has(key));
  pushFieldRows(typeSpecificRows, typeFields, typeKeys);

  // Legacy fallback when typeSpecific empty but construction/service fields exist on contractFields.
  if (typeSpecificRows.length === 0) {
    pushFieldRows(typeSpecificRows, intelligence.contractFields, [
      'bauvorhaben',
      'baustelle',
      'stundenlohn',
      'wartezeitregelung',
      'sicherheitseinbehalt',
      'vertragsstrafe',
      'bgBau',
      'sokaBau',
      'kaltmiete',
      'mietobjekt',
      'leasingrate',
      'leasingobjekt',
      'pauschale',
      'reaktionszeit',
    ]);
  }

  // Combined rows for older consumers/tests (general + type-specific, no party duplicates).
  const rows = [...generalRows, ...typeSpecificRows];
  if (proposal.positions.length > 0) {
    rows.push({
      id: 'positions',
      labelKey: 'documentIntelligence.field.positions',
      value: String(proposal.positions.length),
      needsReview: false,
    });
  }

  return {
    titleKey: 'documentIntelligence.workspace.summaryTitle',
    disclaimerKey: 'documentIntelligence.workspace.summaryDisclaimer',
    contractKindLabelKey: kindKey,
    contractKindNeedsReview: intelligence.contractType?.status === 'review_required',
    overviewRows,
    partyRows,
    generalRows,
    typeSpecificRows,
    rows,
    clauseRows: buildClauseRows(proposal),
    statusRows: buildStatusRows(context),
    positionInsightRows: buildPositionInsightRows(proposal),
    reviewHintKeys: proposal.reviewHints.slice(),
    family,
  };
}
