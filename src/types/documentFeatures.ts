import type {
  DocumentZone,
  EvidenceRef,
} from './documentAnalysis';

export type DocumentFeatureCategory =
  | 'identity'
  | 'date'
  | 'reference'
  | 'amount'
  | 'payment'
  | 'register'
  | 'structure'
  | 'authority';

export type DocumentFeatureStrength =
  | 'weak'
  | 'medium'
  | 'strong';

export type ExtractedDocumentFeature = {
  id: string;
  category: DocumentFeatureCategory;
  value?: string | number | boolean;
  rawValue?: string;
  confidence: number;
  strength: DocumentFeatureStrength;
  zone: DocumentZone;
  evidenceRefs: string[];
  source: 'rules';
};

export type DocumentFeatureExtractionResult = {
  features: ExtractedDocumentFeature[];
  evidenceIndex: Record<string, EvidenceRef>;
  warnings: string[];
};
