import { describe, expect, it } from 'vitest';
import { buildDocumentFileRepresentationPlan } from './services/documentFileRepresentationPlanService';
import { resolveDocumentFileTransformArchiveMaterialization } from './services/documentFileTransformArchiveMaterializationService';
import { buildDocumentFileTransformPlan } from './services/documentFileTransformPlanService';
import type { DocumentFileTransformArchiveMaterializationResult } from './types/documentFileTransformArchiveMaterialization';
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

describe('STORAGE-TRANSFORM-ARCHIVE-MATERIALIZATION-01', () => {
  describe('Fall A–B: produktive Planner-Pfade', () => {
    it('legal_document create_archive → source_reuse aus Hints', () => {
      const { plan, archive } = requireArchivePlan('legal_document');
      expect(plan.hints).toEqual({
        preferredOutputKind: 'preserve_source',
        metadataHandling: 'preserve',
        colorHandling: 'preserve',
      });

      const result = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archive,
        hints: plan.hints,
      });

      expect(result).toEqual({ kind: 'source_reuse' });
      expect(result).not.toHaveProperty('policyId');
      expect(result).not.toHaveProperty('requiredCapabilities');
      expect(JSON.stringify(result)).not.toMatch(/write_pdf|encode_raster_image|load_pdf/);
    });

    it('business_document create_archive → unresolved wegen strip_nonessential', () => {
      const { plan, archive } = requireArchivePlan('business_document');
      expect(plan.hints.preferredOutputKind).toBe('preserve_source');
      expect(plan.hints.metadataHandling).toBe('strip_nonessential');

      const result = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archive,
        hints: plan.hints,
      });

      expect(result).toEqual({ kind: 'unresolved' });
      expect(result).not.toHaveProperty('requiredCapabilities');
      expect(JSON.stringify(result)).not.toMatch(/write_pdf|encode_raster_image|source_reuse/);
    });
  });

  describe('Fall C–F: Hint-Kombinationen', () => {
    it('preserve_source + metadata preserve + color preserve → source_reuse', () => {
      const result = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'preserve_source',
          metadataHandling: 'preserve',
          colorHandling: 'preserve',
        }),
      });
      expect(result).toEqual({ kind: 'source_reuse' });
    });

    it('preserve_source + strip_nonessential → unresolved', () => {
      const result = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'preserve_source',
          metadataHandling: 'strip_nonessential',
          colorHandling: 'preserve',
        }),
      });
      expect(result).toEqual({ kind: 'unresolved' });
    });

    it('pdf_preferred → unresolved ohne write_pdf-Annahme', () => {
      const result = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'pdf_preferred',
          metadataHandling: 'preserve',
          colorHandling: 'preserve',
        }),
      });
      expect(result).toEqual({ kind: 'unresolved' });
      expect(JSON.stringify(result)).not.toMatch(/write_pdf/);
    });

    it('image_preferred → unresolved ohne Decode/Encode-Annahme', () => {
      const result = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'image_preferred',
          metadataHandling: 'preserve',
          colorHandling: 'preserve',
        }),
      });
      expect(result).toEqual({ kind: 'unresolved' });
      expect(JSON.stringify(result)).not.toMatch(/decode_raster_image|encode_raster_image/);
    });

    it('preserve_source + metadata preserve + color not_applicable → source_reuse', () => {
      const result = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'preserve_source',
          metadataHandling: 'preserve',
          colorHandling: 'not_applicable',
        }),
      });
      expect(result).toEqual({ kind: 'source_reuse' });
    });

    it('preserve_source + metadata preserve + grayscale_allowed → unresolved', () => {
      const result = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'preserve_source',
          metadataHandling: 'preserve',
          colorHandling: 'grayscale_allowed',
        }),
      });
      expect(result).toEqual({ kind: 'unresolved' });
    });

    it('preserve_source + metadata not_applicable → unresolved', () => {
      const result = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'preserve_source',
          metadataHandling: 'not_applicable',
          colorHandling: 'preserve',
        }),
      });
      expect(result).toEqual({ kind: 'unresolved' });
    });
  });

  describe('Fall G–H: executionIntent und MIME-Neutralität', () => {
    it('required und preferred ergeben dasselbe Result', () => {
      const planHints = hints({
        preferredOutputKind: 'preserve_source',
        metadataHandling: 'preserve',
        colorHandling: 'preserve',
      });
      const required = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archiveIntent('required'),
        hints: planHints,
      });
      const preferred = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archiveIntent('preferred'),
        hints: planHints,
      });
      expect(required).toEqual(preferred);
      expect(required).not.toHaveProperty('executionIntent');
    });

    it('API nimmt keinen sourceMimeType / mediaProfile / policyId', () => {
      const result = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'preserve_source',
          metadataHandling: 'preserve',
          colorHandling: 'preserve',
        }),
      });
      expect(result.kind).toBe('source_reuse');
      expect(resolveDocumentFileTransformArchiveMaterialization).toHaveLength(1);
    });
  });

  describe('Fall I–L: ungültige Inputs', () => {
    const validHints = hints({
      preferredOutputKind: 'preserve_source',
      metadataHandling: 'preserve',
      colorHandling: 'preserve',
    });

    it('create_preview und create_thumbnail → TypeError, nicht unresolved', () => {
      for (const intent of ['create_preview', 'create_thumbnail'] as const) {
        const transformIntent = {
          targetKind: intent === 'create_preview' ? 'preview' : 'thumbnail',
          intent,
          executionIntent: 'preferred',
        } as DocumentFileTransformIntent;

        expect(() =>
          resolveDocumentFileTransformArchiveMaterialization({
            transformIntent,
            hints: validHints,
          }),
        ).toThrow(TypeError);
      }
    });

    it('unbekannter Intent → TypeError', () => {
      for (const intent of ['materialize_archive', 'reuse_source', 'create_export'] as const) {
        const transformIntent = {
          targetKind: 'archive',
          intent,
          executionIntent: 'preferred',
        } as unknown as DocumentFileTransformIntent;

        expect(() =>
          resolveDocumentFileTransformArchiveMaterialization({
            transformIntent,
            hints: validHints,
          }),
        ).toThrow(TypeError);
      }
    });

    it('unbekannte Hint-Werte → TypeError, nicht unresolved', () => {
      expect(() =>
        resolveDocumentFileTransformArchiveMaterialization({
          transformIntent: archiveIntent(),
          hints: {
            ...validHints,
            preferredOutputKind: 'copy_source',
          } as unknown as DocumentFileTransformHints,
        }),
      ).toThrow(TypeError);

      expect(() =>
        resolveDocumentFileTransformArchiveMaterialization({
          transformIntent: archiveIntent(),
          hints: {
            ...validHints,
            metadataHandling: 'remove_all',
          } as unknown as DocumentFileTransformHints,
        }),
      ).toThrow(TypeError);

      expect(() =>
        resolveDocumentFileTransformArchiveMaterialization({
          transformIntent: archiveIntent(),
          hints: {
            ...validHints,
            colorHandling: 'grayscale_required',
          } as unknown as DocumentFileTransformHints,
        }),
      ).toThrow(TypeError);
    });

    it('unvollständige Inputs → TypeError', () => {
      expect(() =>
        resolveDocumentFileTransformArchiveMaterialization(
          { hints: validHints } as unknown as {
            transformIntent: DocumentFileTransformIntent;
            hints: DocumentFileTransformHints;
          },
        ),
      ).toThrow(TypeError);

      expect(() =>
        resolveDocumentFileTransformArchiveMaterialization(
          { transformIntent: archiveIntent() } as unknown as {
            transformIntent: DocumentFileTransformIntent;
            hints: DocumentFileTransformHints;
          },
        ),
      ).toThrow(TypeError);

      expect(() =>
        resolveDocumentFileTransformArchiveMaterialization({
          transformIntent: archiveIntent(),
          hints: {
            metadataHandling: 'preserve',
            colorHandling: 'preserve',
          } as unknown as DocumentFileTransformHints,
        }),
      ).toThrow(TypeError);

      expect(() =>
        resolveDocumentFileTransformArchiveMaterialization({
          transformIntent: archiveIntent(),
          hints: {
            preferredOutputKind: 'preserve_source',
            colorHandling: 'preserve',
          } as unknown as DocumentFileTransformHints,
        }),
      ).toThrow(TypeError);

      expect(() =>
        resolveDocumentFileTransformArchiveMaterialization({
          transformIntent: archiveIntent(),
          hints: {
            preferredOutputKind: 'preserve_source',
            metadataHandling: 'preserve',
          } as unknown as DocumentFileTransformHints,
        }),
      ).toThrow(TypeError);

      expect(() =>
        resolveDocumentFileTransformArchiveMaterialization(null as unknown as {
          transformIntent: DocumentFileTransformIntent;
          hints: DocumentFileTransformHints;
        }),
      ).toThrow(TypeError);
    });
  });

  describe('Fall M–O: Mutation, Immutability, Determinismus', () => {
    it('Eingaben bleiben unverändert; eingefrorene Inputs werden unterstützt', () => {
      const transformIntent = Object.freeze(archiveIntent());
      const planHints = Object.freeze(
        hints({
          preferredOutputKind: 'preserve_source',
          metadataHandling: 'preserve',
          colorHandling: 'preserve',
        }),
      );
      const intentBefore = structuredClone(transformIntent);
      const hintsBefore = structuredClone(planHints);

      const result = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent,
        hints: planHints,
      });

      expect(result).toEqual({ kind: 'source_reuse' });
      expect(transformIntent).toEqual(intentBefore);
      expect(planHints).toEqual(hintsBefore);
    });

    it('source_reuse- und unresolved-Results sind eingefroren', () => {
      const reuse = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'preserve_source',
          metadataHandling: 'preserve',
          colorHandling: 'preserve',
        }),
      });
      const unresolved = resolveDocumentFileTransformArchiveMaterialization({
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'preserve_source',
          metadataHandling: 'strip_nonessential',
          colorHandling: 'preserve',
        }),
      });

      expect(Object.isFrozen(reuse)).toBe(true);
      expect(Object.isFrozen(unresolved)).toBe(true);
    });

    it('mehrfache Aufrufe sind deterministisch und ohne IDs/Zeit', () => {
      const input = {
        transformIntent: archiveIntent(),
        hints: hints({
          preferredOutputKind: 'preserve_source',
          metadataHandling: 'preserve',
          colorHandling: 'preserve',
        }),
      };
      const a = resolveDocumentFileTransformArchiveMaterialization(input);
      const b = resolveDocumentFileTransformArchiveMaterialization(input);
      expect(a).toEqual(b);
      expect(JSON.stringify(a)).not.toMatch(/Date|Math\.random|navigator|fileRef|contentHash/);
    });
  });

  describe('Fall P: keine benachbarten Schichten im Result', () => {
    it('Result trägt keine Capability-/Snapshot-/Binding-Felder', () => {
      const results: DocumentFileTransformArchiveMaterializationResult[] = [
        resolveDocumentFileTransformArchiveMaterialization({
          transformIntent: archiveIntent(),
          hints: hints({
            preferredOutputKind: 'preserve_source',
            metadataHandling: 'preserve',
            colorHandling: 'preserve',
          }),
        }),
        resolveDocumentFileTransformArchiveMaterialization({
          transformIntent: archiveIntent(),
          hints: hints({
            preferredOutputKind: 'pdf_preferred',
            metadataHandling: 'preserve',
            colorHandling: 'preserve',
          }),
        }),
      ];

      for (const result of results) {
        expect(['source_reuse', 'unresolved']).toContain(result.kind);
        expect(result).not.toHaveProperty('status');
        expect(result).not.toHaveProperty('requiredCapabilities');
        expect(result).not.toHaveProperty('capabilitySnapshot');
        expect(result).not.toHaveProperty('fileRefId');
        expect(result).not.toHaveProperty('representationId');
      }
    });
  });
});
