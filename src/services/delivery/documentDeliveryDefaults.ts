import { t, type TranslationKey } from '../../i18n';
import type { AppLanguage, CompanyProfile, VorgangInvoice } from '../../types/models';
import type { DeliveryDocumentKind, DeliveryStatus, DocumentDelivery } from '../../types/documentDelivery';
import { getCustomerById } from '../customerStoreService';
import { isValidRecipientEmail, normalizeRecipientEmail } from './documentDeliveryContract';

/**
 * EMAIL-01B3/01B4 — die **einen** Default-Resolver für einen neuen Send-Entwurf:
 * Empfänger, Betreff, Nachricht. Keine verteilten String-Varianten.
 *
 * Priorität Betreff/Nachricht (Rechnung):
 *   1. gespeicherter Workspace-Standard (`CompanyProfile.defaultInvoiceEmail*`)
 *   2. i18n-Fallback in Produktsprache (de/tr/bg; ro/ru → Deutsch)
 * danach werden nur die bekannten Platzhalter ersetzt. Der Korrekturbeleg
 * nutzt bewusst einen festen i18n-Text — Rechnungs-Standards passen dort nicht.
 *
 * Empfänger-Priorität (kanonische Rechnungs-/Kundenidentität):
 *   1. `invoice.customerSnapshot.email` (historisch, im Fingerprint)
 *   2. aktueller Kundenstamm über `invoice.customerId`
 *   3. leer → der Nutzer muss eine Adresse eingeben; nie erfunden.
 * Diese Defaults gelten nur beim **ersten** Erzeugen eines Send-Entwurfs;
 * ein bestehender Entwurf, eine Delivery oder ein Retry nehmen ihre eigenen,
 * tatsächlich verwendeten Werte (siehe Orchestrator/Panel).
 */
export interface RecipientSuggestion {
  email: string;
  source: 'invoice_snapshot' | 'customer' | 'none';
}

export function resolveDeliveryRecipient(invoice: Pick<VorgangInvoice, 'customerSnapshot' | 'customerId'>): RecipientSuggestion {
  const snapshotEmail = normalizeRecipientEmail(invoice.customerSnapshot?.email ?? '');
  if (snapshotEmail && isValidRecipientEmail(snapshotEmail)) return { email: snapshotEmail, source: 'invoice_snapshot' };
  if (invoice.customerId) {
    const customer = getCustomerById(invoice.customerId);
    const customerEmail = normalizeRecipientEmail(customer?.email ?? '');
    if (customerEmail && isValidRecipientEmail(customerEmail)) return { email: customerEmail, source: 'customer' };
  }
  return { email: '', source: 'none' };
}

/**
 * Platzhalter: nur die bekannten werden ersetzt; unbekannte bleiben wörtlich
 * stehen (fail-safe, keine Template-Engine). Der Nutzer sieht das Ergebnis
 * vor dem Versand im Dialog.
 */
export const DELIVERY_MAIL_PLACEHOLDERS = ['invoiceNumber', 'companyName'] as const;

export function fillDeliveryPlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
}

type MailDefaultsProfile = Pick<CompanyProfile, 'defaultInvoiceEmailSubject' | 'defaultInvoiceEmailBody'>;
export type DeliveryMailKind = Extract<DeliveryDocumentKind, 'invoice' | 'invoice_correction'>;

function profileOverride(
  profile: MailDefaultsProfile | undefined,
  field: 'defaultInvoiceEmailSubject' | 'defaultInvoiceEmailBody',
): string | null {
  const value = profile?.[field];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Firmenname aus dem historischen Snapshot der Rechnung — nie aus dem heutigen Profil. */
export function companyDisplayName(invoice: Pick<VorgangInvoice, 'companySnapshot'>): string {
  const snapshot = invoice.companySnapshot;
  return [snapshot?.companyName?.trim(), snapshot?.legalForm?.trim()].filter(Boolean).join(' ');
}

function placeholderValues(invoice: Pick<VorgangInvoice, 'number' | 'companySnapshot'>): Record<string, string> {
  return { invoiceNumber: invoice.number, companyName: companyDisplayName(invoice) };
}

export function resolveDeliverySubject(
  invoice: Pick<VorgangInvoice, 'number' | 'companySnapshot'>,
  language: AppLanguage,
  profile?: MailDefaultsProfile,
  kind: DeliveryMailKind = 'invoice',
): string {
  const template =
    kind === 'invoice'
      ? (profileOverride(profile, 'defaultInvoiceEmailSubject') ?? t('delivery.mail.subject' as TranslationKey, language))
      : t('delivery.mail.correctionSubject' as TranslationKey, language);
  return fillDeliveryPlaceholders(template, placeholderValues(invoice));
}

export function resolveDeliveryBody(
  invoice: Pick<VorgangInvoice, 'number' | 'companySnapshot'>,
  language: AppLanguage,
  profile?: MailDefaultsProfile,
  kind: DeliveryMailKind = 'invoice',
): string {
  const template =
    kind === 'invoice'
      ? (profileOverride(profile, 'defaultInvoiceEmailBody') ?? t('delivery.mail.body' as TranslationKey, language))
      : t('delivery.mail.correctionBody' as TranslationKey, language);
  return fillDeliveryPlaceholders(template, placeholderValues(invoice));
}

export interface DeliveryDraftDefaults {
  recipient: RecipientSuggestion;
  subject: string;
  bodyText: string;
}

export function resolveDeliveryDraftDefaults(
  invoice: VorgangInvoice,
  language: AppLanguage,
  options: { profile?: MailDefaultsProfile; kind?: DeliveryMailKind } = {},
): DeliveryDraftDefaults {
  const kind = options.kind ?? 'invoice';
  return {
    recipient: resolveDeliveryRecipient(invoice),
    subject: resolveDeliverySubject(invoice, language, options.profile, kind),
    bodyText: resolveDeliveryBody(invoice, language, options.profile, kind),
  };
}

/** Statusanzeige-Schlüssel — `provider_accepted` ist „übergeben", nie „zugestellt". */
export function deliveryStatusLabelKey(status: DeliveryStatus): TranslationKey {
  return `delivery.status.${status}` as TranslationKey;
}

export function deliveryErrorLabelKey(delivery: Pick<DocumentDelivery, 'errorCategory'>): TranslationKey {
  return `delivery.error.${delivery.errorCategory ?? 'unknown'}` as TranslationKey;
}

/** Dokumentart in der Historie: Rechnung vs. Korrekturbeleg sichtbar unterscheiden. */
export function deliveryKindLabelKey(kind: DeliveryDocumentKind): TranslationKey {
  return `delivery.kind.${kind}` as TranslationKey;
}

/** Die jüngste Delivery, die als erfolgreicher OfficePilot-Versand gilt. */
export function findAcceptedDelivery(deliveries: DocumentDelivery[]): DocumentDelivery | undefined {
  return deliveries.find(
    (d) => d.status === 'provider_accepted' || d.status === 'delivered' || d.status === 'bounced' || d.status === 'complained',
  );
}
