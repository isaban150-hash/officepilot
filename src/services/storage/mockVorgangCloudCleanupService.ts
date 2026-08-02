/**
 * Explicit / manual cleanup for demo vorgänge already stored in a real workspace cloud.
 *
 * NOT wired into login or workspace bootstrap — must be invoked deliberately
 * (CLI script or future admin action).
 *
 * Soft-deletes only known seed IDs: v-001, v-002, v-003 (no title matching).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Vorgang } from '../../types/models';
import {
  listCloudCleanupMockVorgangIds,
  isCloudSyncBlockedMockVorgangId,
} from './mockDataDetectionService';
import {
  buildVorgangCloudPushPayload,
  type WorkspaceVorgangRow,
} from '../vorgang/vorgangCloudService';
import { rpcPullWorkspaceSyncState, rpcUpsertWorkspaceSyncEntity } from '../workspace/workspaceCloudService';

export type MockVorgangCloudCleanupPlan = {
  workspaceId: string;
  candidateIds: string[];
  activeInCloud: string[];
  alreadyDeleted: string[];
};

export type MockVorgangCloudCleanupResult = {
  workspaceId: string;
  planned: string[];
  tombstoned: string[];
  skippedAlreadyDeleted: string[];
  errors: Array<{ vorgangId: string; message: string }>;
};

function rowVorgangId(row: WorkspaceVorgangRow): string {
  return row.vorgang_id;
}

/**
 * Inspect pull payload and list which demo IDs still need a cloud tombstone.
 * Does not mutate anything.
 */
export function planMockVorgangCloudCleanup(
  workspaceId: string,
  pullVorgaenge: WorkspaceVorgangRow[] | null | undefined,
): MockVorgangCloudCleanupPlan {
  const candidateIds = [...listCloudCleanupMockVorgangIds()];
  const byId = new Map(
    (pullVorgaenge ?? [])
      .filter((row) => isCloudSyncBlockedMockVorgangId(rowVorgangId(row)))
      .map((row) => [rowVorgangId(row), row] as const),
  );

  const activeInCloud: string[] = [];
  const alreadyDeleted: string[] = [];

  for (const id of candidateIds) {
    const row = byId.get(id);
    if (!row) continue;
    if (row.deleted) {
      alreadyDeleted.push(id);
    } else {
      activeInCloud.push(id);
    }
  }

  return {
    workspaceId,
    candidateIds,
    activeInCloud,
    alreadyDeleted,
  };
}

/**
 * Soft-delete demo seed vorgänge in cloud for one workspace.
 * Call only from an explicit operator path (never from login/bootstrap).
 */
export async function runMockVorgangCloudCleanup(input: {
  workspaceId: string;
  client: SupabaseClient;
  /** When true, tombstone even if the row was missing from pull (upsert deleted stub). Default false. */
  forceMissingIds?: boolean;
}): Promise<MockVorgangCloudCleanupResult> {
  const { workspaceId, client } = input;
  const pull = await rpcPullWorkspaceSyncState(workspaceId, client);
  const plan = planMockVorgangCloudCleanup(workspaceId, pull.vorgaenge);

  const toTombstone = input.forceMissingIds
    ? plan.candidateIds.filter((id) => !plan.alreadyDeleted.includes(id))
    : plan.activeInCloud;

  const tombstoned: string[] = [];
  const errors: Array<{ vorgangId: string; message: string }> = [];

  for (const vorgangId of toTombstone) {
    const existing = (pull.vorgaenge ?? []).find((row) => rowVorgangId(row) === vorgangId);
    const payloadTitle =
      existing && typeof (existing.payload as { title?: unknown })?.title === 'string'
        ? String((existing.payload as { title: string }).title)
        : vorgangId;
    const stub = {
      id: vorgangId,
      title: payloadTitle,
      customer: '',
      baustelle: '',
      status: 'eingegangen',
      materialSource: 'unclear',
      orderPositions: [],
      documents: [],
      tasks: [],
      photos: [],
      invoices: [],
    } as Vorgang;
    try {
      await rpcUpsertWorkspaceSyncEntity(
        workspaceId,
        'vorgang',
        buildVorgangCloudPushPayload(stub, true),
        existing ? Number(existing.row_version) : 0,
        client,
      );
      tombstoned.push(vorgangId);
    } catch (error) {
      errors.push({
        vorgangId,
        message: error instanceof Error ? error.message : 'Tombstone fehlgeschlagen',
      });
    }
  }

  return {
    workspaceId,
    planned: toTombstone,
    tombstoned,
    skippedAlreadyDeleted: plan.alreadyDeleted,
    errors,
  };
}
