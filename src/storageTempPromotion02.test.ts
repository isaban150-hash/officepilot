import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
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
  getDocumentFileRefById,
  getDocumentFileRefStoreSnapshot,
  getOriginalDocumentFileBytes,
  hydrateDocumentFileStore,
  promoteDocumentFileRefToCommitted,
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload } from './services/documentFileStoreService';
import { countActiveReferencesToFileRef } from './services/documentFileReferenceService';
import { confirmPendingDocumentIntake, processDocumentFileForPreview } from './services/pendingDocumentIntakeService';
import { getInboxStoreSnapshot, hydrateInboxStore, stageInboxItem } from './services/inboxService';
import { intakeCachedDocumentFile } from './services/documentIntakeService';
import { setImageOcrExtractorForTests } from './services/ocrDocumentService';
import { setPdfTextExtractorForTests } from './services/uploadTextExtractionService';
import * as blobDbService from './services/storage/documentBlobIndexedDbService';
import {
  hasDocumentBlob
} from './services/storage/documentBlobIndexedDbService';
import * as persistenceService from './services/persistenceService';
import type { CachedDocumentFilePayload } from './services/cachedDocumentFileService';
import { applyDocumentFileRefCommittedPromotion } from './services/documentFileStorageLifecycleService';

function createPayload(
  content: string | Uint8Array,
  fileName: string,
  mimeType = 'application/pdf',
): CachedDocumentFilePayload {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return { fileName, mimeType, fileSize: bytes.byteLength, bytes };
}

useDocumentBlobDatabaseReset();

describe('STORAGE-TEMP-PROMOTION-02', () => {
  afterEach(async () => {
    setPdfTextExtractorForTests(null);
    setImageOcrExtractorForTests(null);
    vi.restoreAllMocks();
    resetDocumentFileStoreForTests();
  });

  async function createTempFileRef(marker = 'TEMP-PROMOTION') {
    setImageOcrExtractorForTests(async () => ({
      text: 'Baustellenfoto Rohbau',
      confidence: 80 }));
    const bytes = new TextEncoder().encode(marker);
    const preview = await processDocumentFileForPreview(
      new File([bytes], `${marker}.jpg`, { type: 'image/jpeg' }),
    );
    expect(preview.success).toBe(true);
    if (!preview.success) throw new Error('preview failed');

    const intake = await confirmPendingDocumentIntake(preview.pending, {
      userDecision: 'keep_temporarily',
      importSource: 'upload' });
    expect(intake.success).toBe(true);
    if (!intake.success || intake.duplicate) throw new Error('intake failed');
    expect(intake.fileRef.lifecycleStatus).toBe('temp');
    return { intake, bytes };
  }

  it('temp wird zu committed mit Promotion-Zeit und ohne expiresAt', async () => {
    const { intake } = await createTempFileRef();
    const before = Date.now();
    const result = promoteDocumentFileRefToCommitted(intake.fileRef.id);
    const after = Date.now();

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.alreadyCommitted).toBe(false);
    expect(result.fileRef.lifecycleStatus).toBe('committed');
    expect(result.fileRef.expiresAt).toBeUndefined();
    expect(result.fileRef.committedAt).toBeDefined();
    const committedMs = Date.parse(result.fileRef.committedAt!);
    expect(committedMs).toBeGreaterThanOrEqual(before);
    expect(committedMs).toBeLessThanOrEqual(after);
    expect(Object.prototype.hasOwnProperty.call(result.fileRef, 'expiresAt')).toBe(false);
  });

  it('fileRefId, contentHash, Blobbytes und Ref-Count bleiben unverändert', async () => {
    const { intake, bytes } = await createTempFileRef('STABLE-PROMOTE');
    const saveSpy = vi.spyOn(blobDbService, 'saveDocumentBlob');
    const refsBefore = countActiveReferencesToFileRef(intake.fileRef.id);

    const result = promoteDocumentFileRefToCommitted(intake.fileRef.id);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.fileRef.id).toBe(intake.fileRef.id);
    expect(result.fileRef.contentHash).toBe(intake.fileRef.contentHash);
    expect(countActiveReferencesToFileRef(result.fileRef.id)).toBe(refsBefore);
    expect(saveSpy).not.toHaveBeenCalled();

    const stored = await getOriginalDocumentFileBytes(result.fileRef);
    expect(stored).not.toBeNull();
    expect(Array.from(stored!)).toEqual(Array.from(bytes));
    expect(await hasDocumentBlob(result.fileRef.id)).toBe(true);
  });

  it('zwei Inbox-Einträge mit derselben fileRefId sehen nach Promotion committed', async () => {
    const { intake } = await createTempFileRef('SHARED-PROMOTE');
    stageInboxItem({
      ...getInboxStoreSnapshot()[0],
      id: 'inbox-shared-second',
      title: 'Zweiter Eintrag',
      fileRefId: intake.fileRef.id,
      sourceFileHash: intake.fileRef.contentHash });

    expect(countActiveReferencesToFileRef(intake.fileRef.id)).toBe(2);
    const result = promoteDocumentFileRefToCommitted(intake.fileRef.id);
    expect(result.success).toBe(true);

    const shared = getDocumentFileRefById(intake.fileRef.id);
    expect(shared?.lifecycleStatus).toBe('committed');
    expect(getInboxStoreSnapshot().filter((item) => item.fileRefId === intake.fileRef.id)).toHaveLength(2);
  });

  it('Shared-Hinweis erscheint bei mehr als einer Referenz', async () => {
    const { intake } = await createTempFileRef('SHARED-UI');
    stageInboxItem({
      ...getInboxStoreSnapshot()[0],
      id: 'inbox-shared-ui',
      title: 'Shared UI',
      fileRefId: intake.fileRef.id,
      sourceFileHash: intake.fileRef.contentHash });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(DocumentOriginalFilePanel, {
          fileRefId: intake.fileRef.id,
          translate: (key) => t(key, 'de'),
          testId: 'promote-panel' }),
      );
    });

    expect(host.querySelector('[data-testid="promote-panel-shared-notice"]')?.textContent).toContain('2');
    expect(host.querySelector('[data-testid="promote-panel-temp-badge"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('fehlender FileRef ergibt typisierten Fehler', () => {
    const result = promoteDocumentFileRefToCommitted('missing-file-ref');
    expect(result).toEqual({ success: false, error: 'file_ref_not_found' });
  });

  it('Persistenzfehler stellt den vorherigen temp-Zustand wieder her', async () => {
    const { intake } = await createTempFileRef('PERSIST-ROLLBACK');
    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: {
        phase: 'write_storage',
        errorName: 'Error',
        errorMessage: 'fail',
        storageKey: 'test',
        payloadBytesApprox: 0,
        payloadCharacters: 0 } } as ReturnType<typeof persistenceService.persistAll>);

    const result = promoteDocumentFileRefToCommitted(intake.fileRef.id);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('persist_failed');

    const restored = getDocumentFileRefById(intake.fileRef.id);
    expect(restored?.lifecycleStatus).toBe('temp');
    expect(restored?.expiresAt).toBe(intake.fileRef.expiresAt);
  });

  it('abgelaufenes temp wird nur angezeigt und nicht gelöscht', async () => {
    const stored = await storeDocumentFileFromCachedPayload(
      createPayload('expired-temp', 'expired.jpg', 'image/jpeg'),
      { lifecycleIntent: 'temp' },
    );
    const expiredRef = {
      ...stored.fileRef,
      expiresAt: '2020-01-01T00:00:00.000Z' };
    hydrateDocumentFileStore([expiredRef], {});

    expect(await hasDocumentBlob(expiredRef.id)).toBe(true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(DocumentOriginalFilePanel, {
          fileRefId: expiredRef.id,
          translate: (key) => t(key, 'de'),
          testId: 'expired-panel' }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(host.querySelector('[data-testid="expired-panel-expired-hint"]')).toBeTruthy();
    expect(await hasDocumentBlob(expiredRef.id)).toBe(true);
    expect(getDocumentFileRefById(expiredRef.id)?.lifecycleStatus).toBe('temp');

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('committed-Promotion ist idempotenter No-op', async () => {
    setPdfTextExtractorForTests(() => 'Rechnung 10 EUR');
    const preview = await processDocumentFileForPreview(
      new File([new TextEncoder().encode('%PDF-1.4\ncommitted\n%%EOF')], 'c.pdf', {
        type: 'application/pdf' }),
    );
    if (!preview.success) throw new Error('preview failed');
    const intake = await confirmPendingDocumentIntake(preview.pending, {
      userDecision: 'save_permanently' });
    if (!intake.success || intake.duplicate) throw new Error('intake failed');

    const result = promoteDocumentFileRefToCommitted(intake.fileRef.id);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.alreadyCommitted).toBe(true);
    expect(result.fileRef.lifecycleStatus).toBe('committed');
  });

  it('bestehender keep_temporarily-Intake bleibt temp bis Promotion', async () => {
    const { intake } = await createTempFileRef('STAYS-TEMP');
    expect(intake.fileRef.lifecycleStatus).toBe('temp');
    expect(getDocumentFileRefStoreSnapshot()[0].lifecycleStatus).toBe('temp');
  });

  it('applyDocumentFileRefCommittedPromotion entfernt expiresAt', () => {
    const promoted = applyDocumentFileRefCommittedPromotion({
      id: 'x',
      originalFileName: 'a.jpg',
      mimeType: 'image/jpeg',
      fileSize: 1,
      contentHash: 'h',
      storageType: 'indexeddb',
      localDataKey: 'x',
      createdAt: '2026-07-15T10:00:00.000Z',
      lifecycleStatus: 'temp',
      expiresAt: '2026-07-16T10:00:00.000Z' }, '2026-07-15T12:00:00.000Z');

    expect(promoted.lifecycleStatus).toBe('committed');
    expect(promoted.committedAt).toBe('2026-07-15T12:00:00.000Z');
    expect(promoted.expiresAt).toBeUndefined();
  });

  /**
   * UPLOAD-DRAFT-RESUME-01B0 — ein wiederverwendeter temp-Ref darf eine
   * endgültige Speicherung nicht als temp überleben. InboxItem und committed
   * FileRef gehen durch denselben einen persistAll.
   */
  describe('UPLOAD-DRAFT-RESUME-01B0 atomare Promotion im Intake', () => {
    /** Temp-Ref ohne referenzierendes InboxItem — der Entwurfsfall. */
    async function createUnreferencedTempRef(marker: string) {
      hydrateInboxStore([]);
      const payload = createPayload(marker, `${marker}.pdf`);
      const stored = await storeDocumentFileFromCachedPayload(payload, {
        lifecycleIntent: 'temp',
      });
      expect(stored.created).toBe(true);
      expect(stored.fileRef.lifecycleStatus).toBe('temp');
      expect(stored.fileRef.expiresAt).toBeDefined();
      expect(getInboxStoreSnapshot()).toHaveLength(0);
      return { payload, fileRef: stored.fileRef };
    }

    it('A — save_permanently promotet den wiederverwendeten temp-Ref', async () => {
      const { payload, fileRef } = await createUnreferencedTempRef('REUSE-COMMIT');
      const saveSpy = vi.spyOn(blobDbService, 'saveDocumentBlob');

      const result = await intakeCachedDocumentFile(payload, {
        userDecision: 'save_permanently',
        importSource: 'upload',
        recognizedText: 'Vertragstext',
      });

      expect(result.success).toBe(true);
      if (!result.success || result.duplicate) throw new Error('intake failed');

      // Gleiche Datei, keine zweiten Bytes.
      expect(result.fileRef.id).toBe(fileRef.id);
      expect(result.fileRef.contentHash).toBe(fileRef.contentHash);
      expect(saveSpy).not.toHaveBeenCalled();
      const bytes = await getOriginalDocumentFileBytes(result.fileRef);
      expect(Array.from(bytes!)).toEqual(Array.from(payload.bytes));

      // Das Result trägt den promoteten Ref, kein veralteter temp-Klon.
      expect(result.fileRef.lifecycleStatus).toBe('committed');
      expect(result.fileRef.expiresAt).toBeUndefined();
      expect(result.fileRef.committedAt).toBeDefined();

      const inStore = getDocumentFileRefById(fileRef.id);
      expect(inStore?.lifecycleStatus).toBe('committed');
      expect(inStore?.expiresAt).toBeUndefined();
      expect(getInboxStoreSnapshot()).toHaveLength(1);
      expect(getInboxStoreSnapshot()[0]?.fileRefId).toBe(fileRef.id);
    });

    it('B — Persistenzfehler rollt die Promotion vollständig zurück', async () => {
      const { payload, fileRef } = await createUnreferencedTempRef('ROLLBACK-COMMIT');
      const before = getDocumentFileRefById(fileRef.id)!;

      const persistSpy = vi
        .spyOn(persistenceService, 'persistAll')
        .mockReturnValue({ success: false, error: 'quota_exceeded' });

      const result = await intakeCachedDocumentFile(payload, {
        userDecision: 'save_permanently',
        importSource: 'upload',
        recognizedText: 'Vertragstext',
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected persist failure');
      expect(result.error).toBe('persist_failed');
      expect(persistSpy).toHaveBeenCalled();

      persistSpy.mockRestore();

      expect(getInboxStoreSnapshot()).toHaveLength(0);

      // Exakt der vorherige Ref, nicht nur der Status.
      const after = getDocumentFileRefById(fileRef.id);
      expect(after).toBeDefined();
      expect(after).toEqual(before);
      expect(after?.lifecycleStatus).toBe('temp');
      expect(after?.expiresAt).toBe(before.expiresAt);
      expect(after?.committedAt).toBeUndefined();

      // Wiederverwendete Datei bleibt erhalten.
      expect(await hasDocumentBlob(fileRef.id)).toBe(true);
    });

    it('C — Duplicate-Return ohne allowDuplicateIntake promotet nicht', async () => {
      const { intake } = await createTempFileRef('DUP-NO-PROMOTE');
      expect(intake.fileRef.lifecycleStatus).toBe('temp');
      const payload = createPayload('DUP-NO-PROMOTE', 'DUP-NO-PROMOTE.jpg', 'image/jpeg');

      const result = await intakeCachedDocumentFile(payload, {
        userDecision: 'save_permanently',
        importSource: 'upload',
        recognizedText: 'Foto',
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('intake failed');
      expect(result.duplicate).toBe(true);

      const inStore = getDocumentFileRefById(intake.fileRef.id);
      expect(inStore?.lifecycleStatus).toBe('temp');
      expect(inStore?.expiresAt).toBeDefined();
    });

    it('D — keep_temporarily bleibt temp', async () => {
      const { payload, fileRef } = await createUnreferencedTempRef('KEEP-TEMP-INTAKE');

      const result = await intakeCachedDocumentFile(payload, {
        userDecision: 'keep_temporarily',
        importSource: 'upload',
        recognizedText: 'Notiz',
      });

      expect(result.success).toBe(true);
      if (!result.success || result.duplicate) throw new Error('intake failed');
      expect(result.fileRef.lifecycleStatus).toBe('temp');
      expect(getDocumentFileRefById(fileRef.id)?.lifecycleStatus).toBe('temp');
      expect(getDocumentFileRefById(fileRef.id)?.expiresAt).toBeDefined();
    });

    it('E — bereits committed bleibt idempotent committed', async () => {
      hydrateInboxStore([]);
      const payload = createPayload('ALREADY-COMMITTED', 'ALREADY-COMMITTED.pdf');
      const stored = await storeDocumentFileFromCachedPayload(payload, {
        lifecycleIntent: 'committed',
      });
      expect(stored.fileRef.lifecycleStatus).toBe('committed');
      const committedAt = stored.fileRef.committedAt;

      const result = await intakeCachedDocumentFile(payload, {
        userDecision: 'save_permanently',
        importSource: 'upload',
        recognizedText: 'Vertragstext',
      });

      expect(result.success).toBe(true);
      if (!result.success || result.duplicate) throw new Error('intake failed');
      expect(result.fileRef.lifecycleStatus).toBe('committed');
      expect(result.fileRef.committedAt).toBe(committedAt);
      expect(result.fileRef.expiresAt).toBeUndefined();
    });
  });
});

describe('STORAGE-TEMP-PROMOTION-02 i18n DE/TR/BG', () => {
  const requiredKeys = Object.keys(deDocumentOriginal);

  it('DE keys sind in TR und BG vorhanden', () => {
    for (const key of requiredKeys) {
      expect(trDocumentOriginal[key as keyof typeof trDocumentOriginal]).toBeTruthy();
      expect(bgDocumentOriginal[key as keyof typeof bgDocumentOriginal]).toBeTruthy();
    }
  });

  it('Promotion-Labels sind übersetzbar', () => {
    expect(t('document.original.action.promotePermanently', 'de')).toContain('dauerhaft');
    expect(t('document.original.lifecycle.temp', 'tr')).toContain('Geçici');
    expect(t('document.original.promote.success', 'bg')).toContain('трайно');
  });
});
