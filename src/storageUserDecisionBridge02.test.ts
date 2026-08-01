import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from './i18n';
import { deUserStorageDecision } from './i18n/locales/de/userStorageDecision';
import { trUserStorageDecision } from './i18n/locales/tr/userStorageDecision';
import { bgUserStorageDecision } from './i18n/locales/bg/userStorageDecision';
import {
  buildStorageRecommendation } from './services/storageRecommendationService';
import {
  confirmPendingDocumentIntake,
  discardPendingDocumentIntake,
  processDocumentFileForPreview } from './services/pendingDocumentIntakeService';
import {
  buildPendingDocumentDecisionActions,
  executePendingDocumentDecision } from './services/pendingDocumentDecisionService';
import {
  resolveAvailableUserStorageDecisions,
  mapDecisionToLifecycleIntent } from './services/userStorageDecisionService';
import {
  getDocumentFileRefStoreSnapshot,
  resetDocumentFileStoreForTests } from './services/documentFileStoreService';
import { countActiveReferencesToFileRef } from './services/documentFileReferenceService';
import { getInboxStoreSnapshot, hydrateInboxStore } from './services/inboxService';
import { computeBufferContentHash } from './services/documentFileHashService';
import { setPdfTextExtractorForTests } from './services/uploadTextExtractionService';
import { setImageOcrExtractorForTests } from './services/ocrDocumentService';
import {
  hasDocumentBlob
} from './services/storage/documentBlobIndexedDbService';
import type { CachedDocumentFilePayload } from './services/cachedDocumentFileService';
import type { DocumentTextExtractionResult } from './services/ocrDocumentService';
import type { InboxItem } from './types/models';

const SAMPLE_TEXT = 'Rechnung Muster GmbH 1.250,00 EUR';

function createPayload(
  content: string | Uint8Array,
  fileName: string,
  mimeType = 'application/pdf',
): CachedDocumentFilePayload {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return { fileName, mimeType, fileSize: bytes.length, bytes };
}

function createExtraction(
  recognizedText: string,
  confidence: DocumentTextExtractionResult['confidence'] = 'high',
): DocumentTextExtractionResult {
  return {
    recognizedText,
    displayText: recognizedText,
    confidence,
    sourceType: 'pdf',
    extractionMethod: 'pdf_direct' };
}

function createFile(payload: CachedDocumentFilePayload): File {
  return new File([payload.bytes], payload.fileName, { type: payload.mimeType });
}

useDocumentBlobDatabaseReset();

describe('STORAGE-USER-DECISION-BRIDGE-02', () => {
  afterEach(async () => {
    setPdfTextExtractorForTests(null);
    setImageOcrExtractorForTests(null);
    vi.restoreAllMocks();
    resetDocumentFileStoreForTests();
  });

  it('archive_required ohne Klick persistiert nichts', async () => {
    setPdfTextExtractorForTests(() => '2. Mahnung offener Betrag sofort zahlen');
    const payload = createPayload('%PDF-1.4\nmahnung\n%%EOF', 'mahnung.pdf');
    const preview = await processDocumentFileForPreview(createFile(payload));
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    expect(preview.pending.storageRecommendation.level).toBe('archive_required');
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
    expect(getInboxStoreSnapshot()).toHaveLength(0);
    discardPendingDocumentIntake(preview.pending);
  });

  it('temporary_only + save_permanently ergibt committed', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: 'Baustellenfoto Rohbau',
      confidence: 80 }));
    const payload = createPayload('photo-bytes', 'foto.jpg', 'image/jpeg');
    const preview = await processDocumentFileForPreview(createFile(payload));
    expect(preview.success).toBe(true);
    if (!preview.success) return;
    expect(preview.pending.storageRecommendation.level).toBe('temporary_only');

    const result = await confirmPendingDocumentIntake(preview.pending, {
      importSource: 'upload',
      userDecision: 'save_permanently' });
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) return;
    expect(result.fileRef.lifecycleStatus).toBe('committed');
    expect(result.fileRef.committedAt).toBeDefined();
  });

  it('temporary_only + keep_temporarily ergibt temp mit expiresAt', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: 'Baustellenfoto Rohbau',
      confidence: 80 }));
    const payload = createPayload('temp-photo', 'temp.jpg', 'image/jpeg');
    const preview = await processDocumentFileForPreview(createFile(payload));
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    const result = await confirmPendingDocumentIntake(preview.pending, {
      importSource: 'scan',
      userDecision: 'keep_temporarily' });
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) return;
    expect(result.fileRef.lifecycleStatus).toBe('temp');
    expect(result.fileRef.expiresAt).toBeDefined();
    expect(result.fileRef.committedAt).toBeUndefined();
  });

  it('archive_recommended bietet keep_temporarily nicht an', async () => {
    setPdfTextExtractorForTests(() => 'Rechnung Betrag: 200,00 EUR Summe gesamt');
    const payload = createPayload('%PDF-1.4\nrechnung\n%%EOF', 'rechnung.pdf');
    const preview = await processDocumentFileForPreview(createFile(payload), {
      selectedKind: 'materialrechnung' });
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    const available = resolveAvailableUserStorageDecisions(
      preview.pending.storageRecommendation,
      preview.pending.storagePolicy,
    );
    expect(available).not.toContain('keep_temporarily');
    await expect(
      confirmPendingDocumentIntake(preview.pending, {
        userDecision: 'keep_temporarily' }),
    ).resolves.toMatchObject({ success: false, error: 'navigation_failed' });
    discardPendingDocumentIntake(preview.pending);
  });

  it('discard erzeugt keinen Blob und keinen Inbox-Eintrag', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const payload = createPayload('%PDF-1.4\ndiscard\n%%EOF', 'discard.pdf');
    const preview = await processDocumentFileForPreview(createFile(payload));
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    const result = await executePendingDocumentDecision(preview.pending, 'discard');
    expect(result).toEqual({ outcome: 'discarded' });
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
    expect(getInboxStoreSnapshot()).toHaveLength(0);
    expect(await hasDocumentBlob('any')).toBe(false);
  });

  it('use_existing mit Inbox-Match schlägt fehl und verwirft den Upload nicht', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const bytes = new TextEncoder().encode('%PDF-1.4\nexisting\n%%EOF');
    const hash = await computeBufferContentHash(bytes);

    const existingInbox: InboxItem = {
      id: 'inbox-existing-decision',
      title: 'Bestehend',
      sender: 'Muster',
      documentType: 'eingangsrechnung',
      status: 'neu',
      priority: 'mittel',
      receivedAt: '2026-07-15T10:00:00.000Z',
      sourceFileHash: hash,
      fileRefId: 'file-ref-existing',
      digitalFolder: { id: 'd1', name: 'Test', path: '/test/' },
      paperFiling: { folderId: 'f1', register: 'A', label: 'Test' },
      deadline: null,
      recommendedAction: 'zuordnen',
      recognizedData: {},
      officePilotSuggestion: '',
      nextTaskLabel: '',
      securityHint: '' };
    hydrateInboxStore([existingInbox]);

    const preview = await processDocumentFileForPreview(
      createFile(createPayload(bytes, 'existing.pdf')),
    );
    expect(preview.success).toBe(true);
    if (!preview.success) return;
    expect(preview.pending.storageRecommendation.level).toBe('duplicate_detected');
    expect(preview.pending.storageRecommendation.duplicateMatch?.type).toBe('inbox');

    const available = resolveAvailableUserStorageDecisions(
      preview.pending.storageRecommendation,
      preview.pending.storagePolicy,
    );
    expect(available).not.toContain('use_existing');

    const result = await executePendingDocumentDecision(preview.pending, 'use_existing');
    expect(result).toMatchObject({ success: false, error: 'navigation_failed' });
    expect(preview.pending.cachedFile.bytes.byteLength).toBeGreaterThan(0);
    discardPendingDocumentIntake(preview.pending);
  });

  it('save_duplicate_anyway erzeugt neuen Inbox-Eintrag mit bestehendem fileRefId', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const bytes = new TextEncoder().encode('%PDF-1.4\ndup-override\n%%EOF');
    const payload = createPayload(bytes, 'dup.pdf');

    const firstPreview = await processDocumentFileForPreview(createFile(payload));
    expect(firstPreview.success).toBe(true);
    if (!firstPreview.success) return;

    const first = await confirmPendingDocumentIntake(firstPreview.pending, {
      importSource: 'upload',
      userDecision: 'save_permanently' });
    expect(first.success).toBe(true);
    if (!first.success || first.duplicate) return;

    const preview = await processDocumentFileForPreview(createFile(payload));
    expect(preview.success).toBe(true);
    if (!preview.success) return;
    expect(preview.pending.storageRecommendation.level).toBe('duplicate_detected');

    const result = await confirmPendingDocumentIntake(preview.pending, {
      importSource: 'upload',
      userDecision: 'save_duplicate_anyway' });
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) return;

    const refs = getDocumentFileRefStoreSnapshot();
    expect(refs).toHaveLength(1);
    expect(getInboxStoreSnapshot()).toHaveLength(2);
    expect(result.inboxItem.fileRefId).toBe(first.fileRef.id);
    expect(result.fileRef.id).toBe(first.fileRef.id);
  });

  it('save_duplicate_anyway erzeugt keinen zweiten Blob', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const bytes = new TextEncoder().encode('%PDF-1.4\nsingle-blob\n%%EOF');
    const file = createFile(createPayload(bytes, 'single-blob.pdf'));

    const firstPreview = await processDocumentFileForPreview(file);
    if (!firstPreview.success) throw new Error('preview failed');
    await confirmPendingDocumentIntake(firstPreview.pending, {
      userDecision: 'save_permanently' });

    const secondPreview = await processDocumentFileForPreview(file);
    if (!secondPreview.success) throw new Error('preview failed');
    await confirmPendingDocumentIntake(secondPreview.pending, {
      userDecision: 'save_duplicate_anyway' });

    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(1);
  });

  it('Referenzzählung steigt bei save_duplicate_anyway', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const bytes = new TextEncoder().encode('%PDF-1.4\nref-count\n%%EOF');
    const file = createFile(createPayload(bytes, 'ref-count.pdf'));

    const firstPreview = await processDocumentFileForPreview(file);
    if (!firstPreview.success) throw new Error('preview failed');
    const first = await confirmPendingDocumentIntake(firstPreview.pending, {
      userDecision: 'save_permanently' });
    if (!first.success || first.duplicate) throw new Error('first intake failed');

    expect(countActiveReferencesToFileRef(first.fileRef.id)).toBe(1);

    const secondPreview = await processDocumentFileForPreview(file);
    if (!secondPreview.success) throw new Error('preview failed');
    await confirmPendingDocumentIntake(secondPreview.pending, {
      userDecision: 'save_duplicate_anyway' });

    expect(countActiveReferencesToFileRef(first.fileRef.id)).toBe(2);
  });

  it('Recommendation bleibt bei gleicher Eingabe unverändert', async () => {
    setPdfTextExtractorForTests(() => 'Rechnung Betrag: 200,00 EUR');
    const file = createFile(createPayload('%PDF-1.4\nstable-rec\n%%EOF', 'stable.pdf'));
    const first = await processDocumentFileForPreview(file);
    const second = await processDocumentFileForPreview(file);
    if (!first.success || !second.success) return;
    expect(first.pending.storageRecommendation.level).toBe(
      second.pending.storageRecommendation.level,
    );
    expect(first.pending.storageRecommendation.reasonKeys).toEqual(
      second.pending.storageRecommendation.reasonKeys,
    );
  });

  it('StoragePolicy bleibt von der Decision unabhängig', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: 'Baustellenfoto Rohbau',
      confidence: 80 }));
    const preview = await processDocumentFileForPreview(
      createFile(createPayload('photo', 'site.jpg', 'image/jpeg')),
    );
    if (!preview.success) return;
    const policyBefore = preview.pending.storagePolicy;

    await confirmPendingDocumentIntake(preview.pending, {
      userDecision: 'save_permanently' });

    expect(policyBefore.policyId).toBe(preview.pending.storagePolicy.policyId);
  });

  it('Upload und Scan nutzen dieselben Decision-Aktionen', async () => {
    setPdfTextExtractorForTests(() => 'Rechnung Betrag: 99,00 EUR');
    const file = createFile(createPayload('%PDF-1.4\nshared-dec\n%%EOF', 'shared-dec.pdf'));
    const upload = await processDocumentFileForPreview(file);
    const scan = await processDocumentFileForPreview(file, { selectedKind: undefined });
    if (!upload.success || !scan.success) return;

    expect(buildPendingDocumentDecisionActions(upload.pending)).toEqual(
      buildPendingDocumentDecisionActions(scan.pending),
    );
  });

  it('mapDecisionToLifecycleIntent mappt nur persistierende Entscheidungen', () => {
    expect(mapDecisionToLifecycleIntent('save_permanently')).toBe('committed');
    expect(mapDecisionToLifecycleIntent('keep_temporarily')).toBe('temp');
    expect(mapDecisionToLifecycleIntent('save_duplicate_anyway')).toBe('committed');
    expect(mapDecisionToLifecycleIntent('discard')).toBeNull();
    expect(mapDecisionToLifecycleIntent('use_existing')).toBeNull();
  });
});

describe('STORAGE-USER-DECISION-BRIDGE-02 i18n DE/TR/BG', () => {
  const requiredKeys = Object.keys(deUserStorageDecision);

  it('DE keys sind in TR und BG vorhanden', () => {
    for (const key of requiredKeys) {
      expect(trUserStorageDecision[key as keyof typeof trUserStorageDecision]).toBeTruthy();
      expect(bgUserStorageDecision[key as keyof typeof bgUserStorageDecision]).toBeTruthy();
    }
  });

  it('Kern-Decision-Labels sind übersetzbar', () => {
    expect(t('userStorageDecision.action.saveDuplicateAnyway', 'de')).toContain('Eintrag');
    expect(t('userStorageDecision.action.keepTemporarily', 'tr')).toContain('Geçici');
    expect(t('userStorageDecision.action.useExisting', 'bg')).toContain('файл');
  });
});
