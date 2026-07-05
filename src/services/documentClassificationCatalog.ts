import type {
  ClassifiedDocumentKind,
  DocumentType,
  InboxPriority,
  ProcessType,
  RecommendedAction,
  SuggestedDocumentAction,
} from '../types/models';
import { suggestPaperFolderId as resolvePaperFolderIdFromService } from './paperFolderService';

export interface ClassificationRule {
  kind: ClassifiedDocumentKind;
  pattern: RegExp;
  reasonKey: string;
}

export const CLASSIFICATION_RULES: ClassificationRule[] = [
  { kind: 'werkvertrag', pattern: /werkvertrag|werkvertrags/, reasonKey: 'classification.detect.werkvertrag' },
  { kind: 'subunternehmervertrag', pattern: /subunternehmervertrag|subunternehmer/, reasonKey: 'classification.detect.subunternehmer' },
  { kind: 'nachunternehmervertrag', pattern: /nachunternehmervertrag|nachunternehmer/, reasonKey: 'classification.detect.nachunternehmer' },
  { kind: 'mahnung', pattern: /mahnung|inkasso|zahlungsaufforderung/, reasonKey: 'classification.detect.mahnung' },
  { kind: 'zahlungserinnerung', pattern: /zahlungserinnerung/, reasonKey: 'classification.detect.zahlungserinnerung' },
  { kind: 'freistellungsbescheinigung', pattern: /freistellungsbescheinigung|§48b|§48 b/, reasonKey: 'classification.detect.freistellung' },
  { kind: 'unbedenklichkeitsbescheinigung', pattern: /unbedenklichkeitsbescheinigung|unbedenklichkeit/, reasonKey: 'classification.detect.unbedenklichkeit' },
  { kind: 'abnahmeprotokoll', pattern: /abnahmeprotokoll|abnahme protokoll/, reasonKey: 'classification.detect.abnahmeprotokoll' },
  { kind: 'maengelprotokoll', pattern: /mängelprotokoll|maengelprotokoll|mangelprotokoll/, reasonKey: 'classification.detect.maengelprotokoll' },
  { kind: 'uebergabeprotokoll', pattern: /übergabeprotokoll|uebergabeprotokoll/, reasonKey: 'classification.detect.uebergabeprotokoll' },
  { kind: 'bg_bau', pattern: /bg[\s-]?bau|berufsgenossenschaft der bauwirtschaft/, reasonKey: 'classification.detect.bgBau' },
  { kind: 'berufsgenossenschaft', pattern: /berufsgenossenschaft/, reasonKey: 'classification.detect.berufsgenossenschaft' },
  { kind: 'soka_bau', pattern: /soka[\s-]?bau/, reasonKey: 'classification.detect.sokaBau' },
  { kind: 'krankmeldung', pattern: /krankmeldung|krankgemeldet/, reasonKey: 'classification.detect.krankmeldung' },
  { kind: 'arbeitsunfaehigkeitsbescheinigung', pattern: /arbeitsunfähigkeit|arbeitsunfaehigkeit|au-bescheinigung|krankenschein/, reasonKey: 'classification.detect.auBescheinigung' },
  { kind: 'aok', pattern: /\baok\b/, reasonKey: 'classification.detect.aok' },
  { kind: 'barmer', pattern: /\bbarmer\b/, reasonKey: 'classification.detect.barmer' },
  { kind: 'tk', pattern: /techniker[\s-]?kranken|\btk\b/, reasonKey: 'classification.detect.tk' },
  { kind: 'dak', pattern: /\bdak\b|dak[\s-]?gesundheit/, reasonKey: 'classification.detect.dak' },
  { kind: 'ikk', pattern: /\bikk\b/, reasonKey: 'classification.detect.ikk' },
  { kind: 'knappschaft', pattern: /knappschaft/, reasonKey: 'classification.detect.knappschaft' },
  { kind: 'pflegekasse', pattern: /pflegekasse/, reasonKey: 'classification.detect.pflegekasse' },
  { kind: 'krankenkasse', pattern: /krankenkasse/, reasonKey: 'classification.detect.krankenkasse' },
  { kind: 'zoll', pattern: /\bzoll\b|hauptzollamt/, reasonKey: 'classification.detect.zoll' },
  { kind: 'handwerkskammer', pattern: /handwerkskammer/, reasonKey: 'classification.detect.handwerkskammer' },
  { kind: 'ihk', pattern: /\bihk\b|industrie[\s-]?und[\s-]?handelskammer/, reasonKey: 'classification.detect.ihk' },
  { kind: 'gewerbeamt', pattern: /gewerbeamt/, reasonKey: 'classification.detect.gewerbeamt' },
  { kind: 'bauamt', pattern: /bauamt|bauaufsicht/, reasonKey: 'classification.detect.bauamt' },
  { kind: 'ordnungsamt', pattern: /ordnungsamt/, reasonKey: 'classification.detect.ordnungsamt' },
  { kind: 'agentur_fuer_arbeit', pattern: /agentur für arbeit|arbeitsagentur/, reasonKey: 'classification.detect.agenturArbeit' },
  { kind: 'deutsche_rentenversicherung', pattern: /deutsche rentenversicherung|rentenversicherung/, reasonKey: 'classification.detect.rentenversicherung' },
  { kind: 'steuerbescheid', pattern: /steuerbescheid/, reasonKey: 'classification.detect.steuerbescheid' },
  { kind: 'umsatzsteuerbescheid', pattern: /umsatzsteuerbescheid/, reasonKey: 'classification.detect.umsatzsteuerbescheid' },
  { kind: 'finanzamt', pattern: /finanzamt|umsatzsteuer|lohnsteuer|steuernummer/, reasonKey: 'classification.detect.finanzamt' },
  { kind: 'gewerbeanmeldung', pattern: /gewerbeanmeldung|gewerbeanzeige/, reasonKey: 'classification.detect.gewerbeanmeldung' },
  { kind: 'handelsregisterauszug', pattern: /handelsregisterauszug/, reasonKey: 'classification.detect.handelsregisterauszug' },
  { kind: 'handelsregister', pattern: /handelsregister|hrb|hr a|amtsgericht.*register/, reasonKey: 'classification.detect.handelsregister' },
  { kind: 'betriebserlaubnis', pattern: /betriebserlaubnis/, reasonKey: 'classification.detect.betriebserlaubnis' },
  { kind: 'iso_nachweis', pattern: /iso[\s-]?9001|iso[\s-]?14001|iso-nachweis/, reasonKey: 'classification.detect.isoNachweis' },
  { kind: 'zertifikat', pattern: /zertifikat|zertifizierung/, reasonKey: 'classification.detect.zertifikat' },
  { kind: 'ausgangsrechnung', pattern: /ausgangsrechnung|rechnung an kunde/, reasonKey: 'classification.detect.ausgangsrechnung' },
  { kind: 'gutschrift', pattern: /gutschrift/, reasonKey: 'classification.detect.gutschrift' },
  { kind: 'quittung', pattern: /quittung/, reasonKey: 'classification.detect.quittung' },
  { kind: 'kassenbeleg', pattern: /kassenbeleg|kassenbon/, reasonKey: 'classification.detect.kassenbeleg' },
  { kind: 'ec_beleg', pattern: /ec-beleg|ec beleg|kartenzahlung/, reasonKey: 'classification.detect.ecBeleg' },
  { kind: 'kreditkartenbeleg', pattern: /kreditkartenbeleg|kreditkarte/, reasonKey: 'classification.detect.kreditkartenbeleg' },
  { kind: 'tankbeleg', pattern: /tankbeleg|tankstelle|kraftstoff|diesel|benzin/, reasonKey: 'classification.detect.tankbeleg' },
  { kind: 'kontoauszug', pattern: /kontoauszug|kontoumsätze|kontobewegungen|sparkasse|volksbank|commerzbank/, reasonKey: 'classification.detect.kontoauszug' },
  { kind: 'lohnabrechnung', pattern: /lohnabrechnung|gehaltsabrechnung|entgeltabrechnung/, reasonKey: 'classification.detect.lohnabrechnung' },
  { kind: 'lohnunterlagen', pattern: /lohnunterlagen/, reasonKey: 'classification.detect.lohnunterlagen' },
  { kind: 'stundenzettel', pattern: /stundenzettel|stundenliste|arbeitszeitnachweis/, reasonKey: 'classification.detect.stundenzettel' },
  { kind: 'arbeitsvertrag', pattern: /arbeitsvertrag/, reasonKey: 'classification.detect.arbeitsvertrag' },
  { kind: 'urlaubsantrag', pattern: /urlaubsantrag/, reasonKey: 'classification.detect.urlaubsantrag' },
  { kind: 'unterweisung', pattern: /unterweisung|schulungsnachweis/, reasonKey: 'classification.detect.unterweisung' },
  { kind: 'sicherheitsbelehrung', pattern: /sicherheitsbelehrung/, reasonKey: 'classification.detect.sicherheitsbelehrung' },
  { kind: 'betriebshaftpflicht', pattern: /betriebshaftpflicht/, reasonKey: 'classification.detect.betriebshaftpflicht' },
  { kind: 'fahrzeugversicherung', pattern: /fahrzeugversicherung|kfz-versicherung/, reasonKey: 'classification.detect.fahrzeugversicherung' },
  { kind: 'rechtsschutzversicherung', pattern: /rechtsschutzversicherung|rechtsschutz/, reasonKey: 'classification.detect.rechtsschutz' },
  { kind: 'gebaeudeversicherung', pattern: /gebäudeversicherung|gebaeudeversicherung/, reasonKey: 'classification.detect.gebaeudeversicherung' },
  { kind: 'versicherungsbescheid', pattern: /versicherungsbescheid/, reasonKey: 'classification.detect.versicherungsbescheid' },
  { kind: 'versicherung', pattern: /versicherung|haftpflicht|allianz|policy|versicherungsschreiben/, reasonKey: 'classification.detect.versicherung' },
  { kind: 'tuev_bericht', pattern: /tüv|tuev|hauptuntersuchung/, reasonKey: 'classification.detect.tuev' },
  { kind: 'reparaturrechnung', pattern: /reparaturrechnung|werkstattrechnung/, reasonKey: 'classification.detect.reparaturrechnung' },
  { kind: 'leasingvertrag', pattern: /leasingvertrag|leasing/, reasonKey: 'classification.detect.leasing' },
  { kind: 'wartungsnachweis', pattern: /wartungsnachweis|wartungsprotokoll/, reasonKey: 'classification.detect.wartung' },
  { kind: 'messprotokoll', pattern: /messprotokoll/, reasonKey: 'classification.detect.messprotokoll' },
  { kind: 'materialnachweis', pattern: /materialnachweis|materialliste/, reasonKey: 'classification.detect.materialnachweis' },
  { kind: 'entsorgungsnachweis', pattern: /entsorgungsnachweis|entsorgung/, reasonKey: 'classification.detect.entsorgung' },
  { kind: 'sicherheitsdokument', pattern: /sicherheitsdokument|gefahrstoff|psa/, reasonKey: 'classification.detect.sicherheitsdokument' },
  { kind: 'pruefprotokoll', pattern: /prüfprotokoll|pruefprotokoll|prüfbericht/, reasonKey: 'classification.detect.pruefprotokoll' },
  { kind: 'auftragsbestaetigung', pattern: /auftragsbestätigung|auftragsbestaetigung/, reasonKey: 'classification.detect.auftragsbestaetigung' },
  { kind: 'leistungsverzeichnis', pattern: /leistungsverzeichnis|\blv\b/, reasonKey: 'classification.detect.leistungsverzeichnis' },
  { kind: 'nachtrag', pattern: /nachtrag|nachtragsangebot/, reasonKey: 'classification.detect.nachtrag' },
  { kind: 'auftrag', pattern: /kundenauftrag|auftrag erteilt|auftragserteilung/, reasonKey: 'classification.detect.auftrag' },
  { kind: 'angebot', pattern: /angebot|kostenvoranschlag|offerte/, reasonKey: 'classification.detect.angebot' },
  { kind: 'lieferschein', pattern: /lieferschein|wareneingang/, reasonKey: 'classification.detect.lieferschein' },
  { kind: 'eingangsrechnung', pattern: /eingangsrechnung|materialrechnung|rechnungsnummer|invoice/, reasonKey: 'classification.detect.eingangsrechnung' },
  { kind: 'rechnung', pattern: /rechnung/, reasonKey: 'classification.detect.rechnung' },
  { kind: 'email_pdf', pattern: /email|e-mail|mail-anhang/, reasonKey: 'classification.detect.emailPdf' },
  { kind: 'schriftverkehr', pattern: /schriftverkehr|korrespondenz/, reasonKey: 'classification.detect.schriftverkehr' },
  { kind: 'notiz', pattern: /notiz|memo/, reasonKey: 'classification.detect.notiz' },
  { kind: 'baustellenfoto', pattern: /baustelle|baustellenfoto/, reasonKey: 'classification.detect.baustellenfoto' },
  { kind: 'foto', pattern: /\.(jpg|jpeg|png|heic|webp)$/, reasonKey: 'classification.detect.foto' },
  { kind: 'pdf_anlage', pattern: /\.pdf$/, reasonKey: 'classification.detect.pdfAnlage' },
  { kind: 'brief', pattern: /brief|schreiben|mitteilung|einladung/, reasonKey: 'classification.detect.brief' },
];

export const CLASSIFIED_DOCUMENT_KINDS: ClassifiedDocumentKind[] = [
  'zoll', 'handwerkskammer', 'ihk', 'gewerbeamt', 'bauamt', 'ordnungsamt',
  'agentur_fuer_arbeit', 'deutsche_rentenversicherung', 'finanzamt', 'bg_bau', 'berufsgenossenschaft',
  'aok', 'barmer', 'tk', 'dak', 'ikk', 'knappschaft', 'pflegekasse', 'soka_bau', 'krankenkasse',
  'eingangsrechnung', 'rechnung', 'ausgangsrechnung', 'gutschrift', 'quittung', 'kassenbeleg',
  'ec_beleg', 'kreditkartenbeleg', 'kontoauszug', 'steuerbescheid', 'umsatzsteuerbescheid',
  'mahnung', 'zahlungserinnerung',
  'werkvertrag', 'subunternehmervertrag', 'nachunternehmervertrag', 'auftrag', 'angebot',
  'auftragsbestaetigung', 'leistungsverzeichnis', 'nachtrag', 'lieferschein',
  'abnahmeprotokoll', 'maengelprotokoll', 'uebergabeprotokoll',
  'arbeitsvertrag', 'lohnabrechnung', 'lohnunterlagen', 'stundenzettel', 'urlaubsantrag',
  'krankmeldung', 'arbeitsunfaehigkeitsbescheinigung', 'unterweisung', 'sicherheitsbelehrung',
  'betriebshaftpflicht', 'fahrzeugversicherung', 'rechtsschutzversicherung', 'gebaeudeversicherung',
  'versicherungsbescheid', 'versicherung',
  'gewerbeanmeldung', 'handelsregister', 'handelsregisterauszug', 'freistellungsbescheinigung',
  'unbedenklichkeitsbescheinigung', 'betriebserlaubnis', 'zertifikat', 'iso_nachweis',
  'baustellenfoto', 'pruefprotokoll', 'messprotokoll', 'materialnachweis', 'entsorgungsnachweis',
  'sicherheitsdokument',
  'tuev_bericht', 'reparaturrechnung', 'leasingvertrag', 'tankbeleg', 'wartungsnachweis',
  'brief', 'schriftverkehr', 'email_pdf', 'pdf_anlage', 'notiz', 'foto', 'sonstiges',
];

const KIND_SET = new Set<string>(CLASSIFIED_DOCUMENT_KINDS);

export function isKnownClassifiedKind(value: string): value is ClassifiedDocumentKind {
  return KIND_SET.has(value);
}

const BEHOERDE_KINDS = new Set<ClassifiedDocumentKind>([
  'zoll', 'handwerkskammer', 'ihk', 'gewerbeamt', 'bauamt', 'ordnungsamt',
  'agentur_fuer_arbeit', 'deutsche_rentenversicherung', 'finanzamt', 'bg_bau',
  'berufsgenossenschaft', 'soka_bau', 'aok', 'barmer', 'tk', 'dak', 'ikk',
  'knappschaft', 'pflegekasse', 'krankenkasse', 'gewerbeanmeldung', 'handelsregister',
  'handelsregisterauszug', 'freistellungsbescheinigung', 'unbedenklichkeitsbescheinigung',
  'betriebserlaubnis', 'zertifikat', 'iso_nachweis', 'steuerbescheid', 'umsatzsteuerbescheid',
]);

const CUSTOMER_KINDS = new Set<ClassifiedDocumentKind>([
  'werkvertrag', 'subunternehmervertrag', 'nachunternehmervertrag', 'auftrag', 'angebot',
  'auftragsbestaetigung', 'leistungsverzeichnis', 'nachtrag', 'lieferschein',
  'abnahmeprotokoll', 'maengelprotokoll', 'uebergabeprotokoll',
]);

const EXPENSE_KINDS = new Set<ClassifiedDocumentKind>([
  'eingangsrechnung', 'rechnung', 'gutschrift', 'quittung', 'kassenbeleg', 'ec_beleg',
  'kreditkartenbeleg', 'tankbeleg', 'reparaturrechnung',
]);

const EMPLOYEE_KINDS = new Set<ClassifiedDocumentKind>([
  'arbeitsvertrag', 'lohnabrechnung', 'lohnunterlagen', 'stundenzettel', 'urlaubsantrag',
  'krankmeldung', 'arbeitsunfaehigkeitsbescheinigung', 'unterweisung', 'sicherheitsbelehrung',
]);

const INSURANCE_KINDS = new Set<ClassifiedDocumentKind>([
  'betriebshaftpflicht', 'fahrzeugversicherung', 'rechtsschutzversicherung',
  'gebaeudeversicherung', 'versicherungsbescheid', 'versicherung',
]);

const SITE_KINDS = new Set<ClassifiedDocumentKind>([
  'baustellenfoto', 'pruefprotokoll', 'messprotokoll', 'materialnachweis',
  'entsorgungsnachweis', 'sicherheitsdokument', 'foto',
]);

const VEHICLE_KINDS = new Set<ClassifiedDocumentKind>([
  'tuev_bericht', 'reparaturrechnung', 'leasingvertrag', 'tankbeleg', 'wartungsnachweis',
]);

export function mapKindToDocumentType(kind: ClassifiedDocumentKind): DocumentType {
  if (kind === 'ausgangsrechnung') return 'ausgangsrechnung';
  if (EXPENSE_KINDS.has(kind) || kind === 'mahnung' || kind === 'zahlungserinnerung') {
    return 'eingangsrechnung';
  }
  if (CUSTOMER_KINDS.has(kind)) return 'kundenauftrag';
  if (BEHOERDE_KINDS.has(kind)) return 'behoerde';
  if (INSURANCE_KINDS.has(kind)) return 'behoerde';
  if (EMPLOYEE_KINDS.has(kind)) return 'sonstiges';
  if (SITE_KINDS.has(kind)) return kind === 'foto' || kind === 'baustellenfoto' ? 'foto' : 'sonstiges';
  if (VEHICLE_KINDS.has(kind)) return 'sonstiges';
  if (kind === 'kontoauszug') return 'sonstiges';
  if (kind === 'brief' || kind === 'schriftverkehr' || kind === 'email_pdf') return 'brief';
  if (kind === 'foto' || kind === 'baustellenfoto') return 'foto';
  return 'sonstiges';
}

const PROCESS_TYPE_MAP: Partial<Record<ClassifiedDocumentKind, ProcessType>> = {
  werkvertrag: 'create_vorgang',
  subunternehmervertrag: 'create_vorgang',
  nachunternehmervertrag: 'attach_to_vorgang',
  auftrag: 'create_vorgang',
  angebot: 'create_vorgang',
  auftragsbestaetigung: 'attach_to_vorgang',
  leistungsverzeichnis: 'attach_to_vorgang',
  nachtrag: 'attach_to_vorgang',
  lieferschein: 'attach_to_vorgang',
  abnahmeprotokoll: 'create_invoice',
  maengelprotokoll: 'review_required',
  uebergabeprotokoll: 'review_required',
  eingangsrechnung: 'record_expense',
  rechnung: 'record_expense',
  ausgangsrechnung: 'create_invoice',
  gutschrift: 'record_expense',
  quittung: 'record_expense',
  kassenbeleg: 'record_expense',
  ec_beleg: 'record_expense',
  kreditkartenbeleg: 'record_expense',
  tankbeleg: 'record_expense',
  reparaturrechnung: 'record_expense',
  mahnung: 'reminder_required',
  zahlungserinnerung: 'reminder_required',
  kontoauszug: 'payment_check',
  freistellungsbescheinigung: 'send_to_client',
  unbedenklichkeitsbescheinigung: 'send_to_client',
  bg_bau: 'monitor_payment',
  soka_bau: 'monitor_payment',
  aok: 'request_documents',
  barmer: 'request_documents',
  tk: 'request_documents',
  dak: 'request_documents',
  stundenzettel: 'create_invoice',
  lohnabrechnung: 'archive_only',
  lohnunterlagen: 'archive_only',
  arbeitsvertrag: 'archive_only',
  foto: 'attach_to_vorgang',
  baustellenfoto: 'attach_to_vorgang',
  pruefprotokoll: 'attach_to_vorgang',
  finanzamt: 'review_required',
  steuerbescheid: 'review_required',
  versicherung: 'review_required',
  sonstiges: 'review_required',
  brief: 'review_required',
};

export function suggestProcessType(kind: ClassifiedDocumentKind): ProcessType {
  return PROCESS_TYPE_MAP[kind] ?? 'archive_only';
}

export function defaultPriority(kind: ClassifiedDocumentKind): InboxPriority {
  if (kind === 'mahnung' || kind === 'zahlungserinnerung') return 'kritisch';
  if (['finanzamt', 'bg_bau', 'freistellungsbescheinigung', 'auftrag', 'werkvertrag', 'steuerbescheid'].includes(kind)) {
    return 'hoch';
  }
  if (EXPENSE_KINDS.has(kind) || kind === 'kontoauszug' || kind === 'unbedenklichkeitsbescheinigung') {
    return 'mittel';
  }
  return 'niedrig';
}

export function defaultRecommendedAction(kind: ClassifiedDocumentKind): RecommendedAction {
  if (EXPENSE_KINDS.has(kind) || kind === 'lieferschein') return 'zuordnen';
  if (kind === 'mahnung' || kind === 'zahlungserinnerung') return 'zahlung_pruefen';
  if (CUSTOMER_KINDS.has(kind)) return 'auftrag_annehmen';
  if (kind === 'kontoauszug' || kind === 'finanzamt' || EMPLOYEE_KINDS.has(kind)) {
    return 'steuerberater_vorbereiten';
  }
  if (SITE_KINDS.has(kind)) return 'archivieren';
  if (kind === 'sonstiges') return 'klaeren';
  return 'abheften';
}

export interface FolderContext {
  customer?: string;
  vorgangTitle?: string;
  sender?: string;
}

export interface FolderSpec {
  name: string;
  path: string;
}

export function buildDigitalFolderSpec(
  kind: ClassifiedDocumentKind,
  context: FolderContext = {},
): FolderSpec {
  const year = new Date().getFullYear();
  const month = String(new Date().getMonth() + 1).padStart(2, '0');
  const customerSlug = (context.customer ?? context.sender ?? 'Allgemein').replace(/\s+/g, '-').slice(0, 30);
  const vorgangSlug = (context.vorgangTitle ?? 'Neu').replace(/\s+/g, '-').slice(0, 30);

  const healthName = (label: string) => ({
    name: label,
    path: `/Krankenkassen/${label}/${year}/`,
  });

  const specs: Partial<Record<ClassifiedDocumentKind, FolderSpec>> = {
    eingangsrechnung: { name: 'Eingangsrechnungen', path: `/Steuerberater/${year}/${month}/Eingangsrechnungen/` },
    rechnung: { name: 'Eingangsrechnungen', path: `/Steuerberater/${year}/${month}/Eingangsrechnungen/` },
    ausgangsrechnung: { name: 'Ausgangsrechnungen', path: `/Steuerberater/${year}/${month}/Ausgangsrechnungen/` },
    mahnung: { name: 'Mahnungen', path: `/Eingang/Mahnungen/${customerSlug}/` },
    zahlungserinnerung: { name: 'Zahlungserinnerungen', path: `/Eingang/Mahnungen/${customerSlug}/` },
    kontoauszug: { name: 'Kontoauszüge', path: `/Steuerberater/${year}/Kontoauszüge/` },
    steuerbescheid: { name: 'Steuerbescheide', path: `/Steuerberater/${year}/Finanzamt/` },
    umsatzsteuerbescheid: { name: 'USt-Bescheide', path: `/Steuerberater/${year}/Finanzamt/` },
    finanzamt: { name: 'Finanzamt', path: `/Behörden/Finanzamt/${year}/` },
    freistellungsbescheinigung: { name: 'Freistellungsbescheinigungen', path: `/Steuerberater/${year}/Freistellungsbescheinigungen/` },
    bg_bau: { name: 'BG BAU', path: `/Behörden/BG-BAU/${year}/` },
    berufsgenossenschaft: { name: 'Berufsgenossenschaft', path: `/Behörden/Berufsgenossenschaft/${year}/` },
    soka_bau: { name: 'SOKA-BAU', path: `/Behörden/SOKA-BAU/${year}/` },
    aok: healthName('AOK'),
    barmer: healthName('Barmer'),
    tk: healthName('TK'),
    dak: healthName('DAK'),
    ikk: healthName('IKK'),
    knappschaft: healthName('Knappschaft'),
    pflegekasse: healthName('Pflegekasse'),
    krankenkasse: { name: 'Krankenkassen', path: `/Krankenkassen/${year}/` },
    werkvertrag: { name: 'Verträge', path: `/Kunden/${vorgangSlug}/Verträge/` },
    subunternehmervertrag: { name: 'Subunternehmer', path: `/Kunden/${vorgangSlug}/Verträge/` },
    nachunternehmervertrag: { name: 'Nachunternehmer', path: `/Kunden/${vorgangSlug}/Verträge/` },
    auftrag: { name: 'Aufträge', path: `/Kunden/${vorgangSlug}/Verträge/` },
    angebot: { name: 'Angebote', path: `/Kunden/${customerSlug}/Angebote/` },
    lieferschein: { name: 'Lieferscheine', path: `/Kunden/${vorgangSlug}/Lieferscheine/` },
    abnahmeprotokoll: { name: 'Abnahmeprotokolle', path: `/Kunden/${vorgangSlug}/Protokolle/` },
    pruefprotokoll: { name: 'Prüfprotokolle', path: `/Kunden/${vorgangSlug}/Protokolle/` },
    lohnabrechnung: { name: 'Lohnunterlagen', path: `/Mitarbeiter/Lohnunterlagen/${year}/` },
    lohnunterlagen: { name: 'Lohnunterlagen', path: `/Mitarbeiter/Lohnunterlagen/${year}/` },
    stundenzettel: { name: 'Stundenzettel', path: `/Mitarbeiter/Stundenzettel/${year}/` },
    betriebshaftpflicht: { name: 'Betriebshaftpflicht', path: `/Versicherungen/Betriebshaftpflicht/${year}/` },
    fahrzeugversicherung: { name: 'Fahrzeugversicherung', path: `/Versicherungen/Fahrzeug/${year}/` },
    versicherung: { name: 'Versicherungen', path: `/Versicherungen/${year}/` },
    tankbeleg: { name: 'Tankbelege', path: `/Fahrzeuge/Tankbelege/${year}/${month}/` },
    tuev_bericht: { name: 'TÜV', path: `/Fahrzeuge/TÜV/${year}/` },
    baustellenfoto: { name: 'Baustellenfotos', path: `/Baustelle/${vorgangSlug}/Fotos/` },
    foto: { name: 'Fotos', path: `/Baustelle/${vorgangSlug}/Fotos/` },
    gewerbeanmeldung: { name: 'Gewerbe', path: `/Firma/Gewerbeanmeldung/${year}/` },
    handelsregister: { name: 'Handelsregister', path: `/Firma/Handelsregister/${year}/` },
    unbedenklichkeitsbescheinigung: { name: 'Unbedenklichkeit', path: `/Behörden/Unbedenklichkeit/${year}/` },
    zoll: { name: 'Zoll', path: `/Behörden/Zoll/${year}/` },
    gewerbeamt: { name: 'Gewerbeamt', path: `/Behörden/Gewerbeamt/${year}/` },
    sonstiges: { name: 'Eingang', path: `/Eingang/Sonstiges/${year}/` },
  };

  if (specs[kind]) return specs[kind]!;

  if (BEHOERDE_KINDS.has(kind)) {
    return { name: 'Behörden', path: `/Behörden/${kind.replace(/_/g, '-')}/${year}/` };
  }
  if (INSURANCE_KINDS.has(kind)) {
    return { name: 'Versicherungen', path: `/Versicherungen/${kind.replace(/_/g, '-')}/${year}/` };
  }
  if (VEHICLE_KINDS.has(kind)) {
    return { name: 'Fahrzeuge', path: `/Fahrzeuge/${kind.replace(/_/g, '-')}/${year}/` };
  }
  if (SITE_KINDS.has(kind)) {
    return { name: 'Baustelle', path: `/Baustelle/${vorgangSlug}/${kind.replace(/_/g, '-')}/` };
  }
  if (EMPLOYEE_KINDS.has(kind)) {
    return { name: 'Mitarbeiter', path: `/Mitarbeiter/${kind.replace(/_/g, '-')}/${year}/` };
  }
  if (EXPENSE_KINDS.has(kind)) {
    return { name: 'Ausgaben', path: `/Steuerberater/${year}/${month}/Ausgaben/` };
  }

  return { name: 'Eingang', path: `/Eingang/Sonstiges/${year}/` };
}

export function suggestPaperFolderId(kind: ClassifiedDocumentKind): string {
  return resolvePaperFolderIdFromService(kind);
}

const COMMON_ACTIONS: SuggestedDocumentAction[] = [
  { id: 'confirm_filing', labelKey: 'classification.action.confirmFiling', variant: 'outline' },
];

const PROOF_ARCHIVE_ACTIONS: SuggestedDocumentAction[] = [
  { id: 'archive', labelKey: 'classification.action.archiveProof', variant: 'primary' },
  { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'secondary' },
  { id: 'create_task', labelKey: 'classification.action.createTask', variant: 'secondary' },
  { id: 'confirm_filing', labelKey: 'classification.action.confirmFiling', variant: 'outline' },
];

const EXPENSE_ACTIONS: SuggestedDocumentAction[] = [
  { id: 'record_expense', labelKey: 'classification.action.recordExpense', variant: 'primary' },
  { id: 'link_vorgang', labelKey: 'classification.action.linkVorgang', variant: 'secondary' },
  { id: 'save_tax_folder', labelKey: 'classification.action.saveTaxFolder', variant: 'secondary' },
  { id: 'archive', labelKey: 'classification.action.archive', variant: 'outline' },
];

const KIND_ACTIONS: Partial<Record<ClassifiedDocumentKind, SuggestedDocumentAction[]>> = {
  bg_bau: [
    { id: 'save_bg_bau_folder', labelKey: 'classification.action.saveBgBauFolder', variant: 'primary' },
    { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'secondary' },
    { id: 'create_task', labelKey: 'classification.action.createTask', variant: 'secondary' },
    { id: 'archive', labelKey: 'classification.action.archiveProof', variant: 'outline' },
  ],
  berufsgenossenschaft: PROOF_ARCHIVE_ACTIONS,
  soka_bau: [
    { id: 'save_bg_bau_folder', labelKey: 'classification.action.saveSokaFolder', variant: 'primary' },
    { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'secondary' },
    { id: 'create_task', labelKey: 'classification.action.createTask', variant: 'secondary' },
  ],
  aok: PROOF_ARCHIVE_ACTIONS,
  barmer: PROOF_ARCHIVE_ACTIONS,
  tk: PROOF_ARCHIVE_ACTIONS,
  dak: PROOF_ARCHIVE_ACTIONS,
  ikk: PROOF_ARCHIVE_ACTIONS,
  knappschaft: PROOF_ARCHIVE_ACTIONS,
  pflegekasse: PROOF_ARCHIVE_ACTIONS,
  krankenkasse: PROOF_ARCHIVE_ACTIONS,
  werkvertrag: [
    { id: 'create_vorgang', labelKey: 'classification.action.createVorgang', variant: 'primary' },
    { id: 'import_positions', labelKey: 'classification.action.importPositions', variant: 'secondary' },
    { id: 'check_proof_requirements', labelKey: 'classification.action.checkProofRequirements', variant: 'secondary' },
    { id: 'archive', labelKey: 'classification.action.archive', variant: 'outline' },
  ],
  subunternehmervertrag: [
    { id: 'create_vorgang', labelKey: 'classification.action.createVorgang', variant: 'primary' },
    { id: 'check_proof_requirements', labelKey: 'classification.action.checkProofRequirements', variant: 'secondary' },
    { id: 'archive', labelKey: 'classification.action.archive', variant: 'outline' },
  ],
  eingangsrechnung: EXPENSE_ACTIONS,
  rechnung: EXPENSE_ACTIONS,
  quittung: EXPENSE_ACTIONS,
  kassenbeleg: EXPENSE_ACTIONS,
  ec_beleg: EXPENSE_ACTIONS,
  kreditkartenbeleg: EXPENSE_ACTIONS,
  tankbeleg: EXPENSE_ACTIONS,
  reparaturrechnung: EXPENSE_ACTIONS,
  freistellungsbescheinigung: [
    { id: 'save_tax_folder', labelKey: 'classification.action.saveTaxFolder', variant: 'primary' },
    { id: 'monitor_validity', labelKey: 'classification.action.monitorValidity', variant: 'secondary' },
    { id: 'send_to_customer', labelKey: 'classification.action.sendToCustomer', variant: 'secondary' },
  ],
  unbedenklichkeitsbescheinigung: [
    { id: 'save_tax_folder', labelKey: 'classification.action.saveTaxFolder', variant: 'primary' },
    { id: 'monitor_validity', labelKey: 'classification.action.monitorValidity', variant: 'secondary' },
    { id: 'send_to_customer', labelKey: 'classification.action.sendToCustomer', variant: 'secondary' },
  ],
  mahnung: [
    { id: 'mark_important', labelKey: 'classification.action.markImportant', variant: 'primary' },
    { id: 'check_payment', labelKey: 'classification.action.checkPayment', variant: 'secondary' },
    { id: 'create_task', labelKey: 'classification.action.createTask', variant: 'secondary' },
    { id: 'link_vorgang', labelKey: 'classification.action.linkVorgang', variant: 'outline' },
  ],
  zahlungserinnerung: [
    { id: 'mark_important', labelKey: 'classification.action.markImportant', variant: 'primary' },
    { id: 'check_payment', labelKey: 'classification.action.checkPayment', variant: 'secondary' },
    { id: 'create_task', labelKey: 'classification.action.createTask', variant: 'secondary' },
  ],
  kontoauszug: [
    { id: 'check_payment', labelKey: 'classification.action.checkIncomingPayments', variant: 'primary' },
    { id: 'save_tax_folder', labelKey: 'classification.action.saveTaxFolder', variant: 'secondary' },
    { id: 'archive', labelKey: 'classification.action.archive', variant: 'outline' },
  ],
  abnahmeprotokoll: [
    { id: 'link_vorgang', labelKey: 'classification.action.checkVorgangComplete', variant: 'primary' },
    { id: 'suggest_schlussrechnung', labelKey: 'classification.action.suggestSchlussrechnung', variant: 'secondary' },
    { id: 'archive', labelKey: 'classification.action.archive', variant: 'outline' },
  ],
  stundenzettel: [
    { id: 'link_vorgang', labelKey: 'classification.action.linkVorgang', variant: 'primary' },
    { id: 'import_hours', labelKey: 'classification.action.importHours', variant: 'secondary' },
    { id: 'confirm_filing', labelKey: 'classification.action.confirmFiling', variant: 'outline' },
  ],
  auftrag: [
    { id: 'create_vorgang', labelKey: 'classification.action.createVorgang', variant: 'primary' },
    { id: 'import_positions', labelKey: 'classification.action.importPositions', variant: 'secondary' },
    { id: 'confirm_filing', labelKey: 'classification.action.confirmFiling', variant: 'outline' },
  ],
  angebot: [
    { id: 'create_vorgang', labelKey: 'classification.action.createVorgang', variant: 'primary' },
    { id: 'archive', labelKey: 'classification.action.archive', variant: 'outline' },
  ],
  finanzamt: [
    { id: 'save_tax_folder', labelKey: 'classification.action.saveTaxFolder', variant: 'primary' },
    { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'secondary' },
  ],
  lieferschein: [
    { id: 'link_vorgang', labelKey: 'classification.action.linkVorgang', variant: 'primary' },
    { id: 'confirm_filing', labelKey: 'classification.action.confirmFiling', variant: 'outline' },
  ],
  brief: [
    { id: 'confirm_filing', labelKey: 'classification.action.confirmFiling', variant: 'primary' },
    { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'outline' },
  ],
  versicherung: [
    { id: 'confirm_filing', labelKey: 'classification.action.confirmFiling', variant: 'primary' },
    { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'outline' },
  ],
  betriebshaftpflicht: [
    { id: 'archive', labelKey: 'classification.action.archive', variant: 'primary' },
    { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'outline' },
  ],
  foto: [
    { id: 'link_vorgang', labelKey: 'classification.action.linkVorgang', variant: 'primary' },
    { id: 'archive', labelKey: 'classification.action.archive', variant: 'outline' },
  ],
  baustellenfoto: [
    { id: 'link_vorgang', labelKey: 'classification.action.linkVorgang', variant: 'primary' },
    { id: 'archive', labelKey: 'classification.action.archive', variant: 'outline' },
  ],
  sonstiges: COMMON_ACTIONS,
};

export function getActionsForKind(kind: ClassifiedDocumentKind): SuggestedDocumentAction[] {
  return KIND_ACTIONS[kind] ?? COMMON_ACTIONS;
}

export function buildExplanation(kind: ClassifiedDocumentKind, sender: string): string {
  if (kind === 'werkvertrag') {
    return `Werkvertrag von „${sender}“ erkannt. Vorgang anlegen und Nachweispflichten prüfen.`;
  }
  if (EXPENSE_KINDS.has(kind)) {
    return `Ausgabenbeleg/Rechnung von „${sender}“ erkannt. Als Ausgabe speichern und Vorgang zuordnen.`;
  }
  if (kind === 'mahnung' || kind === 'zahlungserinnerung') {
    return `Mahnung oder Zahlungserinnerung von „${sender}“ erkannt. Hohe Priorität – Zahlung prüfen.`;
  }
  if (kind === 'freistellungsbescheinigung') {
    return `Freistellungsbescheinigung erkannt. Im Steuerordner ablegen und Gültigkeit überwachen.`;
  }
  if (kind === 'abnahmeprotokoll') {
    return `Abnahmeprotokoll erkannt. Vorgang abschließen prüfen und Schlussrechnung vorschlagen.`;
  }
  if (kind === 'stundenzettel') {
    return `Stundenzettel erkannt. Vorgang zuordnen und Stunden für Rechnung übernehmen.`;
  }
  if (kind === 'kontoauszug') {
    return `Kontoauszug erkannt. Zahlungseingänge prüfen und für Steuerberater vorbereiten.`;
  }
  if (BEHOERDE_KINDS.has(kind) && (kind === 'bg_bau' || kind === 'soka_bau' || kind === 'aok')) {
    return `${kind.toUpperCase().replace(/_/g, ' ')}-Schreiben erkannt. Nachweis archivieren und Ablaufdatum prüfen.`;
  }
  if (CUSTOMER_KINDS.has(kind)) {
    return `Kunden-/Auftragsdokument von „${sender}“ erkannt. Dem Vorgang zuordnen.`;
  }
  if (EMPLOYEE_KINDS.has(kind)) {
    return `Mitarbeiterdokument erkannt. Vertraulich aufbewahren.`;
  }
  if (INSURANCE_KINDS.has(kind)) {
    return `Versicherungsdokument erkannt. Deckung und Fristen prüfen.`;
  }
  if (VEHICLE_KINDS.has(kind)) {
    return `Fahrzeug-/Maschinendokument erkannt. Kosten und Vorgang prüfen.`;
  }
  if (SITE_KINDS.has(kind)) {
    return `Baustellendokument erkannt. Dem Vorgang zuordnen.`;
  }
  return `Dokument von „${sender}“ erkannt. Bitte Inhalt prüfen und ablegen.`;
}

export function buildNextTask(kind: ClassifiedDocumentKind): string {
  const tasks: Partial<Record<ClassifiedDocumentKind, string>> = {
    eingangsrechnung: 'Rechnung prüfen und Vorgang zuordnen',
    rechnung: 'Rechnung prüfen und Vorgang zuordnen',
    mahnung: 'Zahlung prüfen',
    zahlungserinnerung: 'Zahlung prüfen',
    werkvertrag: 'Vorgang anlegen und Vertrag archivieren',
    auftrag: 'Auftrag prüfen oder Rückfrage stellen',
    bg_bau: 'BG-BAU-Schreiben prüfen und Frist beachten',
    freistellungsbescheinigung: 'Freistellungsbescheinigung ablegen und weiterleiten',
    aok: 'AOK-Schreiben prüfen und ablegen',
    kontoauszug: 'Kontoauszug für Steuerberater vorbereiten',
    abnahmeprotokoll: 'Vorgang abschließen und Schlussrechnung prüfen',
    stundenzettel: 'Stunden dem Vorgang zuordnen',
    tankbeleg: 'Tankbeleg als Ausgabe speichern',
  };
  return tasks[kind] ?? 'Dokument prüfen und ablegen';
}
