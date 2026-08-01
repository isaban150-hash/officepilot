import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { PDFDocument, PDFName, PDFSignature } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as persistenceService from './services/persistenceService';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import { orchestratePdfMetadataStripAfterImport } from './services/documentFilePdfMetadataStripOrchestrationService';
import {
  setPdfInfoMetadataStripForTests,
  stripDocumentFilePdfInfoMetadata,
} from './services/documentFilePdfMetadataStripService';
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
import { withNewEntitySync } from './services/sync/syncMetaService';
import { createAuftragInboxItem } from './test/fixtures';
import { PDF_INFO_METADATA_STRIP_KEYS } from './types/documentFilePdfMetadataStrip';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import type { CompanyDocument } from './types/models';

const DOC_A = 'doc-pdf-metadata-strip-exec-a';
const STRIPPED_BYTES_A = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x53, 0x41, 0x0a]);
const STRIPPED_BYTES_B = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x53, 0x42, 0x0a]);

/** Hints that resolve to metadata_rewrite_required for PDF sources. */
function pdfMetadataStripTransformPlan(): DocumentFileTransformPlan {
  return {
    policyId: 'business_document',
    mediaProfile: 'native_pdf',
    hints: {
      metadataHandling: 'strip_nonessential',
      colorHandling: 'not_applicable',
      preferredOutputKind: 'preserve_source',
    },
    intents: [
      {
        targetKind: 'archive',
        intent: 'create_archive',
        executionIntent: 'preferred',
      },
    ],
  };
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
      digitalFolder: { id: 'vertraege', name: 'Vertraege', path: '/vertraege' },
      paperFolder: { folderId: 'vertraege', register: 'A', label: 'Vertraege' },
      tags: [],
      linkedCompany: 'Test GmbH',
      linkedVorgang: null,
      archived: false,
      createdAt: '2026-07-20T00:00:00.000Z',
      fileRefId,
    },
    'document',
  );
}

function installStripFake(
  outputBytes: Uint8Array = STRIPPED_BYTES_A,
  onStrip?: (input: { byteLength: number }) => void,
): void {
  setPdfInfoMetadataStripForTests(async (input) => {
    onStrip?.({ byteLength: input.bytes.byteLength });
    return Object.freeze({
      bytes: outputBytes.slice(),
      mimeType: 'application/pdf' as const,
      pageCount: 1,
      clearedInfoKeys: PDF_INFO_METADATA_STRIP_KEYS,
      xmpFullyRemoved: false as const,
    });
  });
}

async function createPdfWithInfoMetadata(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([300, 400]);
  doc.setTitle('Secret Title');
  doc.setAuthor('Secret Author');
  doc.setSubject('Secret Subject');
  doc.setKeywords(['alpha', 'beta']);
  doc.setCreator('Secret Creator');
  doc.setProducer('Secret Producer');
  doc.setCreationDate(new Date('2020-01-15T12:00:00Z'));
  doc.setModificationDate(new Date('2020-06-20T12:00:00Z'));
  return doc.save({ updateFieldAppearances: false });
}

async function createSignedPdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([200, 200]);
  const form = doc.getForm();
  const sigDict = doc.context.obj({
    FT: 'Sig',
    Type: 'Annot',
    Subtype: 'Widget',
    T: 'Signature1',
    F: 4,
    Rect: [0, 0, 100, 50],
    P: page.ref,
  });
  const sigRef = doc.context.register(sigDict);
  page.node.addAnnot(sigRef);
  const fields = form.acroForm.dict.lookup(PDFName.of('Fields'));
  if (fields && 'push' in fields) {
    (fields as { push: (ref: typeof sigRef) => void }).push(sigRef);
  }
  return doc.save({ updateFieldAppearances: false });
}

function createEncryptedPdfBytes(): Uint8Array {
  return new TextEncoder().encode(
    [
      '%PDF-1.4',
      '1 0 obj',
      '<< /Type /Catalog /Pages 2 0 R >>',
      'endobj',
      '2 0 obj',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      'endobj',
      '3 0 obj',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
      'endobj',
      '4 0 obj',
      '<< /Length 0 >>',
      'stream',
      'endstream',
      'endobj',
      '5 0 obj',
      '<< /Filter /Standard /V 1 /R 2 /O <E721D354B2689DEF0EF1CD63BEA9B397D32B638B51FCE157C1CB4D3C06309FDE> /U <A826E45F7032777881A4FB36FFF1B0DD28BF4E5E4E758A4164004E56FFFA0108> /P -4 >>',
      'endobj',
      'xref',
      '0 6',
      '0000000000 65535 f ',
      '0000000009 00000 n ',
      '0000000058 00000 n ',
      '0000000115 00000 n ',
      '0000000206 00000 n ',
      '0000000255 00000 n ',
      'trailer',
      '<< /Size 6 /Root 1 0 R /Encrypt 5 0 R /ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>] >>',
      'startxref',
      '400',
      '%%EOF',
    ].join('\n'),
  );
}

async function storeCommittedPdf(bytes: Uint8Array, fileName: string) {
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

async function prepareDocumentWithPdf(bytes: Uint8Array, fileName: string) {
  const source = await storeCommittedPdf(bytes, fileName);
  hydrateDocumentStore([sampleDocument(DOC_A, source.fileRef.id)]);
  return source;
}

useDocumentBlobDatabaseReset();

afterEach(() => {
  vi.restoreAllMocks();
  setPdfInfoMetadataStripForTests(null);
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
});

describe('STORAGE-PDF-METADATA-STRIP-EXECUTOR-01', () => {
  describe('Fall A: erfolgreicher Metadata-Strip-Pfad', () => {
    it('strippt Info-Metadaten, setzt archive-Binding; Original bleibt unverändert', async () => {
      setPdfInfoMetadataStripForTests(null);
      const sourceBytes = await createPdfWithInfoMetadata();
      const source = await prepareDocumentWithPdf(sourceBytes, 'contract.pdf');
      const sourceSnapshot = Uint8Array.from(sourceBytes);

      const orch = await orchestratePdfMetadataStripAfterImport({
        documentId: DOC_A,
        transformPlan: pdfMetadataStripTransformPlan(),
      });

      expect(orch.kind).toBe('persisted');
      if (orch.kind !== 'persisted') return;
      expect(orch.createdArchiveFileRef).toBe(true);
      expect(orch.archiveFileRefId).not.toBe(source.fileRef.id);

      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      const originalAfter = await getOriginalDocumentFileBytes(source.fileRef);
      expect(Array.from(originalAfter ?? [])).toEqual(Array.from(sourceSnapshot));

      const before = await PDFDocument.load(sourceSnapshot, { updateMetadata: false });
      expect(before.getTitle()).toBe('Secret Title');
      expect(before.getAuthor()).toBe('Secret Author');

      const archiveRef = getDocumentFileRefById(orch.archiveFileRefId);
      expect(archiveRef?.lifecycleStatus).toBe('committed');
      expect(archiveRef?.mimeType).toBe('application/pdf');
      expect(archiveRef?.originalFileName).toBe('contract.pdf');

      const archiveBytes = await getOriginalDocumentFileBytes(archiveRef!);
      const after = await PDFDocument.load(archiveBytes!, { updateMetadata: false });
      expect(after.getTitle()).toBeUndefined();
      expect(after.getAuthor()).toBeUndefined();
      expect(after.getSubject()).toBeUndefined();
      expect(after.getKeywords()).toBeUndefined();
      expect(after.getCreator()).toBeUndefined();
      expect(after.getProducer()).toBeUndefined();
      expect(after.getCreationDate()).toBeUndefined();
      expect(after.getModificationDate()).toBeUndefined();
      expect(after.getPageCount()).toBe(1);

      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: orch.archiveFileRefId,
        },
      ]);
      expect(countActiveReferencesToFileRef(source.fileRef.id)).toBe(1);
      expect(countActiveReferencesToFileRef(orch.archiveFileRefId)).toBe(1);
    });

    it('behauptet XMP nicht als vollständig entfernt', async () => {
      installStripFake(STRIPPED_BYTES_A);
      await prepareDocumentWithPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x0a]), 'xmp.pdf');

      const stripped = await stripDocumentFilePdfInfoMetadata({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x0a]),
      });
      expect(stripped.xmpFullyRemoved).toBe(false);

      const orch = await orchestratePdfMetadataStripAfterImport({
        documentId: DOC_A,
        transformPlan: pdfMetadataStripTransformPlan(),
      });
      expect(orch.kind).toBe('persisted');
      expect(JSON.stringify(orch)).not.toMatch(/xmpCleared|xmpRemoved|xmpFullyRemoved.:true/);
    });
  });

  describe('Fall B: signiert / verschlüsselt / kaputt → kein Binding', () => {
    it('signierte PDF → error, kein archive-Binding, Original unverändert', async () => {
      setPdfInfoMetadataStripForTests(null);
      const signed = await createSignedPdfBytes();
      const loaded = await PDFDocument.load(signed, { updateMetadata: false });
      expect(loaded.getForm().getFields().some((f) => f instanceof PDFSignature)).toBe(true);

      const source = await prepareDocumentWithPdf(signed, 'signed.pdf');
      const snapshot = Uint8Array.from(signed);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestratePdfMetadataStripAfterImport({
        documentId: DOC_A,
        transformPlan: pdfMetadataStripTransformPlan(),
      });

      expect(orch.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      expect(Array.from((await getOriginalDocumentFileBytes(source.fileRef)) ?? [])).toEqual(
        Array.from(snapshot),
      );
    });

    it('verschlüsselte PDF → error, kein Binding', async () => {
      setPdfInfoMetadataStripForTests(null);
      const encrypted = createEncryptedPdfBytes();
      const source = await prepareDocumentWithPdf(encrypted, 'encrypted.pdf');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestratePdfMetadataStripAfterImport({
        documentId: DOC_A,
        transformPlan: pdfMetadataStripTransformPlan(),
      });

      expect(orch.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
    });

    it('kaputte PDF → error, kein Binding', async () => {
      setPdfInfoMetadataStripForTests(null);
      const corrupt = new TextEncoder().encode('this is not a pdf document at all');
      const source = await prepareDocumentWithPdf(corrupt, 'corrupt.pdf');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestratePdfMetadataStripAfterImport({
        documentId: DOC_A,
        transformPlan: pdfMetadataStripTransformPlan(),
      });

      expect(orch.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
    });
  });

  describe('Fall C: Dedupe', () => {
    it('Dedupe auf bestehende Archive-PDF-FileRef nutzt vorhandene FileRef', async () => {
      installStripFake(STRIPPED_BYTES_A);
      const source = await prepareDocumentWithPdf(
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x4f, 0x0a]),
        'dedupe.pdf',
      );
      const existing = await storeCommittedPdf(STRIPPED_BYTES_A, 'existing-archive.pdf');

      const orch = await orchestratePdfMetadataStripAfterImport({
        documentId: DOC_A,
        transformPlan: pdfMetadataStripTransformPlan(),
      });

      expect(orch).toMatchObject({
        kind: 'persisted',
        archiveFileRefId: existing.fileRef.id,
        createdArchiveFileRef: false,
      });
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: existing.fileRef.id,
        },
      ]);
    });
  });

  describe('Fall D: Conflict ohne Replace', () => {
    it('bestehendes archive→Y blockiert neues Binding; neue FileRef wird freigegeben', async () => {
      installStripFake(STRIPPED_BYTES_A);
      const source = await prepareDocumentWithPdf(
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x43, 0x0a]),
        'conflict.pdf',
      );
      const existingArchive = await storeCommittedPdf(STRIPPED_BYTES_B, 'existing-archive.pdf');
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: existingArchive.fileRef.id,
        }),
      ]);

      const refsBefore = new Set(getDocumentFileRefStoreSnapshot().map((ref) => ref.id));
      const orch = await orchestratePdfMetadataStripAfterImport({
        documentId: DOC_A,
        transformPlan: pdfMetadataStripTransformPlan(),
      });

      expect(orch).toEqual({ kind: 'conflict' });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: existingArchive.fileRef.id,
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
    it('Strip-Fehler → kein Binding, Original unverändert', async () => {
      setPdfInfoMetadataStripForTests(async () => {
        throw Object.freeze({ code: 'strip_failed', message: 'strip boom' });
      });
      const sourceBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x46, 0x0a]);
      const source = await prepareDocumentWithPdf(sourceBytes, 'strip-fail.pdf');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestratePdfMetadataStripAfterImport({
        documentId: DOC_A,
        transformPlan: pdfMetadataStripTransformPlan(),
      });

      expect(orch.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      expect(Array.from((await getOriginalDocumentFileBytes(source.fileRef)) ?? [])).toEqual(
        Array.from(sourceBytes),
      );
    });

    it('persistAll-Fehler rollt Binding zurück und entfernt neue FileRef', async () => {
      installStripFake(STRIPPED_BYTES_A);
      const source = await prepareDocumentWithPdf(
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x50, 0x0a]),
        'persist-fail.pdf',
      );
      const refsBefore = new Set(getDocumentFileRefStoreSnapshot().map((ref) => ref.id));

      vi.spyOn(persistenceService, 'persistAll').mockImplementation(() => {
        throw new Error('persist_failed');
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestratePdfMetadataStripAfterImport({
        documentId: DOC_A,
        transformPlan: pdfMetadataStripTransformPlan(),
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

  describe('Fall F: Import / Refcount / unresolved', () => {
    it('JPEG → strip_plan_unresolved', async () => {
      installStripFake(STRIPPED_BYTES_A);
      const source = await storeDocumentFileFromCachedPayload(
        {
          fileName: 'photo.jpg',
          mimeType: 'image/jpeg',
          fileSize: 7,
          bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]),
        },
        { lifecycleIntent: 'committed' },
      );
      hydrateDocumentStore([sampleDocument(DOC_A, source.fileRef.id)]);

      const orch = await orchestratePdfMetadataStripAfterImport({
        documentId: DOC_A,
        transformPlan: pdfMetadataStripTransformPlan(),
      });
      expect(orch).toEqual({ kind: 'noop', reason: 'strip_plan_unresolved' });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
    });

    it('Import bleibt erfolgreich bei Strip-Fehler; Refcount schützt Archive-PDF', async () => {
      setPdfInfoMetadataStripForTests(async () => {
        throw Object.freeze({ code: 'strip_failed', message: 'strip boom' });
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const source = await storeCommittedPdf(
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x49, 0x0a]),
        'import-fail.pdf',
      );
      const item = createAuftragInboxItem({
        id: 'inbox-pdf-strip-fail',
        fileRefId: source.fileRef.id,
        sourceFileHash: source.fileRef.contentHash,
      });
      hydrateInboxStore([item]);

      const imported = importInboxDocumentForTests(item, 'Test GmbH', {
        transformPlan: pdfMetadataStripTransformPlan(),
      });
      expect(imported.success).toBe(true);
      if (!imported.success) return;

      const drained = await orchestratePdfMetadataStripAfterImport({
        documentId: imported.document.id,
        transformPlan: pdfMetadataStripTransformPlan(),
      });
      expect(drained.kind).toBe('error');
      expect(
        getDocumentFileRepresentationBindingStoreSnapshot().every(
          (binding) => binding.kind !== 'archive',
        ),
      ).toBe(true);
      expect(getDocumentById(imported.document.id)?.fileRefId).toBe(source.fileRef.id);
      expect(errorSpy).toHaveBeenCalled();

      installStripFake(STRIPPED_BYTES_A);
      const okSource = await prepareDocumentWithPdf(
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x52, 0x0a]),
        'refcount.pdf',
      );
      const ok = await orchestratePdfMetadataStripAfterImport({
        documentId: DOC_A,
        transformPlan: pdfMetadataStripTransformPlan(),
      });
      expect(ok.kind).toBe('persisted');
      if (ok.kind !== 'persisted') return;
      expect(countActiveReferencesToFileRef(ok.archiveFileRefId)).toBe(1);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(okSource.fileRef.id);
    });
  });
});
