import type {
  CompanyProfile,
  InvoicePrintModel,
  TaxStatus,
  VorgangInvoice,
} from '../../types/models';
import type { HistoricalInvoiceLogoSource } from '../../types/branding';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import { buildLegalNotices } from '../invoiceTaxService';
import { toInvoiceCompanySnapshot } from '../invoiceService';
import { resolveProfileDocumentTemplate } from '../company/companyProfileSettingsContract';

/**
 * SETTINGS-01B3 — „So sieht Ihr Dokument aus".
 *
 * Ein **reiner Anzeige-Builder**: Er erzeugt ein `InvoicePrintModel` für den
 * bestehenden Dokumentrenderer (`InvoiceDocumentView`) aus dem aktuellen
 * Firmenprofil-/Branding-Entwurf — und sonst nichts. Keine Rechnung, keine
 * Kennung, keine Nummer aus dem Nummernkreis, keine Finalisierung, kein
 * Cloud-Schreibvorgang, keine Archivierung.
 *
 * Firmenbezogene Werte (Name, Anschrift, Steuer-/Registerdaten, Bank,
 * Kontoinhaber, Logo, Vorlage) sind echt — aus dem übergebenen Entwurf.
 * Kunde, Positionen, Beträge und Nummer sind neutrale, als Vorschau
 * gekennzeichnete Beispieldaten; kein produktiver Datensatz wird berührt.
 *
 * Bestehende Rechnungen rendern weiterhin ihren historischen Snapshot —
 * dieser Builder wird von ihnen nie benutzt.
 */
export const PREVIEW_INVOICE_NUMBER = 'VORSCHAU-0001';

export interface SettingsDocumentPreviewInput {
  profile: CompanyProfile;
  /** Das Logo des Entwurfs — ausstehend, gespeichert oder entfernt. */
  logo: HistoricalInvoiceLogoSource;
  /** Beispielsteuerstatus für die Vorschau; Standard 19 %. */
  taxStatus?: TaxStatus;
  /** Fixes Datum für deterministische Tests; Standard: heute (UTC). */
  issueDate?: string;
}

const SAMPLE_CUSTOMER = {
  name: 'Beispiel Kunde GmbH',
  contactPerson: 'Max Beispiel',
  street: 'Musterweg 12',
  zip: '12345',
  city: 'Musterstadt',
  email: '',
  phone: '',
};

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function buildSettingsDocumentPreviewModel(
  input: SettingsDocumentPreviewInput,
): InvoicePrintModel {
  const profile = input.profile;
  const taxStatus = input.taxStatus ?? 'standard_19';
  const issueDate = input.issueDate ?? new Date().toISOString().slice(0, 10);
  const paymentDays = Number.isFinite(profile.defaultPaymentDays) ? profile.defaultPaymentDays : 14;

  /*
   * Ein rein lokales Beispielobjekt — nie gespeichert, nie mit einer echten
   * Kennung. Die Beträge sind so gewählt, dass Netto/Steuer/Brutto auf dem
   * Beleg gut lesbar sind.
   */
  const sample: VorgangInvoice = {
    id: 'settings-preview',
    number: PREVIEW_INVOICE_NUMBER,
    type: 'rechnung',
    positions: [
      { id: 'p1', description: 'Beispielposition: Wartung Heizungsanlage', quantity: 1, unit: 'Pauschal', unitPrice: 450, lineTotal: 450 },
      { id: 'p2', description: 'Beispielposition: Monteurstunden', quantity: 4, unit: 'Std', unitPrice: 65, lineTotal: 260 },
    ],
    subtotal: 710,
    taxStatus,
    amount: 0,
    status: 'vorbereitet',
    date: issueDate,
    issueDate,
    createdAt: `${issueDate}T00:00:00.000Z`,
    servicePeriodFrom: addDays(issueDate, -7),
    servicePeriodTo: issueDate,
    servicePeriodConfirmed: true,
    paymentDueDate: addDays(issueDate, paymentDays),
    paymentTermsText: profile.defaultPaymentTerms || '',
    skontoText: '',
    introText: (profile.defaultIntroText ?? '').trim() || 'Vielen Dank für Ihren Auftrag. Wir berechnen wie folgt:',
    closingText: (profile.defaultClosingText ?? '').trim(),
    legalNotices: buildLegalNotices(taxStatus, profile),
    previousAbschlagDeductions: [],
    customerSnapshot: { ...SAMPLE_CUSTOMER },
    companySnapshot: toInvoiceCompanySnapshot(profile),
    brandingSnapshot: { version: 1, documentTemplate: resolveProfileDocumentTemplate(profile) },
  } as VorgangInvoice;

  const model = buildInvoicePrintModelFromInvoice(sample);
  return {
    ...model,
    // Das Logo kommt aus dem Entwurf (ausstehend/gespeichert/entfernt), nicht aus dem Snapshot.
    logo: input.logo,
    documentTemplate: resolveProfileDocumentTemplate(profile),
  };
}
