import type {
  ClassifiedDocumentKind,
  DocumentAiAction,
  DocumentAiActionId,
  DocumentClassificationResult,
  DocumentUnderstandingSummary,
  InboxItem,
} from '../types/models';
import { extractFieldsFromText } from './documentFieldExtractionService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import { assessTextQuality } from './textQualityService';

export type { DocumentUnderstandingSummary, DocumentAiAction, DocumentAiActionId };

function resolveText(item: InboxItem, recognizedText?: string): string {
  return recognizedText?.trim() || getInboxExtractedDocumentText(item) || '';
}

function resolveNextStep(classification?: DocumentClassificationResult | null): string {
  return classification?.nextTaskLabel || classification?.officePilotSuggestion || 'Dokument prüfen und passende Aktion wählen.';
}

export function buildDocumentUnderstandingSummary(
  item: InboxItem,
  options: {
    recognizedText?: string;
    classification?: DocumentClassificationResult | null;
  } = {},
): DocumentUnderstandingSummary {
  const text = resolveText(item, options.recognizedText);
  const extracted = extractFieldsFromText(text);
  const quality = assessTextQuality(text);
  const classification = options.classification;
  const kind = item.classifiedKind ?? classification?.classifiedKind ?? 'sonstiges';
  const recognizedData = item.recognizedData;

  return {
    documentType: kind,
    sender: extracted.Absender ?? item.sender ?? extracted.Lieferant ?? recognizedData.Lieferant,
    recipient: extracted.Empfänger ?? extracted.Kunde ?? recognizedData.Kunde,
    date: extracted.Datum ?? recognizedData.Datum,
    referenceNumber: extracted.Aktenzeichen ?? recognizedData.Aktenzeichen,
    constructionSite:
      extracted.Baustelle ?? extracted.Projekt ?? recognizedData.Baustelle ?? recognizedData.Projekt,
    customer: extracted.Kunde ?? extracted.Empfänger ?? recognizedData.Kunde,
    vorgang: extracted.Vorgang ?? item.vorgangTitle ?? extracted.Projekt ?? recognizedData.Vorgang,
    invoiceNumber: extracted.Rechnungsnummer ?? recognizedData.Rechnungsnummer,
    amount: extracted.Betrag ?? recognizedData.Betrag,
    deadline: extracted.Frist ?? item.deadline ?? recognizedData.Frist ?? undefined,
    nextStep: resolveNextStep(classification),
    partialRecognition: !quality.readable && quality.wordCount > 0,
  };
}

export function buildDocumentAiActions(
  kind: ClassifiedDocumentKind,
  summary: DocumentUnderstandingSummary,
): DocumentAiAction[] {
  const actions: DocumentAiAction[] = [];

  const push = (id: DocumentAiActionId, labelKey: string, recommended: boolean) => {
    actions.push({ id, labelKey, recommended });
  };

  if (['werkvertrag', 'subunternehmervertrag', 'nachunternehmervertrag', 'auftrag', 'angebot', 'auftragsbestaetigung'].includes(kind)) {
    push('create_order', 'document.aiAction.createOrder', true);
  }

  if (['eingangsrechnung', 'rechnung', 'mahnung', 'zahlungserinnerung', 'ausgangsrechnung', 'gutschrift'].includes(kind)) {
    push('write_invoice', 'document.aiAction.writeInvoice', kind === 'ausgangsrechnung');
  }

  if (summary.deadline || ['mahnung', 'zahlungserinnerung', 'finanzamt', 'bg_bau', 'steuerbescheid'].includes(kind)) {
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
): { summary: DocumentUnderstandingSummary; actions: DocumentAiAction[] } {
  const summary = buildDocumentUnderstandingSummary(item, { classification });
  const kind = item.classifiedKind ?? classification?.classifiedKind ?? 'sonstiges';
  const actions = buildDocumentAiActions(kind, summary);
  return { summary, actions };
}
