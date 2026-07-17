import { describe, expect, it } from 'vitest';
import {
  getStoragePolicyRequirements,
  STORAGE_POLICY_REQUIREMENTS_BY_ID,
} from './services/storagePolicyRequirements';
import { resolveStoragePolicy } from './services/storagePolicyService';
import { STORAGE_POLICY_IDS } from './types/storagePolicy';
import type { StoragePolicyRequirements } from './types/storagePolicy';

function expectCompleteRequirements(req: StoragePolicyRequirements): void {
  expect(req.retainOriginal).toBeDefined();
  expect(req.archiveRepresentation).toBeDefined();
  expect(req.previewRequirement).toBeDefined();
  expect(req.thumbnailRequirement).toBeDefined();
  expect(req.metadataHandling).toBeDefined();
  expect(req.colorHandling).toBeDefined();
  expect(req.preferredOutputKind).toBeDefined();
}

describe('STORAGE-POLICY-REQUIREMENTS-01', () => {
  describe('Fall A: Catalog-Vollständigkeit', () => {
    it('jede StoragePolicyId besitzt vollständig definierte Requirements', () => {
      for (const policyId of STORAGE_POLICY_IDS) {
        const fromMap = STORAGE_POLICY_REQUIREMENTS_BY_ID[policyId];
        expect(fromMap).toBeDefined();
        expectCompleteRequirements(fromMap);

        const viaApi = getStoragePolicyRequirements(policyId);
        expect(viaApi).toEqual(fromMap);
        expectCompleteRequirements(viaApi);
      }
    });

    it('deckt genau die bestehenden Policy-IDs ab, ohne implizite Defaults', () => {
      expect(Object.keys(STORAGE_POLICY_REQUIREMENTS_BY_ID).sort()).toEqual(
        [...STORAGE_POLICY_IDS].sort(),
      );
    });
  });

  describe('Fall B: fachliche Unterschiede', () => {
    it('legal_document verlangt stärkeren Originalerhalt als receipt', () => {
      const legal = getStoragePolicyRequirements('legal_document');
      const receipt = getStoragePolicyRequirements('receipt');

      expect(legal.retainOriginal).toBe('required');
      expect(receipt.retainOriginal).not.toBe('required');
      expect(receipt.retainOriginal).toBe('preferred');
    });

    it('construction_photo bevorzugt keine PDF-Darstellung', () => {
      const photo = getStoragePolicyRequirements('construction_photo');
      expect(photo.preferredOutputKind).not.toBe('pdf_preferred');
      expect(photo.preferredOutputKind).toBe('image_preferred');
    });

    it('temporary_unknown erlaubt keine aggressive optimierte Archivdarstellung', () => {
      const temp = getStoragePolicyRequirements('temporary_unknown');
      expect(temp.archiveRepresentation).toBe('temporary_source_only');
      expect(temp.archiveRepresentation).not.toBe('optimized_allowed');
      expect(temp.archiveRepresentation).not.toBe('original_and_optimized');
    });

    it('receipt erlaubt spätere Optimierung stärker als legal_document', () => {
      const receipt = getStoragePolicyRequirements('receipt');
      const legal = getStoragePolicyRequirements('legal_document');

      expect(receipt.archiveRepresentation).toBe('optimized_allowed');
      expect(legal.archiveRepresentation).toBe('original_and_optimized');
      expect(legal.retainOriginal).toBe('required');
      expect(receipt.retainOriginal).toBe('preferred');
    });
  });

  describe('Fall C: Resolver-Regression', () => {
    it('resolveStoragePolicy liefert für repräsentative Kinds unverändert policyId und mediaProfile', () => {
      const receipt = resolveStoragePolicy({
        classifiedKind: 'kassenbeleg',
        detectionReasonKey: 'classification.detect.kassenbeleg',
        mimeType: 'image/jpeg',
        fileName: 'beleg.jpg',
        extractionMethod: 'image_ocr',
        sourceType: 'image',
        ocrConfidence: 'high',
      });
      expect(receipt.policyId).toBe('receipt');
      expect(receipt.mediaProfile).toBe('raster_image');

      const business = resolveStoragePolicy({
        classifiedKind: 'eingangsrechnung',
        detectionReasonKey: 'classification.detect.eingangsrechnung',
        mimeType: 'application/pdf',
        fileName: 'rechnung.pdf',
        extractionMethod: 'pdf_text',
        sourceType: 'pdf',
        ocrConfidence: 'high',
      });
      expect(business.policyId).toBe('business_document');
      expect(business.mediaProfile).toBe('native_pdf');

      const legal = resolveStoragePolicy({
        classifiedKind: 'werkvertrag',
        detectionReasonKey: 'classification.detect.werkvertrag',
        mimeType: 'application/pdf',
        fileName: 'vertrag.pdf',
        extractionMethod: 'pdf_text',
        sourceType: 'pdf',
        ocrConfidence: 'high',
      });
      expect(legal.policyId).toBe('legal_document');
      expect(legal.mediaProfile).toBe('native_pdf');

      const photo = resolveStoragePolicy({
        classifiedKind: 'baustellenfoto',
        detectionReasonKey: 'classification.detect.baustellenfoto',
        mimeType: 'image/jpeg',
        fileName: 'baustelle.jpg',
        extractionMethod: 'image_ocr',
        sourceType: 'image',
        ocrConfidence: 'high',
      });
      expect(photo.policyId).toBe('construction_photo');
      expect(photo.mediaProfile).toBe('raster_image');

      const temp = resolveStoragePolicy({
        classifiedKind: 'sonstiges',
        detectionReasonKey: 'classification.detect.fallback',
        mimeType: 'application/pdf',
        fileName: 'unbekannt.pdf',
        extractionMethod: 'pdf_text',
        sourceType: 'pdf',
        ocrConfidence: 'low',
      });
      expect(temp.policyId).toBe('temporary_unknown');
      expect(temp.mediaProfile).toBe('native_pdf');
    });
  });
});
