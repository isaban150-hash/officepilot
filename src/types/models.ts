/** OfficePilot V1 – zentrales Datenmodell (Foundation MVP) */

import type { SyncClientConfig, SyncMeta, SyncOutboxEntry } from './sync';
import type { Workspace, WorkspaceMember, WorkspaceSettings } from './workspace';
import type { ContractIntelligenceResult, ContractOrderProposal } from './documentIntelligence';

export type AppLanguage = 'de' | 'tr' | 'bg' | 'ro' | 'ru';

export type TaxStatus =
  | 'standard_19'
  | 'standard_7'
  | 'kleinunternehmer_19'
  | 'reverse_charge_13b'
  | 'tax_free'
  | 'unclear';

export type InvoiceDocumentType =
  | 'rechnung'
  | 'abschlag'
  | 'teilrechnung'
  | 'schluss'
  | 'gutschrift'
  | 'storno';

export type MaterialStandard =
  | 'auftraggeber'
  | 'betrieb'
  | 'gemischt'
  | 'unclear';

export type VorgangStatus =
  /** @deprecated Legacy persisted value; migrated to `eingegangen` on load. */
  | 'neu'
  | 'eingegangen'
  | 'in_pruefung'
  | 'in_verhandlung'
  | 'beauftragt'
  | 'in_bearbeitung'
  | 'wartet'
  | 'abgeschlossen';

export type TaskType =
  | 'dokument_pruefen'
  | 'brief_abheften'
  | 'rechnung_vorbereiten'
  | 'kontoauszug_hochladen'
  | 'steuerberater_export';

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'archived';

export type TaskPriority = InboxPriority;

export type TaskCategory =
  | 'dokumente'
  | 'rechnungen'
  | 'zahlungen'
  | 'behoerden'
  | 'mitarbeiter'
  | 'baustelle'
  | 'fahrzeuge'
  | 'versicherungen'
  | 'steuern'
  | 'sonstiges';

export type TaskSourceType =
  | 'inbox'
  | 'classification'
  | 'contract'
  | 'invoice'
  | 'manual'
  | 'system';

export type TaskFilter = 'offen' | 'heute' | 'ueberfaellig' | 'kritisch' | 'erledigt';

export interface TaskProposal {
  title: string;
  description: string;
  priority: TaskPriority;
  category: TaskCategory;
  dueDate?: string;
  linkedVorgangId?: string;
  linkedVorgangTitle?: string;
  linkedInboxId?: string;
  linkedDocumentId?: string;
  linkedInvoiceId?: string;
  sourceType: TaskSourceType;
  sourceId?: string;
  taskKind: string;
  dedupeKey?: string;
  autoCreated?: boolean;
  /** Legacy i18n mapping */
  type?: TaskType;
}

export interface TaskSummary {
  open: number;
  today: number;
  overdue: number;
  critical: number;
  done: number;
  total: number;
}

export type PendingItemKind =
  | 'inbox_new'
  | 'inbox_deferred'
  | 'inbox_unfiled'
  | 'inbox_unlinked'
  | 'document_unarchived'
  | 'document_expiring'
  | 'document_expired'
  | 'invoice_overdue'
  | 'invoice_due_today'
  | 'invoice_due_soon'
  | 'invoice_partial'
  | 'contract_missing_proof'
  | 'document_lifecycle_reply'
  | 'document_lifecycle_filing'
  | 'document_lifecycle_deadline'
  | 'document_lifecycle_proof';

export interface PendingItem {
  id: string;
  kind: PendingItemKind;
  title: string;
  description?: string;
  priority: InboxPriority;
  route: string;
  sourceType: 'inbox' | 'document' | 'invoice' | 'contract';
  sourceId?: string;
  dueDate?: string;
  daysUntilDue?: number;
  metadata?: Record<string, string | number>;
}

export interface PendingHighlight {
  id: string;
  kind: PendingItemKind | 'open_tasks';
  labelKey: string;
  count: number;
  route: string;
  params?: Record<string, string | number>;
}

export interface PendingSummary {
  newInboxItems: number;
  deferredInboxItems: number;
  unfiledInboxItems: number;
  unlinkedInboxItems: number;
  unarchivedDocuments: number;
  openTasks: number;
  overdueInvoices: number;
  dueTodayInvoices: number;
  dueSoonInvoices: number;
  partialInvoices: number;
  expiringDocuments: number;
  expiredDocuments: number;
  missingContractDocuments: number;
  highlights: PendingHighlight[];
  scannedAt: string;
}

export interface PendingScanResult {
  items: PendingItem[];
  summary: PendingSummary;
}

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
  /** Herkunft aus E-Mail-Import (MAIL-01) */
  mailImportId?: string;
  importSource?: 'scan' | 'upload' | 'email';
  /** Lokale Dateireferenz (DOC-FOUNDATION-01) */
  fileRefId?: string;
  sourceFileHash?: string;
  sync?: SyncMeta;
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
  pageTexts?: Array<{ pageNumber: number; text: string }>;
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
  /**
   * Runtime-only universal understanding. Never persist on InboxItem / CompanyDocument.
   */
  documentProfile?: import('./documentProfile').DocumentProfile;
  needsKindReview?: boolean;
  suggestedKinds?: ClassifiedDocumentKind[];
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

export type WorkflowActionId =
  | 'archive_document'
  | 'link_vorgang'
  | 'create_vorgang'
  | 'import_positions'
  | 'accept_tasks'
  | 'cancel';

export interface WorkflowNextAction {
  id: WorkflowActionId;
  labelKey: string;
  enabled: boolean;
}

export interface WorkflowWarning {
  id: string;
  message: string;
}

export interface WorkflowLetterSummary {
  kind: string;
  about: import('../i18n/types').ExplanationTextBlock;
  importance: import('../i18n/types').ExplanationTextBlock;
  deadline: import('../i18n/types').ExplanationTextBlock;
  nextSteps: import('../i18n/types').ExplanationTextBlock;
  digitalStorage: string;
  paperStorage: string;
  legalDisclaimer: string;
  disclaimer: import('../i18n/types').ExplanationTextBlock[];
}

export interface DocumentUnderstandingSummary {
  documentType: string;
  sender?: string;
  recipient?: string;
  date?: string;
  referenceNumber?: string;
  constructionSite?: string;
  customer?: string;
  vorgang?: string;
  invoiceNumber?: string;
  amount?: string;
  deadline?: string;
  nextStep: string;
  partialRecognition: boolean;
  uncertainFields?: string[];
  /** Runtime hints from document profile — not persisted. */
  kindReviewRequired?: boolean;
  suggestedDocumentKinds?: string[];
  profileWarningKeys?: string[];
}

export type DocumentAiActionId =
  | 'create_order'
  | 'write_invoice'
  | 'monitor_deadline'
  | 'archive_document'
  | 'paper_folder'
  | 'tax_advisor_relevant';

export interface DocumentAiAction {
  id: DocumentAiActionId;
  labelKey: string;
  recommended: boolean;
}

export interface WorkflowResult {
  inboxItemId: string;
  companyRelevant: boolean;
  companyRelevance: CompanyRelevanceResult;
  classifiedKind: ClassifiedDocumentKind;
  classificationConfidence: AnalysisConfidence;
  classification: DocumentClassificationResult | null;
  documentExplanation: WorkflowLetterSummary | null;
  documentUnderstanding: DocumentUnderstandingSummary | null;
  documentAiActions: DocumentAiAction[];
  contractAnalysis: ContractAnalysisResult | null;
  contractIntelligence: ContractIntelligenceResult | null;
  contractOrderProposal: ContractOrderProposal | null;
  suggestedVorgang: SuggestedVorgangLink | null;
  similarVorgaenge: Vorgang[];
  suggestedOrderPositions: DetectedOrderPosition[];
  suggestedTasks: TaskProposal[];
  suggestedArchiveFolder: DigitalFolder;
  requiredDocuments: RequiredDocument[];
  pendingSummary: PendingSummary | null;
  warnings: WorkflowWarning[];
  nextActions: WorkflowNextAction[];
}

export type WorkflowExecutionStepId =
  | 'archive_document'
  | 'link_vorgang'
  | 'create_vorgang'
  | 'import_positions'
  | 'apply_contract_fields'
  | 'accept_tasks'
  | 'refresh_pending'
  | 'finalize_inbox';

export interface WorkflowExecutionFailure {
  step: WorkflowExecutionStepId;
  message: string;
}

export interface WorkflowResultExecution {
  completed: boolean;
  successSteps: WorkflowExecutionStepId[];
  failedSteps: WorkflowExecutionFailure[];
  warnings: WorkflowWarning[];
  inboxItem: InboxItem | null;
  vorgangId?: string;
  archiveDocumentId?: string;
  tasksCreated: number;
  positionsAdded: number;
  pendingSummary: PendingSummary | null;
}

import type { CommunicationChannel } from './communication';

export interface CompanySetup {
  companyName: string;
  industry: string;
  taxStatus: TaxStatus;
  materialStandard: MaterialStandard;
  language: AppLanguage;
  setupComplete: boolean;
  setupVersion: number;
  communicationChannel: CommunicationChannel;
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
  skontoEnabled?: boolean;
  skontoPercent?: number;
  skontoDays?: number;
  managingDirector?: string;
  taxFreeNotice?: string;
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
  /** Standard-Kategorie (FOLDER-01) */
  category?: PaperFolderCategory;
}

export type PaperFolderCategory =
  | 'behoerden'
  | 'kunden'
  | 'lieferanten'
  | 'eingangsrechnungen'
  | 'ausgangsrechnungen'
  | 'steuerberater'
  | 'bg_bau'
  | 'krankenkassen'
  | 'versicherungen'
  | 'personal'
  | 'fahrzeuge'
  | 'maschinen'
  | 'vertraege'
  | 'baustellen'
  | 'sonstiges';

/** Register innerhalb eines Papierordners */
export interface PaperRegister {
  folderId: string;
  name: string;
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

export interface VorgangDocument {
  id: string;
  name: string;
  type: DocumentType;
  date: string;
  paperFiling?: PaperFilingRule;
  /** Verweis auf zentrales Firmenarchiv (DOC-FOUNDATION-01) */
  companyDocumentId?: string;
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

/** ORDER-AMENDMENT: additive change kinds (draft + confirmed). */
export type OrderAmendmentChangeType = 'add' | 'quantity_increase';

export interface OrderPosition {
  id: string;
  description: string;
  plannedQuantity: number;
  unit: OrderUnit;
  /** Anzeige-Einheit, z. B. lfm bei gespeichertem Meter-Wert */
  unitLabel?: string;
  unitPrice: number;
  category?: OrderPositionCategory;
  billable?: boolean;
  /** Actually executed quantity during order execution — not plan, not billed. */
  executedQuantity?: number;
  /** Provenance for positions composed from confirmed amendments (ORDER-AMENDMENT-01B2). */
  sourceAmendmentId?: string;
  sourceAmendmentSequence?: number;
  parentPositionId?: string;
  amendmentChangeType?: OrderAmendmentChangeType;
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
  unitLabel?: string;
  unitPrice: number;
  category?: OrderPositionCategory;
  billable?: boolean;
}

/** ORDER-AMENDMENT-01A: local draft only — never confirmed, never in orderPositions. */
export type OrderAmendmentStatus = 'entwurf';

export interface OrderAmendmentDraftPosition {
  id: string;
  changeType: OrderAmendmentChangeType;
  description: string;
  quantity: number;
  unit: OrderUnit;
  unitLabel?: string;
  unitPrice: number;
  category?: OrderPositionCategory;
  billable?: boolean;
  /** Required for quantity_increase — references a confirmed order position id. */
  parentPositionId?: string;
}

/**
 * Local-only amendment draft on a confirmed Vorgang.
 * Not synced; must not affect orderPositions, billing, or cloud payload.
 */
export interface OrderAmendment {
  id: string;
  vorgangId: string;
  status: OrderAmendmentStatus;
  title: string;
  reason?: string;
  positions: OrderAmendmentDraftPosition[];
  createdAt: string;
  updatedAt: string;
}

/** Server-authoritative confirmed amendment (ORDER-AMENDMENT-01B2). Local write-once. */
export type ConfirmedOrderAmendmentStatus = 'bestaetigt';

export interface ConfirmedOrderAmendmentPosition {
  id: string;
  changeType: OrderAmendmentChangeType;
  parentPositionId?: string;
  description: string;
  plannedQuantity: number;
  unit: OrderUnit;
  unitLabel?: string;
  unitPrice: number;
  category?: OrderPositionCategory;
  billable?: boolean;
}

export interface ConfirmedOrderAmendment {
  cloudId: string;
  clientAmendmentId: string;
  vorgangId: string;
  sequenceNo: number;
  status: ConfirmedOrderAmendmentStatus;
  title: string;
  reason?: string;
  positions: ConfirmedOrderAmendmentPosition[];
  contentFingerprint: string;
  confirmedAt: string;
  confirmedBy: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  /** Local-only link to the draft that was confirmed — never pushed to cloud. */
  localSourceDraftId?: string;
}

export interface VorgangInvoiceLine {
  id: string;
  orderPositionId: string;
  description: string;
  quantity: number;
  unit: OrderUnit;
  unitLabel?: string;
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

export type InvoiceSentVia =
  | 'email'
  | 'post'
  | 'persoenlich'
  | 'portal'
  | 'sonstige';

export interface VorgangInvoice {
  id: string;
  number: string;
  type: InvoiceDocumentType;
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
  /** ISO date (YYYY-MM-DD) when marked as sent — optional for legacy invoices. */
  sentAt?: string;
  /** How the invoice was handed to the customer — optional for legacy. */
  sentVia?: InvoiceSentVia;
  /** Optional free-text note (e.g. for sentVia=sonstige). */
  sentNote?: string;
  /**
   * Frozen amendment plan revision for Schluss finalize (ORDER-AMENDMENT-01B2).
   * Captured when the Schluss draft/invoice is prepared — not recomputed at finalize.
   */
  expectedAmendmentSequence?: number;
}

/** Negotiation proposals live on the Vorgang only — never mutate the original contract document. */
export type NegotiationDraftKind =
  | 'price_change'
  | 'clarification'
  | 'adjustment_request'
  | 'appointment_request';

export interface NegotiationPriceProposal {
  id: string;
  orderPositionId: string;
  positionLabel: string;
  originalUnitPrice: number;
  proposedUnitPrice: number;
  unit: OrderUnit;
  note?: string;
  createdAt: string;
}

export interface NegotiationPositionProposal {
  id: string;
  description: string;
  proposedUnitPrice?: number;
  proposedQuantity?: number;
  unit?: OrderUnit;
  note?: string;
  createdAt: string;
}

export type NegotiationCommunicationIntent =
  | 'price_adjustment'
  | 'document_reply'
  | 'appointment_change';

export interface NegotiationDraftSnapshot {
  id: string;
  kind: NegotiationDraftKind;
  /** Mapped communication intent used to build the draft. */
  intent: NegotiationCommunicationIntent;
  subject: string;
  body: string;
  createdAt: string;
  /**
   * Confirm-first: drafts are never auto-sent.
   * Remains false until the user explicitly copies/sends outside this service.
   */
  sendConfirmed: false;
}

export interface ContractNegotiationState {
  startedAt?: string;
  /** Set when the user explicitly confirms the order — blocks further proposals. */
  closed?: boolean;
  completedAt?: string;
  notes: string[];
  generalHints: string[];
  priceProposals: NegotiationPriceProposal[];
  positionProposals: NegotiationPositionProposal[];
  draft?: NegotiationDraftSnapshot | null;
  /** Previous drafts kept as history (never auto-deleted). */
  draftHistory?: NegotiationDraftSnapshot[];
}

export interface ConfirmedContractPositionSnapshot {
  id: string;
  description: string;
  plannedQuantity: number;
  unit: OrderUnit;
  unitLabel?: string;
  unitPrice: number;
  category?: OrderPositionCategory;
  billable?: boolean;
}

export interface ContractConfirmationNegotiationSummary {
  notes: string[];
  generalHints: string[];
  priceProposals: NegotiationPriceProposal[];
  positionProposals: NegotiationPositionProposal[];
  drafts: NegotiationDraftSnapshot[];
}

/**
 * Immutable confirmed contract stand on the Vorgang.
 * Must never be overwritten — later changes belong in new Vorgänge (e.g. Nachtrag).
 */
export interface ContractConfirmationSnapshot {
  id: string;
  confirmedAt: string;
  customer: string;
  auftraggeber: string;
  baustelle: string;
  title: string;
  positions: ConfirmedContractPositionSnapshot[];
  negotiation: ContractConfirmationNegotiationSummary;
  /** Marker for tests and guardrails — always true once created. */
  immutable: true;
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
  /** Verhandlungsvorschläge — getrennt vom unveränderlichen Werkvertrag. */
  negotiation?: ContractNegotiationState;
  /** Frozen confirmed stand — created only by explicit user confirmation. */
  contractConfirmation?: ContractConfirmationSnapshot;
  /**
   * Local-only Nachtragsentwürfe (ORDER-AMENDMENT-01A).
   * Never part of VorgangCloudPayload / strip / content key.
   */
  orderAmendments?: OrderAmendment[];
  /**
   * Server-authoritative confirmed amendments (ORDER-AMENDMENT-01B2).
   * Local write-once; never part of VorgangCloudPayload / strip / content key.
   */
  confirmedOrderAmendments?: ConfirmedOrderAmendment[];
  /** Set when the user explicitly starts order execution (beauftragt → in_bearbeitung). */
  executionStartedAt?: string;
  sync?: SyncMeta;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  category: TaskCategory;
  dueDate?: string;
  linkedVorgangId?: string;
  linkedVorgangTitle?: string;
  linkedInboxId?: string;
  linkedDocumentId?: string;
  linkedInvoiceId?: string;
  sourceType: TaskSourceType;
  sourceId?: string;
  taskKind: string;
  dedupeKey: string;
  autoCreated: boolean;
  createdAt: string;
  completedAt?: string;
  /** Legacy – für i18n task.{type} */
  type: TaskType;
  /** Legacy – use linkedVorgangId */
  vorgangId?: string;
  /** Legacy – use linkedVorgangTitle */
  vorgangTitle?: string;
  /** Legacy – abgeleitet aus status */
  done?: boolean;
  sync?: SyncMeta;
}

export interface InvoiceDraftPosition {
  id: string;
  orderPositionId: string;
  description: string;
  plannedQuantity: number;
  /** Read-only display of operative execution qty; never written back to the plan. */
  executedQuantity?: number;
  billedQuantity: number;
  openQuantity: number;
  quantity: number;
  unit: OrderUnit;
  unitLabel?: string;
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
  type: InvoiceDocumentType;
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
  /**
   * Frozen at Schluss draft creation from local confirmed amendments (01B2).
   * Sent as expectedAmendmentSequence on cloud finalize — never recomputed later.
   */
  expectedAmendmentSequence?: number;
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
  type: InvoiceDocumentType;
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

export interface AssistantAction {
  id: string;
  label: string;
  route: string;
}

export interface AssistantAnswer {
  title: string;
  summary: string;
  bullets: string[];
  actions: AssistantAction[];
  linkedRoute?: string;
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
  fileRefId?: string;
  sourceFileHash?: string;
  originalFileName?: string;
  mimeType?: string;
  fileSize?: number;
  classifiedKind?: ClassifiedDocumentKind;
  sourceInboxItemId?: string;
  documentDate?: string | null;
  uploadedAt?: string;
  sync?: SyncMeta;
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
  fileRefId?: string;
  sourceFileHash?: string;
  originalFileName?: string;
  mimeType?: string;
  fileSize?: number;
  classifiedKind?: ClassifiedDocumentKind;
  sourceInboxItemId?: string;
  documentDate?: string | null;
  uploadedAt?: string;
}

import type { Expense } from './expense';
import type { VorgangNote } from './communication';
import type { CommunicationEvent } from './communicationHistory';
import type { KnowledgeFact } from './knowledge';
import type { OfficePilotMemoryState } from './memory';
import type { DocumentFileRef } from './documentFileRef';
import type { DocumentFileRepresentationBinding } from './documentFileRepresentationBinding';
import type { DocumentFileDerivativeStepOutcome } from './documentFileDerivativeStepOutcome';
import type { DocumentFileDerivativeRecoveryContext } from './documentFileDerivativeRecoveryContext';
import type { DocumentFileIntakeTransformPlanCarryContext } from './documentFileIntakeTransformPlanCarryContext';

export interface AppPersistedState {
  version: number;
  syncClient?: SyncClientConfig;
  syncOutbox?: SyncOutboxEntry[];
  workspace?: Workspace;
  workspaceMembers?: WorkspaceMember[];
  workspaceSettings?: WorkspaceSettings;
  setupSync?: SyncMeta;
  companyProfileSync?: SyncMeta;
  setup: CompanySetup;
  companyProfile?: CompanyProfile;
  invoiceNumberSequence?: InvoiceNumberSequence;
  inboxItems: InboxItem[];
  vorgaenge: Vorgang[];
  tasks: Task[];
  documents: CompanyDocument[];
  uploadedDocuments?: import('./uploadedDocument').UploadedDocument[];
  documentFileRefs?: DocumentFileRef[];
  documentFileBlobs?: Record<string, string>;
  /** Document-scoped additional representation roles (not original). */
  documentFileRepresentationBindings?: DocumentFileRepresentationBinding[];
  /** Post-import derived step outcomes (natural key: documentId + stepId). */
  documentFileDerivativeStepOutcomes?: DocumentFileDerivativeStepOutcome[];
  /** Frozen transform plans for later manual derivative retry (natural key: documentId). */
  documentFileDerivativeRecoveryContexts?: DocumentFileDerivativeRecoveryContext[];
  /** Intake→import transform plan carry (natural key: inboxItemId). */
  documentFileIntakeTransformPlanCarryContexts?: DocumentFileIntakeTransformPlanCarryContext[];
  expenses?: Expense[];
  vorgangNotes?: VorgangNote[];
  /** Confirmed payment-reminder / dunning handoffs (local documentation only). */
  dunningDocumentations?: import('./dunningDocumentation').InvoiceDunningDocumentation[];
  communicationHistory?: CommunicationEvent[];
  knowledgeFacts?: KnowledgeFact[];
  officePilotMemory?: OfficePilotMemoryState;
  mailImports?: import('./mailImport').MailImport[];
  savedAt: string;
}

export type {
  CommunicationChannel,
  CommunicationContext,
  CommunicationContextRef,
  CommunicationDraft,
  CommunicationIntent,
  CommunicationMode,
  CommunicationRequest,
  CommunicationResult,
  DocumentQuestionResult,
  MissingCommunicationInfo,
  RewriteStyle,
  VorgangNote,
  VorgangNoteInput,
  VorgangNoteSource,
} from './communication';
export type {
  Expense,
  ExpenseAllocation,
  ExpenseCategory,
  ExpenseInput,
  ExpenseLine,
  ExpenseOverviewItem,
  ExpensePayment,
  ExpensePaymentInput,
  ExpensePaymentStatus,
  ExpensePaymentSummary,
  ExpenseStatus,
  ExpenseSummary,
} from './expense';
