/**
 * ANGEBOT-01B — das Druckmodell eines Angebots.
 *
 * Bewusst **dasselbe** Modell wie die Rechnung (`InvoicePrintModel`), nur mit
 * gesetztem `offer`-Kontext: Kopf, Absender, Empfänger, Positionen, Summen,
 * Steuerhinweise und Fusszeile rendern Bildschirm und PDF mit den vorhandenen
 * Bausteinen. Angebotsspezifisch sind nur Titel, Nummer, Datum, „Gültig bis"
 * und die Konditionen anstelle von Leistungszeitraum und Fälligkeit.
 *
 * Nach der Freigabe stammen Firma, Branding, Rechtshinweise und Summen aus
 * dem eingefrorenen Angebot — nie aus dem heutigen Profil. Im Entwurf gilt
 * das aktuelle Profil, damit Korrekturen daran noch sichtbar werden.
 */
import type { CompanyProfile, InvoicePrintModel, InvoicePrintPosition } from '../../types/models';
import { DEFAULT_DOCUMENT_TEMPLATE } from '../../types/branding';
import type { Offer } from '../../types/offer';
import { formatOrderUnitDisplay } from '../orderUnitMapper';
import { lineTotalMoney } from '../invoiceMoney';
import { selectHistoricalInvoiceLogo } from '../invoice/invoiceHistoricalLogo';
import { buildLegalNotices, freezeBrandingForInvoice, toInvoiceCompanySnapshot } from '../invoiceService';
import { getCompanyProfileStoreSnapshot } from '../companyProfileService';
import { getOfferTotals, isOfferFrozen } from './offerService';

export const OFFER_DOCUMENT_TITLE = 'Angebot';
export const OFFER_DRAFT_NUMBER_LABEL = 'ENTWURF';

function buildPositions(offer: Offer): InvoicePrintPosition[] {
  return offer.positions
    .filter((p) => p.quantity > 0)
    .map((position, index) => ({
      index: index + 1,
      description: position.description,
      quantity: position.quantity,
      unit: formatOrderUnitDisplay(position.unit, position.unitLabel),
      unitPrice: position.unitPrice,
      lineTotal: lineTotalMoney(position.quantity, position.unitPrice),
    }));
}

export function buildOfferPrintModel(offer: Offer, profileForDraft?: CompanyProfile): InvoicePrintModel {
  const frozen = isOfferFrozen(offer);
  const profile = profileForDraft ?? getCompanyProfileStoreSnapshot();
  const company = frozen && offer.companySnapshot ? offer.companySnapshot : toInvoiceCompanySnapshot(profile);
  const branding = frozen && offer.brandingSnapshot ? offer.brandingSnapshot : freezeBrandingForInvoice(profile.branding);
  const legalNotices = frozen && offer.legalNotices ? offer.legalNotices : buildLegalNotices(offer.taxStatus, profile);
  const totals = getOfferTotals(offer);

  return {
    type: 'rechnung',
    documentTitle: OFFER_DOCUMENT_TITLE,
    invoiceNumber: offer.offerNumber ?? OFFER_DRAFT_NUMBER_LABEL,
    issueDate: offer.offerDate,
    company: { ...company },
    logo: selectHistoricalInvoiceLogo({ brandingSnapshot: branding, companySnapshot: company }),
    customer: { ...offer.customer },
    projectTitle: offer.title,
    projectSite: offer.baustelle,
    servicePeriodFrom: '',
    servicePeriodTo: '',
    introText: offer.introText,
    closingText: offer.closingText,
    positions: buildPositions(offer),
    summary: {
      subtotalNet: totals.subtotal,
      taxRate: totals.taxRate,
      taxAmount: totals.tax,
      grossTotal: totals.total,
      deductionLines: [],
      deductionsTotal: 0,
      amountDue: totals.total,
    },
    taxStatus: offer.taxStatus,
    taxNotices: [...legalNotices],
    paymentDueDate: '',
    paymentTermsText: offer.paymentTermsText,
    skontoText: '',
    footerNotes: company.invoiceFooterNotes ?? '',
    documentTemplate: branding.documentTemplate ?? DEFAULT_DOCUMENT_TEMPLATE,
    offer: { validUntil: offer.validUntil, isDraft: !frozen },
  };
}
