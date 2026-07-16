import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import { intakeCachedDocumentFile } from './documentIntakeService';
import { buildInboxItemForDocumentIntake } from './documentIntakeInboxBuilder';
import * as inboxUploadFactory from './inboxUploadFactory';
import {
  confirmPendingDocumentIntake,
  type PendingDocumentIntake,
} from './pendingDocumentIntakeService';
import {
  finishDocumentSaveTrace,
  getDocumentSaveTraceStepNamesForTests,
  resetDocumentSaveTraceForTests,
  setDocumentSaveTraceEnabledForTests,
  startDocumentSaveTrace,
} from './documentSaveTraceService';
import { getInboxItemById, getInboxStoreSnapshot, hydrateInboxStore } from './inboxService';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
import { hydrateDocumentStore } from './documentService';
import {
  getDocumentFileRefById,
  hydrateDocumentFileStore,
} from './documentFileStoreService';
import { hasDocumentBlob } from './storage/documentBlobIndexedDbService';
import { processUploadedDocument } from './intakeWorkflowService';
import type { DocumentClassificationResult } from '../types/models';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';

function sampleBytes(label: string): Uint8Array {
  return new TextEncoder().encode(label);
}

function createPayload(bytes: Uint8Array, fileName: string): CachedDocumentFilePayload {
  return {
    bytes,
    fileName,
    mimeType: 'application/pdf',
    fileSize: bytes.byteLength,
  };
}

function createPreviewClassification(
  overrides: Partial<DocumentClassificationResult> = {},
): DocumentClassificationResult {
  return {
    classifiedKind: 'werkvertrag',
    documentType: 'kundenauftrag',
    processType: 'create_vorgang',
    detectionReasonKey: 'classification.detect.contract',
    title: 'Werkvertrag Preview',
    sender: 'Auftraggeber',
    explanation: 'Preview classification',
    priority: 'mittel',
    deadline: null,
    recommendedAction: 'auftrag_annehmen',
    digitalFolder: { id: 'dig-preview', name: 'Verträge', path: '/vertraege/' },
    paperFiling: { folderId: 'folder-1', register: 'V', label: 'Vertrag' },
    recognizedData: { Dokumentart: 'werkvertrag' },
    officePilotSuggestion: 'Preview',
    nextTaskLabel: 'Prüfen',
    securityHint: 'Test',
    actions: [],
    ...overrides,
  };
}

function createLargeWerkvertragPending(): PendingDocumentIntake {
  const pageTexts = Array.from({ length: 40 }, (_, index) => ({
    pageNumber: index + 1,
    text:
      index % 5 === 0
        ? `${SAMPLE_WERKVERTRAG_TEXT}\nSeite ${index + 1}`
        : `Technische Anlage Windlastberechnung Seite ${index + 1}\n`.repeat(80),
  }));
  const recognizedText = pageTexts.map((page) => page.text).join('\n\n');

  return {
    cachedFile: createPayload(sampleBytes(`LARGE-WV-${recognizedText.length}`), 'werkvertrag-gross.pdf'),
    extraction: {
      recognizedText,
      displayText: recognizedText.slice(0, 200),
      pageTexts,
      extractionMethod: 'pdf_text',
      sourceType: 'pdf',
      confidence: 'high',
    },
    preview: {
      documentTypeLabelKey: 'classifiedKind.werkvertrag',
      previewLines: ['Werkvertrag'],
      previewPartialHint: false,
    },
    previewClassification: createPreviewClassification({
      classifiedKind: 'subunternehmervertrag',
      title: 'Subunternehmervertrag groß',
    }),
    storageRecommendation: {
      level: 'archive_recommended',
      reasonKeys: [],
      evidenceRefs: [],
      requiresUserConfirmation: true,
      confidence: 0.9,
      computedAt: new Date().toISOString(),
    },
    storagePolicy: {
      policyId: 'business_document',
      catalogPolicyId: 'business_document',
      mediaProfile: 'native_pdf',
      classifiedKind: 'subunternehmervertrag',
      policyOverrideApplied: false,
    },
  };
}

describe('CONTRACT-DOCUMENT-SAVE-MAIN-THREAD-FIX-01', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDocumentSaveTraceForTests();
    setDocumentSaveTraceEnabledForTests(true);
    hydrateInboxStore([]);
    hydrateVorgangStore([]);
    hydrateDocumentStore([]);
    hydrateDocumentFileStore([], {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setDocumentSaveTraceEnabledForTests(null);
  });

  it('großer Werkvertrag: Save endet mit intake_success ohne pageTexts-Reklassifikation', async () => {
    const createMockSpy = vi.spyOn(inboxUploadFactory, 'createMockInboxItemFromUpload');
    const pending = createLargeWerkvertragPending();
    const saveTraceId = startDocumentSaveTrace('upload');

    const started = performance.now();
    const result = await confirmPendingDocumentIntake(pending, {
      userDecision: 'save_permanently',
      importSource: 'upload',
      saveTraceId,
    });
    const elapsedMs = performance.now() - started;

    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) return;

    // Save path must stay responsive; heavy multi-page analysis would take far longer.
    expect(elapsedMs).toBeLessThan(2_000);
    // Preview classification reused — no light factory / re-classify on save.
    expect(createMockSpy).not.toHaveBeenCalled();

    const steps = getDocumentSaveTraceStepNamesForTests(saveTraceId);
    expect(steps).toContain('classification_done');
    expect(steps).toContain('persist_all_done');
    expect(steps).toContain('intake_success');

    expect(result.inboxItem.classifiedKind).toBe('subunternehmervertrag');
    expect(result.inboxItem.recognizedData._pageTexts).toBeTruthy();
    expect(result.fileRef.id).toBeTruthy();
    expect(await hasDocumentBlob(result.fileRef.id)).toBe(true);
    expect(getDocumentFileRefById(result.fileRef.id)).toBeTruthy();
    expect(getInboxItemById(result.inboxItem.id)).toBeTruthy();
    expect(getInboxStoreSnapshot().some((item) => item.id === result.inboxItem.id)).toBe(true);

    finishDocumentSaveTrace(saveTraceId);
  });

  it('legt keine OrderPositions vor Nutzerbestätigung an', async () => {
    const pending = createLargeWerkvertragPending();
    const result = await confirmPendingDocumentIntake(pending, {
      userDecision: 'save_permanently',
      importSource: 'scan',
    });
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) return;

    expect(result.inboxItem.vorgangId).toBeUndefined();
    expect(getVorgangById(result.inboxItem.vorgangId ?? '')).toBeUndefined();
  });

  it('Vertragsanalyse auf Detailpfad erst nach Save möglich ohne OrderPositions', async () => {
    const pending = createLargeWerkvertragPending();
    const result = await confirmPendingDocumentIntake(pending, {
      userDecision: 'save_permanently',
      importSource: 'upload',
    });
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) return;

    expect(result.inboxItem.recognizedData._pageTexts).toBeTruthy();
    expect(result.inboxItem.vorgangId).toBeUndefined();

    // Callable after save; may or may not yield positions depending on company relevance.
    const workflow = processUploadedDocument(result.inboxItem.id);
    expect(workflow).not.toBeNull();
    expect(result.inboxItem.vorgangId).toBeUndefined();
  });

  it('Light-Fallback ohne Preview klassifiziert ohne pageTexts', () => {
    const createSpy = vi.spyOn(inboxUploadFactory, 'createMockInboxItemFromUpload');
    const item = buildInboxItemForDocumentIntake({
      sourceFileName: 'direkt.pdf',
      recognizedText: 'Werkvertrag ohne Preview',
      importSource: 'upload',
    });
    expect(item.id).toMatch(/^inbox-upload-/);
    expect(createSpy).toHaveBeenCalled();
    const args = createSpy.mock.calls[0]?.[0];
    expect(args?.pageTexts).toBeUndefined();
  });

  it('Scan und Upload nutzen Preview-Reuse gleich', async () => {
    for (const importSource of ['scan', 'upload'] as const) {
      hydrateInboxStore([]);
      hydrateDocumentFileStore([], {});
      const pending = createLargeWerkvertragPending();
      pending.cachedFile = createPayload(
        sampleBytes(`${importSource}-${Date.now()}`),
        `${importSource}.pdf`,
      );
      const result = await confirmPendingDocumentIntake(pending, {
        userDecision: 'save_permanently',
        importSource,
      });
      expect(result.success).toBe(true);
      if (!result.success || result.duplicate) continue;
      expect(result.inboxItem.importSource).toBe(importSource);
      expect(result.inboxItem.classifiedKind).toBe('subunternehmervertrag');
    }
  });

  it('direkter intake ohne Preview bleibt leicht und speichert pageTexts separat', async () => {
    const createSpy = vi.spyOn(inboxUploadFactory, 'createMockInboxItemFromUpload');
    const pageTexts = [
      { pageNumber: 1, text: 'Seite 1 Vertrag' },
      { pageNumber: 2, text: 'Seite 2 LV' },
    ];
    const result = await intakeCachedDocumentFile(createPayload(sampleBytes('LIGHT-DIRECT'), 'light.pdf'), {
      recognizedText: 'Werkvertrag light',
      pageTexts,
      userDecision: 'save_permanently',
      importSource: 'upload',
    });
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) return;
    expect(createSpy).toHaveBeenCalled();
    expect(createSpy.mock.calls.every((call) => call[0]?.pageTexts === undefined)).toBe(true);
    expect(result.inboxItem.recognizedData._pageTexts).toContain('Seite 2 LV');
  });
});
