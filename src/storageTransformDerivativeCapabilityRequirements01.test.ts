import { describe, expect, it } from 'vitest';
import { buildDocumentFileRepresentationPlan } from './services/documentFileRepresentationPlanService';
import { buildDocumentFileTransformPlan } from './services/documentFileTransformPlanService';
import { deriveDocumentFileTransformCapabilityRequirements } from './services/documentFileTransformCapabilityRequirementsService';
import type { DocumentFileTransformCapabilityRequirementsResult } from './types/documentFileTransformCapabilityRequirements';
import type { DocumentFileTransformIntent } from './types/documentFileTransformPlan';
import type { StoragePolicyId } from './types/storagePolicy';

function previewIntent(
  executionIntent: DocumentFileTransformIntent['executionIntent'] = 'preferred',
): DocumentFileTransformIntent {
  return {
    targetKind: 'preview',
    intent: 'create_preview',
    executionIntent,
  };
}

function thumbnailIntent(
  executionIntent: DocumentFileTransformIntent['executionIntent'] = 'preferred',
): DocumentFileTransformIntent {
  return {
    targetKind: 'thumbnail',
    intent: 'create_thumbnail',
    executionIntent,
  };
}

function archiveIntent(
  executionIntent: DocumentFileTransformIntent['executionIntent'] = 'preferred',
): DocumentFileTransformIntent {
  return {
    targetKind: 'archive',
    intent: 'create_archive',
    executionIntent,
  };
}

function requireTransformPlan(policyId: StoragePolicyId) {
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
  return plan!;
}

describe('STORAGE-TRANSFORM-DERIVATIVE-CAPABILITY-REQUIREMENTS-01', () => {
  describe('Fall A–B: PDF Preview und Thumbnail', () => {
    it('PDF create_preview → load_pdf, render_pdf_page, encode_raster_image', () => {
      const result = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: previewIntent(),
        sourceMimeType: 'application/pdf',
      });

      expect(result).toEqual({
        kind: 'capability_requirements',
        requiredCapabilities: ['load_pdf', 'render_pdf_page', 'encode_raster_image'],
      });
      if (result.kind !== 'capability_requirements') return;
      expect(result.requiredCapabilities).not.toContain('write_pdf');
      expect(result.requiredCapabilities).not.toContain('decode_raster_image');
      expect(result.requiredCapabilities).toHaveLength(3);
    });

    it('PDF create_thumbnail → dieselbe Capability-Menge wie Preview', () => {
      const preview = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: previewIntent(),
        sourceMimeType: 'application/pdf',
      });
      const thumbnail = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: thumbnailIntent(),
        sourceMimeType: 'application/pdf',
      });

      expect(preview).toEqual(thumbnail);
      expect(thumbnail).toEqual({
        kind: 'capability_requirements',
        requiredCapabilities: ['load_pdf', 'render_pdf_page', 'encode_raster_image'],
      });
    });
  });

  describe('Fall C–E: Raster Preview/Thumbnail inkl. WebP', () => {
    it('image/jpeg create_preview → decode_raster_image, encode_raster_image', () => {
      const result = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: previewIntent(),
        sourceMimeType: 'image/jpeg',
      });

      expect(result).toEqual({
        kind: 'capability_requirements',
        requiredCapabilities: ['decode_raster_image', 'encode_raster_image'],
      });
      if (result.kind !== 'capability_requirements') return;
      expect(result.requiredCapabilities).not.toContain('load_pdf');
      expect(result.requiredCapabilities).not.toContain('render_pdf_page');
      expect(result.requiredCapabilities).not.toContain('write_pdf');
    });

    it('image/png create_thumbnail → dieselbe abstrakte Raster-Menge', () => {
      const preview = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: previewIntent(),
        sourceMimeType: 'image/jpeg',
      });
      const thumbnail = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: thumbnailIntent(),
        sourceMimeType: 'image/png',
      });

      expect(thumbnail).toEqual({
        kind: 'capability_requirements',
        requiredCapabilities: ['decode_raster_image', 'encode_raster_image'],
      });
      expect(thumbnail).toEqual(preview);
    });

    it('image/webp verwendet dieselbe abstrakte Raster-Capability-Menge', () => {
      const result = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: previewIntent(),
        sourceMimeType: 'image/webp',
      });

      expect(result).toEqual({
        kind: 'capability_requirements',
        requiredCapabilities: ['decode_raster_image', 'encode_raster_image'],
      });
    });
  });

  describe('Fall F–G: create_archive Requirements', () => {
    it('create_archive für JPEG/PNG/WebP → decode_raster_image, encode_raster_image', () => {
      for (const sourceMimeType of ['image/jpeg', 'image/png', 'image/webp'] as const) {
        const result = deriveDocumentFileTransformCapabilityRequirements({
          transformIntent: archiveIntent(),
          sourceMimeType,
        });
        expect(result).toEqual({
          kind: 'capability_requirements',
          requiredCapabilities: ['decode_raster_image', 'encode_raster_image'],
        });
      }
    });

    it('create_archive für PDF bleibt unresolved', () => {
      const result = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: archiveIntent(),
        sourceMimeType: 'application/pdf',
      });
      expect(result).toEqual({ kind: 'unresolved' });
      expect(result).not.toHaveProperty('requiredCapabilities');
    });

    it('produktive Archive-Intents: PDF unresolved, Raster mit decode/encode', () => {
      for (const policyId of ['business_document', 'legal_document'] as const) {
        const plan = requireTransformPlan(policyId);
        const archive = plan.intents.find((entry) => entry.intent === 'create_archive');
        expect(archive).toBeDefined();

        expect(
          deriveDocumentFileTransformCapabilityRequirements({
            transformIntent: archive!,
            sourceMimeType: 'application/pdf',
          }),
        ).toEqual({ kind: 'unresolved' });

        expect(
          deriveDocumentFileTransformCapabilityRequirements({
            transformIntent: archive!,
            sourceMimeType: 'image/jpeg',
          }),
        ).toEqual({
          kind: 'capability_requirements',
          requiredCapabilities: ['decode_raster_image', 'encode_raster_image'],
        });
      }
    });
  });

  describe('Fall H: Receipt und Construction Photo erzeugen keinen Archive-Intent', () => {
    it('receipt und construction_photo: kein create_archive im produktiven Plan', () => {
      for (const policyId of ['receipt', 'construction_photo'] as const) {
        const plan = requireTransformPlan(policyId);
        expect(plan.intents.some((entry) => entry.intent === 'create_archive')).toBe(false);
        expect(plan.intents.map((entry) => entry.intent).sort()).toEqual([
          'create_preview',
          'create_thumbnail',
        ]);
      }
    });
  });

  describe('Fall I: required vs preferred', () => {
    it('executionIntent beeinflusst PDF-Preview-Capabilities nicht', () => {
      const required = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: previewIntent('required'),
        sourceMimeType: 'application/pdf',
      });
      const preferred = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: previewIntent('preferred'),
        sourceMimeType: 'application/pdf',
      });
      expect(required).toEqual(preferred);
      expect(required).not.toHaveProperty('executionIntent');
    });
  });

  describe('Fall J: API ohne Hints/Policy/mediaProfile', () => {
    it('Mapper-Signatur benötigt nur transformIntent und sourceMimeType', () => {
      const result = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: thumbnailIntent(),
        sourceMimeType: 'image/jpeg',
      });
      expect(result.kind).toBe('capability_requirements');
      expect(deriveDocumentFileTransformCapabilityRequirements).toHaveLength(1);
    });
  });

  describe('Fall K–L: ungültige Eingaben', () => {
    it('ungültige Source-MIME-Typen → TypeError, nicht unresolved', () => {
      for (const sourceMimeType of ['application/octet-stream'] as const) {
        expect(() =>
          deriveDocumentFileTransformCapabilityRequirements({
            transformIntent: previewIntent(),
            sourceMimeType,
          }),
        ).toThrow(TypeError);

        try {
          deriveDocumentFileTransformCapabilityRequirements({
            transformIntent: previewIntent(),
            sourceMimeType,
          });
          expect.unreachable('expected TypeError');
        } catch (error) {
          expect(error).toBeInstanceOf(TypeError);
          expect(JSON.stringify(error)).not.toMatch(/unresolved|unsupported|unknown|invalid_type/);
        }
      }
    });

    it('unbekannter Intent → TypeError, nicht unresolved', () => {
      for (const intent of ['create_export', 'preserve_original', 'create_pdf'] as const) {
        const transformIntent = {
          targetKind: 'preview',
          intent,
          executionIntent: 'preferred',
        } as unknown as DocumentFileTransformIntent;

        expect(() =>
          deriveDocumentFileTransformCapabilityRequirements({
            transformIntent,
            sourceMimeType: 'application/pdf',
          }),
        ).toThrow(TypeError);
      }
    });
  });

  describe('Fall M–N: keine Mutation / Runtime-Immutability', () => {
    it('Eingabe bleibt unverändert; Result und Capability-Set sind eingefroren', () => {
      const transformIntent = previewIntent();
      const before = structuredClone(transformIntent);

      const result = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent,
        sourceMimeType: 'application/pdf',
      });

      expect(transformIntent).toEqual(before);
      expect(Object.isFrozen(result)).toBe(true);

      if (result.kind !== 'capability_requirements') {
        expect.unreachable('expected capability_requirements');
        return;
      }
      expect(Object.isFrozen(result.requiredCapabilities)).toBe(true);

      const mutableCaps = result.requiredCapabilities as unknown as string[];
      const lengthBefore = mutableCaps.length;
      try {
        mutableCaps.push('write_pdf');
      } catch {
        // engines may throw on frozen arrays
      }
      expect(result.requiredCapabilities).toHaveLength(lengthBefore);
      expect(result.requiredCapabilities).not.toContain('write_pdf');
    });

    it('unresolved-Result ist eingefroren', () => {
      const result = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: archiveIntent(),
        sourceMimeType: 'application/pdf',
      });
      expect(result).toEqual({ kind: 'unresolved' });
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  describe('Fall O–P: Determinismus und keine Snapshot-Auswertung', () => {
    it('mehrfache Aufrufe liefern strukturell dasselbe Resultat', () => {
      const a = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: previewIntent(),
        sourceMimeType: 'image/png',
      });
      const b = deriveDocumentFileTransformCapabilityRequirements({
        transformIntent: previewIntent(),
        sourceMimeType: 'image/png',
      });
      expect(a).toEqual(b);
      expect(JSON.stringify(a)).not.toMatch(/supported|unsupported|unknown|Date|Math\.random|navigator/);
    });

    it('Result trägt keinen Capability-Status und keine Snapshot-Felder', () => {
      const results: DocumentFileTransformCapabilityRequirementsResult[] = [
        deriveDocumentFileTransformCapabilityRequirements({
          transformIntent: previewIntent(),
          sourceMimeType: 'application/pdf',
        }),
        deriveDocumentFileTransformCapabilityRequirements({
          transformIntent: archiveIntent(),
          sourceMimeType: 'application/pdf',
        }),
      ];

      for (const result of results) {
        expect(result).not.toHaveProperty('status');
        expect(result).not.toHaveProperty('capabilitySnapshot');
        expect(result).not.toHaveProperty('unsupportedCapabilities');
        expect(result).not.toHaveProperty('unknownCapabilities');
        expect(['capability_requirements', 'unresolved']).toContain(result.kind);
      }
    });
  });
});
