import type { AnalysisConfidence, ClassifiedDocumentKind, DetectedOrderPosition, DetectedPaymentTerm } from './models';

export type DocumentSectionType =
  | 'contract_core'
  | 'bill_of_quantities'
  | 'technical_attachment'
  | 'commercial_attachment'
  | 'unknown';

export type ExtractedFieldStatus = 'confirmed' | 'review_required' | 'not_found';

export type FieldConfidenceLevel = 'high' | 'medium' | 'low';

export interface DocumentPageText {
  pageNumber: number;
  text: string;
}

export interface DocumentPageSection {
  pageNumber: number;
  sectionType: DocumentSectionType;
  confidence: AnalysisConfidence;
  textPreview: string;
}

export interface DocumentSegmentationResult {
  pages: DocumentPageSection[];
  contractCorePages: number[];
  billOfQuantitiesPages: number[];
  technicalAttachmentPages: number[];
  commercialAttachmentPages: number[];
  unknownPages: number[];
}

export interface ExtractedContractField<T = string> {
  value?: T;
  status: ExtractedFieldStatus;
  confidence: FieldConfidenceLevel;
  sourcePage?: number;
  sourceText?: string;
}

export interface AmountCandidate {
  value: number;
  formatted: string;
  context: string;
  label?: string;
  sourcePage?: number;
}

export interface EnhancedDetectedOrderPosition extends DetectedOrderPosition {
  sourcePage?: number;
  confidence: AnalysisConfidence;
  reviewStatus: ExtractedFieldStatus;
  constructionSection?: string;
}

export interface ContractIntelligenceResult {
  documentLabelKey: string;
  classifiedKind: ClassifiedDocumentKind;
  reviewRequired: boolean;
  segmentation: DocumentSegmentationResult;
  contractFields: Record<string, ExtractedContractField>;
  positions: EnhancedDetectedOrderPosition[];
  contractTotalNet?: ExtractedContractField<number>;
  paymentTerms: DetectedPaymentTerm[];
  progressBillingAllowed: boolean;
  finalInvoiceMentioned: boolean;
  technicalAttachmentCount: number;
  openReviewHints: string[];
}

export interface ContractOrderProposal {
  customer: string;
  contractor: string;
  constructionSite: string;
  contractDate?: string;
  positionCount: number;
  contractTotalNet?: string;
  paymentTermsSummary: string;
  progressBillingHint?: string;
  technicalAttachmentsLabel?: string;
  reviewHints: string[];
  positions: EnhancedDetectedOrderPosition[];
  intelligence: ContractIntelligenceResult;
}
