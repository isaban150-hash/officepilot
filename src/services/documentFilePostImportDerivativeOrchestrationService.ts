import type { DocumentFileTransformPlan } from '../types/documentFileTransformPlan';
import { orchestrateRasterArchiveEncodeAfterImport } from './documentFileRasterArchiveEncodeOrchestrationService';
import { orchestrateImageToPdfArchiveEncodeAfterImport } from './documentFileImageToPdfArchiveEncodeOrchestrationService';
import { orchestratePdfMetadataStripAfterImport } from './documentFilePdfMetadataStripOrchestrationService';
import { orchestrateRasterThumbnailEncodeAfterImport } from './documentFileRasterThumbnailEncodeOrchestrationService';
import { orchestrateRasterPreviewEncodeAfterImport } from './documentFileRasterPreviewEncodeOrchestrationService';
import { orchestratePdfThumbnailEncodeAfterImport } from './documentFilePdfThumbnailEncodeOrchestrationService';
import { orchestratePdfPreviewEncodeAfterImport } from './documentFilePdfPreviewEncodeOrchestrationService';

const LOG_PREFIX = '[OfficePilot:post-import-derivatives]';

export const POST_IMPORT_DERIVATIVE_STEP_IDS = [
  'raster_archive',
  'image_to_pdf_archive',
  'pdf_metadata_strip',
  'raster_thumbnail',
  'raster_preview',
  'pdf_thumbnail',
  'pdf_preview',
] as const;

export type PostImportDerivativeStepId = (typeof POST_IMPORT_DERIVATIVE_STEP_IDS)[number];

export interface OrchestratePostImportDerivativesAfterImportInput {
  documentId: string;
  transformPlan: DocumentFileTransformPlan | null | undefined;
}

export interface PostImportDerivativeStepResult {
  readonly stepId: PostImportDerivativeStepId;
  readonly outcome: 'completed' | 'failed';
  readonly error?: unknown;
}

export interface PostImportDerivativesOrchestrationResult {
  readonly kind: 'completed';
  readonly steps: readonly PostImportDerivativeStepResult[];
}

type PostImportDerivativeStepRunner = (
  input: OrchestratePostImportDerivativesAfterImportInput,
) => Promise<unknown>;

const DEFAULT_STEP_RUNNERS: Readonly<Record<PostImportDerivativeStepId, PostImportDerivativeStepRunner>> =
  Object.freeze({
    raster_archive: orchestrateRasterArchiveEncodeAfterImport,
    image_to_pdf_archive: orchestrateImageToPdfArchiveEncodeAfterImport,
    pdf_metadata_strip: orchestratePdfMetadataStripAfterImport,
    raster_thumbnail: orchestrateRasterThumbnailEncodeAfterImport,
    raster_preview: orchestrateRasterPreviewEncodeAfterImport,
    pdf_thumbnail: orchestratePdfThumbnailEncodeAfterImport,
    pdf_preview: orchestratePdfPreviewEncodeAfterImport,
  });

let stepRunnerOverrides: Partial<
  Record<PostImportDerivativeStepId, PostImportDerivativeStepRunner>
> | null = null;

export function setPostImportDerivativeStepRunnersForTests(
  runners: Partial<Record<PostImportDerivativeStepId, PostImportDerivativeStepRunner>> | null,
): void {
  stepRunnerOverrides = runners;
}

function resolveStepRunner(stepId: PostImportDerivativeStepId): PostImportDerivativeStepRunner {
  return stepRunnerOverrides?.[stepId] ?? DEFAULT_STEP_RUNNERS[stepId];
}

function reportCoordinatorError(stepId: PostImportDerivativeStepId, error: unknown): void {
  console.error(LOG_PREFIX, stepId, error);
}

/**
 * Run post-import derived representation orchestrators strictly one after another.
 * Import callers should fire-and-forget this; a failing step is logged and must not
 * block later steps or fail the document import.
 */
export async function orchestratePostImportDerivativesAfterImport(
  input: OrchestratePostImportDerivativesAfterImportInput,
): Promise<PostImportDerivativesOrchestrationResult> {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid post-import derivatives orchestration input');
  }
  if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
    throw new TypeError('Invalid post-import derivatives orchestration documentId');
  }

  const stepInput = {
    documentId: input.documentId,
    transformPlan: input.transformPlan,
  };

  const steps: PostImportDerivativeStepResult[] = [];

  for (const stepId of POST_IMPORT_DERIVATIVE_STEP_IDS) {
    try {
      const result = await resolveStepRunner(stepId)(stepInput);
      if (
        result !== null &&
        typeof result === 'object' &&
        'kind' in result &&
        (result as { kind: unknown }).kind === 'error'
      ) {
        steps.push(
          Object.freeze({
            stepId,
            outcome: 'failed' as const,
            error: (result as { error?: unknown }).error,
          }),
        );
      } else {
        steps.push(Object.freeze({ stepId, outcome: 'completed' as const }));
      }
    } catch (error) {
      reportCoordinatorError(stepId, error);
      steps.push(Object.freeze({ stepId, outcome: 'failed' as const, error }));
    }
  }

  return Object.freeze({
    kind: 'completed',
    steps: Object.freeze(steps),
  });
}
