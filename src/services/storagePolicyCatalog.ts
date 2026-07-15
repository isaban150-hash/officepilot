import type { ClassifiedDocumentKind } from '../types/models';
import type { StoragePolicyId } from '../types/storagePolicy';
import { CLASSIFIED_DOCUMENT_KINDS } from './documentClassificationCatalog';

/**
 * Deterministic fachliche Storage-Policy pro ClassifiedDocumentKind.
 * Medienprofil (native_pdf / scanned_pdf / raster_image) wird separat aufgelöst.
 */
export const STORAGE_POLICY_BY_KIND: Record<ClassifiedDocumentKind, StoragePolicyId> = {
  // Belege
  tankbeleg: 'receipt',
  kassenbeleg: 'receipt',
  quittung: 'receipt',
  ec_beleg: 'receipt',
  kreditkartenbeleg: 'receipt',

  // Geschäftsdokumente – Rechnungen & Zahlungsverkehr
  eingangsrechnung: 'business_document',
  rechnung: 'business_document',
  ausgangsrechnung: 'business_document',
  gutschrift: 'business_document',
  mahnung: 'business_document',
  zahlungserinnerung: 'business_document',
  kontoauszug: 'business_document',
  reparaturrechnung: 'business_document',

  // Geschäftsdokumente – Auftrag & Lieferung
  angebot: 'business_document',
  auftrag: 'business_document',
  auftragsbestaetigung: 'business_document',
  leistungsverzeichnis: 'business_document',
  nachtrag: 'business_document',
  lieferschein: 'business_document',
  abnahmeprotokoll: 'business_document',
  maengelprotokoll: 'business_document',
  uebergabeprotokoll: 'business_document',

  // Normale Geschäftskorrespondenz
  brief: 'business_document',
  schriftverkehr: 'business_document',
  email_pdf: 'business_document',
  pdf_anlage: 'business_document',
  notiz: 'business_document',

  // Verträge & Rechtliches
  werkvertrag: 'legal_document',
  subunternehmervertrag: 'legal_document',
  nachunternehmervertrag: 'legal_document',
  arbeitsvertrag: 'legal_document',
  leasingvertrag: 'legal_document',

  // Steuer- & Behördenbescheide
  steuerbescheid: 'legal_document',
  umsatzsteuerbescheid: 'legal_document',
  zoll: 'legal_document',
  handwerkskammer: 'legal_document',
  ihk: 'legal_document',
  gewerbeamt: 'legal_document',
  bauamt: 'legal_document',
  ordnungsamt: 'legal_document',
  finanzamt: 'legal_document',

  // Sozialversicherung, Krankenkasse, BG BAU, SOKA BAU
  agentur_fuer_arbeit: 'legal_document',
  deutsche_rentenversicherung: 'legal_document',
  bg_bau: 'legal_document',
  berufsgenossenschaft: 'legal_document',
  soka_bau: 'legal_document',
  aok: 'legal_document',
  barmer: 'legal_document',
  tk: 'legal_document',
  dak: 'legal_document',
  ikk: 'legal_document',
  knappschaft: 'legal_document',
  pflegekasse: 'legal_document',
  krankenkasse: 'legal_document',

  // Bescheinigungen & Firmennachweise
  freistellungsbescheinigung: 'legal_document',
  unbedenklichkeitsbescheinigung: 'legal_document',
  gewerbeanmeldung: 'legal_document',
  handelsregister: 'legal_document',
  handelsregisterauszug: 'legal_document',
  betriebserlaubnis: 'legal_document',
  zertifikat: 'legal_document',
  iso_nachweis: 'legal_document',

  // Versicherungen
  betriebshaftpflicht: 'legal_document',
  fahrzeugversicherung: 'legal_document',
  rechtsschutzversicherung: 'legal_document',
  gebaeudeversicherung: 'legal_document',
  versicherungsbescheid: 'legal_document',
  versicherung: 'legal_document',

  // Prüf-, Sicherheits- und Pflichtnachweise
  pruefprotokoll: 'legal_document',
  messprotokoll: 'legal_document',
  materialnachweis: 'legal_document',
  entsorgungsnachweis: 'legal_document',
  sicherheitsdokument: 'legal_document',
  unterweisung: 'legal_document',
  sicherheitsbelehrung: 'legal_document',
  tuev_bericht: 'legal_document',
  wartungsnachweis: 'legal_document',

  // Mitarbeiter & Lohn
  lohnabrechnung: 'legal_document',
  lohnunterlagen: 'legal_document',
  stundenzettel: 'legal_document',
  urlaubsantrag: 'legal_document',
  krankmeldung: 'legal_document',
  arbeitsunfaehigkeitsbescheinigung: 'legal_document',

  // Baustellenfotos
  baustellenfoto: 'construction_photo',
  foto: 'temporary_unknown',

  // Unklar / Fallback-Basis
  sonstiges: 'temporary_unknown',
};

export function getStoragePolicyForKind(kind: ClassifiedDocumentKind): StoragePolicyId {
  return STORAGE_POLICY_BY_KIND[kind];
}

export function assertStoragePolicyCatalogComplete(): void {
  for (const kind of CLASSIFIED_DOCUMENT_KINDS) {
    if (!(kind in STORAGE_POLICY_BY_KIND)) {
      throw new Error(`Missing storage policy for kind: ${kind}`);
    }
  }
}
