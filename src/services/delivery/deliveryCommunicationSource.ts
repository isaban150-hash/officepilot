/**
 * E-MAIL-07C — wohin führt ein Eintrag der Kommunikationshistorie?
 *
 * Zum Quelldokument, soweit es lokal bekannt ist: Rechnung, Geschäftsbrief,
 * Angebot oder Archivdokument — dort liegt auch die vollständige Versand-
 * historie. Unbekannt (z. B. auf einem anderen Gerät angelegt, noch nicht
 * synchronisiert): nur die Beschriftung aus dem Anhang, kein Link.
 */
import type { TranslationKey } from '../../i18n';
import type { DocumentDelivery } from '../../types/documentDelivery';
import { getBusinessLetterById } from '../businessLetterService';
import { getDocumentById } from '../documentService';
import { getInvoiceStoreSnapshot } from '../invoice/invoiceStore';
import { getOfferById } from '../offer/offerService';
import { deliveryKindLabelKey } from './documentDeliveryDefaults';

export interface DeliverySource {
  label: string;
  to?: string;
}

export function describeDeliverySource(
  delivery: DocumentDelivery,
  translate: (key: TranslationKey) => string,
): DeliverySource {
  const kindLabel = translate(deliveryKindLabelKey(delivery.documentKind));
  const fallbackLabel = delivery.attachment?.filename?.replace(/\.pdf$/i, '');

  if (delivery.linkedInvoiceId) {
    const entry = getInvoiceStoreSnapshot().find((candidate) => candidate.invoice.id === delivery.linkedInvoiceId);
    if (entry) {
      return {
        label: `${kindLabel} ${entry.invoice.number || ''}`.trim(),
        to: entry.vorgangId ? `/vorgaenge/${entry.vorgangId}/rechnungen/${entry.invoice.id}` : undefined,
      };
    }
  }

  if (delivery.linkedDocumentId) {
    const document = getDocumentById(delivery.linkedDocumentId);
    if (document?.linkedLetterId) {
      const letter = getBusinessLetterById(document.linkedLetterId);
      if (letter) return { label: `${kindLabel} ${letter.subject}`.trim(), to: `/schreiben/${letter.id}` };
    }
    if (document?.linkedOfferId) {
      const offer = getOfferById(document.linkedOfferId);
      if (offer) return { label: `${kindLabel} ${offer.offerNumber || document.title}`.trim(), to: `/angebote/${offer.id}` };
    }
    if (document) return { label: `${kindLabel} ${document.title}`.trim(), to: `/dokumente/${document.id}` };
  }

  return { label: fallbackLabel ? `${kindLabel} ${fallbackLabel}` : kindLabel };
}
