import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import { intakeCachedDocumentFile } from './documentIntakeService';
import * as inboxUploadFactory from './inboxUploadFactory';
import { DocumentBlobStorageError } from './documentFileStoreService';
import * as persistenceService from './persistenceService';
import * as documentBlobIndexedDbService from './storage/documentBlobIndexedDbService';
import {
  confirmPendingDocumentIntake,
  type PendingDocumentIntake,
} from './pendingDocumentIntakeService';
import type { DocumentClassificationResult } from '../types/models';
import {
  finishDocumentSaveTrace,
  getDocumentSaveTraceEventsForTests,
  getDocumentSaveTraceStepNamesForTests,
  resetDocumentSaveTraceForTests,
  setDocumentSaveTraceEnabledForTests,
  startDocumentSaveTrace,
  traceStep,
} from './documentSaveTraceService';
import { hydrateInboxStore } from './inboxService';
import { hydrateVorgangStore } from './vorgangService';
import { hydrateDocumentStore } from './documentService';
import { hydrateDocumentFileStore } from './documentFileStoreService';

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

function assertNoSensitiveLogContent(events: ReturnType<typeof getDocumentSaveTraceEventsForTests>): void {
  const serialized = JSON.stringify(events);
  expect(serialized).not.toMatch(/Müller|Hauptstr|IBAN|DE89|OCR-VOLLTEXT|Vertragssumme 5070/i);
  for (const event of events) {
    if (event.meta?.errorMessage) {
      expect(event.meta.errorMessage.length).toBeLessThanOrEqual(160);
    }
  }
}

describe('CONTRACT-DOCUMENT-SAVE-TRACE-01', () => {
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
    finishDocumentSaveTrace(undefined);
    setDocumentSaveTraceEnabledForTests(null);
  });

  it('erfolgreicher Save: Hauptschritte in Reihenfolge bis intake_success', async () => {
    const saveTraceId = startDocumentSaveTrace('test');
    const result = await intakeCachedDocumentFile(createPayload(sampleBytes('SAVE-OK'), 'vertrag.pdf'), {
      importSource: 'upload',
      recognizedText: 'Werkvertrag Leistungspositionen',
      pageTexts: [
        { pageNumber: 1, text: 'Werkvertrag' },
        { pageNumber: 2, text: 'LV Positionen' },
      ],
      saveTraceId,
      userDecision: 'save_permanently',
    });

    expect(result.success).toBe(true);
    const steps = getDocumentSaveTraceStepNamesForTests(saveTraceId);
    expect(steps[0]).toBe('save_clicked');
    expect(steps).toContain('file_store_start');
    expect(steps).toContain('hash_done');
    expect(steps).toContain('file_ref_created');
    expect(steps).toContain('classification_start');
    expect(steps).toContain('classification_done');
    expect(steps).toContain('stage_inbox_done');
    expect(steps).toContain('persist_all_done');
    expect(steps).toContain('cached_file_release_done');
    expect(steps).toContain('intake_success');

    const order = [
      'file_store_start',
      'classification_start',
      'classification_done',
      'stage_inbox_start',
      'persist_all_start',
      'persist_all_done',
      'intake_success',
    ];
    let lastIndex = -1;
    for (const step of order) {
      const index = steps.indexOf(step);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }

    assertNoSensitiveLogContent(getDocumentSaveTraceEventsForTests());
    finishDocumentSaveTrace(saveTraceId);
  });

  it('Klassifikationsfehler: classification_start ohne classification_done, intake_failure', async () => {
    vi.spyOn(inboxUploadFactory, 'createMockInboxItemFromUpload').mockImplementation(() => {
      throw new Error('classification_boom');
    });

    const saveTraceId = startDocumentSaveTrace('test');
    await expect(
      intakeCachedDocumentFile(createPayload(sampleBytes('SAVE-CLASS-FAIL'), 'vertrag.pdf'), {
        recognizedText: 'Werkvertrag',
        pageTexts: [{ pageNumber: 1, text: 'x' }],
        saveTraceId,
        userDecision: 'save_permanently',
      }),
    ).rejects.toThrow('classification_boom');

    const steps = getDocumentSaveTraceStepNamesForTests(saveTraceId);
    expect(steps).toContain('classification_start');
    expect(steps).not.toContain('classification_done');
    expect(steps).toContain('intake_failure');
    finishDocumentSaveTrace(saveTraceId);
  });

  it('IndexedDB-Fehler: file_store_start und intake_failure', async () => {
    vi.spyOn(documentBlobIndexedDbService, 'saveDocumentBlob').mockRejectedValue(
      new DocumentBlobStorageError('blob_write_failed'),
    );

    const saveTraceId = startDocumentSaveTrace('test');
    const result = await intakeCachedDocumentFile(createPayload(sampleBytes('SAVE-IDB-FAIL'), 'vertrag.pdf'), {
      recognizedText: 'Werkvertrag',
      saveTraceId,
      userDecision: 'save_permanently',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('blob_write_failed');
    }
    const steps = getDocumentSaveTraceStepNamesForTests(saveTraceId);
    expect(steps).toContain('file_store_start');
    expect(steps).toContain('indexeddb_write_start');
    expect(steps).toContain('intake_failure');
    assertNoSensitiveLogContent(getDocumentSaveTraceEventsForTests());
    finishDocumentSaveTrace(saveTraceId);
  });

  it('persistAll-Fehler: persist_all_start ohne persist_all_done, Failure + Rollback', async () => {
    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: {
        reason: 'quota_exceeded',
      },
    });

    const saveTraceId = startDocumentSaveTrace('test');
    const result = await intakeCachedDocumentFile(createPayload(sampleBytes('SAVE-PERSIST-FAIL'), 'vertrag.pdf'), {
      recognizedText: 'Werkvertrag',
      pageTexts: [{ pageNumber: 1, text: 'LV' }],
      saveTraceId,
      userDecision: 'save_permanently',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('persist_failed');
    }
    const steps = getDocumentSaveTraceStepNamesForTests(saveTraceId);
    expect(steps).toContain('persist_all_start');
    expect(steps).not.toContain('persist_all_done');
    expect(steps).toContain('intake_failure');
    expect(steps).toContain('rollback_start');
    expect(steps).toContain('rollback_done');
    finishDocumentSaveTrace(saveTraceId);
  });

  it('Datenschutz: keine OCR-Inhalte in Trace-Events', async () => {
    const secretText =
      'Auftraggeber Müller Bau GmbH Hauptstr. 12 IBAN DE89370400440532013000 Vertragssumme 5070 OCR-VOLLTEXT';
    const saveTraceId = startDocumentSaveTrace('test');
    await intakeCachedDocumentFile(createPayload(sampleBytes('SAVE-PRIVACY'), 'vertrag.pdf'), {
      recognizedText: secretText,
      pageTexts: [{ pageNumber: 1, text: secretText }],
      saveTraceId,
      userDecision: 'save_permanently',
    });

    assertNoSensitiveLogContent(getDocumentSaveTraceEventsForTests());
    const events = getDocumentSaveTraceEventsForTests().filter((event) => event.traceId === saveTraceId);
    const withTextLength = events.find((event) => event.meta?.textLength != null);
    expect(withTextLength?.meta?.textLength).toBe(secretText.length);
    finishDocumentSaveTrace(saveTraceId);
  });

  it('confirmPendingDocumentIntake nutzt denselben Trace-Helper (Scan/Upload-Pfad)', async () => {
    const previewClassification: DocumentClassificationResult = {
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
      processType: 'create_vorgang',
      detectionReasonKey: 'classification.detect.contract',
      title: 'Werkvertrag Trace',
      sender: 'Test',
      explanation: 'Trace preview',
      priority: 'mittel',
      deadline: null,
      recommendedAction: 'auftrag_annehmen',
      digitalFolder: { id: 'dig-1', name: 'Test', path: '/test/' },
      paperFiling: { folderId: 'folder-1', register: 'A', label: 'Test' },
      recognizedData: { Dokumentart: 'werkvertrag' },
      officePilotSuggestion: 'Trace',
      nextTaskLabel: 'Prüfen',
      securityHint: 'Test',
      actions: [],
    };
    const pending: PendingDocumentIntake = {
      cachedFile: createPayload(sampleBytes('PENDING-TRACE'), 'scan-vertrag.pdf'),
      extraction: {
        recognizedText: 'Werkvertrag Subunternehmer',
        displayText: 'Werkvertrag Subunternehmer',
        pageTexts: [{ pageNumber: 1, text: 'Werkvertrag' }],
        extractionMethod: 'pdf_text',
        sourceType: 'pdf',
        confidence: 'high',
      },
      preview: {
        documentTypeLabelKey: 'classifiedKind.werkvertrag',
        previewLines: ['Werkvertrag'],
        previewPartialHint: false,
      },
      previewClassification,
      storageRecommendation: {
        level: 'archive_recommended',
        reasonKeys: [],
        evidenceRefs: [],
        requiresUserConfirmation: true,
        confidence: 0.8,
        computedAt: new Date().toISOString(),
      },
      storagePolicy: {
        policyId: 'business_document',
        catalogPolicyId: 'business_document',
        mediaProfile: 'native_pdf',
        classifiedKind: 'werkvertrag',
        policyOverrideApplied: false,
      },
    };

    const saveTraceId = startDocumentSaveTrace('scan');
    const result = await confirmPendingDocumentIntake(pending, {
      userDecision: 'save_permanently',
      importSource: 'scan',
      saveTraceId,
    });
    expect(result.success).toBe(true);

    const steps = getDocumentSaveTraceStepNamesForTests(saveTraceId);
    expect(steps).toContain('confirm_pending_start');
    expect(steps).toContain('cached_payload_loaded');
    expect(steps).toContain('intake_success');

    const uploadTraceId = startDocumentSaveTrace('upload');
    await confirmPendingDocumentIntake(
      {
        ...pending,
        cachedFile: createPayload(sampleBytes('PENDING-TRACE-UPLOAD'), 'upload-vertrag.pdf'),
      },
      {
        userDecision: 'save_permanently',
        importSource: 'upload',
        saveTraceId: uploadTraceId,
      },
    );
    expect(getDocumentSaveTraceStepNamesForTests(uploadTraceId)).toContain('confirm_pending_start');
    finishDocumentSaveTrace(saveTraceId);
    finishDocumentSaveTrace(uploadTraceId);
  });

  it('UI-Schritte: save_clicked → execute → finally ohne Produktänderung', () => {
    const saveTraceId = startDocumentSaveTrace('upload');
    traceStep(saveTraceId, 'execute_decision_start');
    traceStep(saveTraceId, 'execute_decision_resolved', { success: true });
    traceStep(saveTraceId, 'navigation_start');
    traceStep(saveTraceId, 'navigation_done');
    traceStep(saveTraceId, 'finally_reset_loading');
    finishDocumentSaveTrace(saveTraceId);

    expect(getDocumentSaveTraceStepNamesForTests(saveTraceId)).toEqual([
      'save_clicked',
      'execute_decision_start',
      'execute_decision_resolved',
      'navigation_start',
      'navigation_done',
      'finally_reset_loading',
    ]);
  });
});
