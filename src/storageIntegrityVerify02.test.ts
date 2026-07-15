import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { t } from './i18n';
import { deDocumentOriginal } from './i18n/locales/de/documentOriginal';
import { trDocumentOriginal } from './i18n/locales/tr/documentOriginal';
import { bgDocumentOriginal } from './i18n/locales/bg/documentOriginal';
import { DocumentOriginalFilePanel } from './components/documents/DocumentOriginalFilePanel';
import {
  getDocumentFileRefStoreSnapshot,
  hydrateDocumentFileStore,
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
  verifyDocumentFileIntegrity,
} from './services/documentFileStoreService';
import { intakeCachedDocumentFile } from './services/documentIntakeService';
import {
  confirmPendingDocumentIntake,
  processDocumentFileForPreview,
} from './services/pendingDocumentIntakeService';
import { getInboxStoreSnapshot } from './services/inboxService';
import { setPdfTextExtractorForTests } from './services/uploadTextExtractionService';
import { setImageOcrExtractorForTests } from './services/ocrDocumentService';
import { resetTestStores } from './test/resetStores';
import * as blobDbService from './services/storage/documentBlobIndexedDbService';
import {
  hasDocumentBlob,
  readDocumentBlob,
  resetDocumentBlobDatabaseForTests,
  saveDocumentBlob,
} from './services/storage/documentBlobIndexedDbService';
import type { CachedDocumentFilePayload } from './services/cachedDocumentFileService';
import type { DocumentFileRef } from './types/documentFileRef';

function createPayload(
  content: string | Uint8Array,
  fileName: string,
  mimeType = 'application/pdf',
): CachedDocumentFilePayload {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return {
    fileName,
    mimeType,
    fileSize: bytes.byteLength,
    bytes,
  };
}

function sampleBytes(marker: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n${marker}\n%%EOF`);
}

describe('STORAGE-INTEGRITY-VERIFY-02', () => {
  afterEach(async () => {
    setPdfTextExtractorForTests(null);
    setImageOcrExtractorForTests(null);
    vi.restoreAllMocks();
    resetTestStores();
    resetDocumentFileStoreForTests();
    await resetDocumentBlobDatabaseForTests();
  });

  it('erfolgreicher Write + Readback + Hash + Größe', async () => {
    const original = sampleBytes('VERIFY-OK');
    const payload = createPayload(original, 'ok.pdf');

    const result = await intakeCachedDocumentFile(payload, {
      importSource: 'upload',
      userDecision: 'save_permanently',
    });
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) return;

    expect(result.fileRef.fileSize).toBe(original.byteLength);
    expect(await verifyDocumentFileIntegrity(result.fileRef)).toBe(true);
    const record = await readDocumentBlob(result.fileRef.id);
    expect(record?.fileSize).toBe(original.byteLength);
    expect(record?.blob.size).toBe(original.byteLength);
  });

  it('fehlender Blob nach Write → Intake schlägt fehl und rollt zurück', async () => {
    const original = sampleBytes('MISSING-BLOB');
    const payload = createPayload(original, 'missing.pdf');
    const realSave = saveDocumentBlob;

    vi.spyOn(blobDbService, 'saveDocumentBlob').mockImplementation(async (input) => {
      const saved = await realSave(input);
      await blobDbService.deleteDocumentBlob(input.fileRefId);
      return saved;
    });

    const result = await intakeCachedDocumentFile(payload, {
      userDecision: 'save_permanently',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('blob_missing_after_write');
    expect(getInboxStoreSnapshot()).toHaveLength(0);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
  });

  it('Größenabweichung → Intake schlägt fehl und rollt zurück', async () => {
    const original = sampleBytes('SIZE-MISMATCH');
    const payload = createPayload(original, 'size.pdf');
    const realSave = saveDocumentBlob;

    vi.spyOn(blobDbService, 'saveDocumentBlob').mockImplementation(async (input) => {
      const corrupted = new TextEncoder().encode('%PDF-1.4\nSHORT\n%%EOF');
      return realSave({
        ...input,
        blob: new Blob([corrupted], { type: input.mimeType }),
        fileSize: corrupted.byteLength,
      });
    });

    const result = await intakeCachedDocumentFile(payload, {
      userDecision: 'save_permanently',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('blob_size_mismatch');
    expect(getInboxStoreSnapshot()).toHaveLength(0);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
  });

  it('Hashabweichung → Intake schlägt fehl und rollt zurück', async () => {
    const original = sampleBytes('HASH-MISMATCH');
    const payload = createPayload(original, 'hash.pdf');
    const realSave = saveDocumentBlob;

    vi.spyOn(blobDbService, 'saveDocumentBlob').mockImplementation(async (input) => {
      const sameLength = new Uint8Array(original.byteLength);
      sameLength.set(new TextEncoder().encode('%PDF-1.4\nHASH-MISMATCH-X\n%%EOF').slice(0, original.byteLength));
      return realSave({
        ...input,
        blob: new Blob([sameLength], { type: input.mimeType }),
        fileSize: sameLength.byteLength,
      });
    });

    const result = await intakeCachedDocumentFile(payload, {
      userDecision: 'save_permanently',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('blob_hash_mismatch');
    expect(getInboxStoreSnapshot()).toHaveLength(0);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
  });

  it('bestehender Ref bei Reuse-Fehler wird nicht gelöscht', async () => {
    const bytes = sampleBytes('REUSE-SAFE');
    const first = await storeDocumentFileFromCachedPayload(createPayload(bytes, 'first.pdf'));
    expect(first.created).toBe(true);

    vi.spyOn(blobDbService, 'hasDocumentBlob').mockResolvedValue(false);
    vi.spyOn(blobDbService, 'readDocumentBlob').mockResolvedValue(null);
    vi.spyOn(blobDbService, 'copyDocumentBlobToScope').mockResolvedValue(false);

    await expect(
      storeDocumentFileFromCachedPayload(createPayload(bytes, 'second.pdf')),
    ).rejects.toMatchObject({ code: 'blob_read_failed' });

    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(1);
    expect(getDocumentFileRefStoreSnapshot()[0].id).toBe(first.fileRef.id);
  });

  it('save_duplicate_anyway erzeugt weiterhin keinen zweiten Blob', async () => {
    setPdfTextExtractorForTests(() => 'Rechnung Muster GmbH');
    const bytes = sampleBytes('DUP-OVERRIDE');
    const file = new File([bytes], 'dup.pdf', { type: 'application/pdf' });

    const firstPreview = await processDocumentFileForPreview(file);
    expect(firstPreview.success).toBe(true);
    if (!firstPreview.success) return;
    const first = await confirmPendingDocumentIntake(firstPreview.pending, {
      userDecision: 'save_permanently',
    });
    expect(first.success).toBe(true);
    if (!first.success || first.duplicate) return;

    const secondPreview = await processDocumentFileForPreview(file);
    expect(secondPreview.success).toBe(true);
    if (!secondPreview.success) return;
    const second = await confirmPendingDocumentIntake(secondPreview.pending, {
      userDecision: 'save_duplicate_anyway',
    });
    expect(second.success).toBe(true);
    if (!second.success || second.duplicate) return;

    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(1);
    expect(second.fileRef.id).toBe(first.fileRef.id);
    expect(getInboxStoreSnapshot()).toHaveLength(2);
  });

  it('temp und committed verwenden denselben Integrity-Gate', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: 'Baustellenfoto Rohbau',
      confidence: 80,
    }));
    const bytes = new TextEncoder().encode('temp-gate-photo');
    const preview = await processDocumentFileForPreview(
      new File([bytes], 'temp.jpg', { type: 'image/jpeg' }),
    );
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    const tempResult = await confirmPendingDocumentIntake(preview.pending, {
      userDecision: 'keep_temporarily',
    });
    expect(tempResult.success).toBe(true);
    if (!tempResult.success || tempResult.duplicate) return;
    expect(tempResult.fileRef.lifecycleStatus).toBe('temp');
    expect(await verifyDocumentFileIntegrity(tempResult.fileRef)).toBe(true);
  });

  it('Upload und Scan verwenden denselben Verify-Pfad', async () => {
    setPdfTextExtractorForTests(() => 'Rechnung Betrag 50,00 EUR');
    const bytes = sampleBytes('SHARED-PATH');
    const uploadFile = new File([bytes], 'shared.pdf', { type: 'application/pdf' });
    const scanBytes = sampleBytes('SHARED-PATH-SCAN');
    const scanFile = new File([scanBytes], 'shared-scan.pdf', { type: 'application/pdf' });

    const uploadPreview = await processDocumentFileForPreview(uploadFile);
    const scanPreview = await processDocumentFileForPreview(scanFile);
    expect(uploadPreview.success).toBe(true);
    expect(scanPreview.success).toBe(true);
    if (!uploadPreview.success || !scanPreview.success) return;

    const upload = await confirmPendingDocumentIntake(uploadPreview.pending, {
      importSource: 'upload',
      userDecision: 'save_permanently',
    });
    const scan = await confirmPendingDocumentIntake(scanPreview.pending, {
      importSource: 'scan',
      userDecision: 'save_permanently',
    });
    expect(upload.success).toBe(true);
    expect(scan.success).toBe(true);
    if (!upload.success || upload.duplicate || !scan.success || scan.duplicate) return;
    expect(await verifyDocumentFileIntegrity(upload.fileRef)).toBe(true);
    expect(await verifyDocumentFileIntegrity(scan.fileRef)).toBe(true);
  });

  it('Panel zeigt fehlendes Original verständlich an', async () => {
    const ref: DocumentFileRef = {
      id: 'file-ref-missing-blob',
      originalFileName: 'gone.pdf',
      mimeType: 'application/pdf',
      fileSize: 12,
      contentHash: 'abc',
      storageType: 'indexeddb',
      localDataKey: 'file-ref-missing-blob',
      createdAt: '2026-07-15T10:00:00.000Z',
      lifecycleStatus: 'committed',
      committedAt: '2026-07-15T10:00:00.000Z',
    };
    hydrateDocumentFileStore([ref], {});
    expect(await hasDocumentBlob(ref.id)).toBe(false);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        createElement(DocumentOriginalFilePanel, {
          fileRefId: ref.id,
          translate: (key) => t(key, 'de'),
          testId: 'integrity-panel',
        }),
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const missing = host.querySelector('[data-testid="integrity-panel-blob-missing"]');
    expect(missing).toBeTruthy();
    expect(missing?.textContent).toContain('Dateimetadaten');

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('keine automatische Löschung durch expiresAt', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: 'Baustellenfoto Rohbau',
      confidence: 80,
    }));
    const preview = await processDocumentFileForPreview(
      new File([new TextEncoder().encode('expire-meta')], 'expire.jpg', { type: 'image/jpeg' }),
    );
    if (!preview.success) return;
    const result = await confirmPendingDocumentIntake(preview.pending, {
      userDecision: 'keep_temporarily',
    });
    if (!result.success || result.duplicate) return;

    expect(result.fileRef.expiresAt).toBeDefined();
    expect(await hasDocumentBlob(result.fileRef.id)).toBe(true);
    expect(getInboxStoreSnapshot()).toHaveLength(1);
  });
});

describe('STORAGE-INTEGRITY-VERIFY-02 i18n DE/TR/BG', () => {
  const requiredKeys = Object.keys(deDocumentOriginal);

  it('DE keys sind in TR und BG vorhanden', () => {
    for (const key of requiredKeys) {
      expect(trDocumentOriginal[key as keyof typeof trDocumentOriginal]).toBeTruthy();
      expect(bgDocumentOriginal[key as keyof typeof bgDocumentOriginal]).toBeTruthy();
    }
  });

  it('Integritätsmeldungen sind übersetzbar', () => {
    expect(t('document.original.blobMissing', 'de')).toContain('Originaldatei');
    expect(t('docAssistant.error.blobHashMismatch', 'tr')).toContain('eşleşmiyor');
    expect(t('docAssistant.error.title.integrityFailed', 'bg')).toContain('Целостта');
  });
});
