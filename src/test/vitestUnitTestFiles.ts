/**
 * Explicit allowlist for the Vitest `unit` project (TEST-INFRA-02A).
 * Only unambiguously Light tests — no stores, IDB, AppProvider, or DOM.
 * When in doubt, keep the file on the default project.
 */
export const UNIT_TEST_FILES = [
  // Source/string checks (no DOM runtime)
  'src/App.test.tsx',

  // Pure utilities / formatters / hash
  'src/supabaseUrlNormalization.test.ts',
  'src/services/sha256Digest.test.ts',
  'src/services/documentFileHashService.test.ts',
  'src/services/expenseCategoryMapping.test.ts',
  'src/services/expenseNormalize.test.ts',
  'src/services/invoiceNavigation.test.ts',
  'src/services/invoicePrintModel.test.ts',
  'src/services/paperFolderService.test.ts',
  'src/services/scanResultViewService.test.ts',
  'src/services/letterExplanationService.test.ts',
  'src/types/documentAnalysis.test.ts',

  // Classification / cutover / zoning / scoring (no store hydration)
  'src/services/documentRecognizedDataService.test.ts',
  'src/services/documentZoningService.test.ts',
  'src/services/documentFeatureExtractionService.test.ts',
  'src/services/documentUploadValidation.test.ts',
  'src/services/heicUploadNormalizeService.test.ts',
  'src/services/documentAnalysisLegacyAdapter.test.ts',
  'src/services/documentClassificationHybridPrecedence.test.ts',
  'src/services/documentAuthorityCutoverService.test.ts',
  'src/services/documentCertificateCutoverService.test.ts',
  'src/services/documentContractCutoverService.test.ts',
  'src/services/documentCustomerCutoverService.test.ts',
  'src/services/documentInvoiceCutoverService.test.ts',
  'src/services/documentPaymentCutoverService.test.ts',
  'src/services/documentReceiptCutoverService.test.ts',
  'src/services/documentReceiptCandidateScoringService.test.ts',
  'src/services/documentEmploymentMisclassification01.test.ts',
  'src/services/document/documentAiQuestionIntent.test.ts',
  'src/services/document/documentFreeQuestionEvidence01.test.ts',

  // Communication pure helpers (no history/persist side effects)
  'src/services/communicationIntentService.test.ts',
  'src/services/communicationQuestionService.test.ts',
  'src/services/communicationDraftService.test.ts',
  'src/services/communicationDocumentQaService.test.ts',
  'src/services/communication/communicationAiGuardService.test.ts',

  // Storage plan / model / capability (no blob, no store hydrate)
  'src/storageArchiveTransformResolutionModel01.test.ts',
  'src/storagePdfDerivativeEncodePlan01.test.ts',
  'src/storagePdfMetadataStripCore01.test.ts',
  'src/storagePdfMetadataStripPlan01.test.ts',
  'src/storagePdfRenderCapabilityEnablement01.test.ts',
  'src/storagePdfWriteCapabilityAndPlan01.test.ts',
  'src/storagePdfWriteImageCore01.test.ts',
  'src/storagePolicyRequirements01.test.ts',
  'src/storageRasterArchiveEncodePlan01.test.ts',
  'src/storageRasterDerivativeEncodeOptions01.test.ts',
  'src/storageRasterEncodeCore01.test.ts',
  'src/storageRepresentationBindingPersistenceModel01.test.ts',
  'src/storageRepresentationBindingRegistry01.test.ts',
  'src/storageRepresentationModel01.test.ts',
  'src/storageRepresentationPlanner01.test.ts',
  'src/storageRepresentationSourceReuseBindingPlan01.test.ts',
  'src/storageTransformArchiveMaterialization01.test.ts',
  'src/storageTransformCapabilityEvaluator01.test.ts',
  'src/storageTransformCapabilityModel01.test.ts',
  'src/storageTransformCapabilityProvider01.test.ts',
  'src/storageTransformDerivativeCapabilityRequirements01.test.ts',
  'src/storageTransformIntentPlanner01.test.ts',
  'src/storageTransformPdfPreflight01.test.ts',
] as const;
