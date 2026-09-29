/**
 * E-MAIL-07D — kleine Anzeigehelfer der freien E-Mail (Status, Größen, Zeiten).
 * Status in Alltagssprache über dieselben Texte wie der Dokumentversand.
 */
import type { TranslationKey } from '../../i18n';
import type { EmailMessage, EmailMessageStatus } from '../../types/emailMessage';
import { deliveryStatusLabelKey } from '../../services/delivery/documentDeliveryDefaults';
import { deliveryDisplayHintKey, deliveryDisplayLabelKey, deliveryDisplayTone, displayDeliveryStatus } from '../../services/delivery/providerDeliveryState';
import { getCustomerById } from '../../services/customerStoreService';
import { getVorgangById } from '../../services/vorgangService';
import { formatDisplayDateTime } from '../../utils/displayFormat';

export function emailStatusLabelKey(status: EmailMessageStatus): TranslationKey {
  // E-MAIL-07E — eingegangene Mail hat keinen Versandstatus.
  if (status === 'received') return 'inboundEmail.label' as TranslationKey;
  return deliveryStatusLabelKey(status);
}

export function emailStatusTone(status: EmailMessageStatus): 'success' | 'critical' | 'warning' | 'info' {
  if (status === 'provider_accepted') return 'success';
  if (status === 'failed') return 'critical';
  if (status === 'unknown') return 'warning';
  return 'info';
}

/**
 * E-MAIL 07F-01B — sichtbarer Status einer Nachricht: Versandstatus, nach der
 * Übergabe ergänzt um die Rückmeldung des E-Mail-Dienstes (zugestellt,
 * verzögert, nicht zugestellt …). Nie „gelesen".
 */
export function emailDisplayStatus(message: Pick<EmailMessage, 'status' | 'deliveryState'>): string {
  return displayDeliveryStatus(message.status, message.deliveryState);
}

export function emailDisplayLabelKey(message: Pick<EmailMessage, 'status' | 'deliveryState'>): TranslationKey {
  const status = emailDisplayStatus(message);
  return status === 'received' ? emailStatusLabelKey('received') : deliveryDisplayLabelKey(status);
}

export function emailDisplayTone(message: Pick<EmailMessage, 'status' | 'deliveryState'>): 'success' | 'critical' | 'warning' | 'info' {
  return deliveryDisplayTone(emailDisplayStatus(message));
}

export function emailDisplayHintKey(message: Pick<EmailMessage, 'status' | 'deliveryState'>): TranslationKey | null {
  return deliveryDisplayHintKey(emailDisplayStatus(message));
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('de-DE')} KB`;
  return `${bytes} B`;
}

/** HALBZEIT-FIX B3 — Hausformat `26.09.2026, 20:13`. */
export function formatTimestamp(value?: string): string {
  return formatDisplayDateTime(value);
}

/** Kunde/Vorgang als lesbarer Name — nur über die Kennung, nie geraten. */
export function describeEmailContext(message: Pick<EmailMessage, 'customerId' | 'vorgangId'>): { customer?: string; vorgang?: string } {
  const customer = message.customerId ? getCustomerById(message.customerId) : undefined;
  const vorgang = message.vorgangId ? getVorgangById(message.vorgangId) : undefined;
  return {
    customer: message.customerId ? customer?.name?.trim() || undefined : undefined,
    vorgang: message.vorgangId ? vorgang?.title?.trim() || undefined : undefined,
  };
}
