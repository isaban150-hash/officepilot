export type DocumentSaveTraceSource = 'scan' | 'upload' | 'test';

export type DocumentSaveTraceStepName =
  | 'save_clicked'
  | 'execute_decision_start'
  | 'execute_decision_resolved'
  | 'execute_decision_rejected'
  | 'navigation_start'
  | 'navigation_done'
  | 'finally_reset_loading'
  | 'confirm_pending_start'
  | 'cached_payload_loaded'
  | 'file_store_start'
  | 'hash_start'
  | 'hash_done'
  | 'indexeddb_write_start'
  | 'indexeddb_write_done'
  | 'file_verify_start'
  | 'file_verify_done'
  | 'file_ref_created'
  | 'inbox_item_build_start'
  | 'classification_start'
  | 'classification_done'
  | 'stage_inbox_start'
  | 'stage_inbox_done'
  | 'persist_all_start'
  | 'persist_all_done'
  | 'cached_file_release_start'
  | 'cached_file_release_done'
  | 'intake_success'
  | 'intake_failure'
  | 'rollback_start'
  | 'rollback_done'
  | 'save_unusually_slow';

export interface DocumentSaveTraceMeta {
  durationMs?: number;
  fileSize?: number;
  pageCount?: number;
  textLength?: number;
  classifiedKind?: string;
  detectionReasonKey?: string;
  success?: boolean;
  errorName?: string;
  errorMessage?: string;
  source?: DocumentSaveTraceSource;
}

export interface DocumentSaveTraceEvent {
  traceId: string;
  step: DocumentSaveTraceStepName;
  atMs: number;
  meta?: DocumentSaveTraceMeta;
}

interface ActiveTrace {
  traceId: string;
  startedAtMs: number;
  source: DocumentSaveTraceSource;
  stepStartedAt: Map<string, number>;
  slowTimer: ReturnType<typeof setTimeout> | null;
}

const SLOW_WARN_MS = 30_000;
const LOG_PREFIX = '[OfficePilot:document-save-trace]';

let enabledOverride: boolean | null = null;
let eventSink: DocumentSaveTraceEvent[] = [];
let activeTraces = new Map<string, ActiveTrace>();

function isDocumentSaveTraceEnabled(): boolean {
  if (enabledOverride != null) return enabledOverride;
  try {
    if (typeof import.meta !== 'undefined') {
      if (import.meta.env?.VITE_DEBUG_DOCUMENT_SAVE_TRACE === 'true') return true;
      if (import.meta.env?.DEV) return true;
      if (import.meta.env?.MODE === 'test') return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function sanitizeErrorMessage(message: string): string {
  const trimmed = message.trim().slice(0, 160);
  // Drop anything that looks like free-form document content.
  if (trimmed.length > 120) {
    return `${trimmed.slice(0, 120)}…`;
  }
  return trimmed;
}

function emit(traceId: string, step: DocumentSaveTraceStepName, meta?: DocumentSaveTraceMeta): void {
  if (!isDocumentSaveTraceEnabled()) return;

  const event: DocumentSaveTraceEvent = {
    traceId,
    step,
    atMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    meta: meta && Object.keys(meta).length > 0 ? { ...meta } : undefined,
  };
  eventSink.push(event);

  const payload = {
    traceId,
    step,
    ...event.meta,
  };
  if (step === 'save_unusually_slow' || step === 'intake_failure' || step === 'execute_decision_rejected') {
    console.warn(LOG_PREFIX, payload);
  } else {
    console.info(LOG_PREFIX, payload);
  }
}

export function startDocumentSaveTrace(
  source: DocumentSaveTraceSource = 'test',
): string {
  const traceId = `contract-save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  if (!isDocumentSaveTraceEnabled()) {
    return traceId;
  }

  const startedAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const slowTimer = setTimeout(() => {
    emit(traceId, 'save_unusually_slow', {
      durationMs: SLOW_WARN_MS,
      source,
      errorMessage: 'Speichervorgang dauert ungewöhnlich lange.',
    });
  }, SLOW_WARN_MS);

  activeTraces.set(traceId, {
    traceId,
    startedAtMs,
    source,
    stepStartedAt: new Map(),
    slowTimer,
  });

  emit(traceId, 'save_clicked', { source });
  return traceId;
}

export function traceStepStart(
  traceId: string | undefined,
  step: DocumentSaveTraceStepName,
  meta?: DocumentSaveTraceMeta,
): void {
  if (!traceId || !isDocumentSaveTraceEnabled()) return;
  const active = activeTraces.get(traceId);
  if (active) {
    active.stepStartedAt.set(step, typeof performance !== 'undefined' ? performance.now() : Date.now());
  }
  emit(traceId, step, meta);
}

export function traceStepEnd(
  traceId: string | undefined,
  startStep: DocumentSaveTraceStepName,
  endStep: DocumentSaveTraceStepName,
  meta?: DocumentSaveTraceMeta,
): void {
  if (!traceId || !isDocumentSaveTraceEnabled()) return;
  const active = activeTraces.get(traceId);
  const started = active?.stepStartedAt.get(startStep);
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const durationMs = started != null ? Math.max(0, Math.round(now - started)) : meta?.durationMs;
  if (active) {
    active.stepStartedAt.delete(startStep);
  }
  emit(traceId, endStep, { ...meta, durationMs });
}

export function traceStep(
  traceId: string | undefined,
  step: DocumentSaveTraceStepName,
  meta?: DocumentSaveTraceMeta,
): void {
  if (!traceId || !isDocumentSaveTraceEnabled()) return;
  emit(traceId, step, meta);
}

export function traceStepError(
  traceId: string | undefined,
  step: DocumentSaveTraceStepName,
  error: unknown,
  meta?: DocumentSaveTraceMeta,
): void {
  if (!traceId || !isDocumentSaveTraceEnabled()) return;
  const errorName =
    error instanceof Error ? error.name : typeof error === 'string' ? 'Error' : 'UnknownError';
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'unknown_error';
  emit(traceId, step, {
    ...meta,
    success: false,
    errorName,
    errorMessage: sanitizeErrorMessage(rawMessage),
  });
}

export function finishDocumentSaveTrace(traceId: string | undefined): void {
  if (!traceId) return;
  const active = activeTraces.get(traceId);
  if (active?.slowTimer) {
    clearTimeout(active.slowTimer);
  }
  activeTraces.delete(traceId);
}

/** Test helpers */
export function setDocumentSaveTraceEnabledForTests(enabled: boolean | null): void {
  enabledOverride = enabled;
}

export function resetDocumentSaveTraceForTests(): void {
  for (const active of activeTraces.values()) {
    if (active.slowTimer) clearTimeout(active.slowTimer);
  }
  activeTraces = new Map();
  eventSink = [];
  enabledOverride = true;
}

export function getDocumentSaveTraceEventsForTests(): DocumentSaveTraceEvent[] {
  return [...eventSink];
}

export function getDocumentSaveTraceStepNamesForTests(traceId?: string): DocumentSaveTraceStepName[] {
  return eventSink
    .filter((event) => (traceId ? event.traceId === traceId : true))
    .map((event) => event.step);
}
