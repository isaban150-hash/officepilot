import {
  DOCUMENT_FILE_DERIVATIVE_STEP_ERROR_CODES,
  DOCUMENT_FILE_DERIVATIVE_STEP_NOOP_REASONS,
  DOCUMENT_FILE_DERIVATIVE_STEP_OUTCOMES,
  DOCUMENT_FILE_DERIVATIVE_STEP_REGISTRATION_STATUSES,
  POST_IMPORT_DERIVATIVE_STEP_IDS,
  POST_IMPORT_DERIVATIVE_STEP_REPRESENTATION_KIND,
  type DocumentFileDerivativeStepErrorCode,
  type DocumentFileDerivativeStepNoopReason,
  type DocumentFileDerivativeStepOutcome,
  type DocumentFileDerivativeStepOutcomeKind,
  type DocumentFileDerivativeStepRegistrationStatus,
  type PostImportDerivativeStepId,
} from '../types/documentFileDerivativeStepOutcome';
import { DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS } from '../types/documentFileRepresentationBinding';
import {
  findDocumentFileDerivativeStepOutcome,
  getDocumentFileDerivativeStepOutcomeStoreSnapshot,
  replaceDocumentFileDerivativeStepOutcomeStore,
} from './documentFileDerivativeStepOutcomeStoreService';
import { persistAll } from './persistenceService';

const LOG_PREFIX = '[OfficePilot:derivative-step-outcome]';

export type DocumentFileDerivativeStepOutcomeInput = Omit<
  DocumentFileDerivativeStepOutcome,
  'attempt' | 'updatedAt'
> & {
  readonly attempt?: number;
  readonly updatedAt?: string;
};

function isStepId(value: unknown): value is PostImportDerivativeStepId {
  return (
    typeof value === 'string' &&
    (POST_IMPORT_DERIVATIVE_STEP_IDS as readonly string[]).includes(value)
  );
}

function isOutcomeKind(value: unknown): value is DocumentFileDerivativeStepOutcomeKind {
  return (
    typeof value === 'string' &&
    (DOCUMENT_FILE_DERIVATIVE_STEP_OUTCOMES as readonly string[]).includes(value)
  );
}

function isNoopReason(value: unknown): value is DocumentFileDerivativeStepNoopReason {
  return (
    typeof value === 'string' &&
    (DOCUMENT_FILE_DERIVATIVE_STEP_NOOP_REASONS as readonly string[]).includes(value)
  );
}

function isErrorCode(value: unknown): value is DocumentFileDerivativeStepErrorCode {
  return (
    typeof value === 'string' &&
    (DOCUMENT_FILE_DERIVATIVE_STEP_ERROR_CODES as readonly string[]).includes(value)
  );
}

function isRegistrationStatus(
  value: unknown,
): value is DocumentFileDerivativeStepRegistrationStatus {
  return (
    typeof value === 'string' &&
    (DOCUMENT_FILE_DERIVATIVE_STEP_REGISTRATION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Validate and freeze a derivative step outcome record.
 */
export function createDocumentFileDerivativeStepOutcome(
  input: DocumentFileDerivativeStepOutcomeInput,
): DocumentFileDerivativeStepOutcome {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid derivative step outcome');
  }
  if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
    throw new TypeError('Invalid derivative step outcome documentId');
  }
  if (!isStepId(input.stepId)) {
    throw new TypeError('Invalid derivative step outcome stepId');
  }
  if (
    typeof input.representationKind !== 'string' ||
    !(DOCUMENT_FILE_REPRESENTATION_BINDING_KINDS as readonly string[]).includes(
      input.representationKind,
    )
  ) {
    throw new TypeError('Invalid derivative step outcome representationKind');
  }
  if (!isOutcomeKind(input.outcome)) {
    throw new TypeError('Invalid derivative step outcome outcome');
  }
  if (typeof input.sourceFileRefId !== 'string') {
    throw new TypeError('Invalid derivative step outcome sourceFileRefId');
  }
  if (typeof input.sourceMimeType !== 'string') {
    throw new TypeError('Invalid derivative step outcome sourceMimeType');
  }
  if (typeof input.createdFileRef !== 'boolean') {
    throw new TypeError('Invalid derivative step outcome createdFileRef');
  }

  const attempt =
    typeof input.attempt === 'number' && Number.isInteger(input.attempt) && input.attempt >= 1
      ? input.attempt
      : 1;
  const updatedAt =
    typeof input.updatedAt === 'string' && input.updatedAt.trim().length > 0
      ? input.updatedAt
      : new Date().toISOString();

  const record: DocumentFileDerivativeStepOutcome = {
    documentId: input.documentId,
    stepId: input.stepId,
    representationKind: input.representationKind,
    outcome: input.outcome,
    sourceFileRefId: input.sourceFileRefId,
    sourceMimeType: input.sourceMimeType,
    createdFileRef: input.createdFileRef,
    attempt,
    updatedAt,
  };

  if (input.noopReason !== undefined) {
    if (!isNoopReason(input.noopReason)) {
      throw new TypeError('Invalid derivative step outcome noopReason');
    }
    (record as { noopReason?: DocumentFileDerivativeStepNoopReason }).noopReason =
      input.noopReason;
  }
  if (input.errorCode !== undefined) {
    if (!isErrorCode(input.errorCode)) {
      throw new TypeError('Invalid derivative step outcome errorCode');
    }
    (record as { errorCode?: DocumentFileDerivativeStepErrorCode }).errorCode = input.errorCode;
  }
  if (input.registrationStatus !== undefined) {
    if (!isRegistrationStatus(input.registrationStatus)) {
      throw new TypeError('Invalid derivative step outcome registrationStatus');
    }
    (record as { registrationStatus?: DocumentFileDerivativeStepRegistrationStatus }).registrationStatus =
      input.registrationStatus;
  }
  if (input.resultFileRefId !== undefined) {
    if (typeof input.resultFileRefId !== 'string' || input.resultFileRefId.trim().length === 0) {
      throw new TypeError('Invalid derivative step outcome resultFileRefId');
    }
    (record as { resultFileRefId?: string }).resultFileRefId = input.resultFileRefId;
  }

  return Object.freeze(record);
}

interface NormalizedOrchestratorFields {
  readonly outcome: DocumentFileDerivativeStepOutcomeKind;
  readonly noopReason?: DocumentFileDerivativeStepNoopReason;
  readonly errorCode?: DocumentFileDerivativeStepErrorCode;
  readonly registrationStatus?: DocumentFileDerivativeStepRegistrationStatus;
  readonly resultFileRefId?: string;
  readonly createdFileRef: boolean;
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Map an orchestrator return value to durable outcome fields.
 * Never copies error messages, stacks, filenames, or bytes.
 */
export function normalizeDerivativeOrchestrationResult(
  result: unknown,
): NormalizedOrchestratorFields {
  if (result === null || typeof result !== 'object' || !('kind' in result)) {
    return { outcome: 'error', errorCode: 'unknown_result', createdFileRef: false };
  }

  const record = result as Record<string, unknown>;
  const kind = record.kind;

  if (kind === 'noop') {
    const reason = record.reason;
    if (isNoopReason(reason)) {
      return { outcome: 'noop', noopReason: reason, createdFileRef: false };
    }
    return { outcome: 'noop', noopReason: 'encode_plan_unresolved', createdFileRef: false };
  }

  if (kind === 'conflict') {
    return { outcome: 'conflict', createdFileRef: false };
  }

  if (kind === 'error') {
    return { outcome: 'error', errorCode: 'orchestrator_error', createdFileRef: false };
  }

  if (kind === 'persisted') {
    const registration = record.registration;
    const registrationStatus = isRegistrationStatus(registration) ? registration : undefined;
    const resultFileRefId =
      readStringField(record, 'archiveFileRefId') ??
      readStringField(record, 'previewFileRefId') ??
      readStringField(record, 'thumbnailFileRefId');
    const createdFileRef =
      readBooleanField(record, 'createdArchiveFileRef') ??
      readBooleanField(record, 'createdPreviewFileRef') ??
      readBooleanField(record, 'createdThumbnailFileRef') ??
      false;
    return {
      outcome: 'persisted',
      registrationStatus,
      resultFileRefId,
      createdFileRef,
    };
  }

  return { outcome: 'error', errorCode: 'unknown_result', createdFileRef: false };
}

/**
 * Upsert by natural key (documentId + stepId). Increments attempt on every call.
 * Does not persist — caller decides when to persistAll.
 */
export function upsertDocumentFileDerivativeStepOutcome(
  input: Omit<DocumentFileDerivativeStepOutcomeInput, 'attempt' | 'updatedAt'>,
): DocumentFileDerivativeStepOutcome {
  const existing = findDocumentFileDerivativeStepOutcome(input.documentId, input.stepId);
  const next = createDocumentFileDerivativeStepOutcome({
    ...input,
    attempt: (existing?.attempt ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  });

  const current = getDocumentFileDerivativeStepOutcomeStoreSnapshot();
  const index = current.findIndex(
    (entry) => entry.documentId === next.documentId && entry.stepId === next.stepId,
  );
  if (index === -1) {
    replaceDocumentFileDerivativeStepOutcomeStore([...current, next]);
  } else {
    replaceDocumentFileDerivativeStepOutcomeStore([
      ...current.slice(0, index),
      next,
      ...current.slice(index + 1),
    ]);
  }
  return next;
}

/**
 * Record one step outcome from an orchestration result and persist.
 * Failures are logged with stable codes only and never thrown to the caller.
 * Caller supplies source FileRef context to avoid documentService import cycles.
 */
export function recordPostImportDerivativeStepOutcome(input: {
  documentId: string;
  stepId: PostImportDerivativeStepId;
  result: unknown;
  sourceFileRefId: string;
  sourceMimeType: string;
  runnerThrew?: boolean;
}): DocumentFileDerivativeStepOutcome | null {
  try {
    if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
      throw new TypeError('Invalid derivative step outcome documentId');
    }
    if (!isStepId(input.stepId)) {
      throw new TypeError('Invalid derivative step outcome stepId');
    }

    const normalized = input.runnerThrew
      ? ({
          outcome: 'error' as const,
          errorCode: 'runner_threw' as const,
          createdFileRef: false,
        } satisfies NormalizedOrchestratorFields)
      : normalizeDerivativeOrchestrationResult(input.result);

    const recorded = upsertDocumentFileDerivativeStepOutcome({
      documentId: input.documentId,
      stepId: input.stepId,
      representationKind: POST_IMPORT_DERIVATIVE_STEP_REPRESENTATION_KIND[input.stepId],
      outcome: normalized.outcome,
      noopReason: normalized.noopReason,
      errorCode: normalized.errorCode,
      registrationStatus: normalized.registrationStatus,
      sourceFileRefId: input.sourceFileRefId,
      sourceMimeType: input.sourceMimeType,
      resultFileRefId: normalized.resultFileRefId,
      createdFileRef: normalized.createdFileRef,
    });

    if (recorded.outcome === 'error') {
      console.error(LOG_PREFIX, input.stepId, recorded.errorCode ?? 'orchestrator_error');
    }

    persistAll();
    return recorded;
  } catch {
    console.error(LOG_PREFIX, input.stepId, 'outcome_write_failed');
    return null;
  }
}
