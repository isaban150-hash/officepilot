/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4C — fail-closed Preflight vor
 * einer späteren Rechnungsfinalisierung.
 *
 * Er erzeugt **niemals** eine `clientInvoiceId`, ruft weder `prepare`, `begin`,
 * `execute` noch `complete` und schreibt, überschreibt, repariert oder löscht
 * **keinen** Intent.
 *
 * Cloud-Lesung, Merge und Persistenz laufen vollständig in **einem** Lauf der
 * gemeinsamen Sync-Queue. Der Snapshot für den Merge entsteht erst **nach** dem
 * Netzwerk-`await`; zwischen ihm und der Speicherung liegt kein weiteres
 * `await`.
 */
import type {
  AppPersistedState,
  CompanySetup,
  InvoiceDraft,
  VorgangInvoice,
} from '../../types/models';
import type { SyncCoordinatorReport } from '../../types/sync';
import type { InvoiceDraftIdentity } from '../../types/invoiceDraftDurability';
import { isSupabaseConfigured, getSupabaseClient } from '../../lib/supabase';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { buildStorageKey, getActiveStorageScope } from '../storage/storageScopeService';
import { buildDocumentBlobScopeKey } from '../storage/documentBlobScopeService';
import {
  buildInvoiceContentFingerprintFromInvoice,
  buildInvoiceFinalizationContentFingerprint,
} from '../invoiceService';
import {
  isActiveSyncOperationLease,
  runQueuedSyncOperation,
  type SyncOperationLease,
} from '../sync/syncOperationQueue';
import { applySyncPullCandidateSafely } from '../sync/syncPullPersistService';
import { createEmptySyncSimulationReport } from '../sync/syncSimulationReportService';
import {
  mapPullRowsIsolated,
  mergeCloudInvoicesIntoVorgaenge,
} from './invoiceCloudPullMergeService';
import { rpcPullWorkspaceInvoiceRows } from './workspaceInvoiceCloudService';
import { loadInvoiceDraftRecord } from './invoiceDraftDurabilityService';
import {
  INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX,
  inspectInvoiceFinalizeIntentsForOrigin,
  type InvoiceFinalizeIntentInspectionEntry,
} from './invoiceFinalizeIntentService';

export type InvoiceFinalizationPreflightFailure =
  | 'invalid_identity'
  | 'not_found'
  | 'conflict'
  | 'status_conflict'
  | 'corrupt'
  | 'storage_failed'
  | 'intent_storage_unavailable'
  | 'intent_scan_failed'
  | 'intent_scan_changed'
  | 'intent_corrupt'
  | 'offline_or_unconfigured'
  | 'auth_missing'
  | 'workspace_missing'
  | 'workspace_changed'
  | 'scope_mismatch'
  | 'pull_failed'
  | 'pull_incomplete'
  | 'merge_conflict'
  | 'persist_failed'
  | 'vorgang_missing'
  | 'setup_missing'
  | 'fingerprint_failed'
  | 'possible_existing_invoice'
  | 'legacy_intent_unresolved'
  | 'legacy_intent_conflict'
  | 'unexpected_error';

export interface InvoiceFinalizationPreflightInput {
  identity: InvoiceDraftIdentity;
  expectedRevision: number;
}

export interface InvoiceFinalizationCloudReconciliation {
  pulledRowCount: number;
  mergedInvoiceCount: number;
  resolvedLegacyIntentCount: number;
  warnings: string[];
}

export type InvoiceFinalizationPreflightResult =
  | {
      ok: true;
      identity: InvoiceDraftIdentity;
      revision: number;
      draft: InvoiceDraft;
      setupSnapshot: CompanySetup;
      contentFingerprint: string;
      cloudReconciliation: InvoiceFinalizationCloudReconciliation;
    }
  | {
      ok: false;
      reason: InvoiceFinalizationPreflightFailure;
      detail?: string;
      currentRevision?: number;
      existingInvoiceId?: string;
      warnings?: string[];
    };

/* -------------------------------------------------------------------------- */
/* Hilfen                                                                     */
/* -------------------------------------------------------------------------- */

function fail(
  reason: InvoiceFinalizationPreflightFailure,
  extra: {
    detail?: string;
    currentRevision?: number;
    existingInvoiceId?: string;
    warnings?: string[];
  } = {},
): InvoiceFinalizationPreflightResult {
  return { ok: false, reason, ...extra };
}

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

function detachJson<T>(value: T): T | null {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function mapLoadFailure(reason: string): InvoiceFinalizationPreflightFailure {
  switch (reason) {
    case 'invalid_identity':
    case 'identity_mismatch':
      return 'invalid_identity';
    case 'not_found':
      return 'not_found';
    case 'corrupt':
    case 'unsupported_format':
      return 'corrupt';
    default:
      return 'storage_failed';
  }
}

function mapIntentFailure(reason: string): InvoiceFinalizationPreflightFailure {
  switch (reason) {
    case 'storage_unavailable':
      return 'intent_storage_unavailable';
    case 'scan_changed':
      return 'intent_scan_changed';
    case 'corrupt':
      return 'intent_corrupt';
    default:
      return 'intent_scan_failed';
  }
}

/* -------------------------------------------------------------------------- */
/* Cloud- und Persistenzphase                                                 */
/* -------------------------------------------------------------------------- */

type CloudPhase =
  | { ok: true; pulledRowCount: number; mergedInvoiceCount: number; warnings: string[] }
  | { ok: false; reason: InvoiceFinalizationPreflightFailure; detail?: string };

async function runCloudPhase(identity: InvoiceDraftIdentity): Promise<CloudPhase> {
  let rows: unknown[];
  try {
    rows = await rpcPullWorkspaceInvoiceRows(identity.workspaceId, { since: null });
  } catch (error) {
    return {
      ok: false,
      reason: 'pull_failed',
      detail: error instanceof Error ? error.message : 'pull',
    };
  }

  /*
   * Fail-closed: eine unlesbare oder workspace-fremde Zeile macht den Pull
   * unvollständig. Es wird dann weder gemergt noch gespeichert — ein
   * Teilergebnis dürfte niemals als vollständiger Cloud-Abgleich gelten.
   */
  const report = createEmptySyncSimulationReport(new Date().toISOString());
  const { mapped, invalidCount } = mapPullRowsIsolated(rows, identity.workspaceId, report);
  if (invalidCount > 0) {
    return { ok: false, reason: 'pull_incomplete', detail: `invalid_rows:${invalidCount}` };
  }

  /* Erst jetzt der frische Snapshot — ab hier kein weiteres `await`. */
  const snapshot = buildPersistedStateSnapshot();
  if (resolveCloudWorkspaceId(snapshot).trim() !== identity.workspaceId) {
    return { ok: false, reason: 'workspace_changed' };
  }
  if (resolveActiveScopeKey() !== identity.sourceScopeKey) {
    return { ok: false, reason: 'scope_mismatch' };
  }
  const vorgaenge = snapshot.vorgaenge ?? [];
  if (!vorgaenge.some((vorgang) => vorgang.id === identity.vorgangId)) {
    return { ok: false, reason: 'vorgang_missing' };
  }

  const merge = mergeCloudInvoicesIntoVorgaenge(vorgaenge, mapped, {
    workspaceId: identity.workspaceId,
    report,
    // Der Preflight räumt niemals einen Intent.
    reconcileIntents: false,
  });

  const warnings: string[] = [];
  for (const conflict of merge.conflicts) {
    if (conflict.vorgangId === identity.vorgangId) {
      return { ok: false, reason: 'merge_conflict', detail: conflict.reason };
    }
    warnings.push(`merge_conflict:${conflict.reason}`);
  }

  const candidate: AppPersistedState = { ...snapshot, vorgaenge: merge.vorgaenge };
  const preflightReport: SyncCoordinatorReport = {
    ...report,
    retryAttempts: 0,
    uploadCount: 0,
    downloadCount: merge.insertedCount + merge.statusRaisedCount,
  };
  const applied = applySyncPullCandidateSafely({
    state: candidate,
    report: preflightReport,
    // Ausdrücklich keine Intent-Räumung durch den Preflight.
  });
  if (!applied.persisted) {
    return { ok: false, reason: 'persist_failed' };
  }

  return {
    ok: true,
    pulledRowCount: rows.length,
    mergedInvoiceCount: merge.insertedCount + merge.statusRaisedCount,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Öffentliche Operation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Öffentlicher Einstieg: der **vollständige** Preflight — Cloud, Persistenz,
 * zweite Intent-Inspektion, Draft-Neuladung, Abschlussprüfung, Setup-Snapshot
 * und Klassifikation — liegt in genau **einem** Queue-Lauf. Ein normaler Sync
 * kann ihn dadurch nicht mehr in seiner Nachphase überholen.
 */
export async function runInvoiceFinalizationPreflight(
  input: InvoiceFinalizationPreflightInput,
): Promise<InvoiceFinalizationPreflightResult> {
  try {
    return await runQueuedSyncOperation((lease) =>
      runInvoiceFinalizationPreflightWithinSyncOperation(input, lease),
    );
  } catch (error) {
    return fail('unexpected_error', {
      detail: error instanceof Error ? error.message : 'unknown',
    });
  }
}

/**
 * Für Aufrufer, die den Queue-Lauf bereits halten (später der Coordinator).
 * Er fordert selbst **keine** Queue an — sonst entstünde ein Deadlock.
 */
export async function runInvoiceFinalizationPreflightWithinSyncOperation(
  input: InvoiceFinalizationPreflightInput,
  lease: SyncOperationLease,
): Promise<InvoiceFinalizationPreflightResult> {
  if (!isActiveSyncOperationLease(lease)) {
    return fail('unexpected_error', { detail: 'inactive_sync_operation_lease' });
  }
  try {
    return await runPreflight(input);
  } catch (error) {
    return fail('unexpected_error', {
      detail: error instanceof Error ? error.message : 'unknown',
    });
  }
}

export interface InvoiceFinalizationLocalGuardInput {
  identity: InvoiceDraftIdentity;
  expectedRevision: number;
  contentFingerprint: string;
}

export type InvoiceFinalizationLocalGuardResult =
  | { ok: true; revision: number; warnings: string[] }
  | {
      ok: false;
      reason: InvoiceFinalizationPreflightFailure;
      detail?: string;
      currentRevision?: number;
      existingInvoiceId?: string;
    };

/**
 * Reiner lokaler Wächter unmittelbar **vor** `begin`: derselbe Entwurfs-,
 * Workspace-, Scope-, Intent- und Rechnungsvertrag wie am Ende des Preflights —
 * **ohne** Cloud-Pull, ohne Persistenz, ohne Kennung, ohne Intent-Mutation.
 */
export async function recheckInvoiceFinalizationLocalGuardsWithinSyncOperation(
  input: InvoiceFinalizationLocalGuardInput,
  lease: SyncOperationLease,
): Promise<InvoiceFinalizationLocalGuardResult> {
  if (!isActiveSyncOperationLease(lease)) {
    return { ok: false, reason: 'unexpected_error', detail: 'inactive_sync_operation_lease' };
  }
  try {
    return await runLocalGuards(input);
  } catch (error) {
    return {
      ok: false,
      reason: 'unexpected_error',
      detail: error instanceof Error ? error.message : 'unknown',
    };
  }
}

async function runLocalGuards(
  input: InvoiceFinalizationLocalGuardInput,
): Promise<InvoiceFinalizationLocalGuardResult> {
  const { identity, expectedRevision, contentFingerprint } = input;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return { ok: false, reason: 'invalid_identity', detail: 'expectedRevision' };
  }
  if (!contentFingerprint) {
    return { ok: false, reason: 'fingerprint_failed', detail: 'missing' };
  }

  const reloaded = await loadInvoiceDraftRecord(identity);
  if (!reloaded.ok) {
    return { ok: false, reason: mapLoadFailure(reloaded.reason), detail: reloaded.detail };
  }
  if (reloaded.record.status !== 'active') {
    return { ok: false, reason: 'status_conflict', detail: reloaded.record.status };
  }
  if (reloaded.record.revision !== expectedRevision) {
    return { ok: false, reason: 'conflict', currentRevision: reloaded.record.revision };
  }

  const latest = buildPersistedStateSnapshot();
  let workspaceId: string;
  try {
    workspaceId = resolveCloudWorkspaceId(latest).trim();
  } catch {
    workspaceId = '';
  }
  if (!workspaceId) return { ok: false, reason: 'workspace_missing' };
  if (workspaceId !== identity.workspaceId) {
    return { ok: false, reason: 'workspace_changed', detail: workspaceId };
  }
  if (resolveActiveScopeKey() !== identity.sourceScopeKey) {
    return { ok: false, reason: 'scope_mismatch' };
  }

  const scan = inspectInvoiceFinalizeIntentsForOrigin();
  if (!scan.ok) {
    return { ok: false, reason: mapIntentFailure(scan.reason), detail: scan.detail };
  }

  const classified = classifyVorgangInvoicesAndIntents({
    identity,
    entries: scan.entries,
    latest,
    contentFingerprint,
  });
  if (!classified.ok) return classified;

  return {
    ok: true,
    revision: reloaded.record.revision,
    warnings: [...scan.warnings, ...classified.warnings],
  };
}

export type InvoiceFinalizationCloudReconciliationResult =
  | {
      ok: true;
      pulledRowCount: number;
      mergedInvoiceCount: number;
      warnings: string[];
    }
  | {
      ok: false;
      reason: InvoiceFinalizationPreflightFailure;
      detail?: string;
    };

/**
 * Reiner Cloud-Abgleich für die Wiederaufnahme: vollständiger Pull mit
 * `since: null`, fail-closed Rohzeilenprüfung, Merge auf frischem Snapshot und
 * Persistenz über den einen vorhandenen Weg.
 *
 * Er verlangt **keinen** `active`-Entwurf, liest und ändert keinen
 * Finalisierungsstatus, erzeugt weder `clientInvoiceId` noch Request und räumt
 * keinen Intent.
 */
export async function runInvoiceFinalizationCloudReconciliationWithinSyncOperation(
  input: { identity: InvoiceDraftIdentity },
  lease: SyncOperationLease,
): Promise<InvoiceFinalizationCloudReconciliationResult> {
  if (!isActiveSyncOperationLease(lease)) {
    return { ok: false, reason: 'unexpected_error', detail: 'inactive_sync_operation_lease' };
  }
  try {
    const cloud = await runCloudPhase(input.identity);
    if (!cloud.ok) return { ok: false, reason: cloud.reason, detail: cloud.detail };
    return {
      ok: true,
      pulledRowCount: cloud.pulledRowCount,
      mergedInvoiceCount: cloud.mergedInvoiceCount,
      warnings: cloud.warnings,
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'unexpected_error',
      detail: error instanceof Error ? error.message : 'unknown',
    };
  }
}

async function runPreflight(
  input: InvoiceFinalizationPreflightInput,
): Promise<InvoiceFinalizationPreflightResult> {
  const { identity, expectedRevision } = input;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return fail('invalid_identity', { detail: 'expectedRevision' });
  }

  /* 1./2. Ausgangsdatensatz laden und prüfen. */
  const initial = await loadInvoiceDraftRecord(identity);
  if (!initial.ok) return fail(mapLoadFailure(initial.reason), { detail: initial.detail });
  if (initial.record.status !== 'active') {
    return fail('status_conflict', { detail: initial.record.status });
  }
  if (initial.record.revision !== expectedRevision) {
    return fail('conflict', { currentRevision: initial.record.revision });
  }

  /* 3./4. Erste originweite Intent-Inspektion. */
  const firstScan = inspectInvoiceFinalizeIntentsForOrigin();
  if (!firstScan.ok) return fail(mapIntentFailure(firstScan.reason), { detail: firstScan.detail });

  /* 5. Workspace und Scope gegen die Identität. */
  if (!isSupabaseConfigured()) return fail('offline_or_unconfigured');
  if (!(await hasAuthSession())) return fail('auth_missing');
  const workspaceId = resolveActiveWorkspaceId();
  if (!workspaceId) return fail('workspace_missing');
  if (workspaceId !== identity.workspaceId) return fail('workspace_changed', { detail: workspaceId });
  if (resolveActiveScopeKey() !== identity.sourceScopeKey) return fail('scope_mismatch');

  /*
   * 6.–20. Cloud-Lesung, Prüfung, Merge und Persistenz. Die Queue hält bereits
   * der Aufrufer — hier wird kein zweiter Lauf angefordert.
   */
  const cloud = await runCloudPhase(identity);
  if (!cloud.ok) return fail(cloud.reason, { detail: cloud.detail });

  /* 21. Zweite Inspektion — ein Fremd-Tab könnte inzwischen geschrieben haben. */
  const secondScan = inspectInvoiceFinalizeIntentsForOrigin();
  if (!secondScan.ok) {
    return fail(mapIntentFailure(secondScan.reason), { detail: secondScan.detail });
  }

  /* 22.–24. Entwurf und Revision erneut prüfen. */
  const reloaded = await loadInvoiceDraftRecord(identity);
  if (!reloaded.ok) return fail(mapLoadFailure(reloaded.reason), { detail: reloaded.detail });
  if (reloaded.record.status !== 'active') {
    return fail('status_conflict', { detail: reloaded.record.status });
  }
  if (reloaded.record.revision !== expectedRevision) {
    return fail('conflict', { currentRevision: reloaded.record.revision });
  }

  /*
   * 25a. Abschlussbindung: Der Pull darf bereits dauerhaft persistiert sein —
   * aber ein Erfolgssnapshot mit dem Setup eines inzwischen fremden Workspace
   * oder Scope wäre wertlos. Kein Rückfall auf ein anderes Setup, keinen
   * anderen Workspace und keinen anderen Scope.
   */
  const latest = buildPersistedStateSnapshot();
  let finalWorkspaceId: string;
  try {
    finalWorkspaceId = resolveCloudWorkspaceId(latest).trim();
  } catch {
    finalWorkspaceId = '';
  }
  if (!finalWorkspaceId) return fail('workspace_missing');
  if (finalWorkspaceId !== identity.workspaceId) {
    return fail('workspace_changed', { detail: finalWorkspaceId });
  }
  if (resolveActiveScopeKey() !== identity.sourceScopeKey) {
    return fail('scope_mismatch');
  }

  /* 25./26. Setup aus dem neuesten persistierten Zustand abtrennen. */
  if (!latest?.setup) return fail('setup_missing');
  const setupSnapshot = detachJson(latest.setup);
  const draft = detachJson(reloaded.draft);
  if (!setupSnapshot || !draft) return fail('setup_missing', { detail: 'detach' });

  /* 27. Fingerprint selbst berechnen — nie vom Aufrufer übernehmen. */
  let contentFingerprint: string;
  try {
    contentFingerprint = buildInvoiceFinalizationContentFingerprint(draft, setupSnapshot);
  } catch (error) {
    return fail('fingerprint_failed', {
      detail: error instanceof Error ? error.message : 'draft',
    });
  }
  if (!contentFingerprint) return fail('fingerprint_failed');

  /* 28. Vorhandene Rechnungen und Altintents prüfen. */
  const classified = classifyVorgangInvoicesAndIntents({
    identity,
    entries: secondScan.entries,
    latest,
    contentFingerprint,
  });
  if (!classified.ok) {
    return fail(classified.reason, {
      detail: classified.detail,
      existingInvoiceId: classified.existingInvoiceId,
    });
  }

  const warnings = [...cloud.warnings, ...secondScan.warnings, ...classified.warnings];

  return {
    ok: true,
    identity,
    revision: reloaded.record.revision,
    draft,
    setupSnapshot,
    contentFingerprint,
    cloudReconciliation: {
      pulledRowCount: cloud.pulledRowCount,
      mergedInvoiceCount: cloud.mergedInvoiceCount,
      resolvedLegacyIntentCount: classified.resolvedCount,
      warnings,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Intent-Klassifikation                                                      */
/* -------------------------------------------------------------------------- */

type ClassificationResult =
  | { ok: true; resolvedCount: number; warnings: string[] }
  | {
      ok: false;
      reason: InvoiceFinalizationPreflightFailure;
      detail?: string;
      existingInvoiceId?: string;
    };

/**
 * Gemeinsame Bewertung der Vorgangsrechnungen und Altintents — von Preflight
 * **und** lokalem Guard verwendet, damit es nur einen Vertrag gibt.
 */
function classifyVorgangInvoicesAndIntents(input: {
  identity: InvoiceDraftIdentity;
  entries: InvoiceFinalizeIntentInspectionEntry[];
  latest: AppPersistedState;
  contentFingerprint: string;
}): ClassificationResult {
  const { identity, entries, latest, contentFingerprint } = input;
  const vorgang = (latest.vorgaenge ?? []).find((entry) => entry.id === identity.vorgangId);
  if (!vorgang) return { ok: false, reason: 'vorgang_missing' };

  const invoices = vorgang.invoices ?? [];
  const invoiceFingerprints = new Map<string, string>();
  for (const invoice of invoices) {
    try {
      invoiceFingerprints.set(invoice.id, buildInvoiceContentFingerprintFromInvoice(invoice));
    } catch (error) {
      return {
        ok: false,
        reason: 'fingerprint_failed',
        detail: error instanceof Error ? error.message : `invoice:${invoice.id}`,
      };
    }
  }

  for (const [invoiceId, fingerprint] of invoiceFingerprints) {
    if (fingerprint === contentFingerprint) {
      return { ok: false, reason: 'possible_existing_invoice', existingInvoiceId: invoiceId };
    }
  }

  const intentOutcome = classifyLegacyIntents({
    identity,
    entries,
    invoices,
    invoiceFingerprints,
  });
  if (!intentOutcome.ok) {
    return { ok: false, reason: intentOutcome.reason, detail: intentOutcome.detail };
  }
  return { ok: true, resolvedCount: intentOutcome.resolvedCount, warnings: intentOutcome.warnings };
}

type IntentOutcome =
  | { ok: true; resolvedCount: number; warnings: string[] }
  | {
      ok: false;
      reason: 'legacy_intent_unresolved' | 'legacy_intent_conflict';
      detail?: string;
    };

/**
 * Fachlich zählt ausschließlich `workspaceId` und `vorgangId` des Intents —
 * der physische Storage-Scope entscheidet nie allein. Es wird nichts gelöscht.
 */
function classifyLegacyIntents(input: {
  identity: InvoiceDraftIdentity;
  entries: InvoiceFinalizeIntentInspectionEntry[];
  invoices: VorgangInvoice[];
  invoiceFingerprints: Map<string, string>;
}): IntentOutcome {
  const { identity, entries, invoiceFingerprints } = input;
  const expectedStorageKey = `${buildStorageKey({
    type: 'workspace',
    workspaceId: identity.workspaceId,
  })}${INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX}`;
  const warnings: string[] = [];
  const resolvedIds = new Set<string>();

  const relevant = entries.filter(
    (entry) =>
      entry.intent.workspaceId === identity.workspaceId &&
      entry.intent.vorgangId === identity.vorgangId,
  );

  for (const entry of relevant) {
    const { clientInvoiceId, contentFingerprint } = entry.intent;
    const localFingerprint = invoiceFingerprints.get(clientInvoiceId);

    if (localFingerprint === undefined) {
      // Gleicher Fingerprint bei anderer Rechnungs-ID bleibt ein Verdacht.
      for (const fingerprint of invoiceFingerprints.values()) {
        if (fingerprint === contentFingerprint) {
          return { ok: false, reason: 'legacy_intent_conflict', detail: 'foreign_invoice_id' };
        }
      }
      return { ok: false, reason: 'legacy_intent_unresolved', detail: clientInvoiceId };
    }

    if (localFingerprint !== contentFingerprint) {
      return { ok: false, reason: 'legacy_intent_conflict', detail: clientInvoiceId };
    }

    // Exakt aufgelöst: Kennung und Fingerprint passen zu einer lokalen Rechnung.
    if (resolvedIds.has(clientInvoiceId)) {
      warnings.push('duplicate_resolved_intent');
    }
    resolvedIds.add(clientInvoiceId);
    if (entry.storageKey !== expectedStorageKey) {
      // Falscher physischer Scope — eine Warnung, aber kein ewiger Block.
      warnings.push('wrong_storage_scope');
    }
  }

  return { ok: true, resolvedCount: resolvedIds.size, warnings };
}
