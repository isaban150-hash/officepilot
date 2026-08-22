/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4B — intent-freier
 * Prepare/Execute-Pfad.
 *
 * Grundregeln dieses Sprints:
 *  - `prepare` erzeugt den vollständigen Cloud-Request **synchron vor dem
 *    ersten `await`**; danach werden Draft, Setup und Freigabedaten nicht mehr
 *    gelesen.
 *  - `execute` übernimmt weder Request noch Kennung noch Fingerprint aus dem
 *    Arbeitsspeicher des Aufrufers — alles stammt aus IndexedDB.
 *  - Kein LocalStorage-Intent, kein `begin`, kein `complete`, kein Retry.
 *  - Der Legacy-Pfad `finalizeInvoiceDraftWithCloud` bleibt unberührt.
 */
import type { CompanySetup, InvoiceDraft, VorgangInvoice } from '../../types/models';
import type { InvoiceApprovalOptions, InvoiceValidationResult } from '../invoiceValidationService';
import type { InvoiceDraftIdentity } from '../../types/invoiceDraftDurability';
import { isSupabaseConfigured, getSupabaseClient } from '../../lib/supabase';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { getActiveStorageScope } from '../storage/storageScopeService';
import { buildDocumentBlobScopeKey } from '../storage/documentBlobScopeService';
import { getVorgangById, upsertFinalizedInvoiceOnVorgang } from '../vorgangService';
import { archiveOutgoingInvoice } from '../invoiceArchiveService';
import {
  buildInvoiceContentFingerprintFromInvoice,
  buildInvoiceFinalizationCandidate,
  buildInvoiceFinalizationContentFingerprint,
  getOverbillingWarnings,
} from '../invoiceService';
// Als Modul importiert, damit Tests `generateEntityId` gezielt ersetzen können
// — das Produktionsmodul führt dafür keine veränderbare Abhängigkeit.
import * as syncMetaService from '../sync/syncMetaService';
import { loadInvoiceDraftFinalizationPreparation } from './invoiceDraftDurabilityService';
import {
  buildWorkspaceInvoiceFinalizePayload,
  rpcFinalizePreparedWorkspaceInvoice,
  WorkspaceInvoiceCloudError,
} from './workspaceInvoiceCloudService';
import {
  buildActualPreparedResponseProjection,
  buildExpectedPreparedResponseProjection,
} from './invoicePreparedResponseProjection';
import {
  validateInvoiceApprovalContext,
  validatePreparedWorkspaceInvoiceFinalizeRequest,
  INVOICE_APPROVAL_CONTEXT_FORMAT_VERSION,
  INVOICE_APPROVAL_CONTEXT_KIND,
  PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
  PREPARED_FINALIZE_REQUEST_KIND,
  type InvoiceApprovalContextV1,
  type PreparedWorkspaceInvoiceFinalizeRequest,
} from './workspaceInvoiceFinalizeRequestValidator';

export type PrepareInvoiceFinalizationFailure =
  | 'validation_failed'
  | 'vorgang_missing'
  | 'offline_or_unconfigured'
  | 'auth_missing'
  | 'workspace_missing'
  | 'workspace_changed'
  | 'scope_mismatch'
  | 'invalid_candidate'
  | 'invalid_approval_context'
  | 'preparation_failed';

export interface PrepareInvoiceFinalizationInput {
  vorgangId: string;
  draft: InvoiceDraft;
  setup: CompanySetup;
  approvalOptions?: InvoiceApprovalOptions;
  /**
   * Ob die Überbilligung überhaupt bestätigt werden **muss** und welche
   * Positionen betroffen sind, leitet `prepare` selbst aus dem eingefrorenen
   * Entwurf ab. Der Aufrufer bringt allein seine Entscheidung mit.
   */
  overbillingAcknowledged: boolean;
}

export type PrepareInvoiceFinalizationResult =
  | {
      ok: true;
      workspaceId: string;
      sourceScopeKey: string;
      clientInvoiceId: string;
      contentFingerprint: string;
      request: PreparedWorkspaceInvoiceFinalizeRequest;
      approvalContext: InvoiceApprovalContextV1;
    }
  | {
      ok: false;
      reason: PrepareInvoiceFinalizationFailure;
      detail?: string;
      message?: string;
      validation?: InvoiceValidationResult;
    };

/**
 * Cloud-Zustand als Union statt zweier Booleans — der spätere Koordinator
 * entscheidet ausschließlich anhand dieses Werts.
 */
export type PreparedFinalizeCloudState = 'not_committed' | 'unknown' | 'confirmed' | 'conflict';

export type ExecutePreparedFinalizationFailure =
  | 'invalid_identity'
  | 'not_found'
  | 'conflict'
  | 'status_conflict'
  | 'corrupt'
  | 'unsupported_preparation'
  | 'storage_failed'
  | 'request_invalid'
  | 'approval_context_invalid'
  | 'fingerprint_mismatch'
  | 'offline_or_unconfigured'
  | 'auth_missing'
  | 'workspace_missing'
  | 'workspace_changed'
  | 'scope_mismatch'
  | 'rpc_failed'
  | 'idempotency_conflict'
  | 'amendment_state_stale'
  | 'local_persist_failed'
  | 'local_conflict'
  | 'cloud_response_mismatch'
  | 'unexpected_error';

export interface ExecutePreparedFinalizationInput {
  identity: InvoiceDraftIdentity;
  expectedRevision: number;
}

export type ExecutePreparedFinalizationResult =
  | {
      ok: true;
      invoice: VorgangInvoice;
      idempotentReplay: boolean;
      archiveWarning: boolean;
      clientInvoiceId: string;
      contentFingerprint: string;
      expectedRevision: number;
      cloudState: 'confirmed';
    }
  | {
      ok: false;
      reason: ExecutePreparedFinalizationFailure;
      cloudState: PreparedFinalizeCloudState;
      detail?: string;
      message?: string;
      currentRevision?: number;
      validation?: InvoiceValidationResult;
    };

/* -------------------------------------------------------------------------- */
/* Gemeinsame Hilfen                                                          */
/* -------------------------------------------------------------------------- */

async function hasAuthSession(): Promise<boolean> {
  try {
    const client = getSupabaseClient();
    if (!client) return false;
    const { data, error } = await client.auth.getSession();
    return Boolean(!error && data.session);
  } catch {
    return false;
  }
}

function resolveActiveWorkspaceId(): string {
  try {
    return resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
  } catch {
    return '';
  }
}

function resolveActiveScopeKey(): string {
  try {
    return buildDocumentBlobScopeKey(getActiveStorageScope());
  } catch {
    return '';
  }
}

function expectedWorkspaceScopeKey(workspaceId: string): string {
  return buildDocumentBlobScopeKey({ type: 'workspace', workspaceId });
}

/** Rundreise durch JSON — erzeugt genau die Form, die auch gespeichert wird. */
function jsonRoundTrip<T>(value: T): T | null {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Prepare                                                                    */
/* -------------------------------------------------------------------------- */

type SyncPreparation =
  | {
      ok: true;
      workspaceId: string;
      sourceScopeKey: string;
      clientInvoiceId: string;
      contentFingerprint: string;
      request: PreparedWorkspaceInvoiceFinalizeRequest;
      approvalContext: InvoiceApprovalContextV1;
    }
  | {
      ok: false;
      reason: PrepareInvoiceFinalizationFailure;
      detail?: string;
      validation?: InvoiceValidationResult;
    };

/**
 * Vollständig synchron: nach Rückkehr dieser Funktion wird auf `draft`,
 * `setup` und die Freigabedaten nie wieder zugegriffen. Eine Mutation während
 * eines später angehaltenen Auth-Aufrufs kann den vorbereiteten Stand deshalb
 * nicht mehr erreichen.
 */
function buildPreparationSynchronously(input: PrepareInvoiceFinalizationInput): SyncPreparation {
  const { vorgangId, draft, setup } = input;
  const approvalOptions: InvoiceApprovalOptions = { ...(input.approvalOptions ?? {}) };

  if (!getVorgangById(vorgangId)) {
    return { ok: false, reason: 'vorgang_missing' };
  }

  const workspaceId = resolveActiveWorkspaceId();
  if (!workspaceId) return { ok: false, reason: 'workspace_missing' };

  const sourceScopeKey = resolveActiveScopeKey();
  if (!sourceScopeKey || sourceScopeKey !== expectedWorkspaceScopeKey(workspaceId)) {
    return { ok: false, reason: 'scope_mismatch', detail: sourceScopeKey };
  }

  const clientInvoiceId = syncMetaService.generateEntityId('inv');
  if (typeof clientInvoiceId !== 'string' || clientInvoiceId.length === 0) {
    return { ok: false, reason: 'preparation_failed', detail: 'client_invoice_id' };
  }

  const contentFingerprint = buildInvoiceFinalizationContentFingerprint(draft, setup);
  if (!contentFingerprint) {
    return { ok: false, reason: 'preparation_failed', detail: 'fingerprint' };
  }

  const candidate = buildInvoiceFinalizationCandidate(
    vorgangId,
    draft,
    setup,
    clientInvoiceId,
    approvalOptions,
  );
  if (!candidate.ok) {
    if (candidate.reason === 'vorgang_missing') return { ok: false, reason: 'vorgang_missing' };
    return {
      ok: false,
      reason: 'validation_failed',
      validation: candidate.validation,
    };
  }

  /*
   * 01P4B2 — Paritätsprüfung: der fertige Kandidat muss denselben
   * Geschäfts-Fingerprint tragen wie der geprüfte Entwurf. Beide Builder sind
   * an einzelnen Stellen asymmetrisch (etwa `billable`), und eine Abweichung
   * würde sonst erst nach `begin` als `fingerprint_mismatch` auffallen — also
   * an einem Punkt, an dem der Entwurf bereits gesperrt ist.
   */
  let candidateFingerprint: string;
  try {
    candidateFingerprint = buildInvoiceContentFingerprintFromInvoice(candidate.invoice);
  } catch {
    return { ok: false, reason: 'invalid_candidate', detail: 'candidate_fingerprint' };
  }
  if (candidateFingerprint !== contentFingerprint) {
    // Nichts wird repariert und keine Position still entfernt.
    return { ok: false, reason: 'invalid_candidate', detail: 'candidate_fingerprint' };
  }

  // Genau ein Aufruf des Builders — danach ist der Payload eingefroren.
  const rawPayload = buildWorkspaceInvoiceFinalizePayload(candidate.invoice);

  /*
   * Überbilligung wird aus demselben eingefrorenen Entwurf abgeleitet, den
   * auch der Kandidat verwendet — der Aufrufer kann sie weder behaupten noch
   * verschweigen. Die Warnungstexte selbst sind übersetzte Fließtexte und
   * taugen nicht als Nachweis; deshalb eine kanonische Projektion genau der
   * stabilen Rohfelder, aus denen die Warnung entsteht.
   */
  const overbillingWarnings = getOverbillingWarnings(draft);
  const overbillingEvidenceKeys = draft.positions
    .filter((position) => position.billable && position.quantity > position.openQuantity)
    .map(
      (position) =>
        `overbilling:${position.id}:${position.orderPositionId}:${position.quantity}:${position.openQuantity}`,
    );
  if (overbillingEvidenceKeys.length !== overbillingWarnings.length) {
    return { ok: false, reason: 'preparation_failed', detail: 'overbilling_evidence' };
  }

  const approvalContext: InvoiceApprovalContextV1 = {
    kind: INVOICE_APPROVAL_CONTEXT_KIND,
    formatVersion: INVOICE_APPROVAL_CONTEXT_FORMAT_VERSION,
    reverseCharge13bConfirmed: approvalOptions.reverseCharge13bConfirmed === true,
    overbillingRequired: overbillingWarnings.length > 0,
    overbillingAcknowledged: input.overbillingAcknowledged === true,
    overbillingEvidenceKeys:
      overbillingWarnings.length > 0 ? overbillingEvidenceKeys : [],
    archiveCompanyName: typeof setup.companyName === 'string' ? setup.companyName : '',
  };

  const contextCheck = validateInvoiceApprovalContext(jsonRoundTrip(approvalContext), {
    taxStatus: candidate.invoice.taxStatus,
  });
  if (!contextCheck.ok) {
    return { ok: false, reason: 'invalid_approval_context', detail: contextCheck.detail };
  }

  const carrier = jsonRoundTrip({
    kind: PREPARED_FINALIZE_REQUEST_KIND,
    formatVersion: PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
    workspaceId,
    vorgangId,
    clientInvoiceId,
    invoice: candidate.invoice,
    invoicePayload: rawPayload,
  });
  if (!carrier) return { ok: false, reason: 'preparation_failed', detail: 'serialize' };

  const expectedResponseProjectionRawJson = buildExpectedPreparedResponseProjection(
    carrier.invoicePayload,
    clientInvoiceId,
  );
  if (!expectedResponseProjectionRawJson) {
    return { ok: false, reason: 'preparation_failed', detail: 'projection' };
  }

  const requestCheck = validatePreparedWorkspaceInvoiceFinalizeRequest({
    ...carrier,
    expectedResponseProjectionRawJson,
  });
  if (!requestCheck.ok) {
    return { ok: false, reason: 'invalid_candidate', detail: requestCheck.detail };
  }

  return {
    ok: true,
    workspaceId,
    sourceScopeKey,
    clientInvoiceId,
    contentFingerprint,
    request: requestCheck.request,
    approvalContext: contextCheck.approvalContext,
  };
}

export async function prepareInvoiceDraftFinalization(
  input: PrepareInvoiceFinalizationInput,
): Promise<PrepareInvoiceFinalizationResult> {
  let prepared: SyncPreparation;
  try {
    prepared = buildPreparationSynchronously(input);
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid_candidate',
      detail: error instanceof Error ? error.message : 'unknown',
    };
  }
  if (!prepared.ok) return prepared;

  try {
    if (!isSupabaseConfigured()) {
      return {
        ok: false,
        reason: 'offline_or_unconfigured',
        message: 'Cloud ist nicht konfiguriert.',
      };
    }
    if (!(await hasAuthSession())) {
      return { ok: false, reason: 'auth_missing', message: 'Keine gültige Anmeldung.' };
    }

    // Der Kontext muss nach dem Warten noch derselbe sein.
    const workspaceId = resolveActiveWorkspaceId();
    if (!workspaceId) return { ok: false, reason: 'workspace_missing' };
    if (workspaceId !== prepared.workspaceId) {
      return { ok: false, reason: 'workspace_changed', detail: workspaceId };
    }
    const scopeKey = resolveActiveScopeKey();
    if (scopeKey !== prepared.sourceScopeKey) {
      return { ok: false, reason: 'scope_mismatch', detail: scopeKey };
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'preparation_failed',
      detail: error instanceof Error ? error.message : 'unknown',
    };
  }

  return {
    ok: true,
    workspaceId: prepared.workspaceId,
    sourceScopeKey: prepared.sourceScopeKey,
    clientInvoiceId: prepared.clientInvoiceId,
    contentFingerprint: prepared.contentFingerprint,
    request: prepared.request,
    approvalContext: prepared.approvalContext,
  };
}

/* -------------------------------------------------------------------------- */
/* Execute                                                                    */
/* -------------------------------------------------------------------------- */

function fail(
  reason: ExecutePreparedFinalizationFailure,
  cloudState: PreparedFinalizeCloudState,
  extra: { detail?: string; message?: string; currentRevision?: number } = {},
): ExecutePreparedFinalizationResult {
  return { ok: false, reason, cloudState, ...extra };
}

function mapPreparationLoadFailure(
  reason: string,
): ExecutePreparedFinalizationFailure {
  switch (reason) {
    case 'invalid_identity':
    case 'identity_mismatch':
      return 'invalid_identity';
    case 'not_found':
      return 'not_found';
    case 'conflict':
      return 'conflict';
    case 'status_conflict':
      return 'status_conflict';
    case 'unsupported_preparation':
      return 'unsupported_preparation';
    case 'invalid_preparation':
      return 'request_invalid';
    case 'corrupt':
    case 'unsupported_format':
      return 'corrupt';
    default:
      return 'storage_failed';
  }
}

function mapCloudError(
  error: WorkspaceInvoiceCloudError,
): { reason: ExecutePreparedFinalizationFailure; cloudState: PreparedFinalizeCloudState } {
  if (error.code === 'idempotency_conflict') {
    return { reason: 'idempotency_conflict', cloudState: 'conflict' };
  }
  if (error.message.includes('invoice_amendment_state_stale')) {
    return { reason: 'amendment_state_stale', cloudState: 'not_committed' };
  }
  if (error.code === 'auth') return { reason: 'auth_missing', cloudState: 'not_committed' };
  if (error.code === 'rls') return { reason: 'rpc_failed', cloudState: 'not_committed' };
  if (error.code === 'validation') return { reason: 'rpc_failed', cloudState: 'not_committed' };
  if (error.code === 'network') {
    return { reason: 'offline_or_unconfigured', cloudState: 'unknown' };
  }
  // Unbekannter Ausgang: der Server könnte bereits geschrieben haben.
  return { reason: 'rpc_failed', cloudState: 'unknown' };
}

/**
 * Phasenvertrag für unerwartete Fehler: vor dem RPC `not_committed`, ab dem
 * Aufruf bis zu einem eindeutigen Ergebnis `unknown`, danach `confirmed`.
 */
export async function executePreparedInvoiceFinalization(
  input: ExecutePreparedFinalizationInput,
): Promise<ExecutePreparedFinalizationResult> {
  const phase: { state: PreparedFinalizeCloudState } = { state: 'not_committed' };
  try {
    return await runPreparedFinalization(input, phase);
  } catch (error) {
    return fail('unexpected_error', phase.state, {
      message: error instanceof Error ? error.message : 'Unerwarteter Fehler',
    });
  }
}

async function runPreparedFinalization(
  input: ExecutePreparedFinalizationInput,
  phase: { state: PreparedFinalizeCloudState },
): Promise<ExecutePreparedFinalizationResult> {
  const { identity, expectedRevision } = input;

  let loaded;
  try {
    loaded = await loadInvoiceDraftFinalizationPreparation({ identity, expectedRevision });
  } catch {
    return fail('storage_failed', 'not_committed', { detail: 'load' });
  }
  if (!loaded.ok) {
    return fail(mapPreparationLoadFailure(loaded.reason), 'not_committed', {
      detail: loaded.detail,
      currentRevision: loaded.currentRevision,
    });
  }

  const record = loaded.record;
  const finalization = record.finalization;
  if (!finalization) return fail('status_conflict', 'not_committed');

  const requestCheck = validatePreparedWorkspaceInvoiceFinalizeRequest(
    loaded.preparation.request,
  );
  if (!requestCheck.ok) {
    return fail('request_invalid', 'not_committed', { detail: requestCheck.detail });
  }
  const request = requestCheck.request;

  const contextCheck = validateInvoiceApprovalContext(loaded.preparation.approvalContext, {
    taxStatus: request.invoice.taxStatus,
  });
  if (!contextCheck.ok) {
    return fail('approval_context_invalid', 'not_committed', { detail: contextCheck.detail });
  }

  // Der geladene Request muss vollständig zum Datensatz gehören.
  if (
    request.workspaceId !== record.workspaceId ||
    request.vorgangId !== record.vorgangId ||
    request.clientInvoiceId !== finalization.clientInvoiceId ||
    request.invoice.type !== record.invoiceType
  ) {
    return fail('request_invalid', 'not_committed', { detail: 'record_binding' });
  }

  // Zusätzlicher Geschäftsvergleich — kein Ersatz für den Antwortbeweis.
  if (
    buildInvoiceContentFingerprintFromInvoice(request.invoice) !== finalization.contentFingerprint
  ) {
    return fail('fingerprint_mismatch', 'not_committed', { detail: 'prepared_invoice' });
  }
  if (
    buildExpectedPreparedResponseProjection(request.invoicePayload, request.clientInvoiceId) !==
    request.expectedResponseProjectionRawJson
  ) {
    return fail('request_invalid', 'not_committed', { detail: 'projection' });
  }

  if (!isSupabaseConfigured()) {
    return fail('offline_or_unconfigured', 'not_committed', {
      message: 'Cloud ist nicht konfiguriert.',
    });
  }
  if (!(await hasAuthSession())) {
    return fail('auth_missing', 'not_committed', { message: 'Keine gültige Anmeldung.' });
  }

  // Unmittelbar vor dem RPC — kein Firmenname, keine Heuristik, kein Fallback.
  const workspaceId = resolveActiveWorkspaceId();
  if (!workspaceId) return fail('workspace_missing', 'not_committed');
  if (workspaceId !== record.workspaceId) {
    return fail('workspace_changed', 'not_committed', { detail: workspaceId });
  }
  const scopeKey = resolveActiveScopeKey();
  if (scopeKey !== record.sourceScopeKey) {
    return fail('scope_mismatch', 'not_committed', { detail: scopeKey });
  }

  // Ab hier ist ein Cloud-Schreibvorgang möglich.
  phase.state = 'unknown';
  let rpcResult;
  try {
    rpcResult = await rpcFinalizePreparedWorkspaceInvoice({
      workspaceId: request.workspaceId,
      vorgangId: request.vorgangId,
      clientInvoiceId: request.clientInvoiceId,
      invoicePayload: request.invoicePayload,
    });
  } catch (error) {
    if (error instanceof WorkspaceInvoiceCloudError) {
      const mapped = mapCloudError(error);
      return fail(mapped.reason, mapped.cloudState, { message: error.message });
    }
    return fail('rpc_failed', 'unknown', {
      message: error instanceof Error ? error.message : 'Unbekannter RPC-Fehler',
    });
  }

  /* Ab hier steht fest: die Cloud hat geschrieben. */
  phase.state = 'confirmed';
  const raw = rpcResult.rawInvoicePayload;
  const actualProjection = buildActualPreparedResponseProjection(raw);
  if (actualProjection === null || actualProjection !== request.expectedResponseProjectionRawJson) {
    return fail('cloud_response_mismatch', 'confirmed', { detail: 'projection' });
  }
  if (raw.id !== request.clientInvoiceId) {
    return fail('cloud_response_mismatch', 'confirmed', { detail: 'id' });
  }
  if (raw.type !== request.invoice.type) {
    return fail('cloud_response_mismatch', 'confirmed', { detail: 'type' });
  }
  if (raw.status !== 'vorbereitet') {
    return fail('cloud_response_mismatch', 'confirmed', { detail: 'status' });
  }
  const number = typeof raw.number === 'string' ? raw.number : '';
  if (number.trim().length === 0) {
    return fail('cloud_response_mismatch', 'confirmed', { detail: 'number' });
  }
  const sequence = raw.invoiceSequenceNumber;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1) {
    return fail('cloud_response_mismatch', 'confirmed', { detail: 'invoiceSequenceNumber' });
  }
  if (typeof raw.date !== 'string' || raw.date.length === 0) {
    return fail('cloud_response_mismatch', 'confirmed', { detail: 'date' });
  }

  /*
   * Die lokale Rechnung entsteht aus dem vorbereiteten Kandidaten plus
   * ausschließlich den erlaubten Serverfeldern — nie aus der verlustbehafteten
   * Abbildung der Cloud-Antwort.
   */
  const localInvoice: VorgangInvoice = {
    ...request.invoice,
    id: request.clientInvoiceId,
    number,
    invoiceSequenceNumber: sequence,
    status: 'vorbereitet',
    date: raw.date,
    issueDate: typeof raw.issueDate === 'string' ? raw.issueDate : request.invoice.issueDate,
    paymentStatus: 'offen',
    payments: [],
  };

  if (
    buildInvoiceContentFingerprintFromInvoice(localInvoice) !== finalization.contentFingerprint
  ) {
    return fail('fingerprint_mismatch', 'confirmed', { detail: 'local_invoice' });
  }

  let upsert;
  try {
    upsert = upsertFinalizedInvoiceOnVorgang(request.vorgangId, localInvoice);
  } catch (error) {
    return fail('local_persist_failed', 'confirmed', {
      message: error instanceof Error ? error.message : 'Lokale Speicherung fehlgeschlagen.',
    });
  }
  if (!upsert.ok) {
    if (upsert.reason === 'local_persist_failed' || upsert.reason === 'vorgang_missing') {
      return fail('local_persist_failed', 'confirmed', {
        message: 'Lokale Speicherung fehlgeschlagen. Cloud-Freigabe bleibt wiederaufnehmbar.',
        detail: upsert.reason,
      });
    }
    return fail('local_conflict', 'confirmed', { detail: upsert.reason });
  }

  let archived: VorgangInvoice = upsert.invoice;
  let archiveWarning = false;
  try {
    const archiveResult = archiveOutgoingInvoice(
      request.vorgangId,
      upsert.invoice,
      contextCheck.approvalContext.archiveCompanyName,
    );
    if (archiveResult.success) {
      archived = archiveResult.invoice;
    } else {
      archiveWarning = true;
    }
  } catch {
    archiveWarning = true;
  }

  return {
    ok: true,
    invoice: archived,
    idempotentReplay: rpcResult.idempotentReplay,
    archiveWarning,
    clientInvoiceId: request.clientInvoiceId,
    contentFingerprint: finalization.contentFingerprint,
    expectedRevision,
    cloudState: 'confirmed',
  };
}
