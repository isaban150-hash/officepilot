import type {
  ClassifiedDocumentKind,
  DigitalFolder,
  PaperFilingRule,
} from './models';
import type { SyncMeta } from './sync';

/** Nachweis-Typen für CORE-01B (Handwerks-Nachweise) */
export type ProofType =
  | 'freistellungsbescheinigung'
  | 'bg_bau'
  | 'soka_bau'
  | 'betriebshaftpflicht';

export type ProofStatus = 'valid' | 'expiring' | 'expired' | 'missing' | 'unknown';

export type MemoryRelationType = 'requires_proof';

export type MemoryRiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export type MemorySourceConfidence = 'high' | 'medium' | 'low';

/** Herkunft der Summary – heute `rules`, später AI-01 via `ai` / `hybrid`. */
export type DocumentSummaryOrigin = 'rules' | 'ai' | 'hybrid';

export type MemoryAuthorityId =
  | 'bg_bau'
  | 'finanzamt'
  | 'aok'
  | 'tk'
  | 'barmer'
  | 'ikk'
  | 'soka_bau'
  | 'handwerkskammer'
  | 'ihk'
  | 'steuerberater'
  | 'versicherung';

export interface DocumentSummary {
  documentKindLabel: string;
  issuer: string;
  topic: string;
  shortSummary: string;
  deadline: string | null;
  amounts: string[];
  requiredDocuments: string[];
  nextAction: string;
  riskLevel: MemoryRiskLevel;
  sourceConfidence: MemorySourceConfidence;
  /** Einheitliches Feldschema – Regeln heute, KI-Verbesserung später ohne zweite Struktur. */
  origin: DocumentSummaryOrigin;
  generatedAt: string;
}

export interface PremiumLetterExplanation {
  shortExplanation: string;
  whatIsItAbout: string;
  whyReceived: string;
  actionRequired: string;
  deadline: string;
  requiredDocuments: string[];
  risks: string;
  recommendation: string;
  digitalStorage: string;
  paperStorage: string;
  disclaimer: string;
}

export interface MemoryQueryAnswer {
  shortAnswer: string;
  source: string;
  digitalLocation: string;
  paperLocation: string;
  register: string;
  status: string;
  nextStep: string;
  uncertainty?: string;
}

/** Einheitliche Dokument-Erklärung aus Firmen-Gedächtnis (AI-01, regelbasiert). */
export interface DocumentExplanation {
  shortAnswer: string;
  whatIsIt: string;
  whyImportant: string;
  actionRequired: string;
  deadline: string;
  requiredDocuments: string[];
  risk: string;
  recommendation: string;
  digitalLocation: string;
  paperLocation: string;
  register: string;
  originalFiledStatus: string;
  communicationStatus?: string;
  nextSteps: string[];
  uncertaintyNote?: string;
  disclaimer: string;
  sourceDocumentId?: string;
  sourceTitle?: string;
}

export interface PaperRegisterEntry {
  id: string;
  documentId: string;
  documentTitle: string;
  sourceInboxId?: string;
  folderId: string;
  register: string;
  physicalFiled: boolean;
  filedAt?: string;
  filedByUser?: string;
  createdAt: string;
  updatedAt: string;
  sync?: SyncMeta;
}

export type DocumentMemorySource = 'scan' | 'upload' | 'email';

export interface DocumentMemory {
  id: string;
  documentId: string;
  inboxId?: string;
  classifiedKind?: ClassifiedDocumentKind;
  title: string;
  issuer: string;
  digitalFolder: DigitalFolder;
  paperFolder: PaperFilingRule;
  validUntil: string | null;
  linkedVorgangId?: string;
  proofType?: ProofType;
  summary?: DocumentSummary;
  topic?: string;
  nextAction?: string;
  riskLevel?: MemoryRiskLevel;
  requiredDocuments?: string[];
  relatedAuthorities?: MemoryAuthorityId[];
  relatedCustomers?: string[];
  relatedProofs?: ProofType[];
  letterExplanation?: PremiumLetterExplanation;
  memoryStatus?: 'understood' | 'partial' | 'pending';
  physicalFiled?: boolean;
  filedAt?: string;
  filedByUser?: string;
  paperRegisterEntryId?: string;
  source?: DocumentMemorySource;
  mailFrom?: string;
  mailSubject?: string;
  mailImportId?: string;
  createdAt: string;
  updatedAt: string;
  sync?: SyncMeta;
}

export interface ProofMemory {
  id: string;
  proofType: ProofType;
  status: ProofStatus;
  validFrom?: string | null;
  validUntil?: string | null;
  documentMemoryId?: string | null;
  documentId?: string | null;
  requiredByVorgangIds: string[];
  sourceInboxId?: string;
  lastCheckedAt: string;
  updatedAt: string;
  sync?: SyncMeta;
}

export interface MemoryRelation {
  id: string;
  relation: MemoryRelationType;
  fromType: 'vorgang' | 'document';
  fromId: string;
  toProofType: ProofType;
  sourceInboxId?: string;
  reason?: string;
  createdAt: string;
  sync?: SyncMeta;
}

export interface OfficePilotMemoryState {
  documentMemories: DocumentMemory[];
  proofMemories: ProofMemory[];
  relations: MemoryRelation[];
  paperRegisterEntries: PaperRegisterEntry[];
}

export const PROOF_EXPIRY_WARNING_DAYS = 30;

export const SUPPORTED_PROOF_TYPES: ProofType[] = [
  'freistellungsbescheinigung',
  'bg_bau',
  'soka_bau',
  'betriebshaftpflicht',
];
