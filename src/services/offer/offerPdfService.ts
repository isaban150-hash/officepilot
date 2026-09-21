/**
 * ANGEBOT-01B — PDF eines Angebots aus der vorhandenen Rechnungs-Engine.
 *
 * Kein eigener Satz, keine eigene Schrift, kein eigenes Layout: Das Modell
 * kommt aus `offerPrintModel`, die Bytes aus `renderOfferPrintModelToPdf`.
 * Nach der Freigabe stammt alles aus dem eingefrorenen Angebot; ein späterer
 * Wechsel von Logo oder Firmenprofil ändert das Ergebnis nicht.
 */
import { downloadInvoicePdfBytes, renderOfferPrintModelToPdf } from '../invoicePdfService';
import type { Offer } from '../../types/offer';
import { buildOfferPrintModel } from './offerPrintModel';

export type OfferPdfResult =
  | { ok: true; bytes: Uint8Array; filename: string; mimeType: 'application/pdf' }
  | { ok: false; reason: 'incomplete' | 'encode_failed'; message?: string };

export function buildOfferPdfFilename(offer: Pick<Offer, 'offerNumber' | 'id'>): string {
  const base = (offer.offerNumber ?? `Entwurf-${offer.id}`)
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `Angebot_${base || 'ohne_Nummer'}.pdf`;
}

/** Erzeugt die Bytes. Ändert am Angebot nichts und legt nichts ab. Entwürfe ergeben eine Vorschau mit „ENTWURF". */
export async function generateOfferPdf(offer: Offer): Promise<OfferPdfResult> {
  if (!offer.customer.name.trim() || offer.positions.filter((p) => p.quantity > 0).length === 0) {
    return { ok: false, reason: 'incomplete' };
  }
  try {
    const bytes = await renderOfferPrintModelToPdf(buildOfferPrintModel(offer));
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5) {
      return { ok: false, reason: 'encode_failed', message: 'empty_pdf' };
    }
    const head = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]);
    if (head !== '%PDF-') return { ok: false, reason: 'encode_failed', message: 'invalid_pdf_header' };
    return { ok: true, bytes, filename: buildOfferPdfFilename(offer), mimeType: 'application/pdf' };
  } catch (error) {
    return { ok: false, reason: 'encode_failed', message: error instanceof Error ? error.message : 'encode_failed' };
  }
}

export async function downloadOfferPdf(offer: Offer): Promise<OfferPdfResult> {
  const result = await generateOfferPdf(offer);
  if (result.ok) downloadInvoicePdfBytes(result.bytes, result.filename);
  return result;
}
