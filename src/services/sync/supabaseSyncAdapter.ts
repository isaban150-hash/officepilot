import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppPersistedState, Vorgang } from '../../types/models';
import type { SyncOutboxEntry, SyncSimulationReport } from '../../types/sync';
import { getSupabaseClient, isSupabaseConfigured } from '../../lib/supabase';
import type {
  SyncAcknowledgeInput,
  SyncAdapter,
  SyncAdapterStatus,
  SyncBlobReference,
  SyncInvoiceNumberReservation,
  SyncPullInput,
  SyncPullResult,
  SyncPushFailure,
  SyncPushInput,
  SyncPushResult,
} from './syncAdapter';
import { isSupabaseSyncAllowed } from './cloudSyncAllowlist';
import {
  createEmptySyncSimulationReport,
  finalizeSyncSimulationReport,
} from './syncSimulationReportService';
import { markOutboxEntriesCompleted, markOutboxEntriesFailed } from './syncOutboxService';
import {
  buildCompanyProfileCloudPayload,
  buildCompanySetupCloudPayload,
  buildWorkspaceCloudPayload,
  buildWorkspaceSettingsCloudPayload,
  rpcPullWorkspaceSyncState,
  rpcUpsertWorkspaceSyncEntity,
  WorkspaceCloudError,
} from '../workspace/workspaceCloudService';
import { extractCloudSyncEntity, resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import {
  applyRemoteCompanyProfileSyncMeta,
  applyRemoteSetupSyncMeta,
} from '../workspace/workspaceStore';
import {
  applyVorgangPushResultToState,
  buildVorgangCloudPushPayload,
  mergeVorgaengeFromPull,
} from '../vorgang/vorgangCloudService';
import { applyInvoicePullAfterVorgangMerge } from '../invoice/invoiceCloudPullOrchestrator';
import { listOrderAmendmentConfirmIntents } from '../orderAmendment/orderAmendmentConfirmIntentService';
import {
  type MergeCloudAmendmentsResult,
} from '../orderAmendment/orderAmendmentCloudPullMergeService';
import { pullAndMergeWorkspaceOrderAmendmentsInMemory } from '../orderAmendment/orderAmendmentCloudPullOrchestrator';
import type { SyncOutboxOperation } from '../../types/sync';

function shortenSyncReportId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/** Map B3A merge issues into the shared sync report (no full payloads / prices). */
function appendAmendmentMergeToSyncReport(
  report: SyncSimulationReport,
  merge: MergeCloudAmendmentsResult,
): void {
  report.mergedEntityCount += merge.appliedCount;

  for (const issue of merge.issues) {
    const entityId = issue.vorgangId ?? 'amendment';
    const message = `${issue.errorKey ?? issue.reason}: ${issue.message}`;

    // Soft warnings: visible in report, do not fail the sync toast.
    if (issue.reason === 'duplicate_content_warning') {
      report.conflicts.push({
        entityType: 'vorgang',
        entityId,
        resolution: 'conflict',
      });
      report.conflictCount += 1;
      report.errors.push({ outboxId: 'amendment-pull-warning', message });
      continue;
    }

    report.conflictCount += 1;
    report.conflicts.push({
      entityType: 'vorgang',
      entityId,
      resolution: 'conflict',
    });
    report.errors.push({ outboxId: 'amendment-pull', message });
    report.errorCount += 1;
  }
}

/** Warn when invoice lines reference orderPositionIds missing from the final plan. */
export function appendMissingInvoicePositionRefsToReport(
  vorgaenge: Vorgang[],
  report: SyncSimulationReport,
): void {
  const seen = new Set<string>();
  for (const vorgang of vorgaenge) {
    const planIds = new Set((vorgang.orderPositions ?? []).map((position) => position.id));
    for (const invoice of vorgang.invoices ?? []) {
      for (const line of invoice.positions ?? []) {
        if (planIds.has(line.orderPositionId)) continue;
        const key = `${vorgang.id}::${line.orderPositionId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        report.conflictCount += 1;
        report.conflicts.push({
          entityType: 'vorgang',
          entityId: shortenSyncReportId(vorgang.id),
          resolution: 'conflict',
        });
        report.errorCount += 1;
        report.errors.push({
          outboxId: 'invoice-position-ref',
          message:
            `Invoice-Line verweist auf fehlende Planposition ` +
            `${shortenSyncReportId(line.orderPositionId)} ` +
            `(Vorgang ${shortenSyncReportId(vorgang.id)}).`,
        });
      }
    }
  }
}

function updateOutboxEntryStatus(
  outbox: SyncOutboxEntry[],
  outboxId: string,
  status: SyncOutboxEntry['status'],
  retryCount?: number,
): SyncOutboxEntry[] {
  return outbox.map((entry) =>
    entry.id === outboxId
      ? {
          ...entry,
          status,
          retryCount: retryCount ?? entry.retryCount,
        }
      : entry,
  );
}

function buildPushPayload(
  extracted: NonNullable<ReturnType<typeof extractCloudSyncEntity>>,
  operation: SyncOutboxOperation,
): Record<string, unknown> {
  switch (extracted.entityType) {
    case 'workspace':
      return buildWorkspaceCloudPayload(extracted.entity);
    case 'workspace_settings':
      return buildWorkspaceSettingsCloudPayload(extracted.entity);
    case 'company_setup':
      return buildCompanySetupCloudPayload(extracted.entity);
    case 'company_profile':
      return buildCompanyProfileCloudPayload(extracted.entity);
    case 'workspace_member':
      return { ...extracted.entity };
    case 'vorgang':
      return buildVorgangCloudPushPayload(
        extracted.entity,
        operation === 'delete' || extracted.deleted,
      );
    default:
      return {};
  }
}

function applyPushResultToState(
  state: AppPersistedState,
  entityType: string,
  entityId: string,
  rowVersion: number,
  updatedAt: string,
  deleted = false,
): AppPersistedState {
  const workspaceId = resolveCloudWorkspaceId(state);
  const next = { ...state };

  if (entityType === 'company_setup') {
    applyRemoteSetupSyncMeta(rowVersion, updatedAt);
    next.setupSync = {
      version: rowVersion,
      updatedAt,
      deleted: false,
      deviceId: state.syncClient!.deviceId,
      workspaceId,
    };
  } else if (entityType === 'company_profile') {
    applyRemoteCompanyProfileSyncMeta(rowVersion, updatedAt);
    next.companyProfileSync = {
      version: rowVersion,
      updatedAt,
      deleted: false,
      deviceId: state.syncClient!.deviceId,
      workspaceId,
    };
  } else if (entityType === 'workspace_settings' && next.workspaceSettings) {
    next.workspaceSettings = {
      ...next.workspaceSettings,
      version: rowVersion,
      updatedAt,
    };
  } else if (entityType === 'workspace' && next.workspace) {
    next.workspace = {
      ...next.workspace,
      version: rowVersion,
      updatedAt,
    };
  } else if (entityType === 'vorgang') {
    next.vorgaenge = applyVorgangPushResultToState(
      next.vorgaenge,
      entityId,
      rowVersion,
      updatedAt,
      deleted,
      state.syncClient!.deviceId,
      workspaceId,
    );
  }

  return next;
}

export class SupabaseSyncAdapter implements SyncAdapter {
  readonly providerKind = 'supabase' as const;

  private syncState: SyncAdapterStatus['syncState'] = 'idle';
  private pendingChanges = 0;
  private lastSyncedAt?: string;
  private lastError?: string;

  constructor(private readonly client: SupabaseClient | null = getSupabaseClient()) {}

  private assertClient(): SupabaseClient {
    if (!this.client) {
      throw new WorkspaceCloudError('Supabase ist nicht konfiguriert.', 'unknown', false);
    }
    return this.client;
  }

  async pushChanges(input: SyncPushInput): Promise<SyncPushResult> {
    this.syncState = 'uploading';
    const startedAt = new Date().toISOString();
    const report = createEmptySyncSimulationReport(startedAt);
    report.pushCount = 1;

    if (!isSupabaseConfigured()) {
      this.syncState = 'offline';
      return {
        success: false,
        state: input.state,
        completedOutboxIds: [],
        failedOutbox: [{ outboxId: 'adapter', message: 'Supabase nicht konfiguriert', retryable: false }],
        report: finalizeSyncSimulationReport(report, new Date().toISOString()),
      };
    }

    const workspaceId = input.state.syncClient?.serverWorkspaceId ?? resolveCloudWorkspaceId(input.state);
    if (!workspaceId) {
      this.syncState = 'error';
      this.lastError = 'Kein Workspace provisioniert';
      return {
        success: false,
        state: input.state,
        completedOutboxIds: [],
        failedOutbox: [{ outboxId: 'adapter', message: this.lastError, retryable: false }],
        report: finalizeSyncSimulationReport(report, new Date().toISOString()),
      };
    }

    let currentState = input.state;
    let outbox = [...(input.outbox ?? [])];
    const completedOutboxIds: string[] = [];
    const failedOutbox: SyncPushFailure[] = [];

    const pendingEntries = outbox.filter((entry) => entry.status === 'pending' || entry.status === 'error');

    for (const entry of pendingEntries) {
      if (!isSupabaseSyncAllowed(entry.entityType)) {
        continue;
      }

      const extracted = extractCloudSyncEntity(currentState, entry.entityType, entry.entityId);
      if (!extracted) {
        failedOutbox.push({
          outboxId: entry.id,
          message: `Entity ${entry.entityType}:${entry.entityId} nicht gefunden`,
          retryable: false,
        });
        outbox = updateOutboxEntryStatus(outbox, entry.id, 'error', entry.retryCount + 1);
        report.errorCount += 1;
        report.errors.push({ outboxId: entry.id, message: 'Entity nicht gefunden' });
        continue;
      }

      if (entry.entityType === 'workspace_member') {
        completedOutboxIds.push(entry.id);
        outbox = updateOutboxEntryStatus(outbox, entry.id, 'completed');
        report.completedOutboxCount += 1;
        continue;
      }

      try {
        this.assertClient();
        const pushResult = await rpcUpsertWorkspaceSyncEntity(
          workspaceId,
          entry.entityType,
          buildPushPayload(extracted, entry.operation),
          extracted.rowVersion,
          this.client,
        );
        const pushDeleted =
          entry.entityType === 'vorgang' &&
          (entry.operation === 'delete' || extracted.entityType === 'vorgang' && extracted.deleted);
        currentState = applyPushResultToState(
          currentState,
          entry.entityType,
          entry.entityId,
          pushResult.rowVersion,
          new Date().toISOString(),
          pushDeleted,
        );
        completedOutboxIds.push(entry.id);
        outbox = updateOutboxEntryStatus(outbox, entry.id, 'completed');
        report.completedOutboxCount += 1;
        report.syncedEntities.push({
          entityType: entry.entityType,
          entityId: entry.entityId,
          resolution: 'local_wins',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Push fehlgeschlagen';
        const retryable = error instanceof WorkspaceCloudError ? error.retryable : true;
        const isVersionConflict = error instanceof WorkspaceCloudError && error.code === 'version_conflict';

        failedOutbox.push({ outboxId: entry.id, message, retryable });
        outbox = updateOutboxEntryStatus(
          outbox,
          entry.id,
          isVersionConflict ? 'blocked' : 'error',
          entry.retryCount + 1,
        );
        report.errorCount += 1;
        report.errors.push({ outboxId: entry.id, message });
        if (isVersionConflict) {
          report.conflictCount += 1;
          report.conflicts.push({
            entityType: entry.entityType,
            entityId: entry.entityId,
            resolution: 'conflict',
          });
        }
      }
    }

    currentState = {
      ...currentState,
      syncOutbox: outbox,
    };

    markOutboxEntriesCompleted(completedOutboxIds);
    if (failedOutbox.length > 0) {
      markOutboxEntriesFailed(
        failedOutbox.map((item) => item.outboxId),
        failedOutbox[0]?.message,
      );
    }

    this.pendingChanges = outbox.filter((entry) => entry.status === 'pending' || entry.status === 'error').length;
    this.syncState = failedOutbox.length > 0 ? 'error' : 'synced';
    this.lastError = failedOutbox[0]?.message;
    if (failedOutbox.length === 0) {
      this.lastSyncedAt = new Date().toISOString();
    }

    return {
      success: failedOutbox.length === 0,
      state: currentState,
      completedOutboxIds,
      failedOutbox,
      report: finalizeSyncSimulationReport(report, new Date().toISOString()),
    };
  }

  async pullChanges(input: SyncPullInput): Promise<SyncPullResult> {
    this.syncState = 'downloading';
    const startedAt = new Date().toISOString();
    const report = createEmptySyncSimulationReport(startedAt);
    report.pullCount = 1;

    const workspaceId = input.state.syncClient?.serverWorkspaceId ?? resolveCloudWorkspaceId(input.state);
    if (!workspaceId || !isSupabaseConfigured()) {
      return {
        success: true,
        state: input.state,
        report: finalizeSyncSimulationReport(report, new Date().toISOString()),
      };
    }

    try {
      this.assertClient();
      const remote = await rpcPullWorkspaceSyncState(workspaceId, this.client);
      const merged = mergeRemoteWorkspacePullIntoState(input.state, remote);
      const vorgangMerge = mergeVorgaengeFromPull(
        merged.state.vorgaenge,
        remote.vorgaenge ?? [],
        input.state.syncClient!.deviceId,
        workspaceId,
      );
      report.mergedEntityCount = 1 + vorgangMerge.vorgaenge.length;
      report.conflictCount = merged.conflicts.length + vorgangMerge.conflicts.length;
      for (const conflict of merged.conflicts) {
        report.conflicts.push({
          entityType: conflict as SyncOutboxEntry['entityType'],
          entityId: workspaceId,
          resolution: 'conflict',
        });
      }
      for (const conflict of vorgangMerge.conflicts) {
        const [, vorgangId] = conflict.split(':');
        report.conflicts.push({
          entityType: 'vorgang',
          entityId: vorgangId ?? conflict,
          resolution: 'conflict',
        });
      }

      // ORDER-AMENDMENT-01B3B: confirmed amendments after vorgang merge, before invoices.
      const amendmentIntents = listOrderAmendmentConfirmIntents().filter(
        (intent) => intent.workspaceId === workspaceId,
      );
      const amendmentPull = await pullAndMergeWorkspaceOrderAmendmentsInMemory({
        workspaceId,
        vorgaenge: vorgangMerge.vorgaenge,
        intents: amendmentIntents,
      });

      if (!amendmentPull.ok) {
        const message =
          amendmentPull.message ??
          `Amendment-Pull fehlgeschlagen (${amendmentPull.reason})`;
        this.syncState = 'error';
        this.lastError = message;
        report.errorCount += 1;
        report.errors.push({ outboxId: 'amendment-pull', message });
        return {
          success: false,
          state: input.state,
          report: finalizeSyncSimulationReport(report, new Date().toISOString()),
          skipPersist: true,
        };
      }

      appendAmendmentMergeToSyncReport(report, amendmentPull.merge);

      // CLOUD-ORDER-CHAIN-03B2: invoice pull only after amendment plan is composed.
      // Invoice RPC failure must not discard vorgang/amendment pull results.
      const invoicePull = await applyInvoicePullAfterVorgangMerge({
        workspaceId,
        vorgaenge: amendmentPull.merge.vorgaenge,
        report,
        client: this.client,
      });

      appendMissingInvoicePositionRefsToReport(invoicePull.vorgaenge, report);

      const finalState = {
        ...merged.state,
        vorgaenge: invoicePull.vorgaenge,
      };

      // Vorgang+amendment pull succeeded; invoice RPC failure is reported but does not roll back.
      this.syncState = invoicePull.invoiceRpcFailed ? 'error' : 'synced';
      this.lastSyncedAt = new Date().toISOString();
      this.lastError = invoicePull.invoiceRpcFailed
        ? report.errors.find((e) => e.outboxId === 'invoice-pull')?.message
        : undefined;

      return {
        success: !invoicePull.invoiceRpcFailed,
        state: finalState,
        report: finalizeSyncSimulationReport(report, new Date().toISOString()),
        pendingInvoiceIntentClears: invoicePull.pendingIntentClears,
        pendingAmendmentIntentClears: amendmentPull.merge.pendingIntentClears,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Pull fehlgeschlagen';
      this.syncState = 'error';
      this.lastError = message;
      report.errorCount = 1;
      report.errors.push({ outboxId: 'pull', message });
      return {
        success: false,
        state: input.state,
        report: finalizeSyncSimulationReport(report, new Date().toISOString()),
        skipPersist: true,
      };
    }
  }

  async acknowledgeChanges(_input: SyncAcknowledgeInput): Promise<void> {
    /* Outbox status wird bereits in pushChanges aktualisiert */
  }

  /**
   * Intentionally unimplemented for Supabase.
   * CLOUD-ORDER-CHAIN-03A: numbers must be assigned only inside finalize_workspace_invoice
   * (atomic with invoice insert). Use rpcFinalizeWorkspaceInvoice — never reserve alone.
   */
  async reserveInvoiceNumber(_workspaceId: string): Promise<SyncInvoiceNumberReservation> {
    throw new Error(
      'Rechnungsnummern dürfen nicht getrennt reserviert werden. Nutze finalize_workspace_invoice (CLOUD-ORDER-CHAIN-03A).',
    );
  }

  async uploadBlob(
    _workspaceId: string,
    _blob: Blob,
    _metadata?: Record<string, string>,
  ): Promise<SyncBlobReference> {
    throw new Error('Blob-Upload ist in CLOUD-DATA-01 nicht implementiert.');
  }

  async downloadBlob(_blobId: string): Promise<Blob | null> {
    return null;
  }

  getSyncStatus(): SyncAdapterStatus {
    return {
      syncState: this.syncState,
      pendingChanges: this.pendingChanges,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
    };
  }
}

export function createSupabaseSyncAdapter(client?: SupabaseClient | null): SupabaseSyncAdapter {
  return new SupabaseSyncAdapter(client ?? getSupabaseClient());
}
