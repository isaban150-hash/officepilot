import { useDocumentBlobDatabaseReset } from '../test/documentBlobTestReset';
/**
 * DUPLIKAT-ABLAGE-GATE-01 — Inbox-Match ≠ Archivdokument; use_existing / confirmFiling Gates.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { computeBufferContentHash } from './documentFileHashService';
import {
  getAllDocuments,
  getDocumentById,
  hydrateDocumentStore,
} from './documentService';
import {
  getInboxItemById,
  getInboxStoreSnapshot,
  hydrateInboxStore,
} from './inboxService';
import { confirmFiling, inboxHasArchiveTruth } from './inboxTaskService';
import {
  executePendingDocumentDecision,
} from './pendingDocumentDecisionService';
import {
  confirmPendingDocumentIntake,
  discardPendingDocumentIntake,
  processDocumentFileForPreview,
} from './pendingDocumentIntakeService';
import { applyStateToStores, buildPersistedStateSnapshot } from './persistenceService';
import { setPdfTextExtractorForTests } from './uploadTextExtractionService';
import {
  resolveAvailableUserStorageDecisions,
  resolvePrimarySuggestedUserStorageDecision,
  validateUserStorageDecision,
} from './userStorageDecisionService';
import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import type { CompanyDocument, InboxItem } from '../types/models';

const SAMPLE_TEXT = 'Subunternehmervertrag Muster GmbH Leistung 1.250,00 EUR';

function createPayload(
  content: string | Uint8Array,
  fileName: string,
): CachedDocumentFilePayload {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return {
    fileName,
    mimeType: 'application/pdf',
    fileSize: bytes.length,
    bytes,
  };
}

function createFile(payload: CachedDocumentFilePayload): File {
  return new File([payload.bytes], payload.fileName, { type: payload.mimeType });
}

function archiveDocument(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-archive-gate-01',
    title: 'Bestehender Subunternehmervertrag',
    category: 'vertrag',
    issuer: 'Muster GmbH',
    recognizedText: SAMPLE_TEXT,
    issueDate: '2026-01-01',
    validUntil: null,
    digitalFolder: { id: 'd1', name: 'Verträge', path: '/Firma/Vertraege/' },
    paperFolder: { folderId: 'f1', register: 'A', label: 'Verträge' },
    tags: ['Vertrag'],
    linkedCompany: 'Test GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  };
}

function openInbox(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-open-gate-01',
    title: 'Offener Eingang',
    sender: 'Muster GmbH',
    documentType: 'sonstiges',
    status: 'neu',
    priority: 'mittel',
    receivedAt: '2026-07-15T10:00:00.000Z',
    deadline: null,
    recommendedAction: 'abheften',
    digitalFolder: { id: 'd1', name: 'Verträge', path: '/Firma/Vertraege/' },
    paperFiling: { folderId: 'f1', register: 'A', label: 'Verträge' },
    recognizedData: {},
    officePilotSuggestion: '',
    nextTaskLabel: '',
    securityHint: '',
    ...overrides,
  };
}

useDocumentBlobDatabaseReset();

describe('DUPLIKAT-ABLAGE-GATE-01', () => {
  afterEach(() => {
    setPdfTextExtractorForTests(null);
  });

  it('Inbox-Match: kein use_existing in verfügbaren Entscheidungen', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const bytes = new TextEncoder().encode('%PDF-1.4\ninbox-match\n%%EOF');
    const hash = await computeBufferContentHash(bytes);
    hydrateInboxStore([openInbox({ sourceFileHash: hash })]);

    const preview = await processDocumentFileForPreview(
      createFile(createPayload(bytes, 'vertrag.pdf')),
    );
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    expect(preview.pending.storageRecommendation.duplicateMatch?.type).toBe('inbox');
    expect(preview.pending.storageRecommendation.reasonKeys).toContain(
      'storageRecommendation.reason.duplicateInInbox',
    );

    const available = resolveAvailableUserStorageDecisions(
      preview.pending.storageRecommendation,
      preview.pending.storagePolicy,
    );
    expect(available).not.toContain('use_existing');
    expect(available).toContain('save_duplicate_anyway');
    expect(resolvePrimarySuggestedUserStorageDecision(preview.pending.storageRecommendation)).toBe(
      'save_duplicate_anyway',
    );

    const validation = validateUserStorageDecision({
      decision: 'use_existing',
      recommendation: preview.pending.storageRecommendation,
      storagePolicy: preview.pending.storagePolicy,
    });
    expect(validation.valid).toBe(false);

    discardPendingDocumentIntake(preview.pending);
  });

  it('use_existing akzeptiert nur echte CompanyDocument-ID', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const bytes = new TextEncoder().encode('%PDF-1.4\ndoc-match\n%%EOF');
    const hash = await computeBufferContentHash(bytes);
    hydrateDocumentStore([
      archiveDocument({ id: 'doc-real-match', sourceFileHash: hash, title: 'Archiv Vertrag' }),
    ]);

    const preview = await processDocumentFileForPreview(
      createFile(createPayload(bytes, 'vertrag.pdf')),
    );
    expect(preview.success).toBe(true);
    if (!preview.success) return;
    expect(preview.pending.storageRecommendation.duplicateMatch?.type).toBe('document');

    const result = await executePendingDocumentDecision(preview.pending, 'use_existing');
    expect(result).toMatchObject({
      outcome: 'navigate_existing',
      match: { type: 'document', id: 'doc-real-match' },
    });
    expect(getDocumentById('doc-real-match')).toBeDefined();
  });

  it('fehlendes Archivdokument → Fehler, Upload bleibt wiederaufnehmbar', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const bytes = new TextEncoder().encode('%PDF-1.4\nstale-doc\n%%EOF');
    const hash = await computeBufferContentHash(bytes);

    const preview = await processDocumentFileForPreview(
      createFile(createPayload(bytes, 'stale.pdf')),
    );
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    // Forge a stale document match without a store entry.
    preview.pending.storageRecommendation = {
      ...preview.pending.storageRecommendation,
      level: 'duplicate_detected',
      duplicateMatch: {
        type: 'document',
        id: 'doc-does-not-exist',
        title: 'Ghost',
      },
      reasonKeys: ['storageRecommendation.reason.duplicateDetected'],
    };

    const pendingBytes = preview.pending.cachedFile.bytes.byteLength;
    const result = await executePendingDocumentDecision(preview.pending, 'use_existing');
    expect(result).toEqual({ success: false, error: 'existing_document_missing' });
    expect(preview.pending.cachedFile.bytes.byteLength).toBe(pendingBytes);
    expect(getInboxStoreSnapshot()).toHaveLength(0);

    // Upload remains resumable — pending was not discarded.
    const saved = await confirmPendingDocumentIntake(preview.pending, {
      importSource: 'upload',
      userDecision: 'save_duplicate_anyway',
    });
    expect(saved.success).toBe(true);
    if (!saved.success || saved.duplicate) return;
    expect(getInboxItemById(saved.inboxItem.id)?.status).toBe('neu');
  });

  it('confirmFiling ohne Archive Truth beendet den Vorgang nicht erfolgreich', () => {
    const item = openInbox({ id: 'inbox-no-archive' });
    hydrateInboxStore([item]);

    const result = confirmFiling(item.id);
    expect(result?.success).toBe(false);
    expect(result?.messageKey).toBe('inbox.toast.filingRequiresArchive');
    expect(inboxHasArchiveTruth(getInboxItemById(item.id)!)).toBe(false);
    expect(getInboxItemById(item.id)?.status).toBe('neu');
  });

  it('confirmFiling mit Archive Truth bleibt erfolgreich', () => {
    const doc = archiveDocument({ id: 'doc-filed-ok' });
    hydrateDocumentStore([doc]);
    const item = openInbox({
      id: 'inbox-with-archive',
      importedToArchive: true,
      archiveDocumentId: doc.id,
    });
    hydrateInboxStore([item]);

    const result = confirmFiling(item.id);
    expect(result?.success).toBe(true);
    expect(getInboxItemById(item.id)?.status).toBe('abgelegt');
  });

  it('Reload: Inbox ohne Archiv bleibt neu; Document-Match bleibt auffindbar', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const bytes = new TextEncoder().encode('%PDF-1.4\nreload-doc\n%%EOF');
    const hash = await computeBufferContentHash(bytes);
    const doc = archiveDocument({
      id: 'doc-reload-visible',
      sourceFileHash: hash,
      title: 'Reload Archiv Vertrag',
    });
    hydrateDocumentStore([doc]);

    const preview = await processDocumentFileForPreview(
      createFile(createPayload(bytes, 'reload.pdf')),
    );
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    const useExisting = await executePendingDocumentDecision(preview.pending, 'use_existing');
    expect(useExisting).toMatchObject({
      outcome: 'navigate_existing',
      match: { id: 'doc-reload-visible' },
    });

    const openItem = openInbox({
      id: 'inbox-still-open',
      sourceFileHash: 'other-hash',
    });
    hydrateInboxStore([openItem]);
    expect(confirmFiling(openItem.id)?.success).toBe(false);

    const snapshot = buildPersistedStateSnapshot();
    hydrateInboxStore([]);
    hydrateDocumentStore([]);
    applyStateToStores(snapshot);

    expect(getDocumentById('doc-reload-visible')?.title).toBe('Reload Archiv Vertrag');
    expect(getAllDocuments().some((d) => d.id === 'doc-reload-visible')).toBe(true);
    expect(getInboxItemById('inbox-still-open')?.status).toBe('neu');
  });

  it('bestehender Document-Match: Workflow unverändert funktionsfähig', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const bytes = new TextEncoder().encode('%PDF-1.4\nkeep-doc-path\n%%EOF');
    const hash = await computeBufferContentHash(bytes);
    hydrateDocumentStore([
      archiveDocument({ id: 'doc-keep-path', sourceFileHash: hash }),
    ]);

    const preview = await processDocumentFileForPreview(
      createFile(createPayload(bytes, 'keep.pdf')),
    );
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    const available = resolveAvailableUserStorageDecisions(
      preview.pending.storageRecommendation,
      preview.pending.storagePolicy,
    );
    expect(available).toEqual(['use_existing', 'save_duplicate_anyway', 'discard']);
    expect(resolvePrimarySuggestedUserStorageDecision(preview.pending.storageRecommendation)).toBe(
      'use_existing',
    );

    const result = await executePendingDocumentDecision(preview.pending, 'use_existing');
    expect(result).toMatchObject({
      outcome: 'navigate_existing',
      match: { type: 'document', id: 'doc-keep-path' },
    });
  });
});
