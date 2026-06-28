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

export interface CompanySetup {
  companyName: string;
  industry: string;
  taxStatus: TaxStatus;
  materialStandard: MaterialStandard;
  language: AppLanguage;
  setupComplete: boolean;
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

export interface VorgangInvoice {
  id: string;
  number: string;
  type: 'abschlag' | 'schluss';
  abschlagNumber?: number;
  positions: VorgangInvoiceLine[];
  subtotal: number;
  taxStatus: TaxStatus;
  amount: number;
  status: 'entwurf' | 'vorbereitet' | 'versendet';
  date: string;
  createdAt: string;
}

export interface Vorgang {
  id: string;
  title: string;
  customer: string;
  baustelle: string;
  status: VorgangStatus;
  materialSource: MaterialStandard;
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
  type: 'abschlag' | 'schluss';
  abschlagNumber?: number;
  taxStatus: TaxStatus;
  materialSource: MaterialStandard;
  positions: InvoiceDraftPosition[];
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
}

export interface AppPersistedState {
  version: number;
  setup: CompanySetup;
  inboxItems: InboxItem[];
  vorgaenge: Vorgang[];
  tasks: Task[];
  documents: CompanyDocument[];
  savedAt: string;
}
