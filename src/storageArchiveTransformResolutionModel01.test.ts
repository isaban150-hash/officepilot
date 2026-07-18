import { describe, expect, it } from 'vitest';
import { resolveDocumentFileArchiveTransformResolution } from './services/documentFileArchiveTransformResolutionService';
import { buildDocumentFileRepresentationPlan } from './services/documentFileRepresentationPlanService';
import { resolveDocumentFileTransformArchiveMaterialization } from './services/documentFileTransformArchiveMaterializationService';
import { buildDocumentFileTransformPlan } from './services/documentFileTransformPlanService';
import type { DocumentFileArchiveTransformResolutionResult } from './types/documentFileArchiveTransformResolution';
import type {
  DocumentFileTransformHints,
  DocumentFileTransformIntent,
} from './types/documentFileTransformPlan';
import type { StoragePolicyId } from './types/storagePolicy';

function archiveIntent(
  executionIntent: DocumentFileTransformIntent['executionIntent'] = 'preferred',
): DocumentFileTransformIntent {
  return {
    targetKind: 'archive',
    intent: 'create_archive',
    executionIntent,
  };
}

function hints(partial: DocumentFileTransformHints): DocumentFileTransformHints {
  return { ...partial };
}

function requireArchivePlan(policyId: StoragePolicyId) {
  const representationPlan = buildDocumentFileRepresentationPlan({
    policyId,
    decision: 'save_permanently',
  });
  expect(representationPlan).not.toBeNull();
  const plan = buildDocumentFileTransformPlan({
    representationPlan: representationPlan!,
    mediaProfile: 'native_pdf',
  });
  expect(plan).not.toBeNull();
  const archive = plan!.intents.find((entry) => entry.intent === 'create_archive');
  expect(archive).toBeDefined();
  return { plan: plan!, archive: archive! };
}

describe('STORAGE-ARCHIVE-TRANSFORM-RESOLUTION-MODEL-01', () => {
  describe('Fall A–B: produktive Planner-Pfade', () => {
    it('legal_document create_archive → source_reuse unverändert zur Materialization', () => {
      const { plan, archive } = requireArchivePlan('legal_document');
      expect(plan.hints).toEqual({
        preferredOutputKind: 'preserve_source',
        metadataHandling: 'preserve',
        colorHandling: 'preserve',
      });

      const materialization = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archive,
        hints: plan.hints,
      });
      const resolution = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archive,
        hints: plan.hints,
      });

      expect(materialization).toEqual({ kind: 'source_reuse' });
      expect(resolution).toEqual({ kind: 'source_reuse' });
      expect(JSON.stringify(resolution)).not.toMatch(
        /write_pdf|encode_raster_image|load_pdf|requiredCapabilities/,
      );
    });

    it('business_document + strip_nonessential → metadata_rewrite_required', () => {
      const { plan, archive } = requireArchivePlan('business_document');
      expect(plan.hints.preferredOutputKind).toBe('preserve_source');
      expect(plan.hints.metadataHandling).toBe('strip_nonessential');

      const materialization = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archive,
        hints: plan.hints,
      });
      const resolution = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archive,
        hints: plan.hints,
      });

      expect(materialization).toEqual({ kind: 'unresolved' });
      expect(resolution).toEqual({ kind: 'metadata_rewrite_required' });
      expect(JSON.stringify(resolution)).not.toMatch(
        /write_pdf|encode_raster_image|source_reuse|executor/,
      );
    });
  });

  describe('Fall C: Output-Konvertierung nur bei eindeutigem Quellformat', () => {
    it('pdf_preferred + Raster-MIME → output_conversion_required', () => {
      const result = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'pdf_preferred',
          metadataHandling: 'preserve',
          colorHandling: 'preserve',
        }),
        sourceMimeType: 'image/jpeg',
      });
      expect(result).toEqual({ kind: 'output_conversion_required' });
      expect(JSON.stringify(result)).not.toMatch(/write_pdf|encode_raster_image/);
    });

    it('image_preferred + PDF-MIME → output_conversion_required', () => {
      const result = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'image_preferred',
          metadataHandling: 'preserve',
          colorHandling: 'preserve',
        }),
        sourceMimeType: 'application/pdf',
      });
      expect(result).toEqual({ kind: 'output_conversion_required' });
      expect(JSON.stringify(result)).not.toMatch(/decode_raster_image|encode_raster_image/);
    });

    it('pdf_preferred ohne / mit bereits passendem Quellformat → strategy_unresolved', () => {
      const withoutMime = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'pdf_preferred',
          metadataHandling: 'preserve',
          colorHandling: 'preserve',
        }),
      });
      const alreadyPdf = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'pdf_preferred',
          metadataHandling: 'preserve',
          colorHandling: 'preserve',
        }),
        sourceMimeType: 'application/pdf',
      });

      expect(withoutMime).toEqual({ kind: 'strategy_unresolved' });
      expect(alreadyPdf).toEqual({ kind: 'strategy_unresolved' });
    });

    it('image_preferred ohne / mit bereits passendem Quellformat → strategy_unresolved', () => {
      const withoutMime = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'image_preferred',
          metadataHandling: 'preserve',
          colorHandling: 'preserve',
        }),
      });
      const alreadyImage = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'image_preferred',
          metadataHandling: 'preserve',
          colorHandling: 'preserve',
        }),
        sourceMimeType: 'image/png',
      });

      expect(withoutMime).toEqual({ kind: 'strategy_unresolved' });
      expect(alreadyImage).toEqual({ kind: 'strategy_unresolved' });
    });
  });

  describe('Fall D: grayscale_allowed ist keine ausführbare Farbtransformation', () => {
    it('preserve_source + grayscale_allowed → strategy_unresolved, nicht color_processing_required', () => {
      const result = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'preserve_source',
          metadataHandling: 'preserve',
          colorHandling: 'grayscale_allowed',
        }),
      });

      expect(result).toEqual({ kind: 'strategy_unresolved' });
      expect(result.kind).not.toBe('color_processing_required');
      expect(result.kind).not.toBe('source_reuse');
    });
  });

  describe('Fall E: source_reuse-Bedingungen und weitere unresolved-Fälle', () => {
    it('preserve_source + metadata preserve + color preserve|not_applicable → source_reuse', () => {
      expect(
        resolveDocumentFileArchiveTransformResolution({
          transformIntent: archiveIntent(),
          hints: hints({
            preferredOutputKind: 'preserve_source',
            metadataHandling: 'preserve',
            colorHandling: 'preserve',
          }),
        }),
      ).toEqual({ kind: 'source_reuse' });

      expect(
        resolveDocumentFileArchiveTransformResolution({
          transformIntent: archiveIntent(),
          hints: hints({
            preferredOutputKind: 'preserve_source',
            metadataHandling: 'preserve',
            colorHandling: 'not_applicable',
          }),
        }),
      ).toEqual({ kind: 'source_reuse' });
    });

    it('strip_nonessential hat Vorrang vor pdf_preferred', () => {
      const result = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'pdf_preferred',
          metadataHandling: 'strip_nonessential',
          colorHandling: 'preserve',
        }),
        sourceMimeType: 'image/jpeg',
      });
      expect(result).toEqual({ kind: 'metadata_rewrite_required' });
    });

    it('metadata not_applicable → strategy_unresolved', () => {
      const result = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'preserve_source',
          metadataHandling: 'not_applicable',
          colorHandling: 'preserve',
        }),
      });
      expect(result).toEqual({ kind: 'strategy_unresolved' });
    });
  });

  describe('Fall F: ungültige Inputs kontrolliert ablehnen', () => {
    const validHints = hints({
      preferredOutputKind: 'preserve_source',
      metadataHandling: 'preserve',
      colorHandling: 'preserve',
    });

    it('create_preview und create_thumbnail → TypeError', () => {
      for (const intent of ['create_preview', 'create_thumbnail'] as const) {
        const transformIntent = {
          targetKind: intent === 'create_preview' ? 'preview' : 'thumbnail',
          intent,
          executionIntent: 'preferred',
        } as DocumentFileTransformIntent;

        expect(() =>
          resolveDocumentFileArchiveTransformResolution({
            transformIntent,
            hints: validHints,
          }),
        ).toThrow(TypeError);
      }
    });

    it('unbekannte Hint-Werte → TypeError', () => {
      expect(() =>
        resolveDocumentFileArchiveTransformResolution({
          transformIntent: archiveIntent(),
          hints: {
            ...validHints,
            preferredOutputKind: 'copy_source',
          } as unknown as DocumentFileTransformHints,
        }),
      ).toThrow(TypeError);

      expect(() =>
        resolveDocumentFileArchiveTransformResolution({
          transformIntent: archiveIntent(),
          hints: {
            ...validHints,
            metadataHandling: 'remove_all',
          } as unknown as DocumentFileTransformHints,
        }),
      ).toThrow(TypeError);

      expect(() =>
        resolveDocumentFileArchiveTransformResolution({
          transformIntent: archiveIntent(),
          hints: {
            ...validHints,
            colorHandling: 'grayscale_required',
          } as unknown as DocumentFileTransformHints,
        }),
      ).toThrow(TypeError);
    });

    it('ungültiger sourceMimeType → TypeError', () => {
      for (const sourceMimeType of ['', 'text/plain', 'image/heic', 'application/octet-stream'] as const) {
        expect(() =>
          resolveDocumentFileArchiveTransformResolution({
            transformIntent: archiveIntent(),
            hints: hints({
              preferredOutputKind: 'pdf_preferred',
              metadataHandling: 'preserve',
              colorHandling: 'preserve',
            }),
            sourceMimeType,
          }),
        ).toThrow(TypeError);
      }
    });

    it('unvollständige Inputs → TypeError', () => {
      expect(() =>
        resolveDocumentFileArchiveTransformResolution(
          { hints: validHints } as unknown as {
            transformIntent: DocumentFileTransformIntent;
            hints: DocumentFileTransformHints;
          },
        ),
      ).toThrow(TypeError);

      expect(() =>
        resolveDocumentFileArchiveTransformResolution(
          { transformIntent: archiveIntent() } as unknown as {
            transformIntent: DocumentFileTransformIntent;
            hints: DocumentFileTransformHints;
          },
        ),
      ).toThrow(TypeError);

      expect(() =>
        resolveDocumentFileArchiveTransformResolution(null as unknown as {
          transformIntent: DocumentFileTransformIntent;
          hints: DocumentFileTransformHints;
        }),
      ).toThrow(TypeError);
    });
  });

  describe('Fall G: Immutability, Determinismus, Schichtgrenzen', () => {
    it('Results sind eingefroren; Eingaben bleiben unverändert', () => {
      const transformIntent = Object.freeze(archiveIntent());
      const planHints = Object.freeze(
        hints({
          preferredOutputKind: 'preserve_source',
          metadataHandling: 'strip_nonessential',
          colorHandling: 'preserve',
        }),
      );
      const intentBefore = structuredClone(transformIntent);
      const hintsBefore = structuredClone(planHints);

      const result = resolveDocumentFileArchiveTransformResolution({
        transformIntent,
        hints: planHints,
      });

      expect(result).toEqual({ kind: 'metadata_rewrite_required' });
      expect(Object.isFrozen(result)).toBe(true);
      expect(transformIntent).toEqual(intentBefore);
      expect(planHints).toEqual(hintsBefore);
    });

    it('Result trägt keine Capability-/Executor-/Persistenz-Felder', () => {
      const results: DocumentFileArchiveTransformResolutionResult[] = [
        resolveDocumentFileArchiveTransformResolution({
          transformIntent: archiveIntent(),
          hints: hints({
            preferredOutputKind: 'preserve_source',
            metadataHandling: 'preserve',
            colorHandling: 'preserve',
          }),
        }),
        resolveDocumentFileArchiveTransformResolution({
          transformIntent: archiveIntent(),
          hints: hints({
            preferredOutputKind: 'pdf_preferred',
            metadataHandling: 'preserve',
            colorHandling: 'preserve',
          }),
          sourceMimeType: 'image/webp',
        }),
      ];

      for (const result of results) {
        expect([
          'source_reuse',
          'metadata_rewrite_required',
          'output_conversion_required',
          'color_processing_required',
          'strategy_unresolved',
        ]).toContain(result.kind);
        expect(result).not.toHaveProperty('requiredCapabilities');
        expect(result).not.toHaveProperty('capabilitySnapshot');
        expect(result).not.toHaveProperty('fileRefId');
        expect(result).not.toHaveProperty('strategy');
        expect(result).not.toHaveProperty('executor');
      }
    });

    it('executionIntent beeinflusst das Result nicht', () => {
      const planHints = hints({
        preferredOutputKind: 'preserve_source',
        metadataHandling: 'strip_nonessential',
        colorHandling: 'preserve',
      });
      expect(
        resolveDocumentFileArchiveTransformResolution({
          transformIntent: archiveIntent('required'),
          hints: planHints,
        }),
      ).toEqual(
        resolveDocumentFileArchiveTransformResolution({
          transformIntent: archiveIntent('preferred'),
          hints: planHints,
        }),
      );
    });
  });
});
