import type {
  ContractFamily,
  ContractOrderProposal,
  ContractPartyRole,
  DetectedContractClause,
  EnhancedDetectedOrderPosition,
  ExtractedContractField,
} from '../types/documentIntelligence';
import type { DetectedOrderPosition, InboxItem, Vorgang } from '../types/models';
import type { TranslationKey } from '../i18n';
import { isImportableLvPosition } from './contractPositionImportService';
import { cleanPartyFactValue } from './documentSummaryContent';
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
  /** Short line for default display; full value stays in `value`. */
  shortValue: string;
};

export type ContractWorkspacePartyRow = {
  id: string;
  roleLabelKey: TranslationKey;
  name: string;
  address?: string;
  contact?: string;
  isOwnCompany?: boolean;
};

export type ContractWorkspaceMoneyMetric = {
  id: string;
  labelKey: TranslationKey;
  value: string;
  needsReview: boolean;
};

export type ContractWorkspaceLvOverview = {
  positionCount: number;
  totalLabel?: string;
  importableCount: number;
  needsReviewCount: number;
};

export type ContractWorkspaceSummaryView = {
  titleKey: TranslationKey;
  disclaimerKey: TranslationKey;
  contractKindLabelKey: TranslationKey;
  contractKindNeedsReview: boolean;
  statusBadgeKey: TranslationKey;
  subject?: string;
  moneyMetric: ContractWorkspaceMoneyMetric | null;
  objectFact: ContractWorkspaceSummaryRow | null;
  deadlineFact: ContractWorkspaceSummaryRow | null;
  overviewRows: ContractWorkspaceSummaryRow[];
  partyRows: ContractWorkspacePartyRow[];
  primaryPartyRows: ContractWorkspacePartyRow[];
  extraPartyRows: ContractWorkspacePartyRow[];
  factRows: ContractWorkspaceSummaryRow[];
  generalRows: ContractWorkspaceSummaryRow[];
  typeSpecificRows: ContractWorkspaceSummaryRow[];
  /** @deprecated use factRows — kept for older tests expecting rows */
  rows: ContractWorkspaceSummaryRow[];
  clauseRows: ContractWorkspaceClauseRow[];
  statusRows: ContractWorkspaceStatusRow[];
  positionInsightRows: ContractWorkspaceStatusRow[];
  lvOverview: ContractWorkspaceLvOverview | null;
  compactPositions: EnhancedDetectedOrderPosition[];
  reviewHintKeys: string[];
  family: ContractFamily;
  showTechnicalDetails: boolean;
  technicalMeta: {
    contractCorePages: string;
    billOfQuantitiesPages: string;
    technicalAttachmentCount: number;
  };
};

export type ContractWorkspaceSummaryContext = {
  item?: InboxItem;
  vorgang?: Vorgang | null;
};

const POSITION_SUM_SOURCE = 'Summe der erkannten Positionen';
export const CONTRACT_COMPACT_POSITION_LIMIT = 5;

function normalizeName(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Party-name fields are shown in the parties section — not again under facts. */
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

const CLAUSE_PRIORITY: DetectedContractClause['id'][] = [
  'kuendigung',
  'stundenlohnarbeiten',
  'wartezeit',
  'abnahme',
  'nachtraege',
  'behinderungsanzeige',
  'materialbereitstellung',
  'baustrom',
  'bauwasser',
  'geruest',
  'kran',
  'entsorgung',
];

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
  mietobjekt: 'documentIntelligence.field.rentalObject',
  mietbeginn: 'documentIntelligence.field.rentStart',
  kaltmiete: 'documentIntelligence.field.coldRent',
  nebenkosten: 'documentIntelligence.field.additionalCosts',
  kaution: 'documentIntelligence.field.deposit',
  leasingobjekt: 'documentIntelligence.field.leasingObject',
  leasingrate: 'documentIntelligence.field.leasingRate',
  sonderzahlung: 'documentIntelligence.field.specialPayment',
  restwert: 'documentIntelligence.field.residualValue',
  liefergegenstand: 'documentIntelligence.field.deliveryItem',
  liefertermin: 'documentIntelligence.field.deliveryDate',
  lieferort: 'documentIntelligence.field.deliveryPlace',
  eigentumsvorbehalt: 'documentIntelligence.field.retentionOfTitle',
  versicherungsart: 'documentIntelligence.field.insuranceType',
  beitrag: 'documentIntelligence.field.premium',
  selbstbeteiligung: 'documentIntelligence.field.deductible',
  taetigkeit: 'documentIntelligence.field.jobTitle',
  eintrittsdatum: 'documentIntelligence.field.startDate',
  arbeitsort: 'documentIntelligence.field.workPlace',
  arbeitszeit: 'documentIntelligence.field.workingTime',
  probezeit: 'documentIntelligence.field.probation',
  urlaub: 'documentIntelligence.field.vacation',
};

const FACT_KEYS_BY_FAMILY: Partial<Record<ContractFamily, readonly string[]>> = {
  werkvertrag: [
    'bauvorhaben',
    'baustelle',
    'vertragsdatum',
    'beginn',
    'laufzeit',
    'zahlungsbedingungen',
    'gewaehrleistung',
    'vertragsstrafe',
    'sicherheitseinbehalt',
    'stundenlohn',
    'wartezeitregelung',
  ],
  subunternehmervertrag: [
    'bauvorhaben',
    'baustelle',
    'vertragsdatum',
    'beginn',
    'laufzeit',
    'zahlungsbedingungen',
    'gewaehrleistung',
    'vertragsstrafe',
    'sicherheitseinbehalt',
    'stundenlohn',
    'wartezeitregelung',
  ],
  wartungsvertrag: [
    'vertragsgegenstand',
    'leistungsbeschreibung',
    'leistungsintervall',
    'reaktionszeit',
    'laufzeit',
    'kuendigungsfrist',
    'pauschale',
    'zahlungsbedingungen',
  ],
  dienstleistungsvertrag: [
    'vertragsgegenstand',
    'leistungsbeschreibung',
    'reaktionszeit',
    'laufzeit',
    'kuendigungsfrist',
    'pauschale',
    'zahlungsbedingungen',
  ],
  mietvertrag: [
    'mietobjekt',
    'mietbeginn',
    'laufzeit',
    'kuendigungsfrist',
    'kaution',
    'nebenkosten',
    'kaltmiete',
    'vertragsdatum',
  ],
  leasingvertrag: [
    'leasingobjekt',
    'laufzeit',
    'kuendigungsfrist',
    'leasingrate',
    'sonderzahlung',
    'restwert',
    'vertragsdatum',
  ],
};

const DEFAULT_FACT_KEYS = [
  'vertragsnummer',
  'vertragsdatum',
  'vertragsgegenstand',
  'leistungsort',
  'beginn',
  'laufzeit',
  'ende',
  'kuendigungsfrist',
  'verlaengerung',
  'zahlungsbedingungen',
  'gewaehrleistung',
] as const;

function readField(field?: ExtractedContractField): { value: string; needsReview: boolean } | null {
  if (!field || field.status === 'not_found') return null;
  const value = field.value?.trim();
  if (!value) return null;
  return {
    value,
    needsReview: field.status === 'review_required' || field.confidence === 'low',
  };
}

/**
 * Date-/deadline-like fields. The extractor captures the whole remainder of an OCR
 * line, so a wrapped contract clause can end up in these fields. Display is
 * normalized here; the raw ContractIntelligenceResult stays untouched.
 */
const DATE_LIKE_FIELD_KEYS = new Set([
  'vertragsdatum',
  'beginn',
  'ende',
  'mietbeginn',
  'liefertermin',
  'eintrittsdatum',
]);

/** Upper bound for a value that still reads as a compact date/term, not a clause. */
const DATE_LIKE_MAX_LENGTH = 40;
const DATE_LIKE_MAX_WORDS = 6;

const DAY_DATE = String.raw`\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4}`;
const DATE_CORE_PATTERNS: Array<{ pattern: RegExp; build: (m: RegExpExecArray) => string }> = [
  // 01.09.2026 – 15.09.2026
  {
    pattern: new RegExp(String.raw`^(${DAY_DATE})\s*[–—-]\s*(${DAY_DATE})`),
    build: (m) => `${m[1].replace(/\s/g, '')} – ${m[2].replace(/\s/g, '')}`,
  },
  // 2026-09-01
  { pattern: /^(\d{4}-\d{2}-\d{2})/, build: (m) => m[1] },
  // 31.08.2026
  { pattern: new RegExp(String.raw`^(${DAY_DATE})`), build: (m) => m[1].replace(/\s/g, '') },
  // KW 36/2026
  {
    pattern: /^(KW\s*\d{1,2}\s*\/\s*\d{2,4})/i,
    build: (m) => m[1].replace(/\s*\/\s*/, '/').replace(/^KW\s*/i, 'KW '),
  },
];

/** A short, clause-free answer such as "KW 36/2026" or "nach Abruf" stays as-is. */
function isCompactDateLikeValue(value: string): boolean {
  if (value.length > DATE_LIKE_MAX_LENGTH) return false;
  if (/[;]/.test(value)) return false;
  if (value.split(' ').length > DATE_LIKE_MAX_WORDS) return false;
  return true;
}

function extractLeadingDateCore(value: string): { core: string; remainder: string } | null {
  for (const { pattern, build } of DATE_CORE_PATTERNS) {
    const match = pattern.exec(value);
    if (match) return { core: build(match), remainder: value.slice(match[0].length).trim() };
  }
  return null;
}

/**
 * Words that qualify the date itself: the shown core would then be only part of
 * the answer. Deliberately about conditions, not about topic — a follow-up
 * sentence on some other matter must not trip this.
 */
const DATE_CONDITION_PATTERN =
  /\b(vorbehaltlich|vorbehalt|bedingung|sofern|soweit|sobald|falls|spätestens|spaetestens|frühestens|fruehestens|voraussichtlich|vorläufig|vorlaeufig|unverbindlich|abhängig|abhaengig|ca\.|etwa|ggf\.|gegebenenfalls|bzw\.|oder|nach\s+(vereinbarung|abruf|absprache|aufforderung|zuschlag|baufortschritt|bedarf))\b/i;

/** A separate statement starts its own sentence or carries its own label. */
const SEPARATE_STATEMENT_PATTERN = /^(?:[A-ZÄÖÜ][\wäöüßÄÖÜ-]*(?:\s+[\wäöüßÄÖÜ-]+)*\s*:|[A-ZÄÖÜ§])/;

/**
 * Where the text that still belongs to the date ends: the next labelled field,
 * the next section mark, or the next sentence. Only a period followed by an
 * upper-case word counts as a sentence break, so abbreviations such as "bzw."
 * or "ca." stay inside the segment they qualify.
 */
const NEXT_SEGMENT_PATTERN =
  /[A-ZÄÖÜ][\wäöüßÄÖÜ-]*(?:\s+[\wäöüßÄÖÜ-]+){0,3}\s*:|§|[.!?]\s+[A-ZÄÖÜ]/;

/**
 * The part of the dropped tail that still qualifies the date itself.
 *
 * Without this bound a wrapped OCR page would let an unrelated later clause
 * decide the review status: page text can merge whole sections into one line.
 */
function localDateRemainder(remainder: string): string {
  const rest = remainder.replace(/^[\s,;:–—-]+/, '').trim();
  const boundary = rest.search(NEXT_SEGMENT_PATTERN);
  return (boundary >= 0 ? rest.slice(0, boundary) : rest).trim();
}

/**
 * Whether the part dropped from a date-like value still belongs to the date.
 *
 * Conservative by design: only clearly foreign follow-up text is treated as
 * harmless. Anything else keeps the review flag, because a hidden qualifier
 * would otherwise be presented as a firm date.
 */
export function isReviewRelevantDateRemainder(remainder: string): boolean {
  const local = localDateRemainder(remainder);
  // Nothing left once the next field/section starts — no qualifier on the date.
  if (!local) return false;
  if (DATE_CONDITION_PATTERN.test(local)) return true;
  // A lower-case continuation reads as part of the same date phrase.
  return !SEPARATE_STATEMENT_PATTERN.test(local);
}

/**
 * null when no compact date/term can be shown safely — the field is then omitted
 * from the compact view rather than rendering a contract paragraph as a date.
 *
 * `remainder` carries the dropped tail so callers can judge review relevance;
 * truncation on its own says nothing about how reliable the date is.
 */
export function normalizeDateLikeDisplayValue(
  raw: string,
): { value: string; truncated: boolean; remainder: string } | null {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  // A concrete date wins over length: "01.04.2026 bzw. nach Baufortschritt" is short
  // but still carries a qualifier that must not be shown as a firm date.
  const core = extractLeadingDateCore(cleaned);
  if (core) {
    return { value: core.core, truncated: core.remainder.length > 0, remainder: core.remainder };
  }
  // No parsable date — a short answer such as "nach Abruf" stays verbatim.
  if (isCompactDateLikeValue(cleaned)) return { value: cleaned, truncated: false, remainder: '' };
  return null;
}

function readDateLikeField(
  field?: ExtractedContractField,
): { value: string; needsReview: boolean } | null {
  const parsed = readField(field);
  if (!parsed) return null;
  const normalized = normalizeDateLikeDisplayValue(parsed.value);
  if (!normalized) return null;
  // Truncation alone is no defect — only a dropped qualifier makes the date unsure.
  return {
    value: normalized.value,
    needsReview: parsed.needsReview || isReviewRelevantDateRemainder(normalized.remainder),
  };
}

/** readField for every key; date-like keys additionally get display normalization. */
function readViewField(
  key: string,
  field?: ExtractedContractField,
): { value: string; needsReview: boolean } | null {
  return DATE_LIKE_FIELD_KEYS.has(key) ? readDateLikeField(field) : readField(field);
}

function fieldMap(
  intelligence: ContractOrderProposal['intelligence'],
): Record<string, ExtractedContractField> {
  return {
    ...(intelligence.commonFields ?? {}),
    ...(intelligence.typeSpecificFields ?? {}),
    ...intelligence.contractFields,
  };
}

function pushFieldRows(
  rows: ContractWorkspaceSummaryRow[],
  fields: Record<string, ExtractedContractField> | undefined,
  keys: readonly string[],
  skipIds?: Set<string>,
): void {
  if (!fields) return;
  for (const key of keys) {
    if (skipIds?.has(key)) continue;
    const parsed = readViewField(key, fields[key]);
    const labelKey = FIELD_LABEL_KEYS[key];
    if (!parsed || !labelKey) continue;
    if (rows.some((row) => row.id === key)) continue;
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

function shortenClauseText(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 90) return cleaned;
  return `${cleaned.slice(0, 87).trim()}…`;
}

function buildClauseRows(proposal: ContractOrderProposal): ContractWorkspaceClauseRow[] {
  const clauses = (proposal.intelligence.clauses ?? []).filter(
    (clause) => clause.status !== 'not_found',
  );
  const order = new Map(CLAUSE_PRIORITY.map((id, index) => [id, index]));
  clauses.sort((a, b) => (order.get(a.id) ?? 100) - (order.get(b.id) ?? 100));

  return clauses.map((clause) => {
    const value = clause.summary?.trim() || clause.sourceText?.trim() || '—';
    return {
      id: clause.id,
      labelKey: CLAUSE_LABEL_KEYS[clause.id],
      value,
      shortValue: shortenClauseText(value),
    };
  });
}

function resolveMoneyMetric(
  proposal: ContractOrderProposal,
  fields: Record<string, ExtractedContractField>,
): ContractWorkspaceMoneyMetric | null {
  const totalField = proposal.intelligence.contractTotalNet;
  const totalFromPositionSum = totalField?.sourceText?.trim() === POSITION_SUM_SOURCE;
  if (
    totalField?.value != null &&
    !totalFromPositionSum &&
    totalField.status !== 'not_found' &&
    proposal.contractTotalNet?.trim()
  ) {
    return {
      id: 'contractTotal',
      labelKey: 'documentIntelligence.field.contractTotal',
      value: proposal.contractTotalNet.trim(),
      needsReview: totalField.status === 'review_required' || totalField.confidence === 'low',
    };
  }

  const moneyCandidates: Array<{ id: string; labelKey: TranslationKey }> = [
    { id: 'pauschale', labelKey: 'documentIntelligence.field.flatRate' },
    { id: 'kaltmiete', labelKey: 'documentIntelligence.field.coldRent' },
    { id: 'leasingrate', labelKey: 'documentIntelligence.field.leasingRate' },
    { id: 'beitrag', labelKey: 'documentIntelligence.field.premium' },
  ];

  for (const candidate of moneyCandidates) {
    const parsed = readField(fields[candidate.id]);
    if (!parsed) continue;
    return {
      id: candidate.id,
      labelKey: candidate.labelKey,
      value: parsed.value,
      needsReview: parsed.needsReview,
    };
  }

  return null;
}

function resolveObjectFact(
  fields: Record<string, ExtractedContractField>,
  subject?: string,
): ContractWorkspaceSummaryRow | null {
  const keys = [
    'baustelle',
    'bauvorhaben',
    'mietobjekt',
    'leasingobjekt',
    'leistungsort',
    'liefergegenstand',
  ] as const;
  for (const key of keys) {
    const parsed = readField(fields[key]);
    const labelKey = FIELD_LABEL_KEYS[key];
    if (!parsed || !labelKey) continue;
    if (subject && parsed.value === subject) continue;
    return {
      id: key,
      labelKey,
      value: parsed.value,
      needsReview: parsed.needsReview,
    };
  }
  return null;
}

function resolveDeadlineFact(
  fields: Record<string, ExtractedContractField>,
): ContractWorkspaceSummaryRow | null {
  for (const key of ['kuendigungsfrist', 'laufzeit', 'beginn', 'mietbeginn'] as const) {
    const parsed = readViewField(key, fields[key]);
    const labelKey = FIELD_LABEL_KEYS[key];
    if (!parsed || !labelKey) continue;
    return {
      id: key,
      labelKey,
      value: parsed.value,
      needsReview: parsed.needsReview,
    };
  }
  return null;
}

function resolvePartyNameFromCandidates(
  ...candidates: Array<string | undefined | null>
): string | undefined {
  for (const candidate of candidates) {
    const cleaned = cleanPartyFactValue(candidate ?? '');
    if (!cleaned) continue;
    if (cleaned.length > 90) continue;
    if (/[.;:]/.test(cleaned) && cleaned.split(/\s+/).length > 8) continue;
    return cleaned;
  }
  return undefined;
}

function getPartyRolePriority(role: ContractPartyRole | undefined): number {
  switch (role) {
    case 'auftraggeber':
    case 'auftragnehmer':
    case 'subunternehmer':
    case 'nachunternehmer':
    case 'kunde':
    case 'dienstleister':
    case 'vermieter':
    case 'mieter':
    case 'leasinggeber':
    case 'leasingnehmer':
    case 'verkaeufer':
    case 'kaeufer':
    case 'versicherer':
    case 'versicherungsnehmer':
    case 'arbeitgeber':
      return 100;
    case 'arbeitnehmer':
    case 'unknown':
      return 50;
    default:
      return 0;
  }
}

function buildPartyRows(
  proposal: ContractOrderProposal,
  fields: Record<string, ExtractedContractField>,
  context?: ContractWorkspaceSummaryContext,
): ContractWorkspacePartyRow[] {
  const contact = readField(fields.ansprechpartner)?.value;
  const parties = proposal.intelligence.parties ?? [];
  const ownCompanyName = proposal.contractor?.trim();
  const isOwnCompanyParty = (role: ContractPartyRole | undefined, name: string) => {
    if (!ownCompanyName) return false;
    const ownCompanyRoles = new Set(['auftragnehmer', 'subunternehmer', 'nachunternehmer', 'dienstleister']);
    return ownCompanyRoles.has(role ?? 'unknown') && normalizeName(name) === normalizeName(ownCompanyName);
  };

  const rows: ContractWorkspacePartyRow[] = [];
  const seenRoles = new Set<ContractPartyRole>();
  const rowRolesByName = new Map<string, ContractPartyRole>();

  const addPartyRow = (role: ContractPartyRole, name: string | undefined, address?: string) => {
    const resolvedName = resolvePartyNameFromCandidates(name);
    if (!resolvedName || seenRoles.has(role)) return;

    const normalizedName = normalizeName(resolvedName);
    const currentPriority = getPartyRolePriority(role);
    const existingIndex = rows.findIndex((row) => normalizeName(row.name) === normalizedName);
    const existingRole = existingIndex >= 0 ? rowRolesByName.get(normalizedName) : undefined;

    if (existingRole) {
      const existingPriority = getPartyRolePriority(existingRole);
      if (existingPriority >= currentPriority) return;
      rows.splice(existingIndex, 1);
      rowRolesByName.delete(normalizedName);
    }

    seenRoles.add(role);
    rows.push({
      id: `${role}-${resolvedName}`,
      roleLabelKey: PARTY_ROLE_LABEL_KEYS[role],
      name: resolvedName,
      address: address?.trim() || undefined,
      contact,
      isOwnCompany: isOwnCompanyParty(role, resolvedName),
    });
    rowRolesByName.set(normalizedName, role);
  };

  addPartyRow(
    'auftraggeber',
    resolvePartyNameFromCandidates(
      readField(fields.auftraggeber)?.value,
      proposal.customer?.trim(),
      context?.item?.recognizedData.Kunde?.trim(),
      context?.item?.recognizedData.Empfänger?.trim(),
      context?.item?.recognizedData.Empfaenger?.trim(),
    ),
  );

  addPartyRow(
    'auftragnehmer',
    resolvePartyNameFromCandidates(
      readField(fields.auftragnehmer)?.value,
      proposal.contractor?.trim(),
      context?.item?.sender?.trim(),
      context?.item?.recognizedData.Lieferant?.trim(),
    ),
  );

  for (const party of parties) {
    const resolvedName = resolvePartyNameFromCandidates(party.name);
    if (!resolvedName) continue;
    if (party.role === 'auftraggeber' || party.role === 'auftragnehmer') continue;
    addPartyRow(party.role, resolvedName, party.address);
  }

  if (rows.length > 0) {
    return rows;
  }

  const ag = readField(fields.auftraggeber);
  const an = readField(fields.auftragnehmer);
  if (ag) {
    rows.push({
      id: 'legacy-ag',
      roleLabelKey: 'documentIntelligence.party.auftraggeber',
      name: resolvePartyNameFromCandidates(ag.value) ?? ag.value,
      contact,
    });
  }
  if (an) {
    rows.push({
      id: 'legacy-an',
      roleLabelKey: 'documentIntelligence.party.auftragnehmer',
      name: resolvePartyNameFromCandidates(an.value) ?? an.value,
      isOwnCompany: isOwnCompanyParty('auftragnehmer', an.value),
    });
  }
  return rows;
}

function buildLvOverview(proposal: ContractOrderProposal): ContractWorkspaceLvOverview | null {
  const positions = proposal.positions;
  if (!positions.length) return null;

  let importable = 0;
  let needsReviewCount = 0;
  for (const position of positions) {
    if (isImportableLvPosition(position)) importable += 1;
    if (position.reviewStatus === 'review_required') needsReviewCount += 1;
  }

  const totalField = proposal.intelligence.contractTotalNet;
  const totalFromPositionSum = totalField?.sourceText?.trim() === POSITION_SUM_SOURCE;
  const totalLabel =
    proposal.contractTotalNet?.trim() && !totalFromPositionSum
      ? proposal.contractTotalNet.trim()
      : undefined;

  return {
    positionCount: positions.length,
    totalLabel,
    importableCount: importable,
    needsReviewCount,
  };
}

function resolveContractFamily(intelligence: ContractOrderProposal['intelligence']): ContractFamily {
  if (intelligence.contractType?.family) {
    return intelligence.contractType.family;
  }
  const kind = intelligence.classifiedKind;
  if (kind === 'werkvertrag') return 'werkvertrag';
  if (kind === 'subunternehmervertrag' || kind === 'nachunternehmervertrag') {
    return 'subunternehmervertrag';
  }
  return 'unknown';
}

/**
 * Reiner View-Adapter: bildet nur bestehende Proposal-/Intelligence-/Inbox-/Vorgang-Werte ab.
 */
export function buildContractWorkspaceSummaryView(
  proposal: ContractOrderProposal,
  context?: ContractWorkspaceSummaryContext,
): ContractWorkspaceSummaryView {
  const intelligence = proposal.intelligence;
  const family = resolveContractFamily(intelligence);
  const fields = fieldMap(intelligence);
  const kindKey = (intelligence.documentLabelKey ||
    intelligence.contractType?.labelKey ||
    'documentIntelligence.label.unknown') as TranslationKey;

  // Badge reflects recognition of the contract type — not position-level review hints.
  const needsReview =
    intelligence.contractType?.status === 'review_required' ||
    family === 'general_contract' ||
    family === 'unknown';

  const subject = readField(fields.vertragsgegenstand)?.value;
  const moneyMetric = resolveMoneyMetric(proposal, fields);
  const objectFact = resolveObjectFact(fields, subject);
  const deadlineFact = resolveDeadlineFact(fields);

  const overviewRows: ContractWorkspaceSummaryRow[] = [];
  if (moneyMetric) {
    overviewRows.push({
      id: moneyMetric.id,
      labelKey: moneyMetric.labelKey,
      value: moneyMetric.value,
      needsReview: moneyMetric.needsReview,
    });
  }
  const date = readViewField('vertragsdatum', fields.vertragsdatum);
  const fallbackDate = proposal.contractDate
    ? normalizeDateLikeDisplayValue(proposal.contractDate)
    : null;
  if (date || fallbackDate) {
    overviewRows.push({
      id: 'contractDate',
      labelKey: 'documentIntelligence.field.contractDate',
      value: date?.value ?? fallbackDate!.value,
      needsReview:
        date?.needsReview ?? isReviewRelevantDateRemainder(fallbackDate!.remainder),
    });
  }

  const partyRows = buildPartyRows(proposal, fields, context);
  const primaryPartyRows = partyRows.slice(0, 2);
  const extraPartyRows = partyRows.slice(2);

  const chefSkip = new Set<string>();
  if (moneyMetric) chefSkip.add(moneyMetric.id);
  if (objectFact) chefSkip.add(objectFact.id);
  if (deadlineFact) chefSkip.add(deadlineFact.id);
  if (subject) chefSkip.add('vertragsgegenstand');
  chefSkip.add('ansprechpartner');

  const factKeys = FACT_KEYS_BY_FAMILY[family] ?? DEFAULT_FACT_KEYS;
  const factRows: ContractWorkspaceSummaryRow[] = [];
  pushFieldRows(factRows, fields, factKeys, chefSkip);
  // Fill remaining safe common fields not already shown.
  pushFieldRows(factRows, fields, DEFAULT_FACT_KEYS, new Set([...chefSkip, ...factRows.map((r) => r.id)]));

  if (!factRows.some((row) => row.id === 'zahlungsbedingungen') && proposal.paymentTermsSummary) {
    factRows.push({
      id: 'paymentTerms',
      labelKey: 'documentIntelligence.field.paymentTerms',
      value: proposal.paymentTermsSummary,
      needsReview: false,
    });
  }

  // Legacy general/typeSpecific partitions for older tests.
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

  const rows = [...factRows];
  if (proposal.positions.length > 0) {
    rows.push({
      id: 'positions',
      labelKey: 'documentIntelligence.field.positions',
      value: String(proposal.positions.length),
      needsReview: false,
    });
  }

  const segmentation = intelligence.segmentation;

  return {
    titleKey: 'documentIntelligence.workspace.summaryTitle',
    disclaimerKey: 'documentIntelligence.workspace.summaryDisclaimer',
    contractKindLabelKey: kindKey,
    contractKindNeedsReview: needsReview,
    statusBadgeKey: needsReview
      ? 'documentIntelligence.workspace.statusBadge.needsReview'
      : 'documentIntelligence.workspace.statusBadge.confirmed',
    subject,
    moneyMetric,
    objectFact,
    deadlineFact,
    overviewRows,
    partyRows,
    primaryPartyRows,
    extraPartyRows,
    factRows,
    generalRows,
    typeSpecificRows,
    rows,
    clauseRows: buildClauseRows(proposal),
    statusRows: buildStatusRows(context),
    positionInsightRows: buildPositionInsightRows(proposal),
    lvOverview: buildLvOverview(proposal),
    compactPositions: proposal.positions.slice(0, CONTRACT_COMPACT_POSITION_LIMIT),
    reviewHintKeys: proposal.reviewHints.slice(),
    family,
    showTechnicalDetails:
      segmentation.contractCorePages.length > 0 ||
      segmentation.billOfQuantitiesPages.length > 0 ||
      intelligence.technicalAttachmentCount > 0,
    technicalMeta: {
      contractCorePages: segmentation.contractCorePages.join(', ') || '–',
      billOfQuantitiesPages: segmentation.billOfQuantitiesPages.join(', ') || '–',
      technicalAttachmentCount: intelligence.technicalAttachmentCount,
    },
  };
}
