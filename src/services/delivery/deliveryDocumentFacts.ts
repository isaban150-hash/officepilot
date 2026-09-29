/**
 * E-MAIL-07C — Platzhalterwerte eines Archivdokuments, ausschliesslich über
 * Kennungen: Brief → Kunde, Angebot → Nummer und Kunde, sonst Vorgang →
 * Kunde. Was sich nicht eindeutig ergibt, bleibt leer (der Platzhalter
 * verschwindet dann sauber).
 *
 * E-MAIL-HALBZEIT-FIX A1 — beim Angebot ist `documentTitle` der fachliche
 * Angebotstitel (`offer.title`). Der Archivtitel des PDFs („AN-2026-0001 –
 * Angebot“) enthält bereits die Nummer; als Titel eingesetzt stand sie im
 * Mailtext doppelt. Fehlt der Angebotstitel, gilt weiter der Archivtitel.
 */
import type { CompanyDocument } from '../../types/models';
import { getBusinessLetterById } from '../businessLetterService';
import { getCustomerById } from '../customerStoreService';
import { getOfferById } from '../offer/offerService';
import { getVorgangById } from '../vorgangService';

export interface DeliveryDocumentFacts {
  documentNumber?: string;
  customerName?: string;
  /** Fachlicher Titel, wenn das Dokument ihn kennt (Angebot); sonst der Archivtitel. */
  documentTitle?: string;
}

function customerName(customerId: string | undefined): string | undefined {
  return customerId ? getCustomerById(customerId)?.name?.trim() || undefined : undefined;
}

export function resolveDeliveryDocumentFacts(document: Pick<CompanyDocument, 'linkedLetterId' | 'linkedOfferId' | 'linkedVorgang'>): DeliveryDocumentFacts {
  if (document.linkedLetterId) {
    const letter = getBusinessLetterById(document.linkedLetterId);
    if (letter) return { customerName: customerName(letter.customerId) };
  }
  if (document.linkedOfferId) {
    const offer = getOfferById(document.linkedOfferId);
    if (offer) {
      return {
        documentNumber: offer.offerNumber?.trim() || undefined,
        documentTitle: offer.title?.trim() || undefined,
        customerName: customerName(offer.customerId) ?? (offer.customer?.name?.trim() || undefined),
      };
    }
  }
  const vorgang = document.linkedVorgang ? getVorgangById(document.linkedVorgang.vorgangId) : undefined;
  return { customerName: customerName(vorgang?.customerId) };
}
