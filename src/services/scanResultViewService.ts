import { formatPaperFilingInstruction } from './paperFolderService';
import { isScanResultActionAvailable } from './officeActionService';
import { processUploadedDocument } from './intakeWorkflowService';
import type { InboxItem } from '../types/models';
import type { TranslationKey } from '../i18n';

const DOC_TYPE_LABELS: Record<string, string> = {
  eingangsrechnung: 'Rechnung',
  kundenauftrag: 'Auftrag',
  ausgangsrechnung: 'Rechnung',
  behoerde: 'Brief',
  brief: 'Brief',
  foto: 'Foto',
  sonstiges: 'Dokument',
};

export interface ScanResultActionView {
  id: string;
  labelKey: TranslationKey;
}

export interface ScanResultViewModel {
  recognizedTitle: string;
  recognizedSummary?: string;
  assistantMessageKey: TranslationKey;
  assistantMessageParams?: Record<string, string>;
  paperInstruction?: string;
  nextActions: ScanResultActionView[];
}

function docTypeLabel(documentType: string): string {
  return DOC_TYPE_LABELS[documentType] ?? 'Dokument';
}

function buildPaperInstruction(item: InboxItem): string | undefined {
  if (item.paperFiling) {
    const folder = formatPaperFilingInstruction(item.paperFiling);
    return folder.replace(
      'Bitte Original abheften in:',
      'Bitte lege das Original in den Ordner',
    );
  }

  const workflow = processUploadedDocument(item.id);
  const paper = workflow?.documentExplanation?.paperStorage;
  if (paper && paper.trim()) return paper;
  return undefined;
}

function buildNextActions(item: InboxItem): ScanResultActionView[] {
  const actions: ScanResultActionView[] = [];

  if (item.isAdvertisement) {
    actions.push({ id: 'dispose', labelKey: 'scanResult.action.dispose' });
    actions.push({ id: 'save', labelKey: 'scanResult.action.saveAnyway' });
    return actions.slice(0, 3);
  }

  switch (item.recommendedAction) {
    case 'abheften':
    case 'archivieren':
      actions.push({ id: 'filing', labelKey: 'scanResult.action.confirmFiling' });
      break;
    case 'entsorgen':
      actions.push({ id: 'dispose', labelKey: 'scanResult.action.dispose' });
      break;
    case 'zuordnen':
      actions.push({ id: 'assign', labelKey: 'scanResult.action.assignOrder' });
      break;
    case 'auftrag_annehmen':
      actions.push({ id: 'assign', labelKey: 'scanResult.action.createOrder' });
      break;
    case 'rechnung_vorbereiten':
      actions.push({ id: 'invoice', labelKey: 'scanResult.action.writeInvoice' });
      break;
    case 'zahlung_pruefen':
      actions.push({ id: 'payment', labelKey: 'scanResult.action.checkPayment' });
      break;
    case 'klaeren':
    case 'steuerberater_vorbereiten':
      actions.push({ id: 'review', labelKey: 'scanResult.action.review' });
      break;
    default:
      actions.push({ id: 'review', labelKey: 'scanResult.action.review' });
  }

  if (item.vorgangId) {
    actions.push({ id: 'openOrder', labelKey: 'scanResult.action.openOrder' });
  }

  return actions.filter((action) => isScanResultActionAvailable(action.id, item)).slice(0, 3);
}

export function buildScanResultView(item: InboxItem): ScanResultViewModel {
  const label = docTypeLabel(item.documentType);
  const recognizedTitle = item.sender ? `${label} von ${item.sender}` : item.title;

  if (item.isAdvertisement) {
    return {
      recognizedTitle: 'Werbung',
      recognizedSummary: item.title,
      assistantMessageKey: 'scanResult.message.advertisement',
      paperInstruction: undefined,
      nextActions: buildNextActions(item),
    };
  }

  let assistantMessageKey: TranslationKey = 'scanResult.message.recognized';
  const assistantMessageParams = { type: label.toLowerCase() };

  if (item.importedToArchive || item.markedAsCompanyDocument) {
    assistantMessageKey = 'scanResult.message.saved';
  } else if (item.status === 'abgelegt') {
    assistantMessageKey = 'scanResult.message.filed';
  }

  return {
    recognizedTitle,
    recognizedSummary:
      item.officePilotSuggestion ||
      item.recognizedData?.betreff ||
      item.recognizedData?.subject,
    assistantMessageKey,
    assistantMessageParams,
    paperInstruction: buildPaperInstruction(item),
    nextActions: buildNextActions(item),
  };
}
