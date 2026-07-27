import type {
  BusinessConditionType,
  BusinessEventType,
  BusinessFactCertainty,
  BusinessFactSource,
  BusinessInterpretationConflict,
  BusinessLabeledFact,
  BusinessMoneyKind,
  BusinessPartyRelation,
  BusinessStructuredFacts,
  BusinessStructuredMoney,
  BusinessStructuredParty,
  BusinessStructuredPosition,
} from '../types/businessInterpretation';
import type {
  ContractFamily,
  ContractPartyRole,
  ExtractedContractField,
  ExtractedFieldStatus,
  FieldConfidenceLevel,
} from '../types/documentIntelligence';
import type { InboxItem, Vorgang, WorkflowResult } from '../types/models';
import { getCompanyProfile } from './companyProfileService';

type WorkflowCore = Omit<WorkflowResult, 'businessInterpretation'>;

/** Families that may forward structured LV / order positions. */
const PERFORMANCE_PLAN_FAMILIES: ReadonlySet<ContractFamily> = new Set([
  'werkvertrag',
  'subunternehmervertrag',
  'general_contract',
]);

const NON_PERFORMANCE_PLAN_FAMILIES: ReadonlySet<ContractFamily> = new Set([
  'mietvertrag',
  'leasingvertrag',
  'wartungsvertrag',
  'versicherungsvertrag',
  'arbeitsvertrag',
  'kaufvertrag',
]);

/** Families with directed AG/AN counterparty ↔ own-company mapping. */
const DIRECTED_WORK_FAMILIES: ReadonlySet<ContractFamily> = new Set([
  'werkvertrag',
  'subunternehmervertrag',
]);

const CONTRACTISH_EVENTS: ReadonlySet<BusinessEventType> = new Set([
  'possible_new_business_case',
  'business_case_update',
  'contract_proposed',
  'order_confirmed',
  'service_change_proposed',
]);

const INVOICEISH_EVENTS: ReadonlySet<BusinessEventType> = new Set([
  'invoice_received',
  'invoice_created',
  'payment_reminder_received',
]);

const COUNTERPARTY_ROLES_DIRECTED: ReadonlySet<ContractPartyRole> = new Set([
  'auftraggeber',
  'kunde',
]);

const OWN_COMPANY_ROLES_DIRECTED: ReadonlySet<ContractPartyRole> = new Set([
  'auftragnehmer',
  'subunternehmer',
  'nachunternehmer',
  'dienstleister',
]);

function isDirectedWorkFamily(family: ContractFamily | undefined): boolean {
  return Boolean(family && DIRECTED_WORK_FAMILIES.has(family));
}

function isInvoiceishEvent(eventType: BusinessEventType): boolean {
  return INVOICEISH_EVENTS.has(eventType);
}

function isContractishEvent(eventType: BusinessEventType): boolean {
  return CONTRACTISH_EVENTS.has(eventType);
}

function parseAmountNumber(raw: string | number | undefined | null): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (raw == null) return undefined;
  const cleaned = String(raw).replace(/[^\d,.-]/g, '').trim();
  if (!cleaned) return undefined;
  let normalized = cleaned;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',')) {
    normalized = cleaned.replace(',', '.');
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

/** Currency only when an existing source string explicitly mentions it. */
function currencyFromSourceText(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  if (/€|\bEUR\b/i.test(raw)) return 'EUR';
  return undefined;
}
function normalizeName(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function fieldCertainty(
  status: ExtractedFieldStatus | undefined,
  confidence?: FieldConfidenceLevel,
): BusinessFactCertainty {
  if (status === 'review_required') return 'uncertain';
  if (status === 'confirmed') {
    return confidence === 'low' ? 'uncertain' : 'detected';
  }
  return 'detected';
}

function fieldValue(
  fields: Record<string, ExtractedContractField> | undefined,
  key: string,
): ExtractedContractField | undefined {
  const field = fields?.[key];
  if (!field || field.status === 'not_found' || !field.value?.toString().trim()) return undefined;
  return field;
}

function labeledFromField(
  fields: Record<string, ExtractedContractField> | undefined,
  key: string,
  source: BusinessFactSource = 'contractIntelligence',
): BusinessLabeledFact | undefined {
  const field = fieldValue(fields, key);
  if (!field?.value) return undefined;
  return {
    value: String(field.value).trim(),
    certainty: fieldCertainty(field.status, field.confidence),
    source,
    fieldKey: key,
  };
}

function pickFirstLabeled(
  candidates: Array<BusinessLabeledFact | undefined>,
): BusinessLabeledFact | undefined {
  return candidates.find(Boolean);
}

function resolveFamily(workflow: WorkflowCore): ContractFamily | undefined {
  return (
    workflow.contractIntelligence?.contractType?.family ??
    workflow.contractOrderProposal?.intelligence.contractType?.family
  );
}

function allContractFields(workflow: WorkflowCore): Record<string, ExtractedContractField> {
  const intelligence =
    workflow.contractIntelligence ?? workflow.contractOrderProposal?.intelligence ?? null;
  if (!intelligence) return {};
  return {
    ...(intelligence.commonFields ?? {}),
    ...(intelligence.typeSpecificFields ?? {}),
    ...intelligence.contractFields,
  };
}

function allowsPositions(
  family: ContractFamily | undefined,
  eventType: BusinessEventType,
): boolean {
  if (isInvoiceishEvent(eventType)) return false;
  if (!family) return false;
  if (NON_PERFORMANCE_PLAN_FAMILIES.has(family)) return false;
  return (
    PERFORMANCE_PLAN_FAMILIES.has(family) ||
    family === 'liefervertrag' ||
    family === 'rahmenvertrag'
  );
}

function mapRoleRelation(
  role: ContractPartyRole | undefined,
  family: ContractFamily | undefined,
): BusinessPartyRelation {
  if (!role || role === 'unknown') return 'other';
  if (isDirectedWorkFamily(family)) {
    if (COUNTERPARTY_ROLES_DIRECTED.has(role)) return 'counterparty';
    if (OWN_COMPANY_ROLES_DIRECTED.has(role)) return 'own_company';
  }
  // Kauf/Miete/Leasing/Versicherung/Arbeit/allgemein: keep role, do not guess side.
  return 'other';
}

function buildParty(
  name: string,
  relation: BusinessPartyRelation,
  source: BusinessFactSource,
  certainty: BusinessFactCertainty,
  role?: ContractPartyRole | 'unknown',
  contactPerson?: string,
): BusinessStructuredParty {
  return {
    name: name.trim(),
    role,
    relation,
    contactPerson,
    certainty,
    source,
  };
}

function buildPartiesBlock(
  workflow: WorkflowCore,
  linkedVorgang: Vorgang | null | undefined,
  conflicts: BusinessInterpretationConflict[],
  family: ContractFamily | undefined,
): BusinessStructuredFacts['parties'] {
  const intelligence =
    workflow.contractIntelligence ?? workflow.contractOrderProposal?.intelligence ?? null;
  const proposal = workflow.contractOrderProposal;
  const fields = allContractFields(workflow);
  const profile = getCompanyProfile();
  const others: BusinessStructuredParty[] = [];
  let counterparty: BusinessStructuredParty | undefined;
  let ownCompany: BusinessStructuredParty | undefined;

  const pushOther = (party: BusinessStructuredParty) => {
    if (
      others.some(
        (existing) =>
          normalizeName(existing.name) === normalizeName(party.name) &&
          existing.relation === party.relation,
      )
    ) {
      return;
    }
    others.push(party);
  };

  for (const party of intelligence?.parties ?? []) {
    if (!party.name.trim()) continue;
    const relation = mapRoleRelation(party.role, family);
    const structured = buildParty(
      party.name,
      relation,
      'contractIntelligence',
      fieldCertainty(party.status, party.confidence),
      party.role,
    );
    if (relation === 'counterparty' && !counterparty) counterparty = structured;
    else if (relation === 'own_company' && !ownCompany) ownCompany = structured;
    else pushOther(structured);
  }

  if (proposal?.customer?.trim()) {
    if (!counterparty && isDirectedWorkFamily(family)) {
      counterparty = buildParty(
        proposal.customer,
        'counterparty',
        'contractOrderProposal',
        'proposed',
        'auftraggeber',
      );
    } else if (!counterparty) {
      pushOther(
        buildParty(
          proposal.customer,
          'other',
          'contractOrderProposal',
          'proposed',
          'unknown',
        ),
      );
    } else if (
      isDirectedWorkFamily(family) &&
      normalizeName(proposal.customer) !== normalizeName(counterparty.name) &&
      !normalizeName(counterparty.name).includes(normalizeName(proposal.customer)) &&
      !normalizeName(proposal.customer).includes(normalizeName(counterparty.name))
    ) {
      conflicts.push({
        id: 'party_counterparty_source_mismatch',
        summary: `Gegenpartei aus Proposal („${proposal.customer}“) weicht von Contract Intelligence („${counterparty.name}“) ab.`,
        certainty: 'conflicting',
      });
      counterparty = { ...counterparty, certainty: 'conflicting' };
    }
  }

  if (proposal?.contractor?.trim()) {
    if (!ownCompany && isDirectedWorkFamily(family)) {
      ownCompany = buildParty(
        proposal.contractor,
        'own_company',
        'contractOrderProposal',
        'proposed',
        'auftragnehmer',
      );
    } else if (!ownCompany) {
      pushOther(
        buildParty(
          proposal.contractor,
          'other',
          'contractOrderProposal',
          'proposed',
          'unknown',
        ),
      );
    }
  }

  const understandingCustomer = workflow.documentUnderstanding?.customer;
  if (understandingCustomer?.trim() && !counterparty) {
    if (isDirectedWorkFamily(family)) {
      counterparty = buildParty(
        understandingCustomer,
        'counterparty',
        'understanding',
        workflow.documentUnderstanding?.uncertainFields?.includes('customer')
          ? 'uncertain'
          : 'detected',
        'kunde',
      );
    } else {
      pushOther(
        buildParty(
          understandingCustomer,
          'other',
          'understanding',
          workflow.documentUnderstanding?.uncertainFields?.includes('customer')
            ? 'uncertain'
            : 'detected',
          'kunde',
        ),
      );
    }
  }

  const recognizedCustomer =
    workflow.classification?.recognizedData?.Kunde ||
    workflow.classification?.recognizedData?.Auftraggeber;
  if (recognizedCustomer?.trim() && !counterparty) {
    if (isDirectedWorkFamily(family)) {
      counterparty = buildParty(
        recognizedCustomer,
        'counterparty',
        'recognizedData',
        'detected',
        'kunde',
      );
    } else {
      pushOther(
        buildParty(recognizedCustomer, 'other', 'recognizedData', 'detected', 'kunde'),
      );
    }
  }

  if (linkedVorgang?.customer?.trim()) {
    const stateParty = buildParty(
      linkedVorgang.customer,
      'counterparty',
      'vorgangState',
      'confirmed_by_existing_state',
      'kunde',
    );
    if (!counterparty) {
      counterparty = stateParty;
    } else if (
      normalizeName(linkedVorgang.customer) !== normalizeName(counterparty.name) &&
      !normalizeName(counterparty.name).includes(normalizeName(linkedVorgang.customer)) &&
      !normalizeName(linkedVorgang.customer).includes(normalizeName(counterparty.name))
    ) {
      conflicts.push({
        id: 'party_vorgang_customer_mismatch',
        summary: `Erkannte Gegenpartei („${counterparty.name}“) weicht vom Vorgangskunden („${linkedVorgang.customer}“) ab.`,
        certainty: 'conflicting',
      });
      counterparty = { ...counterparty, certainty: 'conflicting' };
    }
  }

  if (!ownCompany && profile.companyName.trim()) {
    const matchesContractor =
      proposal?.contractor &&
      normalizeName(proposal.contractor).includes(normalizeName(profile.companyName));
    if (matchesContractor) {
      ownCompany = buildParty(
        profile.companyName,
        'own_company',
        'companyProfile',
        'detected',
        'auftragnehmer',
      );
    }
  }

  const contactPerson = labeledFromField(fields, 'ansprechpartner');

  return {
    counterparty,
    ownCompany,
    others,
    contactPerson,
  };
}

function buildSubject(
  workflow: WorkflowCore,
  linkedVorgang: Vorgang | null | undefined,
  family: ContractFamily | undefined,
  conflicts: BusinessInterpretationConflict[],
): BusinessStructuredFacts['subject'] {
  const fields = allContractFields(workflow);
  const proposal = workflow.contractOrderProposal;

  const subject = pickFirstLabeled([
    labeledFromField(fields, 'vertragsgegenstand'),
    labeledFromField(fields, 'leistungsbeschreibung'),
  ]);

  const project = labeledFromField(fields, 'bauvorhaben');

  const object = pickFirstLabeled([
    labeledFromField(fields, 'mietobjekt'),
    labeledFromField(fields, 'leasingobjekt'),
    family === 'wartungsvertrag' || family === 'dienstleistungsvertrag'
      ? labeledFromField(fields, 'leistungsbeschreibung')
      : undefined,
  ]);

  let site = pickFirstLabeled([
    labeledFromField(fields, 'baustelle'),
    labeledFromField(fields, 'leistungsort'),
    proposal?.constructionSite?.trim()
      ? {
          value: proposal.constructionSite.trim(),
          certainty: 'proposed' as const,
          source: 'contractOrderProposal' as const,
          fieldKey: 'constructionSite',
        }
      : undefined,
    workflow.documentUnderstanding?.constructionSite
      ? {
          value: workflow.documentUnderstanding.constructionSite,
          certainty: 'detected' as const,
          source: 'understanding' as const,
          fieldKey: 'constructionSite',
        }
      : undefined,
  ]);

  if (linkedVorgang?.baustelle?.trim()) {
    if (!site) {
      site = {
        value: linkedVorgang.baustelle,
        certainty: 'confirmed_by_existing_state',
        source: 'vorgangState',
        fieldKey: 'baustelle',
      };
    } else if (
      normalizeName(site.value) !== normalizeName(linkedVorgang.baustelle) &&
      !normalizeName(site.value).includes(normalizeName(linkedVorgang.baustelle)) &&
      !normalizeName(linkedVorgang.baustelle).includes(normalizeName(site.value))
    ) {
      conflicts.push({
        id: 'site_vorgang_mismatch',
        summary: `Erkannte Baustelle/Ort („${site.value}“) weicht von der Vorgangsbaustelle („${linkedVorgang.baustelle}“) ab.`,
        certainty: 'conflicting',
      });
      site = { ...site, certainty: 'conflicting' };
    }
  }

  return { subject, object, project, site };
}

function buildTimeline(
  workflow: WorkflowCore,
  item: InboxItem,
): BusinessStructuredFacts['timeline'] {
  const fields = allContractFields(workflow);
  const proposal = workflow.contractOrderProposal;

  const contractDate = pickFirstLabeled([
    labeledFromField(fields, 'vertragsdatum'),
    proposal?.contractDate
      ? {
          value: proposal.contractDate,
          certainty: 'proposed' as const,
          source: 'contractOrderProposal' as const,
          fieldKey: 'contractDate',
        }
      : undefined,
  ]);

  const start = pickFirstLabeled([
    labeledFromField(fields, 'ausfuehrungsbeginn'),
    labeledFromField(fields, 'beginn'),
    labeledFromField(fields, 'mietbeginn'),
  ]);

  const end = pickFirstLabeled([
    labeledFromField(fields, 'fertigstellung'),
    labeledFromField(fields, 'ende'),
  ]);

  const duration = labeledFromField(fields, 'laufzeit');

  const deadlineRaw =
    workflow.documentUnderstanding?.deadline ||
    workflow.classification?.deadline ||
    item.deadline ||
    item.recognizedData.Faelligkeit ||
    item.recognizedData.Frist;
  const deadline = deadlineRaw
    ? {
        value: String(deadlineRaw),
        certainty: 'detected' as const,
        source: (workflow.documentUnderstanding?.deadline
          ? 'understanding'
          : 'recognizedData') as BusinessFactSource,
        fieldKey: 'deadline',
      }
    : undefined;

  return { contractDate, start, end, duration, deadline };
}

function pushMoney(
  list: BusinessStructuredMoney[],
  entry: BusinessStructuredMoney,
): void {
  if (
    list.some(
      (existing) =>
        existing.kind === entry.kind &&
        existing.amount === entry.amount &&
        existing.amountFormatted === entry.amountFormatted,
    )
  ) {
    return;
  }
  list.push(entry);
}

function buildMoney(
  workflow: WorkflowCore,
  item: InboxItem,
  eventType: BusinessEventType,
  family: ContractFamily | undefined,
  conflicts: BusinessInterpretationConflict[],
): BusinessStructuredMoney[] {
  const money: BusinessStructuredMoney[] = [];
  const intelligence =
    workflow.contractIntelligence ?? workflow.contractOrderProposal?.intelligence ?? null;
  const fields = allContractFields(workflow);
  const proposal = workflow.contractOrderProposal;

  if (isInvoiceishEvent(eventType)) {
    const amount =
      workflow.documentUnderstanding?.amount ||
      workflow.classification?.recognizedData?.Betrag ||
      item.recognizedData.Betrag ||
      item.recognizedData.Rechnungsbetrag ||
      item.recognizedData.Bruttobetrag;
    if (amount) {
      const amountFormatted = String(amount);
      pushMoney(money, {
        kind: 'invoice_total',
        amount: parseAmountNumber(amountFormatted),
        amountFormatted,
        currency: currencyFromSourceText(amountFormatted),
        label: 'Rechnungsbetrag',
        certainty: 'detected',
        source: workflow.documentUnderstanding?.amount ? 'understanding' : 'recognizedData',
      });
    }
    return money;
  }

  if (!isContractishEvent(eventType)) {
    return money;
  }

  const total = intelligence?.contractTotalNet;
  if (total?.value != null) {
    const fromBoqSum = /summe der erkannten positionen/i.test(total.sourceText ?? '');
    const kind: BusinessMoneyKind = fromBoqSum ? 'boq_total' : 'contract_total';
    const amountFormatted =
      proposal?.contractTotalNet ??
      (typeof total.value === 'number' ? String(total.value) : undefined);
    pushMoney(money, {
      kind,
      amount: total.value,
      amountFormatted,
      currency: currencyFromSourceText(
        `${amountFormatted ?? ''} ${total.sourceText ?? ''}`,
      ),
      label: fromBoqSum
        ? 'LV-/Positionssumme (nicht ausdrücklich als Vertragssumme erkannt)'
        : 'Vertragssumme',
      certainty: fieldCertainty(total.status, total.confidence),
      source: 'contractIntelligence',
    });
  } else if (proposal?.contractTotalNet?.trim()) {
    const amountFormatted = proposal.contractTotalNet.trim();
    pushMoney(money, {
      kind: 'contract_total',
      amount: parseAmountNumber(amountFormatted),
      amountFormatted,
      currency: currencyFromSourceText(amountFormatted),
      label: 'Vertragssumme',
      certainty: 'proposed',
      source: 'contractOrderProposal',
    });
  }

  const kaltmiete = labeledFromField(fields, 'kaltmiete');
  if (kaltmiete) {
    pushMoney(money, {
      kind: 'rent',
      amount: parseAmountNumber(kaltmiete.value),
      amountFormatted: kaltmiete.value,
      currency: currencyFromSourceText(kaltmiete.value),
      label: 'Kaltmiete',
      certainty: kaltmiete.certainty,
      source: kaltmiete.source,
    });
  }

  const pauschale = labeledFromField(fields, 'pauschale');
  if (pauschale) {
    pushMoney(money, {
      kind:
        family === 'wartungsvertrag' || family === 'dienstleistungsvertrag'
          ? 'recurring_fee'
          : 'fixed_fee',
      amount: parseAmountNumber(pauschale.value),
      amountFormatted: pauschale.value,
      currency: currencyFromSourceText(pauschale.value),
      label: 'Pauschale',
      certainty: pauschale.certainty,
      source: pauschale.source,
    });
  }

  const stundenlohn = labeledFromField(fields, 'stundenlohn');
  if (stundenlohn) {
    pushMoney(money, {
      kind: 'hourly_rate',
      amount: parseAmountNumber(stundenlohn.value),
      amountFormatted: stundenlohn.value,
      currency: currencyFromSourceText(stundenlohn.value),
      label: 'Stundenlohn',
      certainty: stundenlohn.certainty,
      source: stundenlohn.source,
    });
  }

  const stundenSatz = labeledFromField(fields, 'stundenverrechnungssatz');
  if (stundenSatz) {
    pushMoney(money, {
      kind: 'hourly_rate',
      amount: parseAmountNumber(stundenSatz.value),
      amountFormatted: stundenSatz.value,
      currency: currencyFromSourceText(stundenSatz.value),
      label: 'Stundenverrechnungssatz',
      certainty: stundenSatz.certainty,
      source: stundenSatz.source,
    });
  }

  // Comparable totals only: contract_total vs boq_total, numeric comparison.
  const totals = money.filter((m) => m.kind === 'contract_total' || m.kind === 'boq_total');
  if (totals.length >= 2) {
    const a = totals[0]!;
    const b = totals[1]!;
    const amountA = a.amount ?? parseAmountNumber(a.amountFormatted);
    const amountB = b.amount ?? parseAmountNumber(b.amountFormatted);
    if (
      amountA != null &&
      amountB != null &&
      Math.abs(amountA - amountB) > 0.05
    ) {
      conflicts.push({
        id: 'money_total_kind_mismatch',
        summary: 'Mehrere unterschiedliche Geldkennzahlen (Vertragssumme vs. LV-Summe) vorhanden.',
        certainty: 'conflicting',
      });
    }
  }

  // Same-kind numeric conflicts (e.g. two contract_total entries).
  for (const kind of ['contract_total', 'boq_total', 'invoice_total', 'rent', 'hourly_rate'] as const) {
    const sameKind = money.filter((entry) => entry.kind === kind);
    if (sameKind.length < 2) continue;
    const amounts = sameKind
      .map((entry) => entry.amount ?? parseAmountNumber(entry.amountFormatted))
      .filter((value): value is number => value != null);
    if (amounts.length < 2) continue;
    const first = amounts[0]!;
    if (amounts.some((value) => Math.abs(value - first) > 0.05)) {
      conflicts.push({
        id: `money_same_kind_mismatch_${kind}`,
        summary: `Abweichende Beträge derselben Geldart (${kind}) erkannt.`,
        certainty: 'conflicting',
      });
    }
  }

  return money;
}

function buildPositions(
  workflow: WorkflowCore,
  family: ContractFamily | undefined,
  eventType: BusinessEventType,
): BusinessStructuredPosition[] {
  if (!allowsPositions(family, eventType)) return [];

  const intelligence =
    workflow.contractIntelligence ?? workflow.contractOrderProposal?.intelligence ?? null;
  const sourcePositions =
    workflow.contractOrderProposal?.positions ??
    intelligence?.positions ??
    [];

  // Prefer enhanced positions from intelligence/proposal — never invent from prose.
  if (sourcePositions.length === 0) return [];

  return sourcePositions.map((position, index) => {
    const reviewStatus = 'reviewStatus' in position ? position.reviewStatus : undefined;
    const confidence = 'confidence' in position ? position.confidence : undefined;
    let certainty: BusinessFactCertainty = 'proposed';
    if (reviewStatus === 'review_required' || confidence === 'low') certainty = 'uncertain';
    else if (reviewStatus === 'confirmed' || confidence === 'high') certainty = 'detected';

    return {
      id: `pos-${index + 1}`,
      description: position.description,
      quantity: position.quantity,
      unit: position.unit,
      unitPrice: position.unitPrice,
      lineTotal: position.lineTotal,
      sourcePage: 'sourcePage' in position ? position.sourcePage : undefined,
      reviewStatus,
      certainty,
      source: workflow.contractOrderProposal?.positions?.length
        ? 'contractOrderProposal'
        : 'contractIntelligence',
    };
  });
}

function pushCondition(
  list: BusinessStructuredFacts['conditions'],
  type: BusinessConditionType,
  summary: string,
  certainty: BusinessFactCertainty,
  source: BusinessFactSource,
  sourceText?: string,
): void {
  if (list.some((entry) => entry.type === type && normalizeName(entry.summary) === normalizeName(summary))) {
    return;
  }
  list.push({ type, summary, certainty, source, sourceText });
}

function buildConditions(
  workflow: WorkflowCore,
): BusinessStructuredFacts['conditions'] {
  const conditions: BusinessStructuredFacts['conditions'] = [];
  const intelligence =
    workflow.contractIntelligence ?? workflow.contractOrderProposal?.intelligence ?? null;
  const fields = allContractFields(workflow);
  const proposal = workflow.contractOrderProposal;

  const addField = (key: string, type: BusinessConditionType, label?: string) => {
    const field = labeledFromField(fields, key);
    if (!field) return;
    pushCondition(
      conditions,
      type,
      label ? `${label}: ${field.value}` : field.value,
      field.certainty,
      field.source,
      field.value,
    );
  };

  addField('zahlungsbedingungen', 'payment_terms', 'Zahlungsbedingungen');
  addField('gewaehrleistung', 'warranty', 'Gewährleistung');
  addField('vertragsstrafe', 'contractual_penalty', 'Vertragsstrafe');
  addField('sicherheitseinbehalt', 'retention_or_security', 'Sicherheitseinbehalt');
  addField('stundenlohn', 'hourly_work', 'Stundenlohn');
  addField('wartezeitregelung', 'waiting_time', 'Wartezeit');
  addField('bgBau', 'bg_bau', 'BG BAU');
  addField('sokaBau', 'soka_bau', 'SOKA-BAU');
  addField('kuendigungsfrist', 'termination', 'Kündigungsfrist');
  addField('verlaengerung', 'renewal', 'Verlängerung');
  addField('leistungsintervall', 'service_interval', 'Leistungsintervall');
  addField('reaktionszeit', 'reaction_time', 'Reaktionszeit');
  addField('materialkosten', 'material', 'Materialkosten');
  addField('materialbereitstellung', 'material', 'Materialbereitstellung');

  if (proposal?.paymentTermsSummary?.trim()) {
    pushCondition(
      conditions,
      'payment_terms',
      proposal.paymentTermsSummary.trim(),
      'proposed',
      'contractOrderProposal',
      proposal.paymentTermsSummary.trim(),
    );
  }

  for (const term of intelligence?.paymentTerms ?? []) {
    pushCondition(
      conditions,
      term.type === 'schlussrechnung' ? 'final_invoice' : 'payment_terms',
      term.label,
      'detected',
      'contractIntelligence',
      term.value,
    );
  }

  if (intelligence?.progressBillingAllowed) {
    pushCondition(
      conditions,
      'advance_payment',
      'Abschlagszahlungen laut vorhandenen Zahlungsbedingungen möglich.',
      'detected',
      'contractIntelligence',
    );
  }
  if (intelligence?.finalInvoiceMentioned) {
    pushCondition(
      conditions,
      'final_invoice',
      'Schlussrechnung in den Vertragsdaten erwähnt.',
      'detected',
      'contractIntelligence',
    );
  }

  for (const clause of intelligence?.clauses ?? []) {
    const typeMap: Partial<Record<string, BusinessConditionType>> = {
      materialbereitstellung: 'material',
      stundenlohnarbeiten: 'hourly_work',
      wartezeit: 'waiting_time',
      abnahme: 'acceptance',
      // nachtraege: intentionally not mapped — not an evidence_requirement
      behinderungsanzeige: 'evidence_requirement',
      kuendigung: 'termination',
    };
    const type = typeMap[clause.id];
    if (!type) continue;
    pushCondition(
      conditions,
      type,
      clause.summary ?? clause.id,
      fieldCertainty(clause.status, clause.confidence),
      'contractIntelligence',
      clause.sourceText,
    );
  }

  return conditions;
}

function buildSignatures(workflow: WorkflowCore): BusinessStructuredFacts['signatures'] {
  const pages = workflow.contractAnalysis?.signaturePages ?? [];
  if (pages.length > 0) {
    const hints = pages.map((page) => page.pageHint);
    const hasAg = hints.some((hint) => /auftraggeber/i.test(hint));
    const hasAn = hints.some((hint) => /auftragnehmer/i.test(hint));
    let status: BusinessStructuredFacts['signatures']['status'] = 'detected';
    if (hasAg !== hasAn && (hasAg || hasAn)) status = 'partial';
    return {
      status,
      pageHints: hints,
      partyHint: hasAg && hasAn ? 'beide Seiten angedeutet' : hasAg ? 'Auftraggeber' : hasAn ? 'Auftragnehmer' : undefined,
      certainty: 'detected',
      source: 'contractAnalysis',
    };
  }

  if (workflow.contractAnalysis || workflow.contractIntelligence || workflow.contractOrderProposal) {
    return {
      status: 'unclear',
      certainty: 'uncertain',
      source: workflow.contractAnalysis ? 'contractAnalysis' : 'contractIntelligence',
    };
  }

  return {
    status: 'unclear',
    certainty: 'uncertain',
    source: 'recognizedData',
  };
}

export interface BuildStructuredBusinessFactsInput {
  item: InboxItem;
  workflow: WorkflowCore;
  linkedVorgang?: Vorgang | null;
  eventType: BusinessEventType;
}

export interface BuildStructuredBusinessFactsResult {
  facts: BusinessStructuredFacts;
  conflicts: BusinessInterpretationConflict[];
}

/**
 * Forward existing specialist facts into a structured read-only block.
 * Does not extract new values from OCR/text.
 */
export function buildStructuredBusinessFacts(
  input: BuildStructuredBusinessFactsInput,
): BuildStructuredBusinessFactsResult {
  const conflicts: BusinessInterpretationConflict[] = [];
  const family = resolveFamily(input.workflow);
  const parties = buildPartiesBlock(input.workflow, input.linkedVorgang, conflicts, family);
  const subject = buildSubject(input.workflow, input.linkedVorgang, family, conflicts);
  const timeline = buildTimeline(input.workflow, input.item);
  const money = buildMoney(
    input.workflow,
    input.item,
    input.eventType,
    family,
    conflicts,
  );
  const positions = buildPositions(input.workflow, family, input.eventType);
  const conditions = buildConditions(input.workflow);
  const signatures = buildSignatures(input.workflow);

  return {
    facts: {
      parties,
      subject,
      timeline,
      money,
      positions,
      conditions,
      signatures,
    },
    conflicts,
  };
}
