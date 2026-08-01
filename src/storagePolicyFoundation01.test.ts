import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { afterEach, describe, expect, it } from 'vitest';
import { CLASSIFIED_DOCUMENT_KINDS } from './services/documentClassificationCatalog';
import {
  assertStoragePolicyCatalogComplete,
  getStoragePolicyForKind,
  STORAGE_POLICY_BY_KIND } from './services/storagePolicyCatalog';
import {
  resolveStorageMediaProfile,
  resolveStoragePolicy } from './services/storagePolicyService';
import {
  confirmPendingDocumentIntake,
  processDocumentFileForPreview } from './services/pendingDocumentIntakeService';
import {
  getDocumentFileRefStoreSnapshot,
  resetDocumentFileStoreForTests } from './services/documentFileStoreService';
import { setPdfTextExtractorForTests } from './services/uploadTextExtractionService';
import { setImageOcrExtractorForTests } from './services/ocrDocumentService';
import type { ClassifiedDocumentKind } from './types/models';
import type { StoragePolicyId } from './types/storagePolicy';

const RECEIPT_KINDS: ClassifiedDocumentKind[] = [
  'tankbeleg',
  'kassenbeleg',
  'quittung',
  'ec_beleg',
  'kreditkartenbeleg',
];

const BUSINESS_KINDS: ClassifiedDocumentKind[] = [
  'eingangsrechnung',
  'rechnung',
  'ausgangsrechnung',
  'gutschrift',
  'mahnung',
  'zahlungserinnerung',
  'kontoauszug',
  'angebot',
  'auftrag',
  'auftragsbestaetigung',
  'leistungsverzeichnis',
  'nachtrag',
  'lieferschein',
];

const LEGAL_CONTRACT_KINDS: ClassifiedDocumentKind[] = [
  'werkvertrag',
  'subunternehmervertrag',
  'nachunternehmervertrag',
];

useDocumentBlobDatabaseReset();

describe('STORAGE-POLICY-FOUNDATION-01', () => {
  it('catalog covers every ClassifiedDocumentKind', () => {
    expect(() => assertStoragePolicyCatalogComplete()).not.toThrow();
    expect(Object.keys(STORAGE_POLICY_BY_KIND)).toHaveLength(CLASSIFIED_DOCUMENT_KINDS.length);
    for (const kind of CLASSIFIED_DOCUMENT_KINDS) {
      expect(STORAGE_POLICY_BY_KIND[kind]).toBeDefined();
    }
  });

  it('maps each kind deterministically via getStoragePolicyForKind', () => {
    for (const kind of CLASSIFIED_DOCUMENT_KINDS) {
      const first = getStoragePolicyForKind(kind);
      const second = getStoragePolicyForKind(kind);
      expect(first).toBe(second);
    }
  });

  describe('fachliche Policy-Zuordnung (Catalog)', () => {
    it.each(RECEIPT_KINDS)('%s → receipt', (kind) => {
      expect(getStoragePolicyForKind(kind)).toBe('receipt');
    });

    it.each(BUSINESS_KINDS)('%s → business_document', (kind) => {
      expect(getStoragePolicyForKind(kind)).toBe('business_document');
    });

    it.each(LEGAL_CONTRACT_KINDS)('%s → legal_document', (kind) => {
      expect(getStoragePolicyForKind(kind)).toBe('legal_document');
    });

    it('Steuerbescheid → legal_document', () => {
      expect(getStoragePolicyForKind('steuerbescheid')).toBe('legal_document');
    });

    it('baustellenfoto → construction_photo', () => {
      expect(getStoragePolicyForKind('baustellenfoto')).toBe('construction_photo');
    });

    it('sonstiges → temporary_unknown', () => {
      expect(getStoragePolicyForKind('sonstiges')).toBe('temporary_unknown');
    });
  });

  describe('resolveStorageMediaProfile', () => {
    it('native PDF bei pdf_direct', () => {
      expect(
        resolveStorageMediaProfile({
          mimeType: 'application/pdf',
          fileName: 'rechnung.pdf',
          extractionMethod: 'pdf_direct',
          sourceType: 'pdf' }),
      ).toBe('native_pdf');
    });

    it('scanned PDF bei pdf_ocr', () => {
      expect(
        resolveStorageMediaProfile({
          mimeType: 'application/pdf',
          fileName: 'scan.pdf',
          extractionMethod: 'pdf_ocr',
          sourceType: 'pdf' }),
      ).toBe('scanned_pdf');
    });

    it('Rasterbild bei JPEG-OCR', () => {
      expect(
        resolveStorageMediaProfile({
          mimeType: 'image/jpeg',
          fileName: 'beleg.jpg',
          extractionMethod: 'image_ocr',
          sourceType: 'image' }),
      ).toBe('raster_image');
    });
  });

  describe('resolveStoragePolicy', () => {
    it('Rechnung bleibt business_document unabhängig vom Medienprofil', () => {
      const native = resolveStoragePolicy({
        classifiedKind: 'rechnung',
        detectionReasonKey: 'classification.detect.rechnung',
        mimeType: 'application/pdf',
        fileName: 'rechnung.pdf',
        extractionMethod: 'pdf_direct',
        sourceType: 'pdf',
        ocrConfidence: 'high' });
      const scanned = resolveStoragePolicy({
        classifiedKind: 'rechnung',
        detectionReasonKey: 'classification.detect.rechnung',
        mimeType: 'application/pdf',
        fileName: 'scan.pdf',
        extractionMethod: 'pdf_ocr',
        sourceType: 'pdf',
        ocrConfidence: 'medium' });

      expect(native.policyId).toBe('business_document');
      expect(native.mediaProfile).toBe('native_pdf');
      expect(scanned.policyId).toBe('business_document');
      expect(scanned.mediaProfile).toBe('scanned_pdf');
      expect(native.policyOverrideApplied).toBe(false);
    });

    it('Fallback-Klassifikation → temporary_unknown', () => {
      const resolved = resolveStoragePolicy({
        classifiedKind: 'rechnung',
        detectionReasonKey: 'classification.detect.fallback',
        mimeType: 'application/pdf',
        fileName: 'unklar.pdf',
        extractionMethod: 'pdf_direct',
        sourceType: 'pdf',
        ocrConfidence: 'high' });

      expect(resolved.catalogPolicyId).toBe('business_document');
      expect(resolved.policyId).toBe('temporary_unknown');
      expect(resolved.policyOverrideApplied).toBe(true);
    });

    it('foto mit Baustellenkontext → construction_photo', () => {
      const resolved = resolveStoragePolicy({
        classifiedKind: 'foto',
        detectionReasonKey: 'classification.detect.foto',
        mimeType: 'image/jpeg',
        fileName: 'img.jpg',
        extractionMethod: 'image_ocr',
        sourceType: 'image',
        ocrConfidence: 'high',
        recognizedText: 'Baustelle Rohbau Fortschritt' });

      expect(resolved.catalogPolicyId).toBe('temporary_unknown');
      expect(resolved.policyId).toBe('construction_photo');
      expect(resolved.mediaProfile).toBe('raster_image');
      expect(resolved.policyOverrideApplied).toBe(true);
    });

    it('foto ohne sichere Erkennung → temporary_unknown', () => {
      const resolved = resolveStoragePolicy({
        classifiedKind: 'foto',
        detectionReasonKey: 'classification.detect.foto',
        mimeType: 'image/jpeg',
        fileName: 'bild.jpg',
        extractionMethod: 'image_ocr',
        sourceType: 'image',
        ocrConfidence: 'low' });

      expect(resolved.policyId).toBe('temporary_unknown');
    });
  });

  describe('Policy-Verteilung über alle Kinds', () => {
    it('weist jedem Kind genau eine Catalog-Policy zu', () => {
      const counts: Record<StoragePolicyId, number> = {
        receipt: 0,
        business_document: 0,
        legal_document: 0,
        construction_photo: 0,
        temporary_unknown: 0 };

      for (const kind of CLASSIFIED_DOCUMENT_KINDS) {
        counts[getStoragePolicyForKind(kind)] += 1;
      }

      expect(counts.receipt).toBe(5);
      expect(counts.construction_photo).toBe(1);
      expect(counts.temporary_unknown).toBe(2);
      expect(counts.business_document).toBe(22);
      expect(counts.legal_document).toBe(56);
    });
  });

  describe('PendingDocumentIntake integration', () => {
    afterEach(async () => {
      setPdfTextExtractorForTests(null);
      setImageOcrExtractorForTests(null);
      resetDocumentFileStoreForTests();
    });

    it('führt aufgelöste Policy im Pending mit, ohne Persistenz vor Confirm', async () => {
      setPdfTextExtractorForTests(() => 'Rechnung Muster GmbH 1.250,00 EUR');
      const file = new File(['%PDF-1.4\nrechnung\n%%EOF'], 'rechnung.pdf', {
        type: 'application/pdf' });

      const preview = await processDocumentFileForPreview(file, { selectedKind: 'materialrechnung' });
      expect(preview.success).toBe(true);
      if (!preview.success) return;

      expect(preview.pending.storagePolicy.policyId).toBe('business_document');
      expect(preview.pending.storagePolicy.mediaProfile).toBe('native_pdf');
      expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);

      const confirm = await confirmPendingDocumentIntake(preview.pending, {
        importSource: 'upload',
        userDecision: 'save_permanently' });
      expect(confirm.success).toBe(true);
      if (!confirm.success) return;

      expect(getDocumentFileRefStoreSnapshot()[0]?.lifecycleStatus).toBe('committed');
    });
  });
});
