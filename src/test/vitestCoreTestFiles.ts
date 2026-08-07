/**
 * Core test allowlist for daily development runs (TEST-INFRA-01).
 * Keep this list focused on the most critical paths and stable.
 */
export const CORE_UNIT_TEST_FILES = [
  'src/services/sha256Digest.test.ts',
  'src/services/documentFileHashService.test.ts',
  'src/services/invoiceNavigation.test.ts',
  'src/services/paperFolderService.test.ts',
  'src/services/documentRecognizedDataService.test.ts',
  'src/services/documentZoningService.test.ts',
  'src/services/documentFeatureExtractionService.test.ts',
  'src/services/documentUploadValidation.test.ts',
  'src/services/heicUploadNormalizeService.test.ts',
  'src/services/documentClassificationHybridPrecedence.test.ts',
  'src/services/documentAuthorityCutoverService.test.ts',
  'src/services/documentInvoiceCutoverService.test.ts',
  'src/documentPrimaryTarget02aCore.test.ts',
  'src/documentUnderstanding01a.test.ts',
  'src/storagePdfWriteImageCore01.test.ts',
  'src/storageRepresentationModel01.test.ts',
] as const;

export const CORE_DEFAULT_TEST_FILES = [
  'src/testWorld/gold-pdf-pipeline.test.ts',
] as const;

export const CORE_TEST_FILE_COUNT =
  CORE_UNIT_TEST_FILES.length + CORE_DEFAULT_TEST_FILES.length;
