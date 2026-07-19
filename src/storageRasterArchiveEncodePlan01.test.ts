import { describe, expect, it } from 'vitest';
import { resolveDocumentFileArchiveTransformResolution } from './services/documentFileArchiveTransformResolutionService';
import { buildDocumentFileRepresentationPlan } from './services/documentFileRepresentationPlanService';
import { planDocumentFileRasterArchiveEncode } from './services/documentFileRasterArchiveEncodePlanService';
import { buildDocumentFileTransformPlan } from './services/documentFileTransformPlanService';
import type { DocumentFileArchiveTransformResolutionResult } from './types/documentFileArchiveTransformResolution';
import type {
  DocumentFileTransformHints,
  DocumentFileTransformIntent,
} from './types/documentFileTransformPlan';
import {
  RASTER_ENCODE_JPEG_QUALITY,
  RASTER_ENCODE_MAX_EDGE_PX,
  RASTER_ENCODE_SOURCE_MIME_TYPES,
} from './types/documentFileRasterEncode';
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

describe('STORAGE-RASTER-ARCHIVE-ENCODE-PLAN-01', () => {
  describe('Fall A: Business + Raster + metadata_rewrite_required', () => {
    it('liefert raster_jpeg_reencode mit Encode-Defaults', () => {
      const { plan, archive } = requireArchivePlan('business_document');
      expect(plan.hints.metadataHandling).toBe('strip_nonessential');

      const resolution = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archive,
        hints: plan.hints,
        sourceMimeType: 'image/jpeg',
      });
      expect(resolution).toEqual({ kind: 'metadata_rewrite_required' });

      const encodePlan = planDocumentFileRasterArchiveEncode({
        transformIntent: archive,
        resolution,
        sourceMimeType: 'image/jpeg',
      });

      expect(encodePlan).toEqual({
        kind: 'raster_jpeg_reencode',
        strategy: 'raster_jpeg_reencode',
        sourceMimeType: 'image/jpeg',
        targetMimeType: 'image/jpeg',
        quality: RASTER_ENCODE_JPEG_QUALITY,
        maxEdge: RASTER_ENCODE_MAX_EDGE_PX,
      });
      expect(encodePlan).not.toHaveProperty('bytes');
      expect(encodePlan).not.toHaveProperty('fileRefId');
      expect(JSON.stringify(encodePlan)).not.toMatch(/encodeDocumentFileRasterToJpeg|contentHash/);
    });

    it('akzeptiert JPEG, PNG und WebP', () => {
      const resolution: DocumentFileArchiveTransformResolutionResult = {
        kind: 'metadata_rewrite_required',
      };

      for (const sourceMimeType of RASTER_ENCODE_SOURCE_MIME_TYPES) {
        const encodePlan = planDocumentFileRasterArchiveEncode({
          transformIntent: archiveIntent(),
          resolution,
          sourceMimeType,
        });
        expect(encodePlan.kind).toBe('raster_jpeg_reencode');
        if (encodePlan.kind === 'raster_jpeg_reencode') {
          expect(encodePlan.sourceMimeType).toBe(sourceMimeType);
          expect(encodePlan.targetMimeType).toBe('image/jpeg');
          expect(encodePlan.strategy).toBe('raster_jpeg_reencode');
        }
      }
    });
  });

  describe('Fall B: Defaults', () => {
    it('übernimmt quality und maxEdge aus den Encode-Defaults', () => {
      const encodePlan = planDocumentFileRasterArchiveEncode({
        transformIntent: archiveIntent(),
        resolution: { kind: 'metadata_rewrite_required' },
        sourceMimeType: 'image/png',
      });

      expect(encodePlan).toEqual({
        kind: 'raster_jpeg_reencode',
        strategy: 'raster_jpeg_reencode',
        sourceMimeType: 'image/png',
        targetMimeType: 'image/jpeg',
        quality: 0.85,
        maxEdge: 2048,
      });
    });
  });

  describe('Fall C: kein Encode-Plan', () => {
    it('PDF und unbekannte MIME → unresolved', () => {
      const resolution: DocumentFileArchiveTransformResolutionResult = {
        kind: 'metadata_rewrite_required',
      };

      for (const sourceMimeType of [
        'application/pdf',
        'image/heic',
        'text/plain',
        'application/octet-stream',
      ] as const) {
        expect(
          planDocumentFileRasterArchiveEncode({
            transformIntent: archiveIntent(),
            resolution,
            sourceMimeType,
          }),
        ).toEqual({ kind: 'unresolved' });
      }
    });

    it('source_reuse → kein Encode-Plan; Legal bleibt reuse', () => {
      const { plan, archive } = requireArchivePlan('legal_document');
      const resolution = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archive,
        hints: plan.hints,
      });
      expect(resolution).toEqual({ kind: 'source_reuse' });

      expect(
        planDocumentFileRasterArchiveEncode({
          transformIntent: archive,
          resolution,
          sourceMimeType: 'image/jpeg',
        }),
      ).toEqual({ kind: 'unresolved' });

      expect(
        planDocumentFileRasterArchiveEncode({
          transformIntent: archiveIntent(),
          resolution: { kind: 'source_reuse' },
          sourceMimeType: 'image/png',
        }),
      ).toEqual({ kind: 'unresolved' });
    });

    it('strategy_unresolved und output_conversion_required → kein Encode-Plan', () => {
      for (const kind of ['strategy_unresolved', 'output_conversion_required'] as const) {
        expect(
          planDocumentFileRasterArchiveEncode({
            transformIntent: archiveIntent(),
            resolution: { kind },
            sourceMimeType: 'image/jpeg',
          }),
        ).toEqual({ kind: 'unresolved' });
      }

      const hints: DocumentFileTransformHints = {
        preferredOutputKind: 'pdf_preferred',
        metadataHandling: 'preserve',
        colorHandling: 'preserve',
      };
      const conversion = resolveDocumentFileArchiveTransformResolution({
        transformIntent: archiveIntent(),
        hints,
        sourceMimeType: 'image/jpeg',
      });
      expect(conversion).toEqual({ kind: 'output_conversion_required' });
      expect(
        planDocumentFileRasterArchiveEncode({
          transformIntent: archiveIntent(),
          resolution: conversion,
          sourceMimeType: 'image/jpeg',
        }),
      ).toEqual({ kind: 'unresolved' });
    });

    it('color_processing_required → unresolved', () => {
      expect(
        planDocumentFileRasterArchiveEncode({
          transformIntent: archiveIntent(),
          resolution: { kind: 'color_processing_required' },
          sourceMimeType: 'image/webp',
        }),
      ).toEqual({ kind: 'unresolved' });
    });
  });

  describe('Fall D: ungültige Inputs', () => {
    it('create_preview/create_thumbnail und kaputte Inputs → TypeError', () => {
      expect(() =>
        planDocumentFileRasterArchiveEncode({
          transformIntent: {
            targetKind: 'preview',
            intent: 'create_preview',
            executionIntent: 'preferred',
          },
          resolution: { kind: 'metadata_rewrite_required' },
          sourceMimeType: 'image/jpeg',
        }),
      ).toThrow(TypeError);

      expect(() =>
        planDocumentFileRasterArchiveEncode({
          transformIntent: archiveIntent(),
          resolution: { kind: 'pending' } as unknown as DocumentFileArchiveTransformResolutionResult,
          sourceMimeType: 'image/jpeg',
        }),
      ).toThrow(TypeError);

      expect(() =>
        planDocumentFileRasterArchiveEncode({
          transformIntent: archiveIntent(),
          resolution: { kind: 'metadata_rewrite_required' },
          sourceMimeType: 42 as unknown as string,
        }),
      ).toThrow(TypeError);

      expect(() =>
        planDocumentFileRasterArchiveEncode(null as unknown as {
          transformIntent: DocumentFileTransformIntent;
          resolution: DocumentFileArchiveTransformResolutionResult;
          sourceMimeType: string;
        }),
      ).toThrow(TypeError);
    });
  });

  describe('Fall E: Immutability und Schichtgrenzen', () => {
    it('Result ist eingefroren; Eingaben unverändert', () => {
      const transformIntent = Object.freeze(archiveIntent());
      const resolution = Object.freeze({
        kind: 'metadata_rewrite_required',
      } as const);
      const intentBefore = structuredClone(transformIntent);
      const resolutionBefore = structuredClone(resolution);

      const encodePlan = planDocumentFileRasterArchiveEncode({
        transformIntent,
        resolution,
        sourceMimeType: 'image/webp',
      });

      expect(Object.isFrozen(encodePlan)).toBe(true);
      expect(transformIntent).toEqual(intentBefore);
      expect(resolution).toEqual(resolutionBefore);
      expect(encodePlan).not.toHaveProperty('requiredCapabilities');
      expect(encodePlan).not.toHaveProperty('executor');
      expect(planDocumentFileRasterArchiveEncode).toHaveLength(1);
    });
  });
});
