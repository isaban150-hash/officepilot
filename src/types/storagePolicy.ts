import type { ClassifiedDocumentKind } from './models';

export const STORAGE_POLICY_IDS = [
  'receipt',
  'business_document',
  'legal_document',
  'construction_photo',
  'temporary_unknown',
] as const;

export type StoragePolicyId = (typeof STORAGE_POLICY_IDS)[number];

export const STORAGE_MEDIA_PROFILES = [
  'native_pdf',
  'scanned_pdf',
  'raster_image',
] as const;

export type StorageMediaProfile = (typeof STORAGE_MEDIA_PROFILES)[number];

export interface ResolvedStoragePolicy {
  /** Effective policy after deterministic resolver rules (may differ from catalog on overrides). */
  policyId: StoragePolicyId;
  /** Policy assigned by kind catalog before resolver overrides. */
  catalogPolicyId: StoragePolicyId;
  mediaProfile: StorageMediaProfile;
  classifiedKind: ClassifiedDocumentKind;
  policyOverrideApplied: boolean;
}
