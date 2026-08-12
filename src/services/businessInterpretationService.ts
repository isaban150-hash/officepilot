import type {
  BusinessConfirmationId,
  BusinessEffectKind,
  BusinessEventType,
  BusinessFactCertainty,
  BusinessInterpretationConflict,
  BusinessInterpretationConfirmation,
  BusinessInterpretationEffect,
  BusinessInterpretationGap,
  BusinessInterpretationNextActionCandidate,
  BusinessInterpretationParty,
  BusinessInterpretationResult,
  BusinessInterpretationVorgangRef,
  BusinessStructuredFacts,
} from '../types/businessInterpretation';
import type { ContractFamily } from '../types/documentIntelligence';
import type {
  ClassifiedDocumentKind,
  InboxItem,
  Vorgang,
  WorkflowResult,
} from '../types/models';
import { buildStructuredBusinessFacts } from './businessInterpretationFacts';
import {
  isAuthorityClassifiedKind,
  isBankClassifiedKind,
  isInsuranceClassifiedKind,
  resolveOperationalReading,
} from './businessInterpretationMeaning';
import { isContractPlanLocked } from './orderPlanIntegrityService';

/** Families that may propose a construction/performance plan (LV) from existing positions. */
const PERFORMANCE_PLAN_FAMILIES: ReadonlySet<ContractFamily> = new Set([
  'werkvertrag',
  'subunternehmervertrag',
  'general_contract',
]);

/** Families that must never invent a Bau-LV / performance plan effect. */
const NON_PERFORMANCE_PLAN_FAMILIES: ReadonlySet<ContractFamily> = new Set([
  'mietvertrag',
  'leasingvertrag',
  'wartungsvertrag',
  'versicherungsvertrag',
  'arbeitsvertrag',
  'kaufvertrag',
]);

const INVOICE_RECEIVED_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'eingangsrechnung',
  'reparaturrechnung',
]);

const INVOICE_CREATED_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'ausgangsrechnung',
  'rechnung',
  'gutschrift',
]);

const PAYMENT_REMINDER_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'mahnung',
  'zahlungserinnerung',
]);

const DELIVERY_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set(['lieferschein']);

const ACCEPTANCE_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'abnahmeprotokoll',
  'uebergabeprotokoll',
]);

const COMPLAINT_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'maengelprotokoll',
]);

const EVIDENCE_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'baustellenfoto',
  'foto',
  'messprotokoll',
  'pruefprotokoll',
  'materialnachweis',
  'entsorgungsnachweis',
]);

const CONTRACT_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'werkvertrag',
  'subunternehmervertrag',
  'nachunternehmervertrag',
  'leasingvertrag',
  'arbeitsvertrag',
]);

const ORDER_CONFIRM_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'auftragsbestaetigung',
  'auftrag',
]);

const AMENDMENT_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set(['nachtrag']);

const MAX_NEXT_ACTION_CANDIDATES = 5;

export type WorkflowResultForInterpretation = Omit<
  WorkflowResult,
  'businessInterpretation'
>;

export interface InterpretBusinessFromWorkflowInput {
  item: InboxItem;
  workflow: WorkflowResultForInterpretation;
  /** Current vorgang when already linked or suggested — read-only comparison only. */
  linkedVorgang?: Vorgang | null;
  /**
   * How `linkedVorgang` was reached. 'linked' = confirmed per isInboxLinkedToVorgang,
   * 'suggested' = computed proposal only. Undefined behaves like 'suggested' so a caller
   * that omits it can never accidentally claim a confirmed state.
   */
  vorgangContextStatus?: 'linked' | 'suggested';
}

function normalizeName(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function resolveContractFamily(
  workflow: WorkflowResultForInterpretation,
): ContractFamily | undefined {
  return (
    workflow.contractIntelligence?.contractType?.family ??
    (workflow.contractOrderProposal?.intelligence.contractType?.family)
  );
}

function isRecognitionUncertain(
  item: InboxItem,
  workflow: WorkflowResultForInterpretation,
): boolean {
  if (workflow.classificationConfidence === 'low') return true;
  if (workflow.classification?.processType === 'review_required') return true;
  if (workflow.documentUnderstanding?.kindReviewRequired) return true;
  if (workflow.documentUnderstanding?.partialRecognition) return true;
  if (workflow.contractIntelligence?.reviewRequired) return true;
  if (workflow.classifiedKind === 'sonstiges') return true;
  if ((workflow.documentUnderstanding?.uncertainFields?.length ?? 0) > 0) return true;
  if (!workflow.companyRelevant && !workflow.contractOrderProposal) return true;
  return Boolean(item.isAdvertisement);
}

type EventResolution = {
  eventType: BusinessEventType;
  certainty: BusinessFactCertainty;
  summary: string;
  alternativeEventTypes: BusinessEventType[];
  inheritedConfidence?: WorkflowResultForInterpretation['classificationConfidence'];
};

function resolveEvent(
  item: InboxItem,
  workflow: WorkflowResultForInterpretation,
  linkedVorgang: Vorgang | null | undefined,
  recognitionUncertain: boolean,
): EventResolution {
  const kind = workflow.classifiedKind;
  const hasProposal = Boolean(workflow.contractOrderProposal);
  const hasVorgangHint = Boolean(
    item.vorgangId || workflow.suggestedVorgang || (workflow.similarVorgaenge?.length ?? 0) > 0,
  );
  const family = resolveContractFamily(workflow);
  const earlyCorpus = [
    item.recognizedData._extractedText,
    item.recognizedData._vertragstext,
    item.title,
    item.sender,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  const earlyAuthorityText =
    /finanzamt|bg bau|berufsgenossenschaft|soka-?bau|krankenkasse|unbedenklichkeit|steuernummer|aktenzeichen/i.test(
      earlyCorpus,
    );
  const earlyInsuranceText =
    /versicherung|versicherungsschein|betriebshaftpflicht|beitragsanpassung|jahresbeitrag/i.test(
      earlyCorpus,
    );
  const earlyBankText =
    /rücklastschrift|ruecklastschrift|zahlungsstörung|zahlungsstoerung/i.test(earlyCorpus);

  if (recognitionUncertain && !hasProposal && !INVOICE_RECEIVED_KINDS.has(kind) && !PAYMENT_REMINDER_KINDS.has(kind)) {
    // Keep safe facts only — do not invent a concrete operational event.
    // MEANING-CORE: authority/insurance/bank text may still yield a safe obligation event.
    if (
      !CONTRACT_KINDS.has(kind) &&
      !ORDER_CONFIRM_KINDS.has(kind) &&
      !AMENDMENT_KINDS.has(kind) &&
      !DELIVERY_KINDS.has(kind) &&
      !ACCEPTANCE_KINDS.has(kind) &&
      !COMPLAINT_KINDS.has(kind) &&
      !INVOICE_CREATED_KINDS.has(kind) &&
      !EVIDENCE_KINDS.has(kind) &&
      !isAuthorityClassifiedKind(kind) &&
      !isInsuranceClassifiedKind(kind) &&
      !isBankClassifiedKind(kind) &&
      !earlyAuthorityText &&
      !earlyInsuranceText &&
      !earlyBankText
    ) {
      return {
        eventType: 'review_required',
        certainty: 'uncertain',
        summary: 'Dokumentart oder betriebliche Bedeutung ist unsicher — manuelle Prüfung erforderlich.',
        alternativeEventTypes: [],
        inheritedConfidence: workflow.classificationConfidence,
      };
    }
  }

  if (AMENDMENT_KINDS.has(kind)) {
    return {
      eventType: 'service_change_proposed',
      certainty: 'proposed',
      summary: 'Nachtrag erkannt — mögliche Leistungs- oder Planänderung, Bestätigung erforderlich.',
      alternativeEventTypes: hasVorgangHint ? [] : ['review_required'],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }

  if (PAYMENT_REMINDER_KINDS.has(kind)) {
    return {
      eventType: 'payment_reminder_received',
      certainty: 'detected',
      summary: 'Mahnung oder Zahlungserinnerung — mögliche offene Forderung und Fristwirkung.',
      alternativeEventTypes: [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }

  if (INVOICE_RECEIVED_KINDS.has(kind) || item.documentType === 'eingangsrechnung') {
    return {
      eventType: 'invoice_received',
      certainty: 'detected',
      summary: 'Eingangsrechnung — Ausgabe und möglicher Vorgangsbezug, keine Buchung ohne Freigabe.',
      alternativeEventTypes: [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }

  if (INVOICE_CREATED_KINDS.has(kind) || item.documentType === 'ausgangsrechnung') {
    return {
      eventType: 'invoice_created',
      certainty: 'detected',
      summary: 'Ausgangsrechnung oder Rechnungsdokument — Forderung nur nach Freigabe finalisieren.',
      alternativeEventTypes: [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }

  if (DELIVERY_KINDS.has(kind)) {
    return {
      eventType: recognitionUncertain ? 'review_required' : 'delivery_recorded',
      certainty: recognitionUncertain ? 'uncertain' : 'detected',
      summary: recognitionUncertain
        ? 'Lieferschein-Hinweis unsicher — manuelle Prüfung, keine Mengenänderung.'
        : 'Lieferschein — Materiallieferung erkannt, keine automatische Mengenänderung.',
      alternativeEventTypes: recognitionUncertain ? ['delivery_recorded'] : [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }

  if (ACCEPTANCE_KINDS.has(kind)) {
    return {
      eventType: 'acceptance_recorded',
      certainty: 'detected',
      summary: 'Abnahme- oder Übergabeprotokoll — Leistungsstand, keine automatische Schlussrechnung.',
      alternativeEventTypes: [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }

  if (COMPLAINT_KINDS.has(kind)) {
    return {
      eventType: 'complaint_received',
      certainty: 'detected',
      summary: 'Mängelprotokoll — Reklamation/Nachweis, keine automatische Zugeständnisse.',
      alternativeEventTypes: [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }

  if (EVIDENCE_KINDS.has(kind)) {
    return {
      eventType: 'evidence_added',
      certainty: 'detected',
      summary: 'Nachweis oder Foto — Dokumentation ohne Zustandsänderung.',
      alternativeEventTypes: [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }

  if (ORDER_CONFIRM_KINDS.has(kind)) {
    const alternatives: BusinessEventType[] = [];
    if (!hasVorgangHint) alternatives.push('possible_new_business_case');
    return {
      eventType: 'order_confirmed',
      certainty: 'proposed',
      summary: 'Auftragsbestätigung oder Auftrag — mögliche Bestätigung eines Geschäfts, ohne automatische Übernahme.',
      alternativeEventTypes: alternatives,
      inheritedConfidence: workflow.classificationConfidence,
    };
  }

  // Authority / insurance / bank are never contract business-cases (MEANING-CORE-01).
  if (isAuthorityClassifiedKind(kind)) {
    return {
      eventType: 'deadline_or_obligation_detected',
      certainty: 'detected',
      summary: 'Behörden- oder Sozialkassenschreiben — Verpflichtung oder Frist, kein Auftrag.',
      alternativeEventTypes: [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }
  if (isInsuranceClassifiedKind(kind)) {
    return {
      eventType: 'deadline_or_obligation_detected',
      certainty: 'detected',
      summary: 'Versicherungsschreiben — Information oder Handlung, kein Kundenauftrag.',
      alternativeEventTypes: [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }
  if (isBankClassifiedKind(kind)) {
    return {
      eventType: 'deadline_or_obligation_detected',
      certainty: 'detected',
      summary: 'Bankmitteilung — mögliche Zahlungsinformation oder Störung, keine Rechnungserfindung.',
      alternativeEventTypes: [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }

  // Text signals: do not treat authority/insurance/bank prose as contract (MEANING-CORE-01).
  const corpus = [
    item.recognizedData._extractedText,
    item.recognizedData._vertragstext,
    item.title,
    item.sender,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  if (
    /finanzamt|bg bau|berufsgenossenschaft|soka-?bau|steuernummer|aktenzeichen/i.test(corpus) &&
    !CONTRACT_KINDS.has(kind)
  ) {
    return {
      eventType: 'deadline_or_obligation_detected',
      certainty: 'detected',
      summary: 'Behördlicher Inhalt erkannt — Verpflichtung/Frist, kein Auftrag.',
      alternativeEventTypes: [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }
  if (
    /versicherung|versicherungsschein|betriebshaftpflicht|beitragsanpassung|jahresbeitrag/i.test(
      corpus,
    ) &&
    !CONTRACT_KINDS.has(kind)
  ) {
    return {
      eventType: 'deadline_or_obligation_detected',
      certainty: 'detected',
      summary: 'Versicherungsinhalt erkannt — kein Kundenauftrag.',
      alternativeEventTypes: [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }
  if (
    /rücklastschrift|ruecklastschrift|zahlungsstörung|zahlungsstoerung/i.test(corpus) &&
    !CONTRACT_KINDS.has(kind)
  ) {
    return {
      eventType: 'deadline_or_obligation_detected',
      certainty: 'detected',
      summary: 'Bank-/Zahlungsstörung erkannt — keine Rechnungserfindung.',
      alternativeEventTypes: [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }

  const looksLikeContract =
    hasProposal ||
    Boolean(workflow.contractIntelligence) ||
    Boolean(workflow.contractAnalysis?.isContract) ||
    CONTRACT_KINDS.has(kind) ||
    kind === 'leistungsverzeichnis' ||
    family === 'mietvertrag' ||
    family === 'wartungsvertrag' ||
    family === 'dienstleistungsvertrag' ||
    family === 'rahmenvertrag';

  if (looksLikeContract) {
    const alternatives: BusinessEventType[] = ['contract_proposed'];
    let eventType: BusinessEventType;
    let summary: string;

    if (linkedVorgang || item.vorgangId || workflow.suggestedVorgang) {
      eventType = 'business_case_update';
      summary =
        'Vertragsdokument mit möglichem Bezug zu einem bestehenden Vorgang — Aktualisierung nur nach Freigabe.';
      if (!workflow.suggestedVorgang && !item.vorgangId && (workflow.similarVorgaenge?.length ?? 0) > 1) {
        alternatives.push('possible_new_business_case', 'review_required');
      }
    } else if ((workflow.similarVorgaenge?.length ?? 0) > 1) {
      eventType = 'review_required';
      summary =
        'Vertragsdokument mit mehreren möglichen Vorgängen — Zuordnung unklar, keine automatische Fallanlage.';
      alternatives.push('possible_new_business_case', 'business_case_update', 'contract_proposed');
    } else {
      eventType = 'possible_new_business_case';
      summary =
        'Vertragsdokument ohne klaren Vorgangsbezug — mögliches neues Geschäft, keine automatische Auftragserstellung.';
    }

    // Ambiguous primary among equals → review_required
    if (
      eventType !== 'review_required' &&
      alternatives.includes('possible_new_business_case') &&
      alternatives.includes('business_case_update')
    ) {
      return {
        eventType: 'review_required',
        certainty: 'uncertain',
        summary:
          'Mehrere betriebliche Deutungen möglich (neues Geschäft oder Aktualisierung) — manuelle Klärung.',
        alternativeEventTypes: ['possible_new_business_case', 'business_case_update', 'contract_proposed'],
        inheritedConfidence: workflow.classificationConfidence,
      };
    }

    return {
      eventType,
      certainty: hasProposal ? 'proposed' : 'detected',
      summary,
      alternativeEventTypes: alternatives.filter((a) => a !== eventType),
      inheritedConfidence: workflow.classificationConfidence,
    };
  }

  if (workflow.classification?.processType === 'monitor_payment' || workflow.documentUnderstanding?.deadline) {
    return {
      eventType: 'deadline_or_obligation_detected',
      certainty: 'detected',
      summary: 'Frist oder Verpflichtung aus vorhandenen Erkennungsdaten.',
      alternativeEventTypes: [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }

  if (workflow.classification?.processType === 'archive_only') {
    return {
      eventType: 'information_only',
      certainty: 'detected',
      summary: 'Dokument ohne klaren Prozessschritt — informationelle Ablage.',
      alternativeEventTypes: [],
      inheritedConfidence: workflow.classificationConfidence,
    };
  }

  return {
    eventType: 'review_required',
    certainty: 'uncertain',
    summary: 'Keine sichere betriebliche Ereignisart aus vorhandenen Spezialisten ableitbar.',
    alternativeEventTypes: [],
    inheritedConfidence: workflow.classificationConfidence,
  };
}

function buildVorgangRef(
  item: InboxItem,
  workflow: WorkflowResultForInterpretation,
  linkedVorgang: Vorgang | null | undefined,
  confirmed: boolean,
): BusinessInterpretationVorgangRef {
  // Only a confirmed link may report 'linked'. A legacy vorgangId without a valid
  // vorgangLinkStatus falls through to the suggestion branches below.
  if (confirmed && item.vorgangId) {
    return {
      status: 'linked',
      linkedVorgangId: item.vorgangId,
      linkedVorgangTitle: linkedVorgang?.title ?? null,
      suggested: workflow.suggestedVorgang,
      similarCount: workflow.similarVorgaenge?.length ?? 0,
    };
  }

  const similarCount = workflow.similarVorgaenge?.length ?? 0;
  if (workflow.suggestedVorgang && similarCount > 1) {
    return {
      status: 'ambiguous',
      suggested: workflow.suggestedVorgang,
      linkedVorgangId: null,
      similarCount,
      ambiguityReason: 'Vorschlag und mehrere ähnliche Vorgänge — Zuordnung nicht eindeutig.',
    };
  }

  if (workflow.suggestedVorgang) {
    return {
      status: 'suggested',
      suggested: workflow.suggestedVorgang,
      linkedVorgangId: workflow.suggestedVorgang.vorgangId,
      linkedVorgangTitle: workflow.suggestedVorgang.vorgangTitle,
      similarCount,
    };
  }

  if (similarCount > 1) {
    return {
      status: 'ambiguous',
      suggested: null,
      similarCount,
      ambiguityReason: 'Mehrere ähnliche Vorgänge ohne eindeutigen Vorschlag.',
    };
  }

  return {
    status: 'none',
    suggested: null,
    linkedVorgangId: null,
    similarCount,
  };
}

function buildParties(
  workflow: WorkflowResultForInterpretation,
): BusinessInterpretationParty[] {
  const parties: BusinessInterpretationParty[] = [];
  const seen = new Set<string>();

  const push = (party: BusinessInterpretationParty) => {
    const key = `${normalizeName(party.name)}|${party.role ?? ''}`;
    if (!party.name.trim() || seen.has(key)) return;
    seen.add(key);
    parties.push(party);
  };

  const intelligenceParties =
    workflow.contractIntelligence?.parties ??
    workflow.contractOrderProposal?.intelligence.parties;
  if (intelligenceParties) {
    for (const party of intelligenceParties) {
      push({
        name: party.name,
        role: party.role,
        certainty:
          party.status === 'confirmed'
            ? 'detected'
            : party.status === 'review_required'
              ? 'uncertain'
              : 'detected',
        source: 'contractIntelligence',
      });
    }
  }

  const proposal = workflow.contractOrderProposal;
  if (proposal) {
    if (proposal.customer) {
      push({
        name: proposal.customer,
        role: 'counterparty',
        certainty: 'proposed',
        source: 'contractOrderProposal',
      });
    }
    if (proposal.contractor) {
      push({
        name: proposal.contractor,
        role: 'own_company',
        certainty: 'proposed',
        source: 'contractOrderProposal',
      });
    }
  }

  const understanding = workflow.documentUnderstanding;
  if (understanding?.sender) {
    push({
      name: understanding.sender,
      role: 'unknown',
      certainty: understanding.uncertainFields?.includes('sender') ? 'uncertain' : 'detected',
      source: 'understanding',
    });
  }
  if (understanding?.customer) {
    push({
      name: understanding.customer,
      role: 'counterparty',
      certainty: understanding.uncertainFields?.includes('customer') ? 'uncertain' : 'detected',
      source: 'understanding',
    });
  }

  const recognizedCustomer = workflow.classification?.recognizedData?.Kunde
    ?? workflow.classification?.recognizedData?.Auftraggeber;
  if (recognizedCustomer) {
    push({
      name: recognizedCustomer,
      role: 'counterparty',
      certainty: 'detected',
      source: 'recognizedData',
    });
  }

  return parties;
}

const CONTRACTISH_EFFECT_EVENTS: ReadonlySet<BusinessEventType> = new Set([
  'possible_new_business_case',
  'business_case_update',
  'contract_proposed',
  'order_confirmed',
  'service_change_proposed',
]);

const INVOICEISH_EFFECT_EVENTS: ReadonlySet<BusinessEventType> = new Set([
  'invoice_received',
  'invoice_created',
  'payment_reminder_received',
]);

function buildEffects(
  item: InboxItem,
  workflow: WorkflowResultForInterpretation,
  eventType: BusinessEventType,
): BusinessInterpretationEffect[] {
  const effects: BusinessInterpretationEffect[] = [];
  const family = resolveContractFamily(workflow);
  const proposal = workflow.contractOrderProposal;
  const intelligence = workflow.contractIntelligence ?? proposal?.intelligence ?? null;
  const understanding = workflow.documentUnderstanding;
  const isInvoiceish = INVOICEISH_EFFECT_EVENTS.has(eventType);
  const isContractish = CONTRACTISH_EFFECT_EVENTS.has(eventType);

  const push = (effect: BusinessInterpretationEffect) => {
    effects.push(effect);
  };

  // Contract effect only for contract-/order-/service-change events — never from CI alone on invoices.
  if (
    isContractish &&
    (intelligence || proposal || workflow.contractAnalysis?.isContract)
  ) {
    push({
      kind: 'contract',
      summary: family
        ? `Vertragswirkung aus Contract Intelligence (Familie: ${family}).`
        : 'Vertragswirkung aus vorhandenen Vertragsdaten.',
      certainty: proposal ? 'proposed' : 'detected',
      detail: proposal
        ? [proposal.customer, proposal.constructionSite].filter(Boolean).join(' · ') || undefined
        : undefined,
    });
  }

  // Performance / LV only for explicitly allowed families (never when family is missing).
  const positions =
    proposal?.positions ??
    intelligence?.positions ??
    workflow.suggestedOrderPositions ??
    [];
  const allowsPerformancePlan =
    Boolean(family) &&
    PERFORMANCE_PLAN_FAMILIES.has(family!) &&
    !NON_PERFORMANCE_PLAN_FAMILIES.has(family!);

  if (
    allowsPerformancePlan &&
    positions.length > 0 &&
    isContractish
  ) {
    push({
      kind: 'performance',
      summary: `Leistungswirkung: ${positions.length} vorhandene Position(en) — nur nach Bestätigung übernehmen.`,
      certainty: 'proposed',
    });
  }

  // Explicitly do not claim Bau-LV for rent / maintenance even if stray positions appear.
  if (family && NON_PERFORMANCE_PLAN_FAMILIES.has(family)) {
    // no performance effect — intentional
  }

  const invoiceAmount =
    understanding?.amount ||
    workflow.classification?.recognizedData?.Betrag ||
    item.recognizedData.Betrag ||
    item.recognizedData.Rechnungsbetrag ||
    item.recognizedData.Bruttobetrag;

  const contractAmount =
    proposal?.contractTotalNet ||
    (intelligence?.contractTotalNet?.value != null
      ? String(intelligence.contractTotalNet.value)
      : undefined) ||
    workflow.classification?.recognizedData?.Angebotssumme ||
    item.recognizedData.Angebotssumme;

  const amount = isInvoiceish
    ? invoiceAmount
    : isContractish
      ? contractAmount || invoiceAmount
      : invoiceAmount || contractAmount;

  if (amount) {
    const moneyKinds: BusinessEffectKind[] = ['money'];
    if (isInvoiceish) {
      moneyKinds.push('invoice');
    }
    for (const kind of moneyKinds) {
      push({
        kind,
        summary:
          kind === 'invoice'
            ? `Rechnungswirkung aus vorhandenen Betragsdaten: ${amount}`
            : `Geldwirkung aus vorhandenen Daten: ${amount}`,
        certainty: 'detected',
        detail: String(amount),
      });
    }
  }

  const deadline =
    understanding?.deadline ||
    workflow.classification?.deadline ||
    item.deadline ||
    item.recognizedData.Faelligkeit ||
    item.recognizedData.Frist;
  if (deadline) {
    push({
      kind: 'deadline',
      summary: `Termin-/Fristwirkung aus vorhandenen Daten: ${deadline}`,
      certainty: 'detected',
      detail: String(deadline),
    });
  }

  if (eventType === 'delivery_recorded') {
    const qty =
      item.recognizedData.Menge ||
      item.recognizedData.Mengen ||
      workflow.classification?.recognizedData?.Menge;
    push({
      kind: 'material',
      summary: qty
        ? `Materialwirkung (Lieferung) — Mengenhinweis vorhanden: ${qty}. Keine automatische Planänderung.`
        : 'Materialwirkung (Lieferung) — keine automatische Mengenänderung am Vorgang.',
      certainty: 'detected',
      detail: qty ? String(qty) : undefined,
    });
  }

  if (eventType === 'evidence_added' || eventType === 'acceptance_recorded' || eventType === 'complaint_received') {
    push({
      kind: 'evidence',
      summary: 'Dokumentations-/Nachweiswirkung — Zuordnung und Bewertung nur nach Nutzerentscheidung.',
      certainty: 'detected',
    });
  }

  return effects;
}

function buildGaps(
  item: InboxItem,
  workflow: WorkflowResultForInterpretation,
  parties: BusinessInterpretationParty[],
  vorgangRef: BusinessInterpretationVorgangRef,
  eventType: BusinessEventType,
): BusinessInterpretationGap[] {
  const gaps: BusinessInterpretationGap[] = [];
  const push = (id: string, summary: string, certainty: BusinessFactCertainty = 'uncertain') => {
    if (gaps.some((g) => g.id === id)) return;
    gaps.push({ id, summary, certainty });
  };

  const hasCounterparty = parties.some(
    (p) => p.role === 'counterparty' || p.role === 'auftraggeber' || p.role === 'kunde' || p.role === 'vermieter',
  );
  if (!hasCounterparty) {
    push('counterparty_unclear', 'Gegenpartei unklar.');
  }

  if (vorgangRef.status === 'none' || vorgangRef.status === 'ambiguous') {
    push('vorgang_unclear', 'Vorgangsbezug unklar oder mehrdeutig.');
  }

  const hasAmount =
    Boolean(workflow.documentUnderstanding?.amount) ||
    Boolean(workflow.contractOrderProposal?.contractTotalNet) ||
    Boolean(item.recognizedData.Betrag) ||
    Boolean(item.recognizedData.Rechnungsbetrag) ||
    Boolean(item.recognizedData.Angebotssumme);

  if (
    (eventType === 'invoice_received' ||
      eventType === 'invoice_created' ||
      eventType === 'payment_reminder_received') &&
    !hasAmount
  ) {
    push('amount_missing', 'Betrag fehlt in den vorhandenen Erkennungsdaten.');
  }

  const hasDeadline =
    Boolean(workflow.documentUnderstanding?.deadline) ||
    Boolean(workflow.classification?.deadline) ||
    Boolean(item.deadline) ||
    Boolean(item.recognizedData.Faelligkeit);

  if (
    (eventType === 'invoice_received' || eventType === 'payment_reminder_received') &&
    !hasDeadline
  ) {
    push('deadline_missing', 'Termin oder Fälligkeit fehlt.');
  }

  const family = resolveContractFamily(workflow);
  const positions =
    workflow.contractOrderProposal?.positions ??
    workflow.contractIntelligence?.positions ??
    [];
  if (
    family &&
    PERFORMANCE_PLAN_FAMILIES.has(family) &&
    positions.length > 0
  ) {
    push('positions_need_review', 'Positionen müssen vor Übernahme geprüft werden.', 'proposed');
  }

  if (workflow.contractIntelligence || workflow.contractOrderProposal) {
    const signatureHint =
      workflow.contractAnalysis?.signaturePages?.length ||
      item.recognizedData.Unterschrift;
    if (!signatureHint) {
      push('signature_unclear', 'Unterschriftenstatus unklar oder nicht geprüft.');
    }
  }

  if (workflow.documentUnderstanding?.uncertainFields?.length) {
    for (const field of workflow.documentUnderstanding.uncertainFields) {
      push(`uncertain_field_${field}`, `Feld unsicher: ${field}.`);
    }
  }

  return gaps;
}

function buildConflicts(
  item: InboxItem,
  workflow: WorkflowResultForInterpretation,
  linkedVorgang: Vorgang | null | undefined,
  eventType: BusinessEventType,
): BusinessInterpretationConflict[] {
  const conflicts: BusinessInterpretationConflict[] = [];
  if (!linkedVorgang) return conflicts;

  const push = (id: string, summary: string) => {
    conflicts.push({ id, summary, certainty: 'conflicting' });
  };

  const detectedCustomer =
    workflow.contractOrderProposal?.customer ||
    workflow.documentUnderstanding?.customer ||
    workflow.classification?.recognizedData?.Kunde ||
    item.recognizedData.Kunde;

  if (
    detectedCustomer &&
    linkedVorgang.customer &&
    normalizeName(detectedCustomer) !== normalizeName(linkedVorgang.customer) &&
    !normalizeName(detectedCustomer).includes(normalizeName(linkedVorgang.customer)) &&
    !normalizeName(linkedVorgang.customer).includes(normalizeName(detectedCustomer))
  ) {
    push(
      'customer_mismatch',
      `Erkannter Kunde („${detectedCustomer}“) weicht vom Vorgangskunden („${linkedVorgang.customer}“) ab.`,
    );
  }

  if (eventType === 'service_change_proposed' && isContractPlanLocked(linkedVorgang)) {
    push(
      'locked_plan_amendment',
      'Nachtrag betrifft einen gelockten bestätigten Plan — Änderung nur nach expliziter Bestätigung, nicht still anwenden.',
    );
  }

  if (
    (eventType === 'possible_new_business_case' ||
      eventType === 'business_case_update' ||
      eventType === 'contract_proposed') &&
    isContractPlanLocked(linkedVorgang) &&
    (workflow.contractOrderProposal?.positions.length ?? 0) > 0
  ) {
    push(
      'locked_plan_positions',
      'Neues Dokument könnte bestätigte Positionen betreffen — Plan ist gelockt, keine stille Änderung.',
    );
  }

  const detectedAmountRaw =
    workflow.documentUnderstanding?.amount ||
    workflow.contractOrderProposal?.contractTotalNet ||
    item.recognizedData.Betrag;
  const confirmedPositions = linkedVorgang.contractConfirmation?.positions ?? [];
  if (detectedAmountRaw && confirmedPositions.length > 0) {
    const confirmedTotal = confirmedPositions.reduce(
      (sum, position) => sum + position.plannedQuantity * position.unitPrice,
      0,
    );
    const detectedNum = Number(
      String(detectedAmountRaw)
        .replace(/\./g, '')
        .replace(/,/g, '.')
        .replace(/[^\d.-]/g, ''),
    );
    if (Number.isFinite(detectedNum) && Math.abs(detectedNum - confirmedTotal) > 0.05) {
      push(
        'amount_mismatch',
        `Erkannter Betrag weicht vom bestätigten Vertragszustand (${confirmedTotal}) ab.`,
      );
    }
  }

  const detectedSite =
    workflow.contractOrderProposal?.constructionSite ||
    workflow.documentUnderstanding?.constructionSite ||
    item.recognizedData.Baustelle;
  if (
    detectedSite &&
    linkedVorgang.baustelle &&
    normalizeName(detectedSite) !== normalizeName(linkedVorgang.baustelle) &&
    !normalizeName(detectedSite).includes(normalizeName(linkedVorgang.baustelle)) &&
    !normalizeName(linkedVorgang.baustelle).includes(normalizeName(detectedSite))
  ) {
    push(
      'site_mismatch',
      `Erkannte Baustelle („${detectedSite}“) weicht von der Vorgangsbaustelle („${linkedVorgang.baustelle}“) ab.`,
    );
  }

  return conflicts;
}

function buildConfirmations(
  item: InboxItem,
  workflow: WorkflowResultForInterpretation,
  eventType: BusinessEventType,
  vorgangRef: BusinessInterpretationVorgangRef,
  linkedVorgang: Vorgang | null | undefined,
): BusinessInterpretationConfirmation[] {
  const list: BusinessInterpretationConfirmation[] = [];
  const push = (id: BusinessConfirmationId, summary: string) => {
    if (list.some((c) => c.id === id)) return;
    list.push({ id, summary, required: true });
  };

  if (!item.importedToArchive) {
    push('save_document', 'Dokument dauerhaft speichern oder Ablage bestätigen.');
  }

  if (vorgangRef.status === 'none' || vorgangRef.status === 'ambiguous' || vorgangRef.status === 'suggested') {
    if (!item.vorgangId) {
      push('assign_vorgang', 'Vorgang zuordnen oder neuen Vorgang bewusst anlegen.');
    }
  }

  if (workflow.contractIntelligence || workflow.contractOrderProposal) {
    push('confirm_contract_parties', 'Vertragsparteien und Rollen bestätigen.');
  }

  const family = resolveContractFamily(workflow);
  const positions =
    workflow.contractOrderProposal?.positions ??
    workflow.contractIntelligence?.positions ??
    [];
  if (
    positions.length > 0 &&
    family &&
    PERFORMANCE_PLAN_FAMILIES.has(family) &&
    !NON_PERFORMANCE_PLAN_FAMILIES.has(family)
  ) {
    push('confirm_positions', 'Leistungspositionen vor Übernahme bestätigen.');
  }

  if (
    eventType === 'service_change_proposed' ||
    (linkedVorgang && isContractPlanLocked(linkedVorgang) && positions.length > 0)
  ) {
    push('confirm_amendment', 'Plan- oder Nachtragsänderung explizit bestätigen.');
  }

  if (
    eventType === 'invoice_received' ||
    eventType === 'invoice_created' ||
    eventType === 'payment_reminder_received'
  ) {
    push('finalize_invoice', 'Rechnungsdaten prüfen und erst nach Freigabe finalisieren.');
  }

  return list;
}

function collectNextActionCandidates(
  workflow: WorkflowResultForInterpretation,
): BusinessInterpretationNextActionCandidate[] {
  const candidates: BusinessInterpretationNextActionCandidate[] = [];
  const seen = new Set<string>();

  for (const action of workflow.nextActions ?? []) {
    const key = `workflow.nextActions:${action.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      id: action.id,
      labelKey: action.labelKey,
      enabled: action.enabled,
      source: 'workflow.nextActions',
      workflowActionId: action.id,
    });
    if (candidates.length >= MAX_NEXT_ACTION_CANDIDATES) {
      return candidates;
    }
  }

  // Surface existing task proposals as labeled candidates — do not re-prioritize or invent.
  for (const task of workflow.suggestedTasks ?? []) {
    if (candidates.length >= MAX_NEXT_ACTION_CANDIDATES) break;
    const id = task.dedupeKey ?? `${task.title}:${task.dueDate ?? ''}`;
    const key = `workflow.suggestedTasks:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      id,
      label: task.title,
      source: 'workflow.suggestedTasks',
    });
  }

  return candidates;
}

function enrichGapsFromFacts(
  gaps: BusinessInterpretationGap[],
  facts: BusinessStructuredFacts,
  eventType: BusinessEventType,
): BusinessInterpretationGap[] {
  const push = (id: string, summary: string, certainty: BusinessFactCertainty = 'uncertain') => {
    if (gaps.some((gap) => gap.id === id)) return;
    gaps.push({ id, summary, certainty });
  };

  if (!facts.parties.counterparty) {
    push('counterparty_unclear', 'Gegenpartei unklar.');
  }
  if (
    (eventType === 'possible_new_business_case' ||
      eventType === 'business_case_update' ||
      eventType === 'contract_proposed') &&
    !facts.subject.site &&
    !facts.subject.object &&
    !facts.subject.project
  ) {
    push('location_unclear', 'Ort / Objekt / Baustelle unklar.');
  }
  if (facts.positions.some((position) => position.certainty === 'uncertain')) {
    push('positions_need_review', 'Positionen müssen vor Übernahme geprüft werden.', 'proposed');
  }
  if (facts.signatures.status === 'unclear' || facts.signatures.status === 'partial') {
    push('signature_unclear', 'Unterschriftenstatus unklar oder unvollständig.');
  }
  return gaps;
}

/**
 * Read-only business coordination over existing specialist outputs.
 * Does not invent facts, mutate state, or call persistence/execution services.
 */
export function interpretBusinessFromWorkflow(
  input: InterpretBusinessFromWorkflowInput,
): BusinessInterpretationResult {
  const { item, workflow, linkedVorgang } = input;
  const vorgangConfirmed = input.vorgangContextStatus === 'linked';
  const recognitionUncertain = isRecognitionUncertain(item, workflow);
  const meaning = resolveEvent(item, workflow, linkedVorgang, recognitionUncertain);
  const vorgangRef = buildVorgangRef(item, workflow, linkedVorgang, vorgangConfirmed);
  const parties = buildParties(workflow);
  const effects = buildEffects(item, workflow, meaning.eventType);
  const structured = buildStructuredBusinessFacts({
    item,
    workflow,
    linkedVorgang,
    vorgangConfirmed,
    eventType: meaning.eventType,
  });
  const missingInformation = enrichGapsFromFacts(
    buildGaps(item, workflow, parties, vorgangRef, meaning.eventType),
    structured.facts,
    meaning.eventType,
  );
  const conflicts = [
    ...buildConflicts(item, workflow, linkedVorgang, meaning.eventType),
    ...structured.conflicts,
  ];
  const requiredConfirmations = buildConfirmations(
    item,
    workflow,
    meaning.eventType,
    vorgangRef,
    linkedVorgang,
  );
  const nextActionCandidates = collectNextActionCandidates(workflow);
  const family = resolveContractFamily(workflow);
  const operational = resolveOperationalReading({
    item,
    workflow,
    eventType: meaning.eventType,
    eventCertainty: meaning.certainty,
    facts: structured.facts,
    requiredConfirmations,
  });

  return {
    readOnly: true,
    sourceDocument: {
      sourceDocumentId: item.id,
      classifiedKind: workflow.classifiedKind,
      classificationConfidence: workflow.classificationConfidence,
      recognitionUncertain,
    },
    meaning: {
      eventType: meaning.eventType,
      certainty: meaning.certainty,
      summary: meaning.summary,
      alternativeEventTypes: meaning.alternativeEventTypes,
      inheritedConfidence: meaning.inheritedConfidence,
    },
    operational,
    vorgangRef,
    parties,
    effects,
    missingInformation,
    conflicts,
    requiredConfirmations,
    nextActionCandidates,
    facts: structured.facts,
    contractFamily: family,
    derivedFrom: {
      hasContractIntelligence: Boolean(workflow.contractIntelligence),
      hasContractOrderProposal: Boolean(workflow.contractOrderProposal),
      hasClassification: Boolean(workflow.classification),
      hasDocumentUnderstanding: Boolean(workflow.documentUnderstanding),
      companyRelevant: workflow.companyRelevant,
    },
  };
}
