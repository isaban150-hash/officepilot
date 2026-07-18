import { describe, expect, it } from 'vitest';
import { buildDocumentFileRepresentationPlan } from './services/documentFileRepresentationPlanService';
import { planDocumentFileRepresentationSourceReuseBinding } from './services/documentFileRepresentationSourceReuseBindingPlanService';
import { resolveDocumentFileTransformArchiveMaterialization } from './services/documentFileTransformArchiveMaterializationService';
import { deriveDocumentFileTransformCapabilityRequirements } from './services/documentFileTransformCapabilityRequirementsService';
import { buildDocumentFileTransformPlan } from './services/documentFileTransformPlanService';
import type { DocumentFileTransformArchiveMaterializationResult } from './types/documentFileTransformArchiveMaterialization';
import type { DocumentFileRepresentationSourceReuseBindingPlan } from './types/documentFileRepresentationSourceReuseBindingPlan';
import type { StoragePolicyId } from './types/storagePolicy';

const SAMPLE_FILE_REF_ID = 'file-ref-source-reuse-binding-01';

function requireArchiveMaterialization(policyId: StoragePolicyId) {
  const representationPlan = buildDocumentFileRepresentationPlan({
    policyId,
    decision: 'save_permanently',
  });
  expect(representationPlan).not.toBeNull();
  const transformPlan = buildDocumentFileTransformPlan({
    representationPlan: representationPlan!,
    mediaProfile: 'native_pdf',
  });
  expect(transformPlan).not.toBeNull();
  const archive = transformPlan!.intents.find((entry) => entry.intent === 'create_archive');
  expect(archive).toBeDefined();
  return resolveDocumentFileTransformArchiveMaterialization({
    transformIntent: archive!,
    hints: transformPlan!.hints,
  });
}

describe('STORAGE-REPRESENTATION-SOURCE-REUSE-BINDING-PLAN-01', () => {
  describe('Fall A–B: Source-Reuse-Plan', () => {
    it('erzeugt exakten reuse_source_file-Plan für archive', () => {
      const result = planDocumentFileRepresentationSourceReuseBinding({
        materialization: { kind: 'source_reuse' },
        sourceFileRefId: SAMPLE_FILE_REF_ID,
      });

      expect(result).toEqual({
        mode: 'reuse_source_file',
        targetKind: 'archive',
        sourceFileRefId: SAMPLE_FILE_REF_ID,
      });
      expect(Object.keys(result).sort()).toEqual(['mode', 'sourceFileRefId', 'targetKind']);
      expect(result).not.toHaveProperty('id');
      expect(result).not.toHaveProperty('createdAt');
      expect(result).not.toHaveProperty('representationId');
    });

    it('Legal-Produktpfad: Materialization source_reuse → Binding-Plan', () => {
      const materialization = requireArchiveMaterialization('legal_document');
      expect(materialization).toEqual({ kind: 'source_reuse' });

      const plan = planDocumentFileRepresentationSourceReuseBinding({
        materialization,
        sourceFileRefId: SAMPLE_FILE_REF_ID,
      });

      expect(plan).toEqual({
        mode: 'reuse_source_file',
        targetKind: 'archive',
        sourceFileRefId: SAMPLE_FILE_REF_ID,
      });
      expect(JSON.stringify(plan)).not.toMatch(/legal_document|preserve_source|metadataHandling/);
    });
  });

  describe('Fall C: Business bleibt nicht bindbar', () => {
    it('unresolved Materialization → TypeError', () => {
      const materialization = requireArchiveMaterialization('business_document');
      expect(materialization).toEqual({ kind: 'unresolved' });

      expect(() =>
        planDocumentFileRepresentationSourceReuseBinding({
          materialization,
          sourceFileRefId: SAMPLE_FILE_REF_ID,
        }),
      ).toThrow(TypeError);
    });
  });

  describe('Fall D–E: API und Source-ID', () => {
    it('API hat keinen targetKind-Eingabeparameter; Result ist immer archive', () => {
      expect(planDocumentFileRepresentationSourceReuseBinding).toHaveLength(1);
      const plan = planDocumentFileRepresentationSourceReuseBinding({
        materialization: { kind: 'source_reuse' },
        sourceFileRefId: SAMPLE_FILE_REF_ID,
      });
      expect(plan.targetKind).toBe('archive');
    });

    it('sourceFileRefId bleibt unverändert ohne Präfix/Suffix', () => {
      const sourceFileRefId = 'file-ref_with-mixed.CHARS-01';
      const plan = planDocumentFileRepresentationSourceReuseBinding({
        materialization: { kind: 'source_reuse' },
        sourceFileRefId,
      });
      expect(plan.sourceFileRefId).toBe(sourceFileRefId);
      expect(plan.sourceFileRefId).not.toBe(`${sourceFileRefId}:archive`);
      expect(plan.sourceFileRefId.includes(':archive')).toBe(false);
    });
  });

  describe('Fall F–I: ungültige Inputs', () => {
    it('ungültige sourceFileRefId → TypeError', () => {
      const invalidIds: unknown[] = ['', '   ', null, undefined, 42];
      for (const sourceFileRefId of invalidIds) {
        expect(() =>
          planDocumentFileRepresentationSourceReuseBinding({
            materialization: { kind: 'source_reuse' },
            sourceFileRefId: sourceFileRefId as string,
          }),
        ).toThrow(TypeError);
      }
    });

    it('unresolved direkt → TypeError', () => {
      expect(() =>
        planDocumentFileRepresentationSourceReuseBinding({
          materialization: { kind: 'unresolved' },
          sourceFileRefId: SAMPLE_FILE_REF_ID,
        }),
      ).toThrow(TypeError);
    });

    it('unbekannter Materialization-Kind → TypeError', () => {
      for (const kind of ['transform', 'physical_copy', 'reuse_existing', 'pending'] as const) {
        expect(() =>
          planDocumentFileRepresentationSourceReuseBinding({
            materialization: { kind } as unknown as DocumentFileTransformArchiveMaterializationResult,
            sourceFileRefId: SAMPLE_FILE_REF_ID,
          }),
        ).toThrow(TypeError);
      }
    });

    it('unvollständige Inputs → TypeError', () => {
      expect(() =>
        planDocumentFileRepresentationSourceReuseBinding(
          null as unknown as {
            materialization: DocumentFileTransformArchiveMaterializationResult;
            sourceFileRefId: string;
          },
        ),
      ).toThrow(TypeError);

      expect(() =>
        planDocumentFileRepresentationSourceReuseBinding({
          sourceFileRefId: SAMPLE_FILE_REF_ID,
        } as unknown as {
          materialization: DocumentFileTransformArchiveMaterializationResult;
          sourceFileRefId: string;
        }),
      ).toThrow(TypeError);

      expect(() =>
        planDocumentFileRepresentationSourceReuseBinding({
          materialization: { kind: 'source_reuse' },
        } as unknown as {
          materialization: DocumentFileTransformArchiveMaterializationResult;
          sourceFileRefId: string;
        }),
      ).toThrow(TypeError);

      expect(() =>
        planDocumentFileRepresentationSourceReuseBinding({
          materialization: {} as DocumentFileTransformArchiveMaterializationResult,
          sourceFileRefId: SAMPLE_FILE_REF_ID,
        }),
      ).toThrow(TypeError);
    });
  });

  describe('Fall J–L: Mutation, Immutability, Determinismus', () => {
    it('Eingaben bleiben unverändert; eingefrorene Materialization wird unterstützt', () => {
      const materialization = Object.freeze({ kind: 'source_reuse' as const });
      const sourceFileRefId = SAMPLE_FILE_REF_ID;
      const before = structuredClone(materialization);

      const plan = planDocumentFileRepresentationSourceReuseBinding({
        materialization,
        sourceFileRefId,
      });

      expect(plan.sourceFileRefId).toBe(SAMPLE_FILE_REF_ID);
      expect(materialization).toEqual(before);
      expect(sourceFileRefId).toBe(SAMPLE_FILE_REF_ID);
    });

    it('Result ist eingefroren', () => {
      const plan = planDocumentFileRepresentationSourceReuseBinding({
        materialization: { kind: 'source_reuse' },
        sourceFileRefId: SAMPLE_FILE_REF_ID,
      });
      expect(Object.isFrozen(plan)).toBe(true);

      const mutable = plan as unknown as { mode: string };
      const modeBefore = mutable.mode;
      try {
        mutable.mode = 'physical_copy';
      } catch {
        // engines may throw
      }
      expect(plan.mode).toBe(modeBefore);
      expect(plan.mode).toBe('reuse_source_file');
    });

    it('mehrfache Aufrufe sind strukturell deterministisch', () => {
      const input = {
        materialization: { kind: 'source_reuse' as const },
        sourceFileRefId: SAMPLE_FILE_REF_ID,
      };
      const a = planDocumentFileRepresentationSourceReuseBinding(input);
      const b = planDocumentFileRepresentationSourceReuseBinding(input);
      expect(a).toEqual(b);
      expect(JSON.stringify(a)).not.toMatch(/Date|Math\.random|navigator|uuid/);
    });
  });

  describe('Fall M–O: keine Metadaten / benachbarte Schichten / Capability', () => {
    it('Result enthält keine Datei-Metadaten', () => {
      const plan: DocumentFileRepresentationSourceReuseBindingPlan =
        planDocumentFileRepresentationSourceReuseBinding({
          materialization: { kind: 'source_reuse' },
          sourceFileRefId: SAMPLE_FILE_REF_ID,
        });

      expect(plan).not.toHaveProperty('contentHash');
      expect(plan).not.toHaveProperty('mimeType');
      expect(plan).not.toHaveProperty('fileSize');
      expect(plan).not.toHaveProperty('localDataKey');
      expect(plan).not.toHaveProperty('storageType');
      expect(plan).not.toHaveProperty('lifecycleStatus');
      expect(plan).not.toHaveProperty('documentId');
    });

    it('Result trägt keine Persistenz-/Capability-Felder', () => {
      const plan = planDocumentFileRepresentationSourceReuseBinding({
        materialization: { kind: 'source_reuse' },
        sourceFileRefId: SAMPLE_FILE_REF_ID,
      });
      expect(plan).not.toHaveProperty('requiredCapabilities');
      expect(plan).not.toHaveProperty('capabilitySnapshot');
      expect(plan).not.toHaveProperty('blobId');
      expect(plan).not.toHaveProperty('refcount');
    });

    it('Capability-Requirements-Mapper bleibt für create_archive unresolved', () => {
      const capability = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: {
          targetKind: 'archive',
          intent: 'create_archive',
          executionIntent: 'preferred',
        },
        sourceMimeType: 'application/pdf',
      });
      expect(capability).toEqual({ kind: 'unresolved' });
    });
  });
});
