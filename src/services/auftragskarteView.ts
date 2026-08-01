/**
 * UX-01 Auftragskarte — read-only view over existing contract proposal data.
 * No new extraction / AI / persistence.
 */
import type { TranslationKey } from '../i18n';
import type { ContractFamily, ContractOrderProposal } from '../types/documentIntelligence';
import type { InboxItem, Vorgang } from '../types/models';
import {
  buildContractWorkspaceSummaryView,
  type ContractWorkspaceSummaryView,
} from './contractWorkspaceSummaryView';
import { deriveContractScope } from './contractScopeDerivationService';

export type AuftragskarteRisk = {
  id: string;
  label: string;
};

export type AuftragskarteView = {
  customer?: string;
  customerLabelKey: TranslationKey;
  project?: string;
  projectLabelKey: TranslationKey;
  /** Site address — DOCUMENT-EXPERIENCE-02 first-screen fact. */
  constructionSite?: string;
  ownRoleLabelKey: TranslationKey;
  serviceSummary: string;
  /** Deterministic trade from CI / LV — Sprint C. */
  gewerk?: string;
  /** Grouped main services from LV — Sprint C. */
  hauptleistungen: string[];
  orderValue?: string;
  /** LV position count for first-screen fact. */
  positionCount: number;
  paymentTerms?: string;
  deadline?: string;
  risks: AuftragskarteRisk[];
  hasLeistungsumfang: boolean;
  contractKindLabelKey: TranslationKey;
};

const RISK_FIELD_IDS = [
  'vertragsstrafe',
  'sicherheitseinbehalt',
  'haftung',
  'gewaehrleistung',
] as const;

const CONSTRUCTION_FAMILIES = new Set<ContractFamily>(['werkvertrag', 'subunternehmervertrag']);

function shortenDescription(value: string, max = 72): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trim()}…`;
}

function stripLeadingArticle(value: string): string {
  return value.replace(/^(die|der|das|den|dem|des)\s+/i, '').trim();
}

function findPartyName(
  summary: ContractWorkspaceSummaryView,
  roleLabelKey: TranslationKey,
): string | undefined {
  return summary.partyRows.find((p) => p.roleLabelKey === roleLabelKey)?.name?.trim() || undefined;
}

const SUMMARY_MAX_CHARS = 280;

function clampSummary(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= SUMMARY_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, SUMMARY_MAX_CHARS - 1).trim()}…`;
}

/** Build a short craftsman-facing service sentence from existing fields / positions. */
export function buildServiceSummaryText(
  proposal: ContractOrderProposal,
  summary: ContractWorkspaceSummaryView,
): string {
  const fields = proposal.intelligence.contractFields ?? {};
  const leistungsbeschreibung = fields.leistungsbeschreibung?.value?.trim();
  if (leistungsbeschreibung) {
    const body = stripLeadingArticle(leistungsbeschreibung);
    if (/^sie\s+/i.test(body)) {
      return clampSummary(body.endsWith('.') ? body : `${body}.`);
    }
    return clampSummary(`Sie übernehmen ${body}.`);
  }

  const subject = summary.subject?.trim();
  const positions = proposal.positions.filter((p) => p.description?.trim());

  if (positions.length === 0) {
    if (subject) {
      const body = stripLeadingArticle(subject);
      if (summary.family === 'mietvertrag') {
        return clampSummary(`Mietobjekt: ${body}.`);
      }
      if (summary.family === 'wartungsvertrag' || summary.family === 'dienstleistungsvertrag') {
        return clampSummary(`Sie übernehmen: ${body}.`);
      }
      return clampSummary(`Sie übernehmen Arbeiten zu: ${body}.`);
    }
    return 'Die Leistung ist im Vertrag beschrieben – bitte unter „Vertrag anzeigen“ prüfen.';
  }

  if (positions.length === 1) {
    const only = stripLeadingArticle(shortenDescription(positions[0]!.description, 100));
    return clampSummary(`Sie übernehmen ${only}.`);
  }

  const main = stripLeadingArticle(shortenDescription(positions[0]!.description, 60));
  const rest = positions
    .slice(1, 4)
    .map((p) => stripLeadingArticle(shortenDescription(p.description, 40)))
    .filter(Boolean);

  if (rest.length === 0) {
    return clampSummary(`Sie übernehmen ${main}.`);
  }
  if (rest.length === 1) {
    return clampSummary(`Sie übernehmen ${main} einschließlich ${rest[0]}.`);
  }
  const last = rest[rest.length - 1]!;
  const head = rest.slice(0, -1).join(', ');
  return clampSummary(`Sie übernehmen ${main} einschließlich ${head} sowie ${last}.`);
}

function resolveOwnRoleLabelKey(
  proposal: ContractOrderProposal,
  summary: ContractWorkspaceSummaryView,
): TranslationKey {
  const parties = proposal.intelligence.parties ?? [];
  if (parties.some((p) => p.role === 'subunternehmer')) {
    return 'documentIntelligence.party.subunternehmer';
  }
  if (parties.some((p) => p.role === 'nachunternehmer')) {
    return 'documentIntelligence.party.nachunternehmer';
  }
  if (parties.some((p) => p.role === 'dienstleister')) {
    return 'documentIntelligence.party.dienstleister';
  }
  if (parties.some((p) => p.role === 'mieter')) {
    return 'documentIntelligence.party.mieter';
  }
  if (parties.some((p) => p.role === 'auftragnehmer')) {
    return 'documentIntelligence.party.auftragnehmer';
  }

  if (summary.family === 'subunternehmervertrag') {
    return 'documentIntelligence.party.subunternehmer';
  }
  if (summary.family === 'mietvertrag') {
    return 'documentIntelligence.party.mieter';
  }
  if (summary.family === 'wartungsvertrag' || summary.family === 'dienstleistungsvertrag') {
    return 'documentIntelligence.party.dienstleister';
  }

  const kind = proposal.intelligence.classifiedKind;
  if (kind === 'subunternehmervertrag') {
    return 'documentIntelligence.party.subunternehmer';
  }
  if (kind === 'nachunternehmervertrag') {
    return 'documentIntelligence.party.nachunternehmer';
  }

  return 'documentIntelligence.party.auftragnehmer';
}

function resolveCustomer(
  proposal: ContractOrderProposal,
  summary: ContractWorkspaceSummaryView,
): { name?: string; labelKey: TranslationKey } {
  if (summary.family === 'mietvertrag') {
    return {
      name:
        findPartyName(summary, 'documentIntelligence.party.vermieter') ||
        proposal.intelligence.contractFields?.vermieter?.value?.trim(),
      labelKey: 'documentIntelligence.party.vermieter',
    };
  }

  if (summary.family === 'wartungsvertrag' || summary.family === 'dienstleistungsvertrag') {
    return {
      name:
        findPartyName(summary, 'documentIntelligence.party.kunde') ||
        findPartyName(summary, 'documentIntelligence.party.auftraggeber') ||
        proposal.customer?.trim(),
      labelKey: 'documentIntelligence.party.kunde',
    };
  }

  return {
    name:
      findPartyName(summary, 'documentIntelligence.party.auftraggeber') ||
      proposal.customer?.trim() ||
      proposal.intelligence.contractFields?.auftraggeber?.value?.trim(),
    labelKey: 'auftragskarte.field.customer',
  };
}

function resolveProject(
  proposal: ContractOrderProposal,
  summary: ContractWorkspaceSummaryView,
): { name?: string; labelKey: TranslationKey } {
  const fields = proposal.intelligence.contractFields ?? {};

  if (summary.family === 'mietvertrag') {
    return {
      name:
        fields.mietobjekt?.value?.trim() ||
        summary.objectFact?.value?.trim() ||
        summary.subject?.trim(),
      labelKey: 'documentIntelligence.field.rentalObject',
    };
  }

  if (summary.family === 'wartungsvertrag' || summary.family === 'dienstleistungsvertrag') {
    return {
      name: summary.subject?.trim() || fields.vertragsgegenstand?.value?.trim(),
      labelKey: 'documentIntelligence.field.subject',
    };
  }

  return {
    name:
      fields.bauvorhaben?.value?.trim() ||
      summary.objectFact?.value?.trim() ||
      fields.baustelle?.value?.trim() ||
      proposal.constructionSite?.trim() ||
      summary.subject?.trim(),
    labelKey: 'auftragskarte.field.project',
  };
}

function resolvePaymentTerms(
  proposal: ContractOrderProposal,
  summary: ContractWorkspaceSummaryView,
): string | undefined {
  const fromFacts = summary.factRows.find(
    (r) => r.id === 'zahlungsbedingungen' || r.id === 'paymentTerms',
  )?.value;
  return fromFacts?.trim() || proposal.paymentTermsSummary?.trim() || undefined;
}

function looksLikeRiskValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3) return false;
  if (/^[.,;:%€\d]/.test(trimmed) && trimmed.length < 8) return false;
  return true;
}

const SHORT_RISK_BY_FIELD: Record<string, TranslationKey> = {
  vertragsstrafe: 'auftragskarte.risk.penalty',
  sicherheitseinbehalt: 'auftragskarte.risk.retention',
  haftung: 'auftragskarte.risk.liability',
  gewaehrleistung: 'auftragskarte.risk.warranty',
  bgBau: 'auftragskarte.risk.proofs',
  sokaBau: 'auftragskarte.risk.proofs',
};

const SHORT_RISK_BY_CLAUSE: Record<string, TranslationKey> = {
  abnahme: 'auftragskarte.risk.acceptance',
  kuendigung: 'auftragskarte.risk.termination',
  wartezeit: 'auftragskarte.risk.waiting',
  nachtraege: 'auftragskarte.risk.amendments',
};

function resolveRisks(
  proposal: ContractOrderProposal,
  summary: ContractWorkspaceSummaryView,
  translateLabel: (key: TranslationKey) => string,
): AuftragskarteRisk[] {
  const risks: AuftragskarteRisk[] = [];
  const push = (id: string, labelKey: TranslationKey) => {
    if (risks.length >= 3) return;
    if (risks.some((r) => r.id === id || r.label === translateLabel(labelKey))) return;
    risks.push({ id, label: translateLabel(labelKey) });
  };

  for (const id of RISK_FIELD_IDS) {
    if (risks.length >= 3) break;
    const row =
      summary.factRows.find((r) => r.id === id) ?? summary.typeSpecificRows.find((r) => r.id === id);
    if (!row?.value?.trim()) continue;
    const key = SHORT_RISK_BY_FIELD[id];
    if (key) push(id, key);
  }

  for (const id of ['bgBau', 'sokaBau'] as const) {
    if (risks.length >= 3) break;
    const row =
      summary.factRows.find((r) => r.id === id) ?? summary.typeSpecificRows.find((r) => r.id === id);
    if (!row?.value?.trim()) continue;
    push(id, 'auftragskarte.risk.proofs');
  }

  if (proposal.technicalAttachmentsLabel || proposal.intelligence.technicalAttachmentCount > 0) {
    push('proofs', 'auftragskarte.risk.proofs');
  }

  if (CONSTRUCTION_FAMILIES.has(summary.family) || risks.length < 3) {
    for (const clause of summary.clauseRows) {
      if (risks.length >= 3) break;
      const key = SHORT_RISK_BY_CLAUSE[clause.id];
      if (!key) continue;
      if (clause.id !== 'abnahme' && !looksLikeRiskValue(clause.shortValue ?? '')) continue;
      push(`clause-${clause.id}`, key);
    }
  }

  return risks.slice(0, 3);
}

export function buildAuftragskarteView(
  proposal: ContractOrderProposal,
  options: {
    item?: InboxItem;
    vorgang?: Vorgang | null;
    /** Used only to format risk labels; pass identity if unused in pure tests. */
    translate: (key: TranslationKey) => string;
  },
): AuftragskarteView {
  const summary = buildContractWorkspaceSummaryView(proposal, {
    item: options.item,
    vorgang: options.vorgang,
  });
  const customer = resolveCustomer(proposal, summary);
  const project = resolveProject(proposal, summary);
  const scope = deriveContractScope({
    intelligence: proposal.intelligence,
    positions: proposal.positions,
  });

  const constructionSite =
    proposal.constructionSite?.trim() ||
    proposal.intelligence.contractFields?.baustelle?.value?.trim() ||
    options.item?.recognizedData.Baustelle?.trim() ||
    options.item?.recognizedData.Baustellenadresse?.trim() ||
    undefined;

  return {
    customer: customer.name,
    customerLabelKey: customer.labelKey,
    project: project.name,
    projectLabelKey: project.labelKey,
    constructionSite,
    ownRoleLabelKey: resolveOwnRoleLabelKey(proposal, summary),
    serviceSummary: buildServiceSummaryText(proposal, summary),
    gewerk: scope.gewerk,
    hauptleistungen: scope.hauptleistungen,
    orderValue: summary.moneyMetric?.value?.trim() || proposal.contractTotalNet?.trim() || undefined,
    positionCount: proposal.positions.length,
    paymentTerms: resolvePaymentTerms(proposal, summary),
    deadline: summary.deadlineFact?.value?.trim() || undefined,
    risks: resolveRisks(proposal, summary, options.translate),
    hasLeistungsumfang: proposal.positions.length > 0,
    contractKindLabelKey: summary.contractKindLabelKey,
  };
}
