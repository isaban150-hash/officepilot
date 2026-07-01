import type { CommunicationContextRef } from '../../types/communication';
import type { TranslationKey } from '../../i18n';

export const INBOX_COMMUNICATION_BUTTON_KEYS: TranslationKey[] = [
  'communication.integration.inbox.question',
  'communication.integration.inbox.reply',
  'communication.integration.inbox.email',
  'communication.integration.inbox.whatsapp',
];

export const DOCUMENT_COMMUNICATION_BUTTON_KEYS: TranslationKey[] =
  INBOX_COMMUNICATION_BUTTON_KEYS;

export const VORGANG_COMMUNICATION_BUTTON_KEYS: TranslationKey[] = [
  'communication.integration.vorgang.messageToCustomer',
  'communication.integration.vorgang.email',
  'communication.integration.vorgang.whatsapp',
];

export const INVOICE_COMMUNICATION_BUTTON_KEYS: TranslationKey[] = [
  'communication.integration.invoice.paymentReminder',
  'communication.integration.invoice.email',
  'communication.integration.invoice.whatsapp',
];

export const EXPENSE_COMMUNICATION_BUTTON_KEYS: TranslationKey[] = [
  'communication.integration.expense.contactSupplier',
  'communication.integration.expense.paymentInquiry',
  'communication.integration.expense.email',
  'communication.integration.expense.whatsapp',
];

export function buildKommunikationPath(ref: CommunicationContextRef): string {
  if (ref.type === 'none') {
    return '/kommunikation';
  }

  const params = new URLSearchParams();
  params.set('context', ref.type);
  if (ref.id) {
    params.set('id', ref.id);
  }
  if (ref.vorgangId) {
    params.set('vorgangId', ref.vorgangId);
  }
  return `/kommunikation?${params.toString()}`;
}

export function parseContextRefFromSearchParams(
  searchParams: URLSearchParams,
): CommunicationContextRef {
  const context = searchParams.get('context');
  const id = searchParams.get('id');
  const vorgangId = searchParams.get('vorgangId');

  if (context === 'inbox' && id) {
    return { type: 'inbox', id };
  }
  if (context === 'document' && id) {
    return { type: 'document', id };
  }
  if (context === 'vorgang' && id) {
    return { type: 'vorgang', id };
  }
  if (context === 'invoice' && id && vorgangId) {
    return { type: 'invoice', id, vorgangId };
  }
  if (context === 'expense' && id) {
    return { type: 'expense', id };
  }
  return { type: 'none' };
}
