import type {
  ClassifiedDocumentKind,
  DocumentAiAction,
  DocumentAiActionId,
  DocumentClassificationResult,
  DocumentUnderstandingSummary,
  InboxItem,
} from '../types/models';
import { extractFieldsWithConfidence, listUncertainFieldKeys, toConfidentPlainFields } from './documentFieldExtractionService';
import type { ContractIntelligenceResult } from '../types/documentIntelligence';
import { analyzeContractIntelligenceFromInbox } from './contractIntelligenceService';
import { formatGermanMoney } from './documentAmountExtractionService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import { assessTextQuality } from './textQualityService';

export type { DocumentUnderstandingSummary, DocumentAiAction, DocumentAiActionId };

function resolveText(item: InboxItem, recognizedText?: string): string {
  return recognizedText?.trim() || getInboxExtractedDocumentText(item) || '';
}

function resolveNextStep(classification?: DocumentClassificationResult | null): string {
  if (classification?.needsKindReview) {
    return 'Dokumentart bitte prüfen';
  }
  return classification?.nextTaskLabel || classification?.officePilotSuggestion || 'Dokument prüfen und passende Aktion wählen.';
}

export function buildDocumentUnderstandingSummary(
  item: InboxItem,
  options: {
    recognizedText?: string;
    classification?: DocumentClassificationResult | null;
    /** When set (including null), skips a second contract-intelligence pass. */
    contractIntelligence?: ContractIntelligenceResult | null;
  } = {},
): DocumentUnderstandingSummary {
  const text = resolveText(item, options.recognizedText);
  const recognizedData = item.recognizedData;
  const fieldsWithConfidence = extractFieldsWithConfidence(text);
  const extracted = toConfidentPlainFields(fieldsWithConfidence);
  const uncertainFields = listUncertainFieldKeys(fieldsWithConfidence);
  const intelligence =
    options.contractIntelligence !== undefined
      ? options.contractIntelligence
      : analyzeContractIntelligenceFromInbox(item);
  const resolvedAmount =
    intelligence?.contractTotalNet?.status === 'confirmed' && intelligence.contractTotalNet.value !== undefined
      ? formatGermanMoney(intelligence.contractTotalNet.value)
      : extracted.Betrag ?? recognizedData.Betrag;
  const quality = assessTextQuality(text);
  const classification = options.classification;
  const kind = item.classifiedKind ?? classification?.classifiedKind ?? 'sonstiges';
  const profile = classification?.documentProfile;
  const kindReviewRequired = Boolean(classification?.needsKindReview);
  const profileWarningKeys = [
    ...(kindReviewRequired ? ['document.profile.reviewKind', 'document.profile.multipleKindsPossible'] : []),
    ...(profile?.reviewReasonKeys ?? []),
  ];

  return {
    documentType: kind,
    sender:
      profile?.senderEntity ??
      extracted.Absender ??
      item.sender ??
      extracted.Lieferant ??
      recognizedData.Lieferant,
    recipient: extracted.Empfänger ?? extracted.Kunde ?? recognizedData.Kunde,
    date: extracted.Datum ?? recognizedData.Datum,
    referenceNumber: extracted.Aktenzeichen ?? recognizedData.Aktenzeichen,
    constructionSite:
      extracted.Baustelle ?? extracted.Projekt ?? recognizedData.Baustelle ?? recognizedData.Projekt,
    customer: extracted.Kunde ?? extracted.Empfänger ?? recognizedData.Kunde,
    vorgang: extracted.Vorgang ?? item.vorgangTitle ?? extracted.Projekt ?? recognizedData.Vorgang,
    invoiceNumber: extracted.Rechnungsnummer ?? recognizedData.Rechnungsnummer,
    amount: resolvedAmount,
    deadline: profile?.deadlineEvidence
      ? extracted.Frist ?? item.deadline ?? recognizedData.Frist ?? undefined
      : extracted.Frist ?? item.deadline ?? recognizedData.Frist ?? undefined,
    nextStep: resolveNextStep(classification),
    partialRecognition: !quality.readable && quality.wordCount > 0,
    uncertainFields: uncertainFields.length > 0 ? uncertainFields : undefined,
    kindReviewRequired: kindReviewRequired || undefined,
    suggestedDocumentKinds:
      classification?.suggestedKinds?.map(String) ??
      profile?.topCandidates.slice(0, 2).map((entry) => entry.kind),
    profileWarningKeys: profileWarningKeys.length > 0 ? [...new Set(profileWarningKeys)] : undefined,
  };
}

export function buildDocumentAiActions(
  kind: ClassifiedDocumentKind,
  summary: DocumentUnderstandingSummary,
  options: { paymentDemand?: boolean; needsKindReview?: boolean } = {},
): DocumentAiAction[] {
  const actions: DocumentAiAction[] = [];

  const push = (id: DocumentAiActionId, labelKey: string, recommended: boolean) => {
    actions.push({ id, labelKey, recommended });
  };

  if (options.needsKindReview || summary.kindReviewRequired) {
    push('archive_document', 'document.aiAction.archive', false);
    push('paper_folder', 'document.aiAction.paperFolder', true);
    return actions;
  }

  if (['werkvertrag', 'subunternehmervertrag', 'nachunternehmervertrag', 'auftrag', 'angebot', 'auftragsbestaetigung'].includes(kind)) {
    push('create_order', 'document.aiAction.createOrder', true);
  }

  if (kind === 'ausgangsrechnung') {
    push('write_invoice', 'document.aiAction.writeInvoice', true);
  }

  const mayMonitorPaymentDeadline =
    options.paymentDemand !== false &&
    (summary.deadline ||
      ['mahnung', 'zahlungserinnerung', 'finanzamt', 'bg_bau', 'steuerbescheid'].includes(kind));
  if (mayMonitorPaymentDeadline) {
    push('monitor_deadline', 'document.aiAction.monitorDeadline', Boolean(summary.deadline));
  }

  push('archive_document', 'document.aiAction.archive', true);
  push('paper_folder', 'document.aiAction.paperFolder', true);

  if (['finanzamt', 'steuerbescheid', 'umsatzsteuerbescheid', 'kontoauszug', 'lohnabrechnung', 'lohnunterlagen', 'freistellungsbescheinigung'].includes(kind)) {
    push('tax_advisor_relevant', 'document.aiAction.taxAdvisor', true);
  }

  return actions;
}

export function buildUnderstandingFromItem(
  item: InboxItem,
  classification?: DocumentClassificationResult | null,
  contractIntelligence?: ContractIntelligenceResult | null,
): { summary: DocumentUnderstandingSummary; actions: DocumentAiAction[] } {
  const summary = buildDocumentUnderstandingSummary(item, {
    classification,
    contractIntelligence,
  });
  const kind = item.classifiedKind ?? classification?.classifiedKind ?? 'sonstiges';
  const actions = buildDocumentAiActions(kind, summary, {
    paymentDemand: classification?.documentProfile?.paymentDemand,
    needsKindReview: classification?.needsKindReview ?? summary.kindReviewRequired,
  });
  return { summary, actions };
}
