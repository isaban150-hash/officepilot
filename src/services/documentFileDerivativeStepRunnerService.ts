import type { DocumentFileTransformPlan } from '../types/documentFileTransformPlan';
import type { PostImportDerivativeStepId } from '../types/documentFileDerivativeStepOutcome';
import { orchestrateRasterArchiveEncodeAfterImport } from './documentFileRasterArchiveEncodeOrchestrationService';
import { orchestrateImageToPdfArchiveEncodeAfterImport } from './documentFileImageToPdfArchiveEncodeOrchestrationService';
import { orchestratePdfMetadataStripAfterImport } from './documentFilePdfMetadataStripOrchestrationService';
import { orchestrateRasterThumbnailEncodeAfterImport } from './documentFileRasterThumbnailEncodeOrchestrationService';
import { orchestrateRasterPreviewEncodeAfterImport } from './documentFileRasterPreviewEncodeOrchestrationService';
import { orchestratePdfThumbnailEncodeAfterImport } from './documentFilePdfThumbnailEncodeOrchestrationService';
import { orchestratePdfPreviewEncodeAfterImport } from './documentFilePdfPreviewEncodeOrchestrationService';

/**
 * Shared step input for post-import derivative runners (coordinator + manual retry).
 */
export interface DocumentFileDerivativeStepRunnerInput {
  documentId: string;
  transformPlan: DocumentFileTransformPlan | null | undefined;
}

export type DocumentFileDerivativeStepRunner = (
  input: DocumentFileDerivativeStepRunnerInput,
) => Promise<unknown>;

const DEFAULT_STEP_RUNNERS: Readonly<
  Record<PostImportDerivativeStepId, DocumentFileDerivativeStepRunner>
> = Object.freeze({
  raster_archive: orchestrateRasterArchiveEncodeAfterImport,
  image_to_pdf_archive: orchestrateImageToPdfArchiveEncodeAfterImport,
  pdf_metadata_strip: orchestratePdfMetadataStripAfterImport,
  raster_thumbnail: orchestrateRasterThumbnailEncodeAfterImport,
  raster_preview: orchestrateRasterPreviewEncodeAfterImport,
  pdf_thumbnail: orchestratePdfThumbnailEncodeAfterImport,
  pdf_preview: orchestratePdfPreviewEncodeAfterImport,
});

let stepRunnerOverrides: Partial<
  Record<PostImportDerivativeStepId, DocumentFileDerivativeStepRunner>
> | null = null;

/**
 * Test-only overrides for the shared step→orchestrator map.
 * Used by both the post-import coordinator and manual retry.
 */
export function setPostImportDerivativeStepRunnersForTests(
  runners: Partial<Record<PostImportDerivativeStepId, DocumentFileDerivativeStepRunner>> | null,
): void {
  stepRunnerOverrides = runners;
}

/**
 * Resolve the single shared orchestrator for a derivative step id.
 */
export function resolveDocumentFileDerivativeStepRunner(
  stepId: PostImportDerivativeStepId,
): DocumentFileDerivativeStepRunner {
  return stepRunnerOverrides?.[stepId] ?? DEFAULT_STEP_RUNNERS[stepId];
}
