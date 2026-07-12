import type { TranslationKey } from '../i18n';
import type { ClassifiedDocumentKind, DocumentType, InboxItem } from '../types/models';

const KIND_DISPLAY_KEYS: Partial<Record<ClassifiedDocumentKind, TranslationKey>> = {
  aok: 'docAssistant.display.aokLetter',
  barmer: 'docAssistant.display.healthInsuranceLetter',
  tk: 'docAssistant.display.healthInsuranceLetter',
  dak: 'docAssistant.display.healthInsuranceLetter',
  ikk: 'docAssistant.display.healthInsuranceLetter',
  knappschaft: 'docAssistant.display.healthInsuranceLetter',
  pflegekasse: 'docAssistant.display.healthInsuranceLetter',
  krankenkasse: 'docAssistant.display.healthInsuranceLetter',
  bg_bau: 'docAssistant.display.bgBauLetter',
  berufsgenossenschaft: 'docAssistant.display.bgBauLetter',
  soka_bau: 'docAssistant.display.sokaBauLetter',
  finanzamt: 'docAssistant.display.finanzamtLetter',
  steuerbescheid: 'docAssistant.display.taxNotice',
  umsatzsteuerbescheid: 'docAssistant.display.taxNotice',
  mahnung: 'docAssistant.display.reminder',
  zahlungserinnerung: 'docAssistant.display.paymentReminder',
  eingangsrechnung: 'docAssistant.display.invoice',
  rechnung: 'docAssistant.display.invoice',
  ausgangsrechnung: 'docAssistant.display.outgoingInvoice',
  freistellungsbescheinigung: 'docAssistant.display.freistellung',
  unbedenklichkeitsbescheinigung: 'docAssistant.display.unbedenklichkeit',
  werkvertrag: 'docAssistant.display.contract',
  auftrag: 'docAssistant.display.order',
  kontoauszug: 'docAssistant.display.bankStatement',
};

const DOCUMENT_TYPE_FALLBACK: Partial<Record<DocumentType, TranslationKey>> = {
  eingangsrechnung: 'docAssistant.display.invoice',
  ausgangsrechnung: 'docAssistant.display.outgoingInvoice',
  kundenauftrag: 'docAssistant.display.order',
  brief: 'docAssistant.display.letter',
  sonstiges: 'docAssistant.display.genericDocument',
};

export function getDocumentDisplayLabelKey(
  classifiedKind?: ClassifiedDocumentKind,
  documentType?: DocumentType,
): TranslationKey {
  if (classifiedKind && KIND_DISPLAY_KEYS[classifiedKind]) {
    return KIND_DISPLAY_KEYS[classifiedKind]!;
  }
  if (classifiedKind) {
    return `classifiedKind.${classifiedKind}` as TranslationKey;
  }
  if (documentType && DOCUMENT_TYPE_FALLBACK[documentType]) {
    return DOCUMENT_TYPE_FALLBACK[documentType]!;
  }
  return 'docAssistant.display.genericDocument';
}

export function formatDigitalFolderBreadcrumb(item: Pick<InboxItem, 'digitalFolder'>): string {
  const segments = item.digitalFolder.path
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return item.digitalFolder.name;
  }
  return segments.join(' → ');
}

export function formatPaperFolderLabel(register: string, folderName: string): string {
  if (!register.trim()) return folderName;
  return `${folderName} → ${register}`;
}

export function containsInternalLabel(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized.includes('classifiedkind') ||
    normalized.includes('documenttype') ||
    normalized.includes('ocr') ||
    /behoerde\s*\(/.test(normalized) ||
    /^behoerde$/.test(normalized)
  );
}
