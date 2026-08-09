/**
 * DOCUMENT-SUMMARY — deterministic projection to DocumentSummary.
 * Sources only: CI / Proposal / Understanding / RecognizedData / BI / Letter.
 * No new parsers, extraction, or AI.
 */
import type { TranslationKey } from '../i18n';
import { formatMessage } from '../i18n/formatMessage';
import type {
  DocumentSummary,
  DocumentSummaryActionId,
  DocumentSummaryActionRef,
  DocumentSummaryAlert,
  DocumentSummaryFact,
  DocumentSummaryFamily,
} from '../types/documentSummary';
import {
  DOCUMENT_SUMMARY_MAX_ALERTS,
  DOCUMENT_SUMMARY_MAX_FACTS,
  DOCUMENT_SUMMARY_MAX_SECONDARY,
} from '../types/documentSummary';
import type { BusinessInterpretationResult } from '../types/businessInterpretation';
import type { ContractOrderProposal } from '../types/documentIntelligence';
import type {
  AppLanguage,
  ClassifiedDocumentKind,
  InboxItem,
  Vorgang,
  WorkflowResult,
} from '../types/models';
import { getDocumentDisplayLabelKey } from './documentDisplayLabelService';
import { isAuthorityClassifiedKind } from './businessInterpretationMeaning';
import type { LetterExplanation } from './letterExplanationService';
import { buildAuftragskarteView } from './auftragskarteView';
import { UNKNOWN_SENDER_CANONICAL } from '../i18n/resolveStoredText';
import {
  formatPositionsFactValue,
  formatSummaryFactValue,
  preferMeaningfulParty,
  preferProjectFactValue,
  preferVorgangFactValue,
  pickBestConstructionSiteCandidate,
  sortContractSummaryFacts,
} from './documentSummaryContent';
import { composeIntelligentDocumentSubject } from './documentSubjectIntelligence';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import { attachDocumentCaseMatch } from './documentCaseMatchPresentation';

export type BuildDocumentSummaryOptions = {
  translate: (key: TranslationKey) => string;
  displayBusinessInterpretation?: BusinessInterpretationResult | null;
  letter?: LetterExplanation | null;
  /** Explicit proposal when workflow is incomplete (contract panel). */
  proposal?: ContractOrderProposal | null;
  vorgang?: Vorgang | null;
  generatedAt?: string;
  /** inbox = list card (type as title, review/later actions). */
  presentation?: 'detail' | 'inbox';
};

function rd(item: InboxItem, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = item.recognizedData[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function resolveKind(
  item: InboxItem,
  workflow: WorkflowResult | null | undefined,
  proposal: ContractOrderProposal | null | undefined,
): ClassifiedDocumentKind {
  return (
    proposal?.intelligence.classifiedKind ??
    item.classifiedKind ??
    workflow?.classifiedKind ??
    workflow?.classification?.classifiedKind ??
    'sonstiges'
  );
}

export function resolveDocumentSummaryFamily(
  item: InboxItem,
  workflow: WorkflowResult | null | undefined,
  proposal?: ContractOrderProposal | null,
): DocumentSummaryFamily {
  if (proposal || workflow?.contractOrderProposal) return 'contract';
  const kind = resolveKind(item, workflow, proposal);
  const docType = item.documentType;

  if (kind === 'tankbeleg') return 'tank';
  if (kind === 'lieferschein') return 'delivery';
  if (kind === 'angebot') return 'offer';
  if (kind === 'ausgangsrechnung' || docType === 'ausgangsrechnung') return 'invoice_out';
  if (kind === 'eingangsrechnung' || kind === 'rechnung' || docType === 'eingangsrechnung') {
    return 'invoice_in';
  }
  if (isAuthorityClassifiedKind(kind) || docType === 'behoerde') return 'authority';
  if (
    kind === 'brief' ||
    kind === 'schriftverkehr' ||
    kind === 'email_pdf' ||
    docType === 'brief'
  ) {
    return 'letter';
  }
  if (
    kind === 'werkvertrag' ||
    kind === 'subunternehmervertrag' ||
    kind === 'nachunternehmervertrag' ||
    kind === 'auftrag'
  ) {
    return 'contract';
  }
  return 'generic';
}

/** Priority: BI truth → Understanding → RD → generic fallback. Never invent qty×price totals. */
function moneyNonContract(
  item: InboxItem,
  workflow: WorkflowResult | null | undefined,
  bi: BusinessInterpretationResult | null,
): string | undefined {
  const biMoney = bi?.facts.money.find((m) => m.amountFormatted || m.amount != null);
  return firstNonEmpty(
    biMoney?.amountFormatted,
    (() => {
      const entry = biMoney;
      if (entry?.amount == null) return undefined;
      return `${entry.amount.toLocaleString('de-DE')} ${entry.currency ?? 'EUR'}`;
    })(),
    workflow?.documentUnderstanding?.amount,
    rd(item, 'Betrag', 'Rechnungsbetrag', 'Bruttobetrag', 'Angebotssumme'),
  );
}

/** Priority: BI timeline → Understanding → item → RD */
function deadlineFromSources(
  item: InboxItem,
  workflow: WorkflowResult | null | undefined,
  bi: BusinessInterpretationResult | null,
): string | undefined {
  return firstNonEmpty(
    bi?.facts.timeline.deadline?.value,
    workflow?.documentUnderstanding?.deadline,
    item.deadline,
    rd(item, 'Frist', 'Fälligkeit', 'Faelligkeit'),
  );
}

function pushFact(
  facts: DocumentSummaryFact[],
  id: string,
  labelKey: TranslationKey,
  value: string | undefined,
): void {
  const formatted = value ? formatSummaryFactValue(id, value) : '';
  if (!formatted) return;
  if (facts.length >= DOCUMENT_SUMMARY_MAX_FACTS) return;
  if (facts.some((f) => f.id === id)) return;
  facts.push({ id, labelKey, value: formatted });
}

function pushFactWithLabel(
  facts: DocumentSummaryFact[],
  id: string,
  labelKey: TranslationKey,
  value: string | undefined,
): void {
  pushFact(facts, id, labelKey, value);
}

function primaryActionForFamily(family: DocumentSummaryFamily): DocumentSummaryActionRef {
  switch (family) {
    case 'contract':
      return {
        id: 'accept_contract_order',
        labelKey: 'auftragskarte.action.accept',
        enabled: true,
      };
    case 'invoice_in':
      return {
        id: 'record_expense',
        labelKey: 'documentExperience.action.recordExpense',
        enabled: true,
      };
    case 'tank':
      return {
        id: 'record_expense',
        labelKey: 'classification.action.recordExpense',
        enabled: true,
      };
    case 'invoice_out':
      return {
        id: 'review_document',
        labelKey: 'documentExperience.action.review',
        enabled: true,
      };
    case 'delivery':
      return {
        id: 'link_vorgang',
        labelKey: 'classification.action.linkVorgang',
        enabled: true,
      };
    case 'authority':
    case 'letter':
      return {
        id: 'create_task',
        labelKey: 'classification.action.createTask',
        enabled: true,
      };
    case 'offer':
      return {
        id: 'create_vorgang',
        labelKey: 'classification.action.createVorgang',
        enabled: true,
      };
    default:
      return {
        id: 'apply_intake',
        labelKey: 'documentExperience.action.continue',
        enabled: true,
      };
  }
}

function secondaryForFamily(family: DocumentSummaryFamily): DocumentSummaryActionRef[] {
  const later: DocumentSummaryActionRef = {
    id: 'later',
    labelKey: 'documentExperience.action.later',
    enabled: true,
  };
  if (family === 'contract') {
    const contractSecondary: DocumentSummaryActionRef[] = [
      {
        id: 'contract_inquiry',
        labelKey: 'auftragskarte.action.inquiry',
        enabled: true,
      },
      {
        id: 'reject_contract_proposal',
        labelKey: 'auftragskarte.action.reject',
        enabled: true,
      },
    ];
    return contractSecondary.slice(0, DOCUMENT_SUMMARY_MAX_SECONDARY);
  }
  const actions: DocumentSummaryActionRef[] = [];
  if (family === 'invoice_in' || family === 'delivery') {
    actions.push({
      id: 'link_vorgang',
      labelKey: 'classification.action.linkVorgang',
      enabled: true,
    });
  } else if (family === 'invoice_out' || family === 'offer') {
    actions.push({
      id: 'link_vorgang',
      labelKey: 'documentExperience.action.openCase',
      enabled: true,
    });
  }
  actions.push(later);
  return actions.slice(0, DOCUMENT_SUMMARY_MAX_SECONDARY);
}

function buildHeadline(
  family: DocumentSummaryFamily,
  typeLabel: string,
  party: string | undefined,
  money: string | undefined,
  deadline: string | undefined,
  translate: (key: TranslationKey) => string,
): string {
  const parts = [typeLabel];
  if (party) parts.push(party);
  if (
    money &&
    (family === 'invoice_in' || family === 'invoice_out' || family === 'tank' || family === 'offer')
  ) {
    parts.push(money);
  } else if (
    deadline &&
    (family === 'authority' || family === 'letter' || family === 'invoice_in')
  ) {
    parts.push(`${translate('documentExperience.fact.deadline')}: ${deadline}`);
  }
  const joined = parts.join(' · ');
  return joined.length > 80 ? `${joined.slice(0, 79).trim()}…` : joined;
}

function buildNonContractAlerts(input: {
  family: DocumentSummaryFamily;
  bi: BusinessInterpretationResult | null;
  letter: LetterExplanation | null;
  translate: (key: TranslationKey) => string;
  missingDeliveryQty: boolean;
  missingMoney: boolean;
}): DocumentSummaryAlert[] {
  const alerts: DocumentSummaryAlert[] = [];
  const push = (alert: DocumentSummaryAlert) => {
    const text = alert.label?.trim() || (alert.labelKey ? input.translate(alert.labelKey) : '');
    if (!text || alerts.length >= DOCUMENT_SUMMARY_MAX_ALERTS) return;
    if (alerts.some((a) => a.id === alert.id)) return;
    alerts.push(alert);
  };

  if (input.letter) {
    const importanceKey = input.letter.importance.key;
    if (
      importanceKey === 'letter.explain.importance.critical' ||
      importanceKey === 'letter.explain.importance.high'
    ) {
      push({
        id: 'letter-importance',
        severity: importanceKey.endsWith('critical') ? 'critical' : 'review',
        label: formatMessage((key) => input.translate(key as TranslationKey), input.letter.importance),
      });
    }
  }

  if (input.missingDeliveryQty) {
    push({
      id: 'delivery-qty',
      severity: 'review',
      labelKey: 'documentExperience.alert.quantitiesMissing',
    });
  }
  if (input.missingMoney && (input.family === 'invoice_in' || input.family === 'tank')) {
    push({
      id: 'money-missing',
      severity: 'review',
      labelKey: 'documentExperience.alert.amountMissing',
    });
  }

  if (input.bi?.sourceDocument.recognitionUncertain) {
    push({
      id: 'recognition',
      severity: 'review',
      labelKey: 'operationalOverview.uncertainty.recognition',
    });
  }

  for (const line of input.bi?.missingInformation ?? []) {
    if (alerts.length >= DOCUMENT_SUMMARY_MAX_ALERTS) break;
    push({ id: `gap-${line.id}`, severity: 'review', label: line.summary });
  }
  for (const line of input.bi?.conflicts ?? []) {
    if (alerts.length >= DOCUMENT_SUMMARY_MAX_ALERTS) break;
    push({ id: `conflict-${line.id}`, severity: 'review', label: line.summary });
  }

  return alerts.slice(0, DOCUMENT_SUMMARY_MAX_ALERTS);
}

function buildContractSummary(
  item: InboxItem,
  proposal: ContractOrderProposal,
  options: BuildDocumentSummaryOptions,
): DocumentSummary {
  const translate = options.translate;
  const ak = buildAuftragskarteView(proposal, {
    item,
    vorgang: options.vorgang,
    translate,
  });
  const kind = resolveKind(item, null, proposal);
  const facts: DocumentSummaryFact[] = [];

  // Order: Kunde → Projekt → Vertragssumme → Baustelle → Positionen → Gewerk
  pushFactWithLabel(facts, 'customer', ak.customerLabelKey, ak.customer);
  pushFactWithLabel(
    facts,
    'project',
    ak.projectLabelKey,
    preferProjectFactValue(
      proposal.intelligence.contractFields?.bauvorhaben?.value,
      ak.project,
    ),
  );
  pushFact(facts, 'orderValue', 'auftragskarte.field.orderValue', ak.orderValue);
  pushFact(facts, 'site', 'auftragskarte.field.constructionSite', ak.constructionSite);
  if (ak.positionCount > 0) {
    pushFact(
      facts,
      'positions',
      'auftragskarte.field.positions',
      translate('auftragskarte.field.positionCount').replace('{count}', String(ak.positionCount)),
    );
  }
  const gewerkDisplay = ak.gewerk?.trim() || translate('auftragskarte.gewerk.unknown');
  if (facts.length < DOCUMENT_SUMMARY_MAX_FACTS) {
    pushFact(facts, 'gewerk', 'auftragskarte.field.gewerk', gewerkDisplay);
  }

  const alerts: DocumentSummaryAlert[] = ak.risks.slice(0, DOCUMENT_SUMMARY_MAX_ALERTS).map((r) => ({
    id: r.id,
    severity: 'review' as const,
    label: r.label,
  }));

  const details = [
    {
      id: 'service',
      titleKey: 'auftragskarte.field.summary' as TranslationKey,
      proseText: ak.serviceSummary,
      rows: [
        {
          id: 'ownRole',
          labelKey: 'auftragskarte.field.ownRole' as TranslationKey,
          value: translate(ak.ownRoleLabelKey),
        },
      ],
      listItems: ak.hauptleistungen,
      listEmptyKey: 'auftragskarte.hauptleistungen.empty' as TranslationKey,
    },
  ];

  const primary = primaryActionForFamily('contract');
  const secondary = secondaryForFamily('contract');
  const typeLabelKey = getDocumentDisplayLabelKey(kind, item.documentType);
  const typeHeadline = translate(typeLabelKey);
  const customerFact = facts.find((f) => f.id === 'customer')?.value;
  const projectFact = facts.find((f) => f.id === 'project')?.value;
  const subtitle = [customerFact, projectFact].filter(Boolean).join(' · ') || undefined;

  return {
    id: `summary:${item.id}`,
    sourceInboxItemId: item.id,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    documentKind: kind,
    documentTypeLabelKey: typeLabelKey,
    family: 'contract',
    headline: typeHeadline,
    subtitle,
    facts: sortContractSummaryFacts(facts).slice(0, DOCUMENT_SUMMARY_MAX_FACTS),
    alerts,
    primaryAction: primary,
    secondaryActions: secondary,
    details,
    workspaceType: 'contract_order',
    hasDeepWorkspace: true,
  };
}

function buildNonContractSummary(
  item: InboxItem,
  workflow: WorkflowResult,
  options: BuildDocumentSummaryOptions,
): DocumentSummary {
  const translate = options.translate;
  const bi =
    options.displayBusinessInterpretation !== undefined
      ? options.displayBusinessInterpretation
      : workflow.businessInterpretation;
  const family = resolveDocumentSummaryFamily(item, workflow, null);
  const kind = resolveKind(item, workflow, null);
  const typeLabelKey = getDocumentDisplayLabelKey(kind, item.documentType);
  const typeLabel = translate(typeLabelKey);
  const understanding = workflow.documentUnderstanding;

  // Priority: BI truth → Understanding → RD → generic fallback (skip placeholders; Absender before Lieferant seed)
  const supplier = preferMeaningfulParty(
    bi?.facts.parties.counterparty?.name,
    understanding?.sender,
    rd(item, 'Absender', 'Lieferant', 'Tankstelle'),
    item.sender,
  );
  const customer = preferMeaningfulParty(
    bi?.facts.parties.counterparty?.name,
    understanding?.customer,
    understanding?.recipient,
    rd(item, 'Auftraggeber', 'Kunde', 'Empfänger'),
  );
  const invoiceNumber = firstNonEmpty(
    rd(item, 'Rechnungsnummer', 'Belegnummer'),
    understanding?.invoiceNumber,
  );
  const date = firstNonEmpty(
    bi?.facts.timeline.contractDate?.value,
    understanding?.date,
    rd(item, 'Datum', 'Belegdatum', 'Vertragsdatum'),
  );
  const site = pickBestConstructionSiteCandidate(
    bi?.facts.subject.site?.value,
    bi?.facts.subject.project?.value,
    understanding?.constructionSite,
    rd(item, 'Baustelle', 'Baustellenadresse'),
    rd(item, 'Straße'),
    rd(item, 'Projekt'),
  );
  const aktenzeichen = firstNonEmpty(
    rd(item, 'Aktenzeichen', 'Az', 'Beitragsnummer'),
    understanding?.referenceNumber,
  );
  const money = moneyNonContract(item, workflow, bi);
  const deadline = deadlineFromSources(item, workflow, bi);
  const tankstelle = preferMeaningfulParty(rd(item, 'Tankstelle'), supplier);

  const letter = options.letter ?? null;
  const formatLetter = (block: Parameters<typeof formatMessage>[1]) =>
    formatMessage((key) => translate(key as TranslationKey), block);
  const letterDemand = letter ? formatLetter(letter.nextSteps) : undefined;
  const letterAbout = letter ? formatLetter(letter.about) : undefined;
  const subjectSender =
    family === 'invoice_out' || family === 'offer'
      ? customer
      : isSenderUncertain(item)
        ? undefined
        : supplier;
  const subject = composeIntelligentDocumentSubject({
    text: getInboxExtractedDocumentText(item),
    typeLabel,
    betreff: firstNonEmpty(bi?.facts.subject.subject?.value, rd(item, 'Betreff')),
    letterAbout,
    vorgang: firstNonEmpty(understanding?.vorgang, rd(item, 'Vorgang')),
    project: firstNonEmpty(bi?.facts.subject.project?.value, rd(item, 'Bauvorhaben', 'Projekt')),
    sender: subjectSender,
    reference: aktenzeichen,
    title: item.title,
  });

  const facts: DocumentSummaryFact[] = [];

  if (family === 'invoice_in') {
    pushFact(facts, 'supplier', 'documentExperience.fact.supplier', supplier);
    pushFact(facts, 'invoiceNumber', 'documentExperience.fact.invoiceNumber', invoiceNumber);
    pushFact(facts, 'amount', 'documentExperience.fact.amount', money);
    pushFact(facts, 'date', 'documentExperience.fact.date', date);
    pushFact(facts, 'deadline', 'documentExperience.fact.due', deadline);
    pushFact(facts, 'site', 'documentExperience.fact.site', site);
  } else if (family === 'invoice_out') {
    pushFact(facts, 'customer', 'documentExperience.fact.recipient', customer || supplier);
    pushFact(facts, 'invoiceNumber', 'documentExperience.fact.invoiceNumber', invoiceNumber);
    pushFact(facts, 'amount', 'documentExperience.fact.amount', money);
    pushFact(facts, 'date', 'documentExperience.fact.date', date);
    pushFact(
      facts,
      'vorgang',
      'documentExperience.fact.case',
      preferVorgangFactValue(understanding?.vorgang, rd(item, 'Vorgang'), rd(item, 'Bauvorhaben', 'Projekt')),
    );
  } else if (family === 'tank') {
    pushFact(facts, 'station', 'documentExperience.fact.fuelStation', tankstelle);
    pushFact(facts, 'date', 'documentExperience.fact.date', date);
    pushFact(facts, 'amount', 'documentExperience.fact.amount', money);
    pushFact(
      facts,
      'receipt',
      'documentExperience.fact.receiptNumber',
      rd(item, 'Belegnummer', 'Rechnungsnummer'),
    );
  } else if (family === 'delivery') {
    pushFact(facts, 'supplier', 'documentExperience.fact.supplier', supplier);
    pushFact(facts, 'date', 'documentExperience.fact.date', date);
    pushFact(facts, 'site', 'documentExperience.fact.site', site);
    pushFact(
      facts,
      'vorgang',
      'documentExperience.fact.case',
      preferVorgangFactValue(understanding?.vorgang, rd(item, 'Vorgang'), rd(item, 'Bauvorhaben', 'Projekt')),
    );
    pushFact(facts, 'qty', 'documentExperience.fact.quantities', rd(item, 'Menge', 'Mengen'));
  } else if (family === 'authority') {
    pushFact(facts, 'authority', 'documentExperience.fact.authority', supplier);
    pushFact(facts, 'subject', 'documentExperience.fact.subject', subject);
    pushFact(facts, 'reference', 'documentExperience.fact.reference', aktenzeichen);
    pushFact(facts, 'deadline', 'documentExperience.fact.deadline', deadline);
    pushFact(facts, 'demand', 'documentExperience.fact.demand', letterDemand || letterAbout);
    if (money) pushFact(facts, 'amount', 'documentExperience.fact.amount', money);
  } else if (family === 'letter') {
    pushFact(facts, 'sender', 'documentExperience.fact.sender', supplier);
    pushFact(facts, 'subject', 'documentExperience.fact.subject', subject);
    pushFact(facts, 'deadline', 'documentExperience.fact.deadline', deadline);
    pushFact(
      facts,
      'demand',
      'documentExperience.fact.whatToDo',
      letterDemand || bi?.operational.nextStep,
    );
  } else if (family === 'offer') {
    pushFact(facts, 'customer', 'documentExperience.fact.customer', customer || supplier);
    pushFact(facts, 'subject', 'documentExperience.fact.subject', subject);
    pushFact(facts, 'amount', 'documentExperience.fact.amount', money);
    pushFact(facts, 'deadline', 'documentExperience.fact.validUntil', deadline);
    pushFact(facts, 'site', 'documentExperience.fact.site', site);
  } else {
    pushFact(facts, 'sender', 'documentExperience.fact.sender', supplier);
    pushFact(facts, 'subject', 'documentExperience.fact.subject', subject);
    pushFact(facts, 'amount', 'documentExperience.fact.amount', money);
    pushFact(facts, 'deadline', 'documentExperience.fact.deadline', deadline);
    pushFact(facts, 'site', 'documentExperience.fact.site', site);
  }

  const missingDeliveryQty = family === 'delivery' && !rd(item, 'Menge', 'Mengen');
  const missingMoney =
    !money && (family === 'invoice_in' || family === 'tank' || family === 'invoice_out');

  const alerts = buildNonContractAlerts({
    family,
    bi,
    letter,
    translate,
    missingDeliveryQty,
    missingMoney,
  });

  const partyForHeadline =
    family === 'invoice_out' || family === 'offer'
      ? customer || supplier
      : family === 'authority'
        ? supplier
        : supplier;

  const nextStep = firstNonEmpty(bi?.operational.nextStep, letterDemand);
  const details = nextStep
    ? [
        {
          id: 'nextStep',
          titleKey: 'documentExperience.details.nextStep' as TranslationKey,
          proseText: nextStep,
        },
      ]
    : [];

  const primary = primaryActionForFamily(family);
  if (!item.isAdvertisement && !workflow.companyRelevant) {
    primary.enabled = false;
  }

  return {
    id: `summary:${item.id}`,
    sourceInboxItemId: item.id,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    documentKind: kind,
    documentTypeLabelKey: typeLabelKey,
    family,
    headline: buildHeadline(family, typeLabel, partyForHeadline, money, deadline, translate),
    facts: facts.slice(0, DOCUMENT_SUMMARY_MAX_FACTS),
    alerts,
    primaryAction: primary,
    secondaryActions: secondaryForFamily(family),
    details,
    workspaceType: 'none',
    hasDeepWorkspace: false,
  };
}

function isSenderUncertain(item: InboxItem): boolean {
  const sender = item.sender?.trim() ?? '';
  if (!sender) return true;
  if (sender === UNKNOWN_SENDER_CANONICAL) return true;
  if (/nicht eindeutig/i.test(sender)) return true;
  if (/unbekannt/i.test(sender) && /absender/i.test(sender)) return true;
  if (/nicht eindeutig/i.test(item.title)) return true;
  return false;
}

/** Lightweight stub from inbox fields only — no pipeline / AI. */
export function createInboxWorkflowStub(item: InboxItem): WorkflowResult {
  const kind = item.classifiedKind ?? 'sonstiges';
  return {
    inboxItemId: item.id,
    companyRelevant: true,
    companyRelevance: { isRelevant: true, reasons: [], matchedHints: [] },
    classifiedKind: kind,
    classificationConfidence: 'medium',
    classification: null,
    documentExplanation: null,
    documentUnderstanding: {
      documentType: kind,
      sender: item.sender,
      recipient: item.recognizedData.Empfänger,
      date: item.recognizedData.Datum,
      referenceNumber:
        item.recognizedData.Aktenzeichen ?? item.recognizedData.Rechnungsnummer,
      constructionSite:
        item.recognizedData.Baustelle ?? item.recognizedData.Baustellenadresse,
      customer: item.recognizedData.Kunde ?? item.recognizedData.Auftraggeber,
      vorgang: item.recognizedData.Vorgang ?? item.vorgangTitle,
      invoiceNumber: item.recognizedData.Rechnungsnummer,
      amount:
        item.recognizedData.Betrag ??
        item.recognizedData.Auftragssumme ??
        item.recognizedData.Vertragssumme ??
        item.recognizedData.Angebotssumme,
      deadline:
        item.deadline ??
        item.recognizedData.Frist ??
        item.recognizedData.Fälligkeit ??
        item.recognizedData.Faelligkeit,
      nextStep: '',
      partialRecognition: false,
    },
    documentAiActions: [],
    contractAnalysis: null,
    contractIntelligence: null,
    contractOrderProposal: null,
    suggestedVorgang: null,
    similarVorgaenge: [],
    suggestedOrderPositions: [],
    suggestedTasks: [],
    suggestedArchiveFolder: item.digitalFolder,
    requiredDocuments: [],
    pendingSummary: null,
    warnings: [],
    nextActions: [],
    businessInterpretation: null,
  };
}

function buildContractInboxSummary(
  item: InboxItem,
  options: BuildDocumentSummaryOptions,
): DocumentSummary {
  const translate = options.translate;
  const kind = resolveKind(item, null, null);
  const typeLabelKey = getDocumentDisplayLabelKey(kind, item.documentType);
  const facts: DocumentSummaryFact[] = [];

  // Order: Kunde → Projekt → Vertragssumme → Baustelle → Positionen → Gewerk
  pushFact(
    facts,
    'customer',
    'documentExperience.fact.customer',
    preferMeaningfulParty(rd(item, 'Auftraggeber', 'Kunde', 'Empfänger'), item.sender),
  );
  pushFact(
    facts,
    'project',
    'auftragskarte.field.project',
    preferProjectFactValue(
      rd(item, 'Bauvorhaben', 'Projekt'),
      rd(item, 'Vertragsgegenstand'),
    ),
  );
  pushFact(
    facts,
    'orderValue',
    'auftragskarte.field.orderValue',
    rd(item, 'Vertragssumme', 'Auftragssumme', 'Angebotssumme', 'Betrag'),
  );
  pushFact(
    facts,
    'site',
    'auftragskarte.field.constructionSite',
    rd(item, 'Baustelle', 'Baustellenadresse'),
  );
  const positionRaw = rd(item, 'Anzahl Positionen', 'Positionsanzahl', 'Positionen');
  const positionsValue = formatPositionsFactValue(positionRaw, (count) =>
    translate('auftragskarte.field.positionCount').replace('{count}', String(count)),
  );
  if (positionsValue) {
    pushFact(facts, 'positions', 'auftragskarte.field.positions', positionsValue);
  }
  const gewerk = rd(item, 'Gewerk');
  if (gewerk) {
    pushFact(facts, 'gewerk', 'auftragskarte.field.gewerk', gewerk);
  }

  // Drop uncertain sender from customer fact
  const customerIdx = facts.findIndex((f) => f.id === 'customer');
  if (
    customerIdx >= 0 &&
    isSenderUncertain(item) &&
    facts[customerIdx]?.value === item.sender?.trim()
  ) {
    facts.splice(customerIdx, 1);
  }

  const alerts: DocumentSummaryAlert[] = [];
  if (isSenderUncertain(item)) {
    alerts.push({
      id: 'sender-uncertain',
      severity: 'review',
      labelKey: 'documentExperience.alert.senderUncertain',
    });
  }

  const ordered = sortContractSummaryFacts(facts).slice(0, DOCUMENT_SUMMARY_MAX_FACTS);
  const typeHeadline = translate(typeLabelKey);
  const subtitle = [ordered.find((f) => f.id === 'customer')?.value, ordered.find((f) => f.id === 'project')?.value]
    .filter(Boolean)
    .join(' · ') || undefined;

  return {
    id: `summary:${item.id}`,
    sourceInboxItemId: item.id,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    documentKind: kind,
    documentTypeLabelKey: typeLabelKey,
    family: 'contract',
    headline: typeHeadline,
    subtitle,
    facts: ordered,
    alerts: alerts.slice(0, DOCUMENT_SUMMARY_MAX_ALERTS),
    primaryAction: {
      id: 'review_document',
      labelKey: 'inbox.reviewNow',
      enabled: true,
    },
    secondaryActions: [
      {
        id: 'later',
        labelKey: 'documentExperience.action.later',
        enabled: true,
      },
    ],
    details: [],
    workspaceType: 'none',
    hasDeepWorkspace: false,
  };
}

function finalizeInboxPresentation(
  summary: DocumentSummary,
  item: InboxItem,
  translate: (key: TranslationKey) => string,
): DocumentSummary {
  const typeLabel = translate(summary.documentTypeLabelKey);
  const facts = summary.facts
    .map((f) => ({
      ...f,
      value: formatSummaryFactValue(f.id, f.value),
    }))
    .filter((f) => {
      if (f.id === 'gewerk' && f.value === translate('auftragskarte.gewerk.unknown')) {
        return false;
      }
      if (
        (f.id === 'supplier' || f.id === 'sender' || f.id === 'authority' || f.id === 'customer') &&
        isSenderUncertain(item) &&
        (f.value === item.sender?.trim() || !f.value.trim())
      ) {
        return false;
      }
      return Boolean(f.value.trim());
    })
    .slice(0, DOCUMENT_SUMMARY_MAX_FACTS);

  const alerts = [...summary.alerts];
  if (isSenderUncertain(item) && !alerts.some((a) => a.id === 'sender-uncertain')) {
    alerts.unshift({
      id: 'sender-uncertain',
      severity: 'review',
      labelKey: 'documentExperience.alert.senderUncertain',
    });
  }

  return {
    ...summary,
    headline: typeLabel,
    facts,
    alerts: alerts.slice(0, DOCUMENT_SUMMARY_MAX_ALERTS),
    primaryAction: {
      id: 'review_document',
      labelKey: 'inbox.reviewNow',
      enabled: true,
    },
    secondaryActions: [
      {
        id: 'later',
        labelKey: 'documentExperience.action.later',
        enabled: true,
      },
    ],
    details: [],
    workspaceType: 'none',
    hasDeepWorkspace: false,
  };
}

/**
 * Build the presentation SSOT for the document first screen.
 */
export function buildDocumentSummary(
  item: InboxItem,
  workflow: WorkflowResult | null | undefined,
  options: BuildDocumentSummaryOptions,
): DocumentSummary {
  if (options.presentation === 'inbox') {
    return buildInboxDocumentSummary(item, options);
  }
  const proposal = options.proposal ?? workflow?.contractOrderProposal ?? null;
  if (proposal) {
    return attachDocumentCaseMatch(buildContractSummary(item, proposal, options), item, {
      preservePrimary: true,
    });
  }
  if (!workflow) {
    // Minimal fallback — should not happen in UI paths without proposal.
    return attachDocumentCaseMatch(
      {
        id: `summary:${item.id}`,
        sourceInboxItemId: item.id,
        generatedAt: options.generatedAt ?? new Date().toISOString(),
        documentKind: item.classifiedKind ?? 'sonstiges',
        documentTypeLabelKey: getDocumentDisplayLabelKey(item.classifiedKind, item.documentType),
        family: 'generic',
        headline: options.translate(
          getDocumentDisplayLabelKey(item.classifiedKind, item.documentType),
        ),
        facts: [],
        alerts: [],
        primaryAction: primaryActionForFamily('generic'),
        secondaryActions: secondaryForFamily('generic'),
        details: [],
        workspaceType: 'none',
        hasDeepWorkspace: false,
      },
      item,
    );
  }
  return attachDocumentCaseMatch(buildNonContractSummary(item, workflow, options), item);
}

/**
 * Inbox list card — DocumentSummary from existing item fields only (no pipeline).
 */
export function buildInboxDocumentSummary(
  item: InboxItem,
  options: BuildDocumentSummaryOptions & { language?: AppLanguage },
): DocumentSummary {
  const stub = createInboxWorkflowStub(item);
  const family = resolveDocumentSummaryFamily(item, stub, null);
  if (family === 'contract') {
    return attachDocumentCaseMatch(buildContractInboxSummary(item, options), item);
  }
  const base = buildNonContractSummary(item, stub, {
    ...options,
    letter: options.letter,
  });
  return attachDocumentCaseMatch(
    finalizeInboxPresentation(base, item, options.translate),
    item,
  );
}

/** Resolve display label for a fact/alert using translate. */
export function resolveDocumentSummaryFactLabel(
  fact: DocumentSummaryFact,
  translate: (key: TranslationKey) => string,
): string {
  if (fact.label?.trim()) return fact.label.trim();
  if (fact.labelKey) return translate(fact.labelKey);
  return fact.id;
}

export function resolveDocumentSummaryAlertLabel(
  alert: DocumentSummaryAlert,
  translate: (key: TranslationKey) => string,
): string {
  if (alert.label?.trim()) return alert.label.trim();
  if (alert.labelKey) return translate(alert.labelKey);
  return alert.id;
}

/** Intake-style primary actions that share applySuggestion in the review page. */
export function isIntakeStyleAction(id: DocumentSummaryActionId): boolean {
  return (
    id === 'apply_intake' ||
    id === 'record_expense' ||
    id === 'create_vorgang' ||
    id === 'create_task' ||
    id === 'review_document' ||
    id === 'link_vorgang' ||
    id === 'open_vorgang' ||
    id === 'select_vorgang'
  );
}
