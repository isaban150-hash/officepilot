import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as persistenceService from './services/persistenceService';
import * as pdfDocumentService from './services/pdfDocumentService';
import { buildDocumentFileRepresentationPlan } from './services/documentFileRepresentationPlanService';
import { buildDocumentFileTransformPlan } from './services/documentFileTransformPlanService';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import { orchestratePdfPreviewEncodeAfterImport } from './services/documentFilePdfPreviewEncodeOrchestrationService';
import { orchestratePdfThumbnailEncodeAfterImport } from './services/documentFilePdfThumbnailEncodeOrchestrationService';
import { orchestrateRasterPreviewEncodeAfterImport } from './services/documentFileRasterPreviewEncodeOrchestrationService';
import {
  encodeDocumentFilePdfPageToJpeg,
  setPdfPageJpegEncodeForTests,
} from './services/documentFilePdfPageJpegEncodeService';
import { setDocumentFileRasterEncodeAdaptersForTests } from './services/documentFileRasterEncodeService';
import { countActiveReferencesToFileRef } from './services/documentFileReferenceService';
import { getDocumentById, hydrateDocumentStore, importInboxDocument } from './services/documentService';
import {
  getDocumentFileRefById,
  getDocumentFileRefStoreSnapshot,
  getOriginalDocumentFileBytes,
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
} from './services/documentFileStoreService';
import { hydrateInboxStore } from './services/inboxService';
import {
  setPdfDocumentLoaderForTests,
  setPdfPageRendererForTests,
} from './services/pdfDocumentService';
import { withNewEntitySync } from './services/sync/syncMetaService';
import { createAuftragInboxItem } from './test/fixtures';
import {
  RASTER_PREVIEW_ENCODE_JPEG_QUALITY,
  RASTER_PREVIEW_ENCODE_MAX_EDGE_PX,
  RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY,
  RASTER_THUMBNAIL_ENCODE_MAX_EDGE_PX,
} from './types/documentFileRasterEncode';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import type { CompanyDocument } from './types/models';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
const JPEG_BYTES_PREVIEW = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0xcc, 0xdd]);
const JPEG_BYTES_EXISTING = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x11, 0x22]);
const JPEG_BYTES_RASTER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x41]);
const JPEG_BYTES_THUMB = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0xaa, 0xbb]);

const DOC_A = 'doc-pdf-preview-exec-a';

function businessPdfTransformPlan(): DocumentFileTransformPlan {
  const representationPlan = buildDocumentFileRepresentationPlan({
    policyId: 'business_document',
    decision: 'save_permanently',
  });
  expect(representationPlan).not.toBeNull();
  const plan = buildDocumentFileTransformPlan({
    representationPlan: representationPlan!,
    mediaProfile: 'native_pdf',
  });
  expect(plan).not.toBeNull();
  expect(plan!.intents.some((entry) => entry.intent === 'create_preview')).toBe(true);
  expect(plan!.intents.some((entry) => entry.intent === 'create_thumbnail')).toBe(true);
  return plan!;
}

function businessRasterTransformPlan(): DocumentFileTransformPlan {
  const representationPlan = buildDocumentFileRepresentationPlan({
    policyId: 'business_document',
    decision: 'save_permanently',
  });
  const plan = buildDocumentFileTransformPlan({
    representationPlan: representationPlan!,
    mediaProfile: 'raster_image',
  });
  return plan!;
}

function sampleDocument(id: string, fileRefId: string): CompanyDocument {
  return withNewEntitySync(
    {
      id,
      title: `Document ${id}`,
      category: 'vertrag',
      issuer: 'Test',
      recognizedText: '',
      issueDate: null,
      validUntil: null,
      digitalFolder: { id: 'vertraege', name: 'Verträge', path: '/vertraege' },
      paperFolder: { folderId: 'vertraege', register: 'A', label: 'Verträge' },
      tags: [],
      linkedCompany: 'Test GmbH',
      linkedVorgang: null,
      archived: false,
      createdAt: '2026-07-19T22:00:00.000Z',
      fileRefId,
    },
    'document',
  );
}

function installPdfLoadAndRender(options?: {
  pageCount?: number;
  pageWidth?: number;
  pageHeight?: number;
  onRenderPage?: (pageNumber: number) => void;
  failRender?: boolean;
}): void {
  const pageCount = options?.pageCount ?? 3;
  const pageWidth = options?.pageWidth ?? 2560;
  const pageHeight = options?.pageHeight ?? 1440;

  setPdfDocumentLoaderForTests(async () => ({
    pdf: {
      numPages: pageCount,
      async destroy() {
        return undefined;
      },
    } as never,
    pageCount,
  }));

  setPdfPageRendererForTests(async (_pdf, pageNumber) => {
    options?.onRenderPage?.(pageNumber);
    if (options?.failRender) {
      throw {
        code: 'render_failed' as const,
        message: 'PDF-Seite konnte nicht gerendert werden.',
      };
    }
    const canvas = document.createElement('canvas');
    canvas.width = pageWidth;
    canvas.height = pageHeight;
    return { canvas, scale: 1 };
  });
}

function installPageEncodeFake(
  outputBytes: Uint8Array = JPEG_BYTES_PREVIEW,
  onEncode?: (input: {
    pageNumber: number;
    quality: number | undefined;
    maxEdge: number | undefined;
  }) => void,
): void {
  setPdfPageJpegEncodeForTests(async (input) => {
    onEncode?.({
      pageNumber: input.pageNumber,
      quality: input.quality,
      maxEdge: input.maxEdge,
    });
    if (input.pageNumber !== 1) {
      throw new Error(`expected page 1, got ${input.pageNumber}`);
    }
    return Object.freeze({
      bytes: outputBytes.slice(),
      mimeType: 'image/jpeg' as const,
      width: 1280,
      height: 720,
    });
  });
}

function installRasterEncodeFake(outputBytes: Uint8Array = JPEG_BYTES_PREVIEW): void {
  setDocumentFileRasterEncodeAdaptersForTests({
    async decodeRaster() {
      return { width: 2560, height: 1440 };
    },
    async encodeJpeg() {
      return outputBytes.slice();
    },
  });
}

async function storeCommittedPdf(bytes: Uint8Array = PDF_BYTES, fileName = 'source.pdf') {
  return storeDocumentFileFromCachedPayload(
    {
      fileName,
      mimeType: 'application/pdf',
      fileSize: bytes.byteLength,
      bytes,
    },
    { lifecycleIntent: 'committed' },
  );
}

async function storeCommittedJpeg(bytes: Uint8Array, fileName: string) {
  return storeDocumentFileFromCachedPayload(
    {
      fileName,
      mimeType: 'image/jpeg',
      fileSize: bytes.byteLength,
      bytes,
    },
    { lifecycleIntent: 'committed' },
  );
}

async function prepareDocumentWithPdf(bytes: Uint8Array = PDF_BYTES, fileName = 'source.pdf') {
  const source = await storeCommittedPdf(bytes, fileName);
  hydrateDocumentStore([sampleDocument(DOC_A, source.fileRef.id)]);
  return source;
}

useDocumentBlobDatabaseReset();

afterEach(() => {
  vi.restoreAllMocks();
  setPdfDocumentLoaderForTests(null);
  setPdfPageRendererForTests(null);
  setPdfPageJpegEncodeForTests(null);
  setDocumentFileRasterEncodeAdaptersForTests(null);
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
});

describe('STORAGE-PDF-PREVIEW-EXECUTOR-01', () => {
  describe('Fall A: erfolgreicher PDF-Preview-Pfad', () => {
    it('encodiert Seite 1 mit Preview-Defaults und setzt Binding; Original bleibt', async () => {
      let encodeCall:
        | { pageNumber: number; quality: number | undefined; maxEdge: number | undefined }
        | undefined;
      installPageEncodeFake(JPEG_BYTES_PREVIEW, (call) => {
        encodeCall = call;
      });
      const source = await prepareDocumentWithPdf();

      const orch = await orchestratePdfPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessPdfTransformPlan(),
      });

      expect(orch.kind).toBe('persisted');
      if (orch.kind !== 'persisted') return;
      expect(orch.createdPreviewFileRef).toBe(true);
      expect(orch.previewFileRefId).not.toBe(source.fileRef.id);

      expect(encodeCall?.pageNumber).toBe(1);
      expect(encodeCall?.quality).toBe(RASTER_PREVIEW_ENCODE_JPEG_QUALITY);
      expect(encodeCall?.quality).toBe(0.8);
      expect(encodeCall?.maxEdge).toBe(RASTER_PREVIEW_ENCODE_MAX_EDGE_PX);
      expect(encodeCall?.maxEdge).toBe(1280);

      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      const sourceBytes = await getOriginalDocumentFileBytes(source.fileRef);
      expect(Array.from(sourceBytes ?? [])).toEqual(Array.from(PDF_BYTES));

      const previewRef = getDocumentFileRefById(orch.previewFileRefId);
      expect(previewRef?.lifecycleStatus).toBe('committed');
      expect(previewRef?.mimeType).toBe('image/jpeg');

      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'preview',
          fileRefId: orch.previewFileRefId,
        },
      ]);
      expect(
        getDocumentFileRepresentationBindingStoreSnapshot().some(
          (binding) => binding.kind === 'thumbnail',
        ),
      ).toBe(false);

      expect(countActiveReferencesToFileRef(source.fileRef.id)).toBe(1);
      expect(countActiveReferencesToFileRef(orch.previewFileRefId)).toBe(1);
    });
  });

  describe('Fall B: Page-Encode-Kern / Canvas-Release', () => {
    it('lädt PDF, rendert Seite 1, nutzt Preview quality/maxEdge und gibt Canvas frei', async () => {
      const requestedPages: number[] = [];
      let encodeCall: { quality: number; targetWidth: number; targetHeight: number } | undefined;
      installPdfLoadAndRender({
        onRenderPage: (pageNumber) => {
          requestedPages.push(pageNumber);
        },
      });
      setDocumentFileRasterEncodeAdaptersForTests({
        async decodeRaster() {
          return { width: 16, height: 12 };
        },
        async encodeJpeg(_source, targetWidth, targetHeight, quality) {
          encodeCall = { quality, targetWidth, targetHeight };
          return JPEG_BYTES_PREVIEW.slice();
        },
      });
      const releaseSpy = vi.spyOn(pdfDocumentService, 'releaseCanvas');

      const result = await encodeDocumentFilePdfPageToJpeg({
        bytes: PDF_BYTES,
        pageNumber: 1,
        quality: RASTER_PREVIEW_ENCODE_JPEG_QUALITY,
        maxEdge: RASTER_PREVIEW_ENCODE_MAX_EDGE_PX,
      });

      expect(requestedPages).toEqual([1]);
      expect(encodeCall?.quality).toBe(0.8);
      expect(encodeCall?.targetWidth).toBe(1280);
      expect(encodeCall?.targetHeight).toBe(720);
      expect(result.mimeType).toBe('image/jpeg');
      expect(Array.from(result.bytes)).toEqual(Array.from(JPEG_BYTES_PREVIEW));
      expect(releaseSpy).toHaveBeenCalled();
    });
  });

  describe('Fall C: Dedupe', () => {
    it('Dedupe auf bestehende FileRef nutzt vorhandene FileRef', async () => {
      installPageEncodeFake(JPEG_BYTES_EXISTING);
      const source = await prepareDocumentWithPdf();
      const existing = await storeCommittedJpeg(JPEG_BYTES_EXISTING, 'existing-preview.jpg');

      const orch = await orchestratePdfPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessPdfTransformPlan(),
      });

      expect(orch).toMatchObject({
        kind: 'persisted',
        previewFileRefId: existing.fileRef.id,
        createdPreviewFileRef: false,
      });
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'preview',
          fileRefId: existing.fileRef.id,
        },
      ]);
    });
  });

  describe('Fall D: Conflict ohne Replace', () => {
    it('bestehendes preview→Y blockiert neues Binding; neue FileRef wird freigegeben', async () => {
      installPageEncodeFake(JPEG_BYTES_PREVIEW);
      const source = await prepareDocumentWithPdf(PDF_BYTES, 'conflict.pdf');
      const existingPreview = await storeCommittedJpeg(JPEG_BYTES_EXISTING, 'existing-preview.jpg');
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'preview',
          fileRefId: existingPreview.fileRef.id,
        }),
      ]);

      const refsBefore = new Set(getDocumentFileRefStoreSnapshot().map((ref) => ref.id));
      const orch = await orchestratePdfPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessPdfTransformPlan(),
      });

      expect(orch).toEqual({ kind: 'conflict' });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'preview',
          fileRefId: existingPreview.fileRef.id,
        },
      ]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);

      await vi.waitFor(() => {
        const current = getDocumentFileRefStoreSnapshot().map((ref) => ref.id);
        expect(current.sort()).toEqual([...refsBefore].sort());
      });
    });
  });

  describe('Fall E: Rollback', () => {
    it('Render-Fehler → kein Binding, Original unverändert', async () => {
      installPdfLoadAndRender({ failRender: true });
      setDocumentFileRasterEncodeAdaptersForTests({
        async decodeRaster() {
          return { width: 16, height: 12 };
        },
        async encodeJpeg() {
          return JPEG_BYTES_PREVIEW.slice();
        },
      });
      const source = await prepareDocumentWithPdf();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestratePdfPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessPdfTransformPlan(),
      });

      expect(orch.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
    });

    it('Encode-Fehler → kein Binding, Original unverändert', async () => {
      setPdfPageJpegEncodeForTests(async () => {
        throw Object.freeze({ code: 'encode_failed', message: 'encode boom' });
      });
      const source = await prepareDocumentWithPdf();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestratePdfPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessPdfTransformPlan(),
      });

      expect(orch.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
    });

    it('persistAll-Fehler rollt Binding zurück und entfernt neue FileRef', async () => {
      installPageEncodeFake(JPEG_BYTES_PREVIEW);
      const source = await prepareDocumentWithPdf(PDF_BYTES, 'persist-fail.pdf');
      const refsBefore = new Set(getDocumentFileRefStoreSnapshot().map((ref) => ref.id));

      vi.spyOn(persistenceService, 'persistAll').mockImplementation(() => {
        throw new Error('persist_failed');
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestratePdfPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessPdfTransformPlan(),
      });

      expect(orch.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);

      await vi.waitFor(() => {
        const current = getDocumentFileRefStoreSnapshot().map((ref) => ref.id);
        expect(current.every((id) => refsBefore.has(id))).toBe(true);
      });
    });
  });

  describe('Fall F: PDF-Thumbnail und Rasterpfade unverändert / Refcount', () => {
    it('Raster-Source → encode_plan_unresolved für PDF-Preview-Orchestrator', async () => {
      installPageEncodeFake(JPEG_BYTES_PREVIEW);
      const source = await storeCommittedJpeg(JPEG_BYTES_RASTER, 'raster.jpg');
      hydrateDocumentStore([sampleDocument(DOC_A, source.fileRef.id)]);

      const orch = await orchestratePdfPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessPdfTransformPlan(),
      });
      expect(orch).toEqual({ kind: 'noop', reason: 'encode_plan_unresolved' });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
    });

    it('Raster-Preview-Pfad bleibt unverändert', async () => {
      installRasterEncodeFake(JPEG_BYTES_PREVIEW);
      const source = await storeCommittedJpeg(JPEG_BYTES_RASTER, 'raster-preview.jpg');
      hydrateDocumentStore([sampleDocument(DOC_A, source.fileRef.id)]);

      const orch = await orchestrateRasterPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessRasterTransformPlan(),
      });
      expect(orch.kind).toBe('persisted');
      if (orch.kind !== 'persisted') return;
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'preview',
          fileRefId: orch.previewFileRefId,
        },
      ]);
    });

    it('PDF-Thumbnail-Pfad bleibt unverändert und kann neben Preview existieren', async () => {
      const encodeCalls: Array<{ quality: number | undefined; maxEdge: number | undefined }> = [];
      setPdfPageJpegEncodeForTests(async (input) => {
        encodeCalls.push({ quality: input.quality, maxEdge: input.maxEdge });
        const bytes =
          input.quality === RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY
            ? JPEG_BYTES_THUMB
            : JPEG_BYTES_PREVIEW;
        return Object.freeze({
          bytes: bytes.slice(),
          mimeType: 'image/jpeg' as const,
          width: input.maxEdge ?? 1,
          height: Math.round(((input.maxEdge ?? 1) * 9) / 16),
        });
      });
      const source = await prepareDocumentWithPdf(PDF_BYTES, 'both.pdf');
      const plan = businessPdfTransformPlan();

      const thumb = await orchestratePdfThumbnailEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: plan,
      });
      const preview = await orchestratePdfPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: plan,
      });

      expect(thumb.kind).toBe('persisted');
      expect(preview.kind).toBe('persisted');
      if (thumb.kind !== 'persisted' || preview.kind !== 'persisted') return;

      expect(encodeCalls).toEqual(
        expect.arrayContaining([
          {
            quality: RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY,
            maxEdge: RASTER_THUMBNAIL_ENCODE_MAX_EDGE_PX,
          },
          {
            quality: RASTER_PREVIEW_ENCODE_JPEG_QUALITY,
            maxEdge: RASTER_PREVIEW_ENCODE_MAX_EDGE_PX,
          },
        ]),
      );
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual(
        expect.arrayContaining([
          {
            documentId: DOC_A,
            kind: 'thumbnail',
            fileRefId: thumb.thumbnailFileRefId,
          },
          {
            documentId: DOC_A,
            kind: 'preview',
            fileRefId: preview.previewFileRefId,
          },
        ]),
      );
      expect(countActiveReferencesToFileRef(preview.previewFileRefId)).toBe(1);
      expect(countActiveReferencesToFileRef(thumb.thumbnailFileRefId)).toBe(1);
    });

    it('Import bleibt erfolgreich bei Encode-Fehler; Refcount schützt Preview', async () => {
      setPdfPageJpegEncodeForTests(async () => {
        throw Object.freeze({ code: 'encode_failed', message: 'encode boom' });
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const source = await storeCommittedPdf(PDF_BYTES, 'import-fail.pdf');
      const item = createAuftragInboxItem({
        id: 'inbox-pdf-preview-fail',
        fileRefId: source.fileRef.id,
        sourceFileHash: source.fileRef.contentHash,
      });
      hydrateInboxStore([item]);

      const imported = importInboxDocumentForTests(item, 'Test GmbH', {
        transformPlan: businessPdfTransformPlan(),
      });
      expect(imported.success).toBe(true);
      if (!imported.success) return;

      const drained = await orchestratePdfPreviewEncodeAfterImport({
        documentId: imported.document.id,
        transformPlan: businessPdfTransformPlan(),
      });
      expect(drained.kind).toBe('error');
      expect(
        getDocumentFileRepresentationBindingStoreSnapshot().every(
          (binding) => binding.kind !== 'preview',
        ),
      ).toBe(true);
      expect(getDocumentById(imported.document.id)?.fileRefId).toBe(source.fileRef.id);
      expect(errorSpy).toHaveBeenCalled();

      installPageEncodeFake(JPEG_BYTES_PREVIEW);
      const okSource = await prepareDocumentWithPdf(PDF_BYTES, 'refcount.pdf');
      const ok = await orchestratePdfPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessPdfTransformPlan(),
      });
      expect(ok.kind).toBe('persisted');
      if (ok.kind !== 'persisted') return;
      expect(countActiveReferencesToFileRef(ok.previewFileRefId)).toBe(1);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(okSource.fileRef.id);
    });
  });
});
