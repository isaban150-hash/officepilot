import { describe, expect, it } from 'vitest';
import { resolveDocumentFileArchiveTransformResolution } from './services/documentFileArchiveTransformResolutionService';
import { planDocumentFilePdfMetadataStrip } from './services/documentFilePdfMetadataStripPlanService';
import { buildDocumentFileRepresentationPlan } from './services/documentFileRepresentationPlanService';
import { buildDocumentFileTransformPlan } from './services/documentFileTransformPlanService';
import type { DocumentFileArchiveTransformResolutionResult } from './types/documentFileArchiveTransformResolution';
import { PDF_INFO_METADATA_STRIP_KEYS } from './types/documentFilePdfMetadataStrip';
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

describe('STORAGE-PDF-METADATA-STRIP-PLAN-01', () => {
  describe('Fall A: PDF + metadata_rewrite_required → Strip-Plan', () => {
    it('business_document PDF liefert pdf_info_metadata_strip', () => {
      const { plan, archive } = requireArchivePlan('business_document');
      expect(plan.hints.metadataHandling).toBe('strip_nonessential');

      const resolution = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archive,
        hints: plan.hints,
        sourceMimeType: 'application/pdf',
      });
      expect(resolution).toEqual({ kind: 'metadata_rewrite_required' });

      const stripPlan = planDocumentFilePdfMetadataStrip({
        transformIntent: archive,
        resolution,
        sourceMimeType: 'application/pdf',
      });

      expect(stripPlan).toEqual({
        kind: 'pdf_info_metadata_strip',
        strategy: 'pdf_info_metadata_strip',
        sourceMimeType: 'application/pdf',
        targetMimeType: 'application/pdf',
        clearedInfoKeys: PDF_INFO_METADATA_STRIP_KEYS,
        xmpFullyRemoved: false,
        stripInputSafetyVerified: false,
      });
      expect(stripPlan).not.toHaveProperty('bytes');
      expect(stripPlan).not.toHaveProperty('fileRefId');
      expect(JSON.stringify(stripPlan)).not.toMatch(
        /stripDocumentFilePdfInfoMetadata|contentHash|executor|FileRef/,
      );
    });

    it('kennzeichnet XMP und Input-Safety als nicht verifiziert', () => {
      const stripPlan = planDocumentFilePdfMetadataStrip({
        transformIntent: archiveIntent(),
        resolution: { kind: 'metadata_rewrite_required' },
        sourceMimeType: 'application/pdf',
      });

      expect(stripPlan.kind).toBe('pdf_info_metadata_strip');
      if (stripPlan.kind === 'pdf_info_metadata_strip') {
        expect(stripPlan.xmpFullyRemoved).toBe(false);
        expect(stripPlan.stripInputSafetyVerified).toBe(false);
      }
    });
  });

  describe('Fall B: andere MIME-Typen und Resolution-Ergebnisse → unresolved', () => {
    it('Raster und unbekannte MIME → unresolved', () => {
      const resolution: DocumentFileArchiveTransformResolutionResult = {
        kind: 'metadata_rewrite_required',
      };

      for (const sourceMimeType of [
        'image/jpeg',
        'image/png',
        'image/webp',
        'text/plain',
        'application/octet-stream',
      ] as const) {
        expect(
          planDocumentFilePdfMetadataStrip({
            transformIntent: archiveIntent(),
            resolution,
            sourceMimeType,
          }),
        ).toEqual({ kind: 'unresolved' });
      }
    });

    it('source_reuse, output_conversion_required und strategy_unresolved → unresolved', () => {
      for (const kind of [
        'source_reuse',
        'output_conversion_required',
        'strategy_unresolved',
        'color_processing_required',
      ] as const) {
        expect(
          planDocumentFilePdfMetadataStrip({
            transformIntent: archiveIntent(),
            resolution: { kind },
            sourceMimeType: 'application/pdf',
          }),
        ).toEqual({ kind: 'unresolved' });
      }
    });

    it('MIME-Normalisierung akzeptiert application/pdf case-insensitiv', () => {
      expect(
        planDocumentFilePdfMetadataStrip({
          transformIntent: archiveIntent(),
          resolution: { kind: 'metadata_rewrite_required' },
          sourceMimeType: '  Application/PDF  ',
        }).kind,
      ).toBe('pdf_info_metadata_strip');
    });
  });

  describe('Fall C: Legal / source_reuse bleibt unverändert', () => {
    it('legal_document bleibt source_reuse und erhält keinen Strip-Plan', () => {
      const { plan, archive } = requireArchivePlan('legal_document');
      const resolution = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archive,
        hints: plan.hints,
        sourceMimeType: 'application/pdf',
      });
      expect(resolution).toEqual({ kind: 'source_reuse' });

      expect(
        planDocumentFilePdfMetadataStrip({
          transformIntent: archive,
          resolution,
          sourceMimeType: 'application/pdf',
        }),
      ).toEqual({ kind: 'unresolved' });
    });

    it('explizites source_reuse bleibt ohne Strip-Plan', () => {
      const hints: DocumentFileTransformHints = {
        preferredOutputKind: 'preserve_source',
        metadataHandling: 'preserve',
        colorHandling: 'not_applicable',
      };
      const resolution = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archiveIntent(),
        hints,
        sourceMimeType: 'application/pdf',
      });
      expect(resolution).toEqual({ kind: 'source_reuse' });

      expect(
        planDocumentFilePdfMetadataStrip({
          transformIntent: archiveIntent(),
          resolution,
          sourceMimeType: 'application/pdf',
        }),
      ).toEqual({ kind: 'unresolved' });
    });
  });

  describe('Fall D: Guardrails', () => {
    it('lehnt Nicht-create_archive Intents ab', () => {
      expect(() =>
        planDocumentFilePdfMetadataStrip({
          transformIntent: {
            targetKind: 'preview',
            intent: 'create_preview',
            executionIntent: 'preferred',
          } as unknown as DocumentFileTransformIntent,
          resolution: { kind: 'metadata_rewrite_required' },
          sourceMimeType: 'application/pdf',
        }),
      ).toThrow(TypeError);
    });
  });
});
