import type { DigitalFolder } from './models';

export type StorageRecommendationLevel =
  | 'archive_required'
  | 'archive_recommended'
  | 'temporary_only'
  | 'review_required'
  | 'duplicate_detected'
  | 'discard_recommended';

export type StorageEvidenceSource = 'ocr' | 'rules' | 'hash' | 'catalog' | 'duplicate';

export type StorageEvidenceRef = {
  id: string;
  source: StorageEvidenceSource;
  fieldKey?: string;
  detectionReasonKey?: string;
  matchedEntityId?: string;
};

export type StorageRecommendation = {
  level: StorageRecommendationLevel;
  reasonKeys: string[];
  evidenceRefs: StorageEvidenceRef[];
  recommendedFolder?: DigitalFolder;
  requiresUserConfirmation: true;
  duplicateFileRefId?: string;
  duplicateMatch?: {
    type: 'inbox' | 'document';
    id: string;
    title: string;
  };
  confidence: number;
  recognitionStatus?: 'confident' | 'assign_customer' | 'review';
  steuerberaterHint?: 'mark' | 'check' | 'not_relevant';
  disclaimerKey?: string;
  computedAt: string;
};
