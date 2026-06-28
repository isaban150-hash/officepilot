/** OfficePilot V1 – zentrales Datenmodell (Foundation MVP) */

export type AppLanguage = 'de' | 'tr' | 'bg' | 'ro' | 'ru';

export type TaxStatus =
  | 'standard_19'
  | 'kleinunternehmer_19'
  | 'reverse_charge_13b'
  | 'unclear';

export type MaterialStandard =
  | 'auftraggeber'
  | 'betrieb'
  | 'gemischt'
  | 'unclear';

export type VorgangStatus =
  | 'neu'
  | 'in_bearbeitung'
  | 'wartet'
  | 'abgeschlossen';

export type TaskType =
  | 'dokument_pruefen'
  | 'brief_abheften'
  | 'rechnung_vorbereiten'
  | 'kontoauszug_hochladen'
  | 'steuerberater_export';

export type DocumentType =
  | 'eingangsrechnung'
  | 'kundenauftrag'
  | 'ausgangsrechnung'
  | 'behoerde'
  | 'brief'
  | 'foto'
  | 'sonstiges';

export type RecommendedAction =
  | 'zuordnen'
  | 'abheften'
  | 'rechnung_vorbereiten'
  | 'archivieren'
  | 'klaeren'
  | 'zahlung_pruefen'
  | 'auftrag_annehmen'
  | 'steuerberater_vorbereiten'
  | 'entsorgen';

export type InboxPriority = 'niedrig' | 'mittel' | 'hoch' | 'kritisch';

export type InboxStatus = 'neu' | 'geprueft' | 'abgelegt' | 'spaeter_klaeren';

export interface InboxTaskTemplate {
  type: TaskType;
  title: string;
  description: string;
  vorgangId?: string;
  vorgangTitle?: string;
  dueDate?: string;
}

export interface InboxItem {
  id: string;
  title: string;
  documentType: DocumentType;
  sender: string;
  priority: InboxPriority;
  deadline: string | null;
  recommendedAction: RecommendedAction;
  digitalFolder: DigitalFolder;
  paperFiling: PaperFilingRule;
  status: InboxStatus;
  receivedAt: string;
  isAdvertisement?: boolean;
  isNewUpload?: boolean;
  sourceFileName?: string;
  recognizedData: Record<string, string>;
  officePilotSuggestion: string;
  nextTaskLabel: string;
  securityHint: string;
  taskTemplate?: InboxTaskTemplate;
  vorgangId?: string;
  vorgangTitle?: string;
  vorgangLinkStatus?: VorgangLinkStatus;
  userModified?: boolean;
  modifiedAt?: string;
  originalRecognizedData?: Record<string, string>;
  /** Nach Übernahme ins Dokumentenarchiv */
  importedToArchive?: boolean;
  archiveDocumentId?: string;
  /** Detaillierte Dokumentart aus Klassifikations-Engine */
  classifiedKind?: ClassifiedDocumentKind;
  /** Manuelle Freigabe für Analyse trotz fehlendem automatischem Firmenbezug */
  markedAsCompanyDocument?: boolean;
}

/** Änderungen aus dem Edit-Modus der Eingang-Detailansicht */
export interface InboxRecognizedDataChanges {
  sender?: string;
  deadline?: string | null;
  vorgangTitle?: string;
  priority?: InboxPriority;
  recognizedData?: Record<string, string>;
  digitalFolderPath?: string;
  digitalFolderName?: string;
  paperFilingFolderId?: string;
  paperFilingRegister?: string;
  recommendedAction?: RecommendedAction;
}

export type VorgangLinkStatus = 'none' | 'linked' | 'created';

export interface VorgangDraft {
  title: string;
  customer: string;
  baustelle: string;
  materialSource: MaterialStandard;
}

export type UploadDocumentKind =
  | 'auftrag'
  | 'zahlungserinnerung'
  | 'materialrechnung'
  | 'bg_bau'
  | 'werbung'
  | 'kontoauszug';

/** Detaillierte Dokumentart (Regel-Engine / spätere KI) */
export type ClassifiedDocumentKind =
  // Behörden
  | 'zoll'
  | 'handwerkskammer'
  | 'ihk'
  | 'gewerbeamt'
  | 'bauamt'
  | 'ordnungsamt'
  | 'agentur_fuer_arbeit'
  | 'deutsche_rentenversicherung'
  | 'finanzamt'
  | 'bg_bau'
  | 'berufsgenossenschaft'
  // Krankenkassen / Sozial
  | 'aok'
  | 'barmer'
  | 'tk'
  | 'dak'
  | 'ikk'
  | 'knappschaft'
  | 'pflegekasse'
  | 'soka_bau'
  | 'krankenkasse'
  // Buchhaltung
  | 'eingangsrechnung'
  | 'rechnung'
  | 'ausgangsrechnung'
  | 'gutschrift'
  | 'quittung'
  | 'kassenbeleg'
  | 'ec_beleg'
  | 'kreditkartenbeleg'
  | 'kontoauszug'
  | 'steuerbescheid'
  | 'umsatzsteuerbescheid'
  | 'mahnung'
  | 'zahlungserinnerung'
  // Kunden / Auftrag
  | 'werkvertrag'
  | 'subunternehmervertrag'
  | 'nachunternehmervertrag'
  | 'auftrag'
  | 'angebot'
  | 'auftragsbestaetigung'
  | 'leistungsverzeichnis'
  | 'nachtrag'
  | 'lieferschein'
  | 'abnahmeprotokoll'
  | 'maengelprotokoll'
  | 'uebergabeprotokoll'
  // Mitarbeiter
  | 'arbeitsvertrag'
  | 'lohnabrechnung'
  | 'lohnunterlagen'
  | 'stundenzettel'
  | 'urlaubsantrag'
  | 'krankmeldung'
  | 'arbeitsunfaehigkeitsbescheinigung'
  | 'unterweisung'
  | 'sicherheitsbelehrung'
  // Versicherungen
  | 'betriebshaftpflicht'
  | 'fahrzeugversicherung'
  | 'rechtsschutzversicherung'
  | 'gebaeudeversicherung'
  | 'versicherungsbescheid'
  | 'versicherung'
  // Firmennachweise
  | 'gewerbeanmeldung'
  | 'handelsregister'
  | 'handelsregisterauszug'
  | 'freistellungsbescheinigung'
  | 'unbedenklichkeitsbescheinigung'
  | 'betriebserlaubnis'
  | 'zertifikat'
  | 'iso_nachweis'
  // Baustelle
  | 'baustellenfoto'
  | 'pruefprotokoll'
  | 'messprotokoll'
  | 'materialnachweis'
  | 'entsorgungsnachweis'
  | 'sicherheitsdokument'
  // Fahrzeuge / Maschinen
  | 'tuev_bericht'
  | 'reparaturrechnung'
  | 'leasingvertrag'
  | 'tankbeleg'
  | 'wartungsnachweis'
  // Sonstiges
  | 'brief'
  | 'schriftverkehr'
  | 'email_pdf'
  | 'pdf_anlage'
  | 'notiz'
  | 'foto'
  | 'sonstiges';

export type ProcessType =
  | 'create_vorgang'
  | 'attach_to_vorgang'
  | 'create_invoice'
  | 'monitor_payment'
  | 'record_expense'
  | 'request_documents'
  | 'send_to_client'
  | 'create_task'
  | 'archive_only'
  | 'review_required'
  | 'payment_check'
  | 'reminder_required';

export type DocumentActionId =
  | 'save_bg_bau_folder'
  | 'check_deadline'
  | 'show_contact'
  | 'link_vorgang'
  | 'check_payment'
  | 'archive'
  | 'save_tax_folder'
  | 'send_to_customer'
  | 'save_health_folder'
  | 'mark_important'
  | 'create_vorgang'
  | 'import_positions'
  | 'confirm_filing'
  | 'create_task'
  | 'record_expense'
  | 'monitor_validity'
  | 'check_proof_requirements'
  | 'suggest_schlussrechnung'
  | 'import_hours';

export interface SuggestedDocumentAction {
  id: DocumentActionId;
  labelKey: string;
  variant?: 'primary' | 'secondary' | 'outline';
}

export interface DocumentClassificationInput {
  sourceFileName?: string;
  kindHint?: UploadDocumentKind | ClassifiedDocumentKind;
  titleHint?: string;
  senderHint?: string;
  recognizedText?: string;
}

export interface SuggestedVorgangLink {
  vorgangId: string;
  vorgangTitle: string;
  customer: string;
  confidence: 'high' | 'medium' | 'low';
  reasonKey: string;
}

export interface DocumentClassificationResult {
  classifiedKind: ClassifiedDocumentKind;
  documentType: DocumentType;
  processType: ProcessType;
  detectionReasonKey: string;
  title: string;
  sender: string;
  explanation: string;
  priority: InboxPriority;
  deadline: string | null;
  recommendedAction: RecommendedAction;
  digitalFolder: DigitalFolder;
  paperFiling: PaperFilingRule;
  recognizedData: Record<string, string>;
  officePilotSuggestion: string;
  nextTaskLabel: string;
  securityHint: string;
  taskTemplate?: InboxTaskTemplate;
  isAdvertisement?: boolean;
  suggestedVorgang?: SuggestedVorgangLink;
  actions: SuggestedDocumentAction[];
}

export type ContractType =
  | 'werkvertrag'
  | 'subunternehmervertrag'
  | 'nachunternehmervertrag'
  | 'bauvertrag'
  | 'auftrag'
  | 'leistungsverzeichnis';

export type AnalysisConfidence = 'high' | 'medium' | 'low';

export interface DetectedOrderPosition {
  positionNumber?: string;
  description: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface DetectedPaymentTerm {
  type: 'net_days' | 'skonto' | 'abschlag' | 'weekly_abschlag' | 'schlussrechnung' | 'payment_due';
  label: string;
  value?: string;
}

export interface RequiredDocument {
  type: string;
  priority: InboxPriority;
  reason: string;
}

export interface SignaturePage {
  pageHint: string;
  description: string;
}

export type ContractActionId =
  | 'create_vorgang'
  | 'import_positions'
  | 'send_freistellung'
  | 'check_bg_bau'
  | 'send_aok'
  | 'archive_contract';

export interface ContractSuggestedAction {
  id: ContractActionId;
  labelKey: string;
  variant?: 'primary' | 'secondary' | 'outline';
}

export interface ContractExtractedFields {
  auftraggeber?: string;
  subunternehmer?: string;
  bauvorhaben?: string;
  baustellenadresse?: string;
  projektname?: string;
  leistungszeitraum?: string;
  vertragsdatum?: string;
  auftragsnummer?: string;
  bestellnummer?: string;
  ansprechpartner?: string;
  telefon?: string;
  email?: string;
}

export interface ContractAnalysisInput {
  recognizedText: string;
  sourceFileName?: string;
  titleHint?: string;
  senderHint?: string;
  kindHint?: UploadDocumentKind | ClassifiedDocumentKind;
  recognizedData?: Record<string, string>;
}

export interface ContractAnalysisResult {
  isContract: boolean;
  contractType: ContractType | null;
  confidence: AnalysisConfidence;
  reason: string;
  fields: ContractExtractedFields;
  positions: DetectedOrderPosition[];
  paymentTerms: DetectedPaymentTerm[];
  requiredDocuments: RequiredDocument[];
  signaturePages: SignaturePage[];
  suggestedActions: ContractSuggestedAction[];
  signatureHint?: string;
}

export type CompanyRelevanceReason =
  | 'company_name'
  | 'contact_person'
  | 'company_address'
  | 'tax_number'
  | 'vat_id'
  | 'authority_reference'
  | 'vorgang_reference'
  | 'customer_reference'
  | 'customer_number'
  | 'manual_override';

export interface CompanyRelevanceInput {
  text: string;
  recognizedData?: Record<string, string>;
  sender?: string;
  title?: string;
  vorgangId?: string;
  vorgangTitle?: string;
  markedAsCompanyDocument?: boolean;
}

export interface CompanyRelevanceResult {
  isRelevant: boolean;
  reasons: CompanyRelevanceReason[];
  matchedHints: string[];
}

export interface CompanySetup {
  companyName: string;
  industry: string;
  taxStatus: TaxStatus;
  materialStandard: MaterialStandard;
  language: AppLanguage;
  setupComplete: boolean;
}

export interface CompanyProfile {
  companyName: string;
  legalForm: string;
  logoDataUrl?: string;
  street: string;
  zip: string;
  city: string;
  country: string;
  contactPerson: string;
  phone: string;
  email: string;
  website: string;
  taxNumber: string;
  vatId: string;
  bankName: string;
  iban: string;
  bic: string;
  defaultPaymentDays: number;
  defaultPaymentTerms: string;
  defaultSkonto: string;
  invoiceFooterNotes: string;
}

export interface CustomerBilling {
  name: string;
  contactPerson: string;
  street: string;
  zip: string;
  city: string;
  email: string;
  phone: string;
}

export interface InvoiceNumberSequence {
  year: number;
  lastIssuedNumber: number;
}

export interface AbschlagDeduction {
  invoiceId: string;
  invoiceNumber: string;
  abschlagNumber?: number;
  date: string;
  subtotal: number;
  amount: number;
}

export interface PaperFolder {
  id: string;
  name: string;
  year?: number;
  registers: string[];
}

export interface DigitalFolder {
  id: string;
  name: string;
  path: string;
}

export interface PaperFilingRule {
  folderId: string;
  register: string;
  label: string;
}

export interface DocumentAnalysis {
  id: string;
  documentType: DocumentType;
  customer: string;
  baustelle: string;
  vorgangId: string | null;
  vorgangTitle: string;
  deadline: string | null;
  paperFiling: PaperFilingRule;
  digitalFolder: DigitalFolder;
  recommendedAction: RecommendedAction;
  sourceFileName: string;
}

export interface VorgangDocument {
  id: string;
  name: string;
  type: DocumentType;
  date: string;
  paperFiling?: PaperFilingRule;
}

export interface VorgangTask {
  id: string;
  type: TaskType;
  title: string;
  done: boolean;
  dueDate?: string;
}

export interface VorgangPhoto {
  id: string;
  caption: string;
  date: string;
}

export type OrderUnit = 'm²' | 'Stück' | 'Meter' | 'Stunden' | 'Pauschal';

export type OrderPositionCategory = 'arbeit' | 'material' | 'sonstiges';

export interface OrderPosition {
  id: string;
  description: string;
  plannedQuantity: number;
  unit: OrderUnit;
  unitPrice: number;
  category?: OrderPositionCategory;
  billable?: boolean;
}

export type OrderPositionEditableField =
  | 'description'
  | 'plannedQuantity'
  | 'unit'
  | 'unitPrice'
  | 'category'
  | 'billable';

export interface PositionBillingStatus {
  orderPositionId: string;
  billedQuantity: number;
  openQuantity: number;
  plannedQuantity: number;
  hasBilling: boolean;
  isFullyBilled: boolean;
}

export interface OrderPositionInput {
  description: string;
  plannedQuantity: number;
  unit: OrderUnit;
  unitPrice: number;
  category?: OrderPositionCategory;
  billable?: boolean;
}

export interface VorgangInvoiceLine {
  id: string;
  orderPositionId: string;
  description: string;
  quantity: number;
  unit: OrderUnit;
  unitPrice: number;
  lineTotal: number;
}

export type InvoicePaymentStatus =
  | 'offen'
  | 'teilbezahlt'
  | 'bezahlt'
  | 'ueberfaellig'
  | 'storniert';

export interface InvoicePayment {
  id: string;
  date: string;
  amount: number;
  reference?: string;
  note?: string;
  createdAt: string;
}

export interface InvoicePaymentInput {
  date: string;
  amount: number;
  reference?: string;
  note?: string;
}

export interface PaymentSummary {
  totalDue: number;
  paidAmount: number;
  openAmount: number;
  overpaidAmount: number;
  status: InvoicePaymentStatus;
}

export interface VorgangInvoice {
  id: string;
  number: string;
  type: 'abschlag' | 'schluss';
  abschlagNumber?: number;
  invoiceSequenceNumber?: number;
  positions: VorgangInvoiceLine[];
  subtotal: number;
  taxStatus: TaxStatus;
  amount: number;
  status: 'entwurf' | 'vorbereitet' | 'versendet';
  date: string;
  createdAt: string;
  issueDate?: string;
  servicePeriodFrom?: string;
  servicePeriodTo?: string;
  paymentDueDate?: string;
  paymentTermsText?: string;
  skontoText?: string;
  customerSnapshot?: CustomerBilling;
  companySnapshot?: CompanyProfile;
  legalNotices?: string[];
  previousAbschlagDeductions?: AbschlagDeduction[];
  introText?: string;
  closingText?: string;
  baustelle?: string;
  vorgangTitle?: string;
  archiveDocumentId?: string;
  payments?: InvoicePayment[];
  paymentStatus?: InvoicePaymentStatus;
  cancelledAt?: string;
  cancelReason?: string;
}

export interface Vorgang {
  id: string;
  title: string;
  customer: string;
  baustelle: string;
  status: VorgangStatus;
  materialSource: MaterialStandard;
  customerBilling?: CustomerBilling;
  orderPositions: OrderPosition[];
  documents: VorgangDocument[];
  tasks: VorgangTask[];
  photos: VorgangPhoto[];
  invoices: VorgangInvoice[];
  createdFromInboxId?: string;
}

export interface Task {
  id: string;
  type: TaskType;
  title: string;
  description: string;
  vorgangId?: string;
  vorgangTitle?: string;
  done: boolean;
  dueDate?: string;
}

export interface InvoiceDraftPosition {
  id: string;
  orderPositionId: string;
  description: string;
  plannedQuantity: number;
  billedQuantity: number;
  openQuantity: number;
  quantity: number;
  unit: OrderUnit;
  unitPrice: number;
  category?: OrderPositionCategory;
  billable: boolean;
}

export interface InvoiceDraft {
  id: string;
  vorgangId: string;
  vorgangTitle: string;
  customer: string;
  baustelle: string;
  type: 'abschlag' | 'schluss';
  abschlagNumber?: number;
  taxStatus: TaxStatus;
  materialSource: MaterialStandard;
  positions: InvoiceDraftPosition[];
  issueDate: string;
  servicePeriodFrom: string;
  servicePeriodTo: string;
  paymentDueDate: string;
  paymentTermsText: string;
  skontoText: string;
  customerBilling: CustomerBilling;
  companySnapshot: CompanyProfile;
  legalNotices: string[];
  previousAbschlagDeductions: AbschlagDeduction[];
  invoiceNumberPreview: string;
  introText: string;
  closingText: string;
}

export interface InvoicePrintPosition {
  index: number;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  lineTotal: number;
}

export interface InvoicePrintDeductionLine {
  label: string;
  invoiceNumber: string;
  amount: number;
}

export interface InvoicePrintSummary {
  subtotalNet: number;
  taxRate: number;
  taxAmount: number;
  grossTotal: number;
  deductionLines: InvoicePrintDeductionLine[];
  deductionsTotal: number;
  amountDue: number;
}

export interface InvoicePrintModel {
  type: 'abschlag' | 'schluss';
  documentTitle: string;
  invoiceNumber: string;
  issueDate: string;
  company: CompanyProfile;
  customer: CustomerBilling;
  projectTitle: string;
  projectSite: string;
  servicePeriodFrom: string;
  servicePeriodTo: string;
  introText: string;
  closingText: string;
  positions: InvoicePrintPosition[];
  summary: InvoicePrintSummary;
  taxStatus: TaxStatus;
  taxNotices: string[];
  paymentDueDate: string;
  paymentTermsText: string;
  skontoText: string;
  footerNotes: string;
}

export interface InvoiceDraftMetadataChanges {
  issueDate?: string;
  servicePeriodFrom?: string;
  servicePeriodTo?: string;
  paymentDueDate?: string;
  paymentTermsText?: string;
  skontoText?: string;
  introText?: string;
  closingText?: string;
  projectTitle?: string;
  projectSite?: string;
  customerBilling?: Partial<CustomerBilling>;
}

export interface InvoiceTotals {
  subtotal: number;
  taxRate: number;
  tax: number;
  total: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface AssistantSuggestion {
  id: string;
  questionKey: string;
}

export type NavTab = 'eingang' | 'aufgaben' | 'vorgaenge' | 'dokumente' | 'assistent';

export type CompanyDocumentCategory =
  | 'vertrag'
  | 'versicherung'
  | 'zertifikat'
  | 'steuer'
  | 'ausgangsrechnung'
  | 'behoerde'
  | 'personal'
  | 'sonstiges';

export interface CompanyDocumentVorgangLink {
  vorgangId: string;
  vorgangTitle: string;
}

export interface CompanyDocument {
  id: string;
  title: string;
  category: CompanyDocumentCategory;
  issuer: string;
  recognizedText: string;
  issueDate: string | null;
  validUntil: string | null;
  digitalFolder: DigitalFolder;
  paperFolder: PaperFilingRule;
  tags: string[];
  linkedCompany: string;
  linkedVorgang: CompanyDocumentVorgangLink | null;
  archived: boolean;
  createdAt: string;
  imagePreview?: string;
  linkedInvoiceId?: string | null;
}

export interface CompanyDocumentInput {
  title: string;
  category: CompanyDocumentCategory;
  issuer?: string;
  recognizedText?: string;
  issueDate?: string | null;
  validUntil?: string | null;
  digitalFolder?: DigitalFolder;
  paperFolder?: PaperFilingRule;
  tags?: string[];
  linkedCompany?: string;
  linkedVorgang?: CompanyDocumentVorgangLink | null;
  archived?: boolean;
  imagePreview?: string;
  linkedInvoiceId?: string | null;
}

export interface AppPersistedState {
  version: number;
  setup: CompanySetup;
  companyProfile?: CompanyProfile;
  invoiceNumberSequence?: InvoiceNumberSequence;
  inboxItems: InboxItem[];
  vorgaenge: Vorgang[];
  tasks: Task[];
  documents: CompanyDocument[];
  savedAt: string;
}
