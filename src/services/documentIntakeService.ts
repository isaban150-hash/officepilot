import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import {
  loadCachedDocumentFileFromUpload,
  releaseCachedDocumentFile,
} from './cachedDocumentFileService';
import type { DocumentFileRef } from '../types/documentFileRef';
import type { DocumentClassificationResult, InboxItem } from '../types/models';
import { validateUploadFile } from './documentUploadValidation';
import { findDuplicateByContentHash } from './documentDuplicateService';
import { extractDocumentTextFromCache } from './ocrDocumentService';
import type { CreateInboxFromUploadOptions } from './inboxUploadFactory';
import { buildInboxItemForDocumentIntake } from './documentIntakeInboxBuilder';
import { stageInboxItem, removeStagedInboxItemById } from './inboxService';
import { itemNeedsDeferredWorkflowAnalysis } from './inboxWorkflowAnalysisKey';
import {
  commitIntakeDocumentAnalysis,
  scheduleIntakeDocumentAnalysisCommit,
} from './intakeAnalysisCommitService';
import {
  applyDocumentFileRefCommittedPromotionInMemory,
  storeDocumentFileFromCachedPayload,
  removeDocumentFileStoreEntry,
  revertDocumentFileRefPromotionInMemory,
  DocumentBlobStorageError,
  hasStoredOriginalDocumentFile,
} from './documentFileStoreService';
import { hasDocumentBlob } from './storage/documentBlobIndexedDbService';
import type { DocumentBlobStorageErrorCode } from './storage/documentBlobIndexedDbService';
import * as persistenceService from './persistenceService';
import type { DocumentUploadValidationError } from '../types/uploadedDocument';
import {
  isPersistingUserStorageDecision,
  type PersistingUserStorageDecision,
} from '../types/userStorageDecision';
import { mapDecisionToLifecycleIntent } from './userStorageDecisionService';
import { alignCreditNoteIntakeItemWithPageOne } from './document/creditNotePageTruth';
import { resolveMainDocumentPageScope } from './document/mainDocumentPageScope';
import { classifyDocument } from './documentClassificationService';
import {
  traceStep,
  traceStepEnd,
  traceStepError,
  traceStepStart,
} from './documentSaveTraceService';

export type DocumentIntakeErrorCode =
  | DocumentUploadValidationError
  | 'file_read_failed'
  | 'storage_failed'
  | 'hash_failed'
  | 'persist_failed'
  | 'navigation_failed'
  | 'existing_document_missing'
  | DocumentBlobStorageErrorCode;

export type DocumentIntakeResult =
  | {
      success: true;
      duplicate: false;
      inboxItem: InboxItem;
      fileRef: DocumentFileRef;
    }
  | {
      success: true;
      duplicate: true;
      fileRef: DocumentFileRef;
      existing: ReturnType<typeof findDuplicateByContentHash>;
    }
  | {
      success: false;
      error: DocumentIntakeErrorCode;
    };

function mapStorageError(error: unknown): DocumentIntakeErrorCode {
  if (error instanceof DocumentBlobStorageError) {
    return error.code;
  }
  if (error instanceof Error) {
    if (error.message === 'hash_failed') return 'hash_failed';
    if (error.message === 'storage_failed') return 'storage_failed';
  }
  return 'storage_failed';
}

async function rollbackFailedIntakeAttempt(input: {
  inboxItemId: string;
  createdFileRef: boolean;
  fileRefId: string;
  localDataKey: string;
  /** Complete pre-promotion ref when this intake promoted temp → committed. */
  promotedFrom?: DocumentFileRef | null;
  saveTraceId?: string;
}): Promise<void> {
  traceStepStart(input.saveTraceId, 'rollback_start');
  removeStagedInboxItemById(input.inboxItemId);
  // Undo the in-memory promotion first: a reused ref must return to its exact
  // previous state, and only a ref created here may be removed afterwards.
  if (input.promotedFrom) {
    revertDocumentFileRefPromotionInMemory(input.promotedFrom);
  }
  if (input.createdFileRef) {
    await removeDocumentFileStoreEntry(input.fileRefId, input.localDataKey);
  }
  traceStepEnd(input.saveTraceId, 'rollback_start', 'rollback_done');
}

export interface DocumentIntakeOptions extends CreateInboxFromUploadOptions {
  userDecision?: PersistingUserStorageDecision;
  allowDuplicateIntake?: boolean;
  /** Diagnostic only — never persisted on documents */
  saveTraceId?: string;
  /** Reuse preview classification; skips heavy pageTexts re-classification on save */
  previewClassification?: DocumentClassificationResult;
}

export async function intakeCachedDocumentFile(
  payload: CachedDocumentFilePayload,
  options: DocumentIntakeOptions = {},
): Promise<DocumentIntakeResult> {
  const saveTraceId = options.saveTraceId;
  const userDecision: PersistingUserStorageDecision = options.userDecision ?? 'save_permanently';
  if (!isPersistingUserStorageDecision(userDecision)) {
    traceStep(saveTraceId, 'intake_failure', {
      success: false,
      errorName: 'navigation_failed',
      errorMessage: 'navigation_failed',
    });
    return { success: false, error: 'navigation_failed' };
  }

  const lifecycleIntent = mapDecisionToLifecycleIntent(userDecision);
  const allowDuplicateIntake =
    options.allowDuplicateIntake ?? userDecision === 'save_duplicate_anyway';
  const validation = validateUploadFile(
    new File([payload.bytes], payload.fileName, { type: payload.mimeType }),
  );
  if (!validation.valid) {
    traceStep(saveTraceId, 'intake_failure', {
      success: false,
      errorName: validation.error,
      errorMessage: validation.error,
      fileSize: payload.bytes.byteLength,
    });
    return { success: false, error: validation.error };
  }

  let fileRef: DocumentFileRef;
  let createdFileRef = false;
  try {
    const stored = await storeDocumentFileFromCachedPayload(payload, {
      lifecycleIntent: lifecycleIntent ?? 'committed',
      saveTraceId,
    });
    fileRef = stored.fileRef;
    createdFileRef = stored.created;
  } catch (error) {
    traceStepError(saveTraceId, 'intake_failure', error, {
      fileSize: payload.bytes.byteLength,
    });
    return { success: false, error: mapStorageError(error) };
  }

  const originalStored = await hasStoredOriginalDocumentFile(fileRef, [{ type: 'guest' }]);
  if (!originalStored) {
    if (createdFileRef) {
      await removeDocumentFileStoreEntry(fileRef.id, fileRef.localDataKey);
    }
    traceStep(saveTraceId, 'intake_failure', {
      success: false,
      errorName: 'storage_failed',
      errorMessage: 'original_not_stored',
    });
    return { success: false, error: 'storage_failed' };
  }

  if (fileRef.storageType === 'indexeddb' && !(await hasDocumentBlob(fileRef.id))) {
    if (createdFileRef) {
      await removeDocumentFileStoreEntry(fileRef.id, fileRef.localDataKey);
    }
    traceStep(saveTraceId, 'intake_failure', {
      success: false,
      errorName: 'storage_failed',
      errorMessage: 'blob_missing',
    });
    return { success: false, error: 'storage_failed' };
  }

  const duplicate = findDuplicateByContentHash(fileRef.contentHash);
  if (duplicate && !allowDuplicateIntake) {
    traceStep(saveTraceId, 'intake_success', {
      success: true,
      fileSize: fileRef.fileSize,
    });
    return { success: true, duplicate: true, fileRef, existing: duplicate };
  }

  let recognizedText = options.recognizedText;
  let pageTextsJson: string | undefined;
  let intakePageTexts: DocumentIntakeOptions['pageTexts'];
  if (recognizedText === undefined) {
    try {
      const extraction = await extractDocumentTextFromCache(payload);
      recognizedText = extraction.recognizedText.trim() || undefined;
      if (extraction.pageTexts?.length) {
        pageTextsJson = JSON.stringify(extraction.pageTexts);
        intakePageTexts = extraction.pageTexts;
      }
    } catch {
      recognizedText = undefined;
    }
  } else if (options.pageTexts?.length) {
    pageTextsJson = JSON.stringify(options.pageTexts);
    intakePageTexts = options.pageTexts;
  }

  const pageCount = options.pageTexts?.length ?? 0;
  const textLength = recognizedText?.length ?? 0;

  traceStepStart(saveTraceId, 'inbox_item_build_start', {
    pageCount,
    textLength,
    fileSize: payload.bytes.byteLength,
  });
  // Classification on save is light: reuse preview result or classify without pageTexts.
  traceStepStart(saveTraceId, 'classification_start', {
    pageCount,
    textLength,
    detectionReasonKey: options.previewClassification
      ? 'preview_classification_reused'
      : 'light_classification_no_page_texts',
  });
  /*
   * EINGANG-02A-3 — die Vorschau-Klassifikation kennt keine Seiten. Ist an
   * einem institutionellen Schreiben eine Fremdanlage sicher abgegrenzt, wird
   * hier mit Seitentexten klassifiziert (nur die Hauptseiten zählen) statt die
   * Vorschau über den Gesamttext zu übernehmen. Sonst bleibt alles wie bisher.
   */
  const seitenScope = resolveMainDocumentPageScope(intakePageTexts?.map((page) => page.text ?? ''));
  const previewClassification =
    seitenScope && seitenScope.attachmentPageNumbers.length > 0 && recognizedText
      ? classifyDocument({
          sourceFileName: options.sourceFileName ?? payload.fileName,
          recognizedText,
          pageTexts: intakePageTexts,
          ...(options.titleHint ? { titleHint: options.titleHint } : {}),
          ...(options.senderHint ? { senderHint: options.senderHint } : {}),
          ...(options.kind ? { kindHint: options.kind } : {}),
        })
      : options.previewClassification;
  let classified: InboxItem;
  try {
    classified = buildInboxItemForDocumentIntake({
      sourceFileName: options.sourceFileName ?? payload.fileName,
      kind: options.kind,
      recognizedText,
      titleHint: options.titleHint,
      senderHint: options.senderHint,
      mailImportId: options.mailImportId,
      importSource: options.importSource,
      emailOrigin: options.emailOrigin,
      inboxItemId: options.inboxItemId,
      previewClassification,
    });
  } catch (error) {
    // Trace only — do not alter product error handling beyond rethrow.
    traceStepError(saveTraceId, 'intake_failure', error, { pageCount, textLength });
    throw error;
  }
  /*
   * EINGANG-01D-2 Paritätsfix 1 — die Vorschau-Klassifikation läuft ohne
   * Seitentexte. Bei einer Gutschrift mit Seitenstruktur folgen Frist,
   * Fristart und Aufgabenvorlage deshalb hier Seite 1 (01D-1-Regel) —
   * keine erneute Klassifikation, keine Wirkung auf andere Dokumentarten.
   */
  classified = alignCreditNoteIntakeItemWithPageOne(classified, { recognizedText, pageTexts: intakePageTexts });
  traceStepEnd(saveTraceId, 'classification_start', 'classification_done', {
    pageCount,
    textLength,
    classifiedKind: classified.classifiedKind,
    detectionReasonKey: options.previewClassification?.detectionReasonKey,
  });

  traceStepStart(saveTraceId, 'stage_inbox_start');
  const inboxItem = stageInboxItem({
    ...classified,
    recognizedData: {
      ...classified.recognizedData,
      ...(pageTextsJson ? { _pageTexts: pageTextsJson } : {}),
    },
    isNewUpload: true,
    importSource: options.importSource ?? 'upload',
    fileRefId: fileRef.id,
    sourceFileHash: fileRef.contentHash,
    sourceFileName: fileRef.originalFileName,
  });
  traceStepEnd(saveTraceId, 'stage_inbox_start', 'stage_inbox_done');

  /**
   * UPLOAD-DRAFT-RESUME-01B0 — a reused temp ref must not survive a final save.
   * The transition runs in memory only, so the InboxItem and the committed
   * FileRef reach storage through the single persistAll below.
   */
  let promotedFrom: DocumentFileRef | null = null;
  if (lifecycleIntent === 'committed' && fileRef.lifecycleStatus !== 'committed') {
    const transition = applyDocumentFileRefCommittedPromotionInMemory(fileRef.id);
    if (!transition.success) {
      removeStagedInboxItemById(inboxItem.id);
      traceStep(saveTraceId, 'intake_failure', {
        success: false,
        errorName: 'storage_failed',
        errorMessage: transition.error,
      });
      return { success: false, error: 'storage_failed' };
    }
    if (!transition.alreadyCommitted) {
      promotedFrom = transition.previous;
    }
    fileRef = transition.fileRef;
  }

  traceStepStart(saveTraceId, 'persist_all_start');
  const persistResult = persistenceService.persistAll();
  if (!persistResult.success) {
    traceStep(saveTraceId, 'intake_failure', {
      success: false,
      errorName: 'persist_failed',
      errorMessage: 'persist_failed',
    });
    await rollbackFailedIntakeAttempt({
      inboxItemId: inboxItem.id,
      createdFileRef,
      fileRefId: fileRef.id,
      localDataKey: fileRef.localDataKey,
      promotedFrom,
      saveTraceId,
    });
    return { success: false, error: 'persist_failed' };
  }
  traceStepEnd(saveTraceId, 'persist_all_start', 'persist_all_done');

  /*
   * EINGANG-01D-1 — die Einschätzung wird beim Übernehmen festgeschrieben,
   * nicht erst beim ersten Öffnen der Detailseite. Sonst fehlte sie auf einem
   * Zweitgerät für jeden nie geöffneten Eingang — und dort lässt sie sich ohne
   * den lokal gebliebenen Volltext nicht gleichwertig neu berechnen.
   *
   * Derselbe Schreibweg wie beim Öffnen (`onlyIfMissing`), dieselbe
   * deterministische Analyse, keine AI. Der Eingang ist zu diesem Zeitpunkt
   * bereits gespeichert; scheitert das Festschreiben, bleibt alles wie bisher
   * (die Detailseite holt es nach) — nie ein halber Fachzustand.
   *
   * Grosse Dokumente (dieselbe Schwelle wie auf der Detailseite) werden erst
   * nach dem Zeichnen analysiert: Speichern bleibt reaktionsschnell
   * (CONTRACT-DOCUMENT-SAVE-MAIN-THREAD-FIX-01), festgeschrieben wird trotzdem
   * ohne Öffnen — mit Zeitgeber-Absicherung und Recovery nach dem Laden
   * (`intakeAnalysisCommitService`).
   */
  if (itemNeedsDeferredWorkflowAnalysis(inboxItem)) {
    scheduleIntakeDocumentAnalysisCommit(inboxItem.id);
  } else {
    commitIntakeDocumentAnalysis(inboxItem.id);
  }

  traceStepStart(saveTraceId, 'cached_file_release_start');
  releaseCachedDocumentFile(payload);
  traceStepEnd(saveTraceId, 'cached_file_release_start', 'cached_file_release_done');

  traceStep(saveTraceId, 'intake_success', {
    success: true,
    fileSize: fileRef.fileSize,
    pageCount,
    textLength,
    classifiedKind: inboxItem.classifiedKind,
  });
  return { success: true, duplicate: false, inboxItem, fileRef };
}

export async function intakeDocumentFile(
  file: File,
  options: DocumentIntakeOptions = {},
): Promise<DocumentIntakeResult> {
  const loaded = await loadCachedDocumentFileFromUpload(file);
  if (!loaded.success) {
    return { success: false, error: loaded.error };
  }
  return intakeCachedDocumentFile(loaded.payload, options);
}
