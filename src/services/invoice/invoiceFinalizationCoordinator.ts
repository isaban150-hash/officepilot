/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4D2A — lokaler Start-Coordinator.
 *
 * Er führt Preflight, Prepare, Fingerprintprüfung, lokale Abschlussprüfung,
 * `begin`, `execute` und `complete` in **einem** tablokalen Queue-Lauf aus.
 * Es gibt in diesem Sprint **keinen** Resume-Pfad und **keine** Anbindung an
 * RechnungPage — die Startfunktion wird produktiv noch nicht aufgerufen.
 */
import type { AppPersistedState, VorgangInvoice } from '../../types/models';
import { buildPersistedStateSnapshot } from '../persistenceService';
import {
  buildInvoiceContentFingerprintFromInvoice,
  matchesPersistedInvoiceContentFingerprint,
} from '../invoiceService';
import {
  archiveOutgoingInvoice,
  isGeneratedInvoiceDocumentSyncSilent,
  syncGeneratedInvoiceDocumentToCloud,
} from '../invoiceArchiveService';
import { inspectInvoiceFinalizeIntentsForOrigin } from './invoiceFinalizeIntentService';
import {
  buildInvoicePayloadV1,
  validatePreparedWorkspaceInvoiceFinalizeRequest,
  type PreparedWorkspaceInvoiceFinalizeRequest,
} from './workspaceInvoiceFinalizeRequestValidator';
import { buildActualPreparedResponseProjection } from './invoicePreparedResponseProjection';
import type { InvoiceApprovalOptions } from '../invoiceValidationService';
import type {
  InvoiceDraftIdentity,
  InvoiceDraftLoadFailure,
  InvoiceDraftPreparationLoadFailure,
} from '../../types/invoiceDraftDurability';
import {
  executePreparedInvoiceFinalization,
  prepareInvoiceDraftFinalization,
  type ExecutePreparedFinalizationFailure,
  type PreparedFinalizeCloudState,
  type PrepareInvoiceFinalizationFailure,
} from './invoicePreparedFinalizeService';
import {
  recheckInvoiceFinalizationLocalGuardsWithinSyncOperation,
  runInvoiceFinalizationCloudReconciliationWithinSyncOperation,
  runInvoiceFinalizationPreflightWithinSyncOperation,
  type InvoiceFinalizationPreflightFailure,
} from './invoiceFinalizationPreflightService';
import {
  beginInvoiceDraftFinalization,
  completeInvoiceDraftFinalization,
  loadInvoiceDraftFinalizationPreparation,
  loadInvoiceDraftRecord,
  loadInvoiceDraftRecordByLocator,
} from './invoiceDraftDurabilityService';
import { runQueuedSyncOperation, type SyncOperationLease } from '../sync/syncOperationQueue';

export type InvoiceFinalizationCoordinatorFailure =
  | InvoiceFinalizationPreflightFailure
  | PrepareInvoiceFinalizationFailure
  | ExecutePreparedFinalizationFailure
  | 'fingerprint_drift'
  | 'invalid_finalization'
  | 'finalization_mismatch'
  | 'invalid_preparation'
  | 'unsupported_format'
  | 'identity_mismatch'
  | 'storage_unavailable'
  | 'transaction_failed'
  | 'committed_but_unverified'
  | 'complete_failed';

export type InvoiceFinalizationRecovery = 'retry_allowed' | 'reload_required' | 'blocked';

export interface StartInvoiceDraftFinalizationInput {
  identity: InvoiceDraftIdentity;
  expectedRevision: number;
  approvalOptions?: InvoiceApprovalOptions;
  overbillingAcknowledged: boolean;
}

export type StartInvoiceDraftFinalizationResult =
  | {
      ok: true;
      invoice: VorgangInvoice;
      clientInvoiceId: string;
      contentFingerprint: string;
      idempotentReplay: boolean;
      archiveWarning: boolean;
      revision: number;
      cloudState: 'confirmed';
    }
  | {
      ok: false;
      reason: InvoiceFinalizationCoordinatorFailure;
      recovery: InvoiceFinalizationRecovery;
      cloudState: PreparedFinalizeCloudState;
      detail?: string;
      message?: string;
      currentRevision?: number;
      existingInvoiceId?: string;
      /** Nur nach nachweislich dauerhaftem `begin`. */
      clientInvoiceId?: string;
    };

export type InvoiceFinalizationResumeDecision =
  | 'already_finalized'
  | 'completed_local'
  | 'completed_cloud_pull'
  | 'finalized';

export interface ResumeInvoiceDraftFinalizationInput {
  identity: InvoiceDraftIdentity;
}

export type ResumeInvoiceDraftFinalizationResult =
  | {
      ok: true;
      decision: InvoiceFinalizationResumeDecision;
      clientInvoiceId: string;
      revision: number;
      archiveWarning: boolean;
      invoice?: VorgangInvoice;
      idempotentReplay?: boolean;
    }
  | {
      ok: false;
      reason: InvoiceFinalizationCoordinatorFailure | 'projection_mismatch';
      recovery: InvoiceFinalizationRecovery;
      cloudState: PreparedFinalizeCloudState;
      detail?: string;
      message?: string;
      currentRevision?: number;
      existingInvoiceId?: string;
      clientInvoiceId?: string;
    };

/**
 * Setzt einen dauerhaft gespeicherten `finalizing`-Datensatz fort — ohne neue
 * Kennung, ohne neuen Request, ohne `prepare` und ohne `begin`. Der gesamte
 * Ablauf liegt in **einem** tablokalen Queue-Lauf.
 */
export async function resumeInvoiceDraftFinalization(
  input: ResumeInvoiceDraftFinalizationInput,
): Promise<ResumeInvoiceDraftFinalizationResult> {
  try {
    return await runQueuedSyncOperation((lease) => runResume(input.identity, lease));
  } catch (error) {
    return {
      ok: false,
      reason: 'unexpected_error',
      recovery: 'blocked',
      cloudState: 'not_committed',
      detail: error instanceof Error ? error.message : 'unknown',
    };
  }
}

function resumeFail(
  reason: ResumeFailureReason,
  extra: {
    recovery?: InvoiceFinalizationRecovery;
    cloudState?: PreparedFinalizeCloudState;
    detail?: string;
    message?: string;
    currentRevision?: number;
    existingInvoiceId?: string;
    clientInvoiceId?: string;
  } = {},
): ResumeInvoiceDraftFinalizationResult {
  return {
    ok: false,
    reason,
    recovery: extra.recovery ?? 'blocked',
    cloudState: extra.cloudState ?? 'not_committed',
    detail: extra.detail,
    message: extra.message,
    currentRevision: extra.currentRevision,
    existingInvoiceId: extra.existingInvoiceId,
    clientInvoiceId: extra.clientInvoiceId,
  };
}

type ResumeFailureReason = InvoiceFinalizationCoordinatorFailure | 'projection_mismatch';

/** Vollständiger Switch — kein unbekannter String erreicht die Fehlerunion. */
function mapLocatorLoadFailure(reason: InvoiceDraftLoadFailure): ResumeFailureReason {
  switch (reason) {
    case 'invalid_identity':
      return 'invalid_identity';
    case 'not_found':
      return 'not_found';
    case 'unsupported_format':
      return 'unsupported_format';
    case 'corrupt':
      return 'corrupt';
    case 'identity_mismatch':
      return 'identity_mismatch';
    case 'storage_unavailable':
      return 'storage_unavailable';
    case 'transaction_failed':
      return 'transaction_failed';
    case 'storage_failed':
      return 'storage_failed';
    default:
      return 'unexpected_error';
  }
}

function mapPreparationLoadFailure(
  reason: InvoiceDraftPreparationLoadFailure,
): ResumeFailureReason {
  switch (reason) {
    case 'invalid_identity':
      return 'invalid_identity';
    case 'not_found':
      return 'not_found';
    case 'identity_mismatch':
      return 'identity_mismatch';
    case 'unsupported_format':
      return 'unsupported_format';
    case 'conflict':
      return 'conflict';
    case 'status_conflict':
      return 'status_conflict';
    case 'corrupt':
      return 'corrupt';
    case 'invalid_preparation':
      return 'invalid_preparation';
    case 'unsupported_preparation':
      return 'unsupported_preparation';
    case 'storage_unavailable':
      return 'storage_unavailable';
    case 'transaction_failed':
      return 'transaction_failed';
    case 'storage_failed':
      return 'storage_failed';
    default:
      return 'unexpected_error';
  }
}

function mapReconciliationFailure(
  reason: InvoiceFinalizationPreflightFailure,
): ResumeFailureReason {
  switch (reason) {
    case 'pull_failed':
    case 'pull_incomplete':
    case 'merge_conflict':
    case 'persist_failed':
    case 'workspace_changed':
    case 'workspace_missing':
    case 'scope_mismatch':
    case 'vorgang_missing':
    case 'offline_or_unconfigured':
    case 'auth_missing':
    case 'storage_failed':
    case 'unexpected_error':
      return reason;
    default:
      return 'unexpected_error';
  }
}

type LocalProof =
  | { kind: 'proven'; invoice: VorgangInvoice }
  | { kind: 'none' }
  | {
      kind: 'blocked';
      reason: ResumeFailureReason;
      detail?: string;
      existingInvoiceId?: string;
    };

/**
 * Vollständiger lokaler Nachweis: Kennung, Vorgang, Typ, Geschäfts-Fingerprint
 * **und** die exakt rekonstruierte Antwortprojektion.
 */
function proveLocalInvoice(input: {
  identity: InvoiceDraftIdentity;
  clientInvoiceId: string;
  contentFingerprint: string;
  request: PreparedWorkspaceInvoiceFinalizeRequest;
}): LocalProof {
  const { identity, clientInvoiceId, contentFingerprint, request } = input;
  let snapshot: AppPersistedState;
  try {
    snapshot = buildPersistedStateSnapshot();
  } catch (error) {
    return {
      kind: 'blocked',
      reason: 'storage_failed',
      detail: error instanceof Error ? error.message : 'snapshot',
    };
  }
  const vorgang = (snapshot.vorgaenge ?? []).find((entry) => entry.id === identity.vorgangId);
  if (!vorgang) return { kind: 'blocked', reason: 'vorgang_missing' };

  const invoices = vorgang.invoices ?? [];
  for (const invoice of invoices) {
    let fingerprint: string;
    try {
      fingerprint = buildInvoiceContentFingerprintFromInvoice(invoice);
    } catch (error) {
      return {
        kind: 'blocked',
        reason: 'fingerprint_failed',
        detail: error instanceof Error ? error.message : `invoice:${invoice.id}`,
      };
    }

    if (invoice.id !== clientInvoiceId) {
      // Derselbe Geschäftsinhalt unter fremder Kennung bleibt ein Verdacht.
      if (fingerprint === contentFingerprint) {
        return {
          kind: 'blocked',
          reason: 'possible_existing_invoice',
          existingInvoiceId: invoice.id,
        };
      }
      continue;
    }

    if (invoice.type !== request.invoice.type) {
      return { kind: 'blocked', reason: 'finalization_mismatch', detail: 'type' };
    }
    if (fingerprint !== contentFingerprint) {
      return { kind: 'blocked', reason: 'finalization_mismatch', detail: 'fingerprint' };
    }

    const payload = buildInvoicePayloadV1(invoice);
    const projection = payload ? buildActualPreparedResponseProjection(payload) : null;
    if (projection === null) {
      return { kind: 'blocked', reason: 'projection_mismatch', detail: 'not_projectable' };
    }
    if (projection !== request.expectedResponseProjectionRawJson) {
      return { kind: 'blocked', reason: 'projection_mismatch', detail: 'projection' };
    }
    return { kind: 'proven', invoice };
  }

  return { kind: 'none' };
}

/**
 * SINGLE-FINAL-INVOICE-INVARIANT-01D — höchstens eine Schlussrechnung je Vorgang.
 *
 * Rein und ohne Speicherzugriff, damit die Regel einzeln prüfbar bleibt.
 *
 * Zwei Feinheiten, die den ganzen Guard tragen:
 *
 *   * **Die eigene Kennung ist ausgenommen.** Ein Wiederaufnahmelauf nach
 *     erfolgreichem RPC findet die eben angelegte Rechnung im Vorgang — sie
 *     darf nicht als „zweite" gelten, sonst bräche jedes Resume.
 *   * **Keine Storno-Ausnahme.** `cancelledAt` verändert `status` nicht;
 *     Client und Server bleiben konsistent zur heutigen Semantik.
 *
 * Der Statusfilter entspricht `hasSchlussrechnung` und dem Serverguard.
 */
export function findConflictingFinalInvoice(
  invoices: readonly VorgangInvoice[],
  invoiceType: VorgangInvoice['type'],
  clientInvoiceId: string,
): VorgangInvoice | null {
  if (invoiceType !== 'schluss') return null;
  return (
    invoices.find(
      (invoice) =>
        invoice.type === 'schluss' &&
        (invoice.status === 'vorbereitet' || invoice.status === 'versendet') &&
        invoice.id !== clientInvoiceId,
    ) ?? null
  );
}

/**
 * Intent-Lage im Wiederaufnahmefall. Es wird ausschließlich
 * `inspectInvoiceFinalizeIntentsForOrigin` verwendet — keine zweite
 * Schlüsselsyntax, keine eigene LocalStorage-Auswertung, kein Schreiben.
 */
function checkResumeIntents(input: {
  identity: InvoiceDraftIdentity;
  clientInvoiceId: string;
  contentFingerprint: string;
}):
  | { ok: true }
  | { ok: false; reason: ResumeFailureReason; detail?: string; existingInvoiceId?: string } {
  const { identity, clientInvoiceId, contentFingerprint } = input;
  const scan = inspectInvoiceFinalizeIntentsForOrigin();
  if (!scan.ok) {
    const reason: ResumeFailureReason =
      scan.reason === 'storage_unavailable'
        ? 'intent_storage_unavailable'
        : scan.reason === 'scan_changed'
          ? 'intent_scan_changed'
          : scan.reason === 'corrupt'
            ? 'intent_corrupt'
            : 'intent_scan_failed';
    return { ok: false, reason, detail: scan.detail };
  }

  let snapshot: AppPersistedState;
  try {
    snapshot = buildPersistedStateSnapshot();
  } catch {
    return { ok: false, reason: 'storage_failed', detail: 'snapshot' };
  }
  const vorgang = (snapshot.vorgaenge ?? []).find((entry) => entry.id === identity.vorgangId);
  const invoices = vorgang?.invoices ?? [];

  for (const entry of scan.entries) {
    const intent = entry.intent;
    if (intent.workspaceId !== identity.workspaceId) continue;
    if (intent.vorgangId !== identity.vorgangId) continue;

    if (intent.clientInvoiceId === clientInvoiceId) {
      /*
       * Die eigene Kennung muss zum gespeicherten Inhalt passen.
       * 01C: Ein vor der Umstellung geschriebener Intent trägt die Altform;
       * genau diese eine Differenz wird toleriert, keine andere.
       */
      if (!matchesPersistedInvoiceContentFingerprint(intent.contentFingerprint, contentFingerprint)) {
        return { ok: false, reason: 'legacy_intent_conflict', detail: 'fingerprint' };
      }
      continue;
    }

    if (matchesPersistedInvoiceContentFingerprint(intent.contentFingerprint, contentFingerprint)) {
      return {
        ok: false,
        reason: 'possible_existing_invoice',
        detail: 'foreign_intent',
        existingInvoiceId: intent.clientInvoiceId,
      };
    }

    // Ein älterer Intent gilt nur als geklärt, wenn er lokal exakt aufgelöst ist.
    const match = invoices.find((invoice) => invoice.id === intent.clientInvoiceId);
    if (!match) {
      return { ok: false, reason: 'legacy_intent_unresolved', detail: intent.clientInvoiceId };
    }
    let matchFingerprint: string;
    try {
      matchFingerprint = buildInvoiceContentFingerprintFromInvoice(match);
    } catch {
      return { ok: false, reason: 'fingerprint_failed', detail: intent.clientInvoiceId };
    }
    if (!matchesPersistedInvoiceContentFingerprint(intent.contentFingerprint, matchFingerprint)) {
      return { ok: false, reason: 'legacy_intent_conflict', detail: intent.clientInvoiceId };
    }
  }

  return { ok: true };
}

async function runResume(
  identity: InvoiceDraftIdentity,
  lease: SyncOperationLease,
): Promise<ResumeInvoiceDraftFinalizationResult> {
  /* 1. Zustand ausschließlich aus dem gespeicherten Datensatz. */
  const loaded = await loadInvoiceDraftRecordByLocator({
    sourceScopeKey: identity.sourceScopeKey,
    workspaceId: identity.workspaceId,
    vorgangId: identity.vorgangId,
    invoiceType: identity.invoiceType,
  });
  if (!loaded.ok) {
    return resumeFail(mapLocatorLoadFailure(loaded.reason), { detail: loaded.detail });
  }
  const record = loaded.record;
  if (record.status === 'active') {
    return resumeFail('status_conflict', { detail: 'active' });
  }
  if (record.status === 'finalized') {
    return {
      ok: true,
      decision: 'already_finalized',
      clientInvoiceId: record.finalization?.clientInvoiceId ?? '',
      revision: record.revision,
      archiveWarning: record.finalization?.archiveWarning === true,
    };
  }

  /* 2. Vorbereitung strikt laden — corrupt und unsupported blockieren. */
  const preparation = await loadInvoiceDraftFinalizationPreparation({
    identity,
    expectedRevision: record.revision,
  });
  if (!preparation.ok) {
    return resumeFail(mapPreparationLoadFailure(preparation.reason), {
      detail: preparation.detail,
      currentRevision: preparation.currentRevision,
      clientInvoiceId: record.finalization?.clientInvoiceId,
    });
  }

  const finalization = preparation.record.finalization;
  if (!finalization) return resumeFail('status_conflict', { detail: 'finalization' });
  const clientInvoiceId = finalization.clientInvoiceId;
  const contentFingerprint = finalization.contentFingerprint;
  const finalizingRevision = preparation.record.revision;

  const requestCheck = validatePreparedWorkspaceInvoiceFinalizeRequest(
    preparation.preparation.request,
  );
  if (!requestCheck.ok) {
    return resumeFail('request_invalid', { detail: requestCheck.detail, clientInvoiceId });
  }
  const request = requestCheck.request;
  const approvalContext = preparation.preparation.approvalContext as {
    archiveCompanyName?: unknown;
  };
  const archiveCompanyName =
    typeof approvalContext?.archiveCompanyName === 'string'
      ? approvalContext.archiveCompanyName
      : '';

  /* 3. Beschädigte Intent-Lage blockiert sofort. */
  const firstIntents = checkResumeIntents({ identity, clientInvoiceId, contentFingerprint });
  if (!firstIntents.ok) {
    return resumeFail(firstIntents.reason, {
      detail: firstIntents.detail,
      existingInvoiceId: firstIntents.existingInvoiceId,
      clientInvoiceId,
    });
  }

  /* 4. Lokalen Vollnachweis prüfen. */
  const localProof = proveLocalInvoice({ identity, clientInvoiceId, contentFingerprint, request });
  if (localProof.kind === 'blocked') {
    return resumeFail(localProof.reason, {
      detail: localProof.detail,
      existingInvoiceId: localProof.existingInvoiceId,
      clientInvoiceId,
    });
  }
  if (localProof.kind === 'proven') {
    return finishFromProvenInvoice({
      identity,
      invoice: localProof.invoice,
      clientInvoiceId,
      contentFingerprint,
      finalizingRevision,
      archiveCompanyName,
      decision: 'completed_local',
      cloudState: 'confirmed',
    });
  }

  /* 5. Ohne lokalen Nachweis: vollständiger Cloud-Abgleich. */
  const reconciliation = await runInvoiceFinalizationCloudReconciliationWithinSyncOperation(
    { identity },
    lease,
  );
  if (!reconciliation.ok) {
    return resumeFail(mapReconciliationFailure(reconciliation.reason), {
      detail: reconciliation.detail,
      recovery: recoveryForReconciliation(reconciliation.reason),
      clientInvoiceId,
    });
  }

  /* 6. Danach Intents und Rechnungen erneut prüfen. */
  const secondIntents = checkResumeIntents({ identity, clientInvoiceId, contentFingerprint });
  if (!secondIntents.ok) {
    return resumeFail(secondIntents.reason, {
      detail: secondIntents.detail,
      existingInvoiceId: secondIntents.existingInvoiceId,
      clientInvoiceId,
    });
  }
  const afterPull = proveLocalInvoice({ identity, clientInvoiceId, contentFingerprint, request });
  if (afterPull.kind === 'blocked') {
    return resumeFail(afterPull.reason, {
      detail: afterPull.detail,
      existingInvoiceId: afterPull.existingInvoiceId,
      clientInvoiceId,
    });
  }
  if (afterPull.kind === 'proven') {
    return finishFromProvenInvoice({
      identity,
      invoice: afterPull.invoice,
      clientInvoiceId,
      contentFingerprint,
      finalizingRevision,
      archiveCompanyName,
      decision: 'completed_cloud_pull',
      cloudState: 'confirmed',
    });
  }

  /* 7. Weder lokal noch in der Cloud: gespeicherten Request erneut senden. */
  const executed = await executePreparedInvoiceFinalization({
    identity,
    expectedRevision: finalizingRevision,
  });
  if (!executed.ok) {
    return resumeFail(executed.reason, {
      recovery: recoveryForExecute(executed.reason, executed.cloudState),
      cloudState: executed.cloudState,
      detail: executed.detail,
      message: executed.message,
      currentRevision: executed.currentRevision,
      clientInvoiceId,
    });
  }

  const completed = await completeInvoiceDraftFinalization({
    identity,
    expectedRevision: finalizingRevision,
    clientInvoiceId,
    contentFingerprint,
    finalizedInvoiceId: executed.invoice.id,
    archiveWarning: executed.archiveWarning,
  });
  if (!completed.ok) {
    const unverified = completed.reason === 'committed_but_unverified';
    return resumeFail(unverified ? 'committed_but_unverified' : 'complete_failed', {
      recovery: unverified ? 'reload_required' : 'blocked',
      cloudState: 'confirmed',
      detail: unverified ? 'complete' : completed.reason,
      currentRevision: completed.currentRevision,
      clientInvoiceId,
    });
  }

  return {
    ok: true,
    decision: 'finalized',
    clientInvoiceId,
    revision: completed.record.revision,
    archiveWarning: executed.archiveWarning,
    invoice: executed.invoice,
    idempotentReplay: executed.idempotentReplay,
  };
}

/** Archiv-Recovery und Abschluss für eine nachgewiesene lokale Rechnung. */
async function finishFromProvenInvoice(input: {
  identity: InvoiceDraftIdentity;
  invoice: VorgangInvoice;
  clientInvoiceId: string;
  contentFingerprint: string;
  finalizingRevision: number;
  archiveCompanyName: string;
  decision: InvoiceFinalizationResumeDecision;
  cloudState: PreparedFinalizeCloudState;
}): Promise<ResumeInvoiceDraftFinalizationResult> {
  const {
    identity,
    invoice,
    clientInvoiceId,
    contentFingerprint,
    finalizingRevision,
    archiveCompanyName,
    decision,
  } = input;

  /*
   * Die Archivierung ist idempotent: ein vorhandenes Dokument wird nur
   * verknüpft. Die Warnung stammt ausschließlich aus diesem Aufruf — nie aus
   * einem fehlenden Feld.
   */
  let archived: VorgangInvoice = invoice;
  let archiveWarning = false;
  try {
    const result = archiveOutgoingInvoice(identity.vorgangId, invoice, archiveCompanyName);
    if (result.success) {
      archived = result.invoice;
      /*
       * 05C1B — dieser Pfad ist produktiv erreichbar (RechnungPage) und
       * erzeugt selbst Archivdokumente. Er muss deshalb genauso pushen wie der
       * delegierte Pfad; sonst bliebe genau hier ein Dokument lokal liegen.
       *
       * Lokal zuerst: An dieser Stelle steht bereits fest, dass Dokument und
       * Rechnungs-Link dauerhaft gespeichert sind.
       */
      const cloudOutcome = await syncGeneratedInvoiceDocumentToCloud(result.document);
      if (!isGeneratedInvoiceDocumentSyncSilent(cloudOutcome)) {
        archiveWarning = true;
      }
    } else {
      archiveWarning = true;
    }
  } catch {
    archiveWarning = true;
  }

  const completed = await completeInvoiceDraftFinalization({
    identity,
    expectedRevision: finalizingRevision,
    clientInvoiceId,
    contentFingerprint,
    finalizedInvoiceId: invoice.id,
    archiveWarning,
  });
  if (!completed.ok) {
    const unverified = completed.reason === 'committed_but_unverified';
    return resumeFail(unverified ? 'committed_but_unverified' : 'complete_failed', {
      recovery: unverified ? 'reload_required' : 'blocked',
      cloudState: 'confirmed',
      detail: unverified ? 'complete' : completed.reason,
      currentRevision: completed.currentRevision,
      clientInvoiceId,
    });
  }

  return {
    ok: true,
    decision,
    clientInvoiceId,
    revision: completed.record.revision,
    archiveWarning,
    invoice: archived,
  };
}

/** Fehler **vor** einem nachweislich dauerhaften `begin`: nie eine Kennung. */
function failBeforeBegin(
  reason: InvoiceFinalizationCoordinatorFailure,
  extra: {
    detail?: string;
    message?: string;
    currentRevision?: number;
    existingInvoiceId?: string;
    recovery?: InvoiceFinalizationRecovery;
  } = {},
): StartInvoiceDraftFinalizationResult {
  return {
    ok: false,
    reason,
    recovery: extra.recovery ?? 'blocked',
    cloudState: 'not_committed',
    detail: extra.detail,
    message: extra.message,
    currentRevision: extra.currentRevision,
    existingInvoiceId: extra.existingInvoiceId,
  };
}

/** Inhalts- und Identitätskonflikte sind dauerhaft — nie wiederholbar. */
const PERMANENT_EXECUTE_FAILURES = new Set<ExecutePreparedFinalizationFailure>([
  'idempotency_conflict',
  'cloud_response_mismatch',
  'local_conflict',
  'request_invalid',
  'approval_context_invalid',
  'fingerprint_mismatch',
  'corrupt',
  'unsupported_preparation',
  'amendment_state_stale',
  'invalid_identity',
  'not_found',
]);

/** Vorübergehend gestörte Voraussetzungen — später erneut **Resume**. */
const TRANSIENT_PRECONDITION_FAILURES = new Set<ExecutePreparedFinalizationFailure>([
  'offline_or_unconfigured',
  'auth_missing',
  'workspace_missing',
  'workspace_changed',
  'scope_mismatch',
  'storage_failed',
]);

/**
 * Gemeinsamer Vertrag für Start **und** Resume. `retry_allowed` bedeutet nach
 * einem dauerhaften `begin` ausschließlich: Resume später erneut aufrufen —
 * niemals einen neuen Start und niemals eine neue Kennung.
 */
function recoveryForExecute(
  reason: ExecutePreparedFinalizationFailure,
  cloudState: PreparedFinalizeCloudState,
): InvoiceFinalizationRecovery {
  if (PERMANENT_EXECUTE_FAILURES.has(reason)) return 'blocked';
  if (cloudState === 'conflict') return 'blocked';
  if (cloudState === 'unknown') return 'reload_required';
  // Bestätigte Antwort ohne dauerhaften Konflikt: zuerst neu laden.
  if (cloudState === 'confirmed') return 'reload_required';
  if (TRANSIENT_PRECONDITION_FAILURES.has(reason)) return 'retry_allowed';
  if (reason === 'conflict' || reason === 'status_conflict') return 'reload_required';
  return 'blocked';
}

/** Fail-closed: unbekannte Reconciliation-Gründe blockieren. */
function recoveryForReconciliation(
  reason: InvoiceFinalizationPreflightFailure,
): InvoiceFinalizationRecovery {
  switch (reason) {
    case 'pull_failed':
    case 'persist_failed':
    case 'workspace_changed':
    case 'workspace_missing':
    case 'scope_mismatch':
    case 'offline_or_unconfigured':
    case 'auth_missing':
    case 'storage_failed':
      return 'retry_allowed';
    default:
      return 'blocked';
  }
}

/**
 * Startet die Finalisierung eines **aktiven** Entwurfs. Kein Resume-Pfad, keine
 * Anbindung an RechnungPage — diese Funktion wird produktiv noch nicht
 * aufgerufen.
 */
export async function startInvoiceDraftFinalization(
  input: StartInvoiceDraftFinalizationInput,
): Promise<StartInvoiceDraftFinalizationResult> {
  try {
    // Genau ein Queue-Lauf für den vollständigen Ablauf bis `complete`.
    return await runQueuedSyncOperation((lease) => runStart(input, lease));
  } catch (error) {
    return failBeforeBegin('unexpected_error', {
      detail: error instanceof Error ? error.message : 'unknown',
    });
  }
}

async function runStart(
  input: StartInvoiceDraftFinalizationInput,
  lease: SyncOperationLease,
): Promise<StartInvoiceDraftFinalizationResult> {
  const { identity, expectedRevision } = input;

  /* 1. Preflight — Cloud-Abgleich, Persistenz, Draft- und Setup-Snapshot. */
  const preflight = await runInvoiceFinalizationPreflightWithinSyncOperation(
    { identity, expectedRevision },
    lease,
  );
  if (!preflight.ok) {
    return failBeforeBegin(preflight.reason, {
      detail: preflight.detail,
      currentRevision: preflight.currentRevision,
      existingInvoiceId: preflight.existingInvoiceId,
    });
  }

  /* 2. Prepare — ausschließlich mit dem Snapshot des Preflights. */
  const prepared = await prepareInvoiceDraftFinalization({
    vorgangId: identity.vorgangId,
    draft: preflight.draft,
    setup: preflight.setupSnapshot,
    approvalOptions: input.approvalOptions ?? {},
    overbillingAcknowledged: input.overbillingAcknowledged,
  });
  if (!prepared.ok) {
    return failBeforeBegin(prepared.reason, {
      detail: prepared.detail,
      message: prepared.message,
    });
  }

  /* 3. Fingerprintgleichheit — keine Reparatur, keine Neuberechnung. */
  if (prepared.contentFingerprint !== preflight.contentFingerprint) {
    return failBeforeBegin('fingerprint_drift', { detail: 'prepare' });
  }

  /* 4. Lokale Abschlussprüfung unmittelbar vor `begin`. */
  const guard = await recheckInvoiceFinalizationLocalGuardsWithinSyncOperation(
    {
      identity,
      expectedRevision,
      contentFingerprint: preflight.contentFingerprint,
    },
    lease,
  );
  if (!guard.ok) {
    return failBeforeBegin(guard.reason, {
      detail: guard.detail,
      currentRevision: guard.currentRevision,
      existingInvoiceId: guard.existingInvoiceId,
    });
  }

  /*
   * 4b. SINGLE-FINAL-INVOICE-INVARIANT-01D — vor `begin` und damit vor jedem
   * RPC. Existiert lokal bereits eine **andere** Schlussrechnung für diesen
   * Vorgang, wird gar nicht erst gesendet.
   *
   * Der Server prüft dasselbe noch einmal — er muss es, weil eine zweite
   * Origin die fremde Rechnung womöglich gar nicht kennt. Dieser Guard hier
   * erspart den vergeblichen Netzgang und liefert den Grund lokal.
   */
  {
    let localInvoices: VorgangInvoice[] = [];
    try {
      const snapshot = buildPersistedStateSnapshot();
      localInvoices =
        (snapshot.vorgaenge ?? []).find((entry) => entry.id === identity.vorgangId)?.invoices ?? [];
    } catch {
      return failBeforeBegin('storage_failed', { detail: 'snapshot' });
    }

    const conflict = findConflictingFinalInvoice(
      localInvoices,
      prepared.request.invoice.type,
      prepared.clientInvoiceId,
    );
    if (conflict) {
      return failBeforeBegin('final_invoice_exists', { existingInvoiceId: conflict.id });
    }
  }

  /* 5. Begin — erst hier wird die Kennung dauerhaft. */
  const begun = await beginInvoiceDraftFinalization({
    identity,
    expectedRevision,
    clientInvoiceId: prepared.clientInvoiceId,
    contentFingerprint: prepared.contentFingerprint,
    request: prepared.request as never,
    approvalContext: prepared.approvalContext as unknown as Record<string, unknown>,
  });
  if (!begun.ok) {
    if (begun.reason === 'committed_but_unverified') {
      /*
       * Der Schreibvorgang liegt dauerhaft vor. Die Kennung wird nur
       * zurückgegeben, wenn sie nachweislich im Datensatz steht.
       */
      const stored = await loadInvoiceDraftRecord(identity);
      const storedId =
        stored.ok && stored.record.status !== 'active'
          ? stored.record.finalization?.clientInvoiceId
          : undefined;
      return {
        ok: false,
        reason: 'committed_but_unverified',
        recovery: 'reload_required',
        cloudState: 'not_committed',
        detail: 'begin',
        clientInvoiceId: storedId,
      };
    }
    return failBeforeBegin(begun.reason, {
      detail: begun.detail,
      currentRevision: begun.currentRevision,
    });
  }

  const finalizingRevision = begun.record.revision;
  const clientInvoiceId = begun.record.finalization?.clientInvoiceId ?? prepared.clientInvoiceId;

  /* 6. Execute — ausschließlich Identität und bestätigte Revision. */
  const executed = await executePreparedInvoiceFinalization({
    identity,
    expectedRevision: finalizingRevision,
  });
  if (!executed.ok) {
    // Kein zweiter RPC im selben Startlauf.
    return {
      ok: false,
      reason: executed.reason,
      recovery: recoveryForExecute(executed.reason, executed.cloudState),
      cloudState: executed.cloudState,
      detail: executed.detail,
      message: executed.message,
      currentRevision: executed.currentRevision,
      clientInvoiceId,
    };
  }

  /* 7. Complete — nur nach bewiesener lokaler Übernahme. */
  const completed = await completeInvoiceDraftFinalization({
    identity,
    expectedRevision: finalizingRevision,
    clientInvoiceId,
    contentFingerprint: prepared.contentFingerprint,
    finalizedInvoiceId: executed.invoice.id,
    archiveWarning: executed.archiveWarning,
  });
  if (!completed.ok) {
    const unverified = completed.reason === 'committed_but_unverified';
    return {
      ok: false,
      reason: unverified ? 'committed_but_unverified' : 'complete_failed',
      recovery: unverified ? 'reload_required' : 'blocked',
      cloudState: 'confirmed',
      detail: unverified ? 'complete' : completed.reason,
      currentRevision: completed.currentRevision,
      clientInvoiceId,
    };
  }

  return {
    ok: true,
    invoice: executed.invoice,
    clientInvoiceId,
    contentFingerprint: prepared.contentFingerprint,
    idempotentReplay: executed.idempotentReplay,
    archiveWarning: executed.archiveWarning,
    revision: completed.record.revision,
    cloudState: 'confirmed',
  };
}
