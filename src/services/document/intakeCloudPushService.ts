/**
 * FINANZ-CORE-DURABILITY-01B — Push einer Intake-Entitaet in die Cloud.
 *
 * Datei: lokaler Blob -> Hash -> Storage-Upload (oder vorhandener Hash) ->
 * workspace_files-Registrierung. Alles andere: Payload -> RPC. Idempotent bei
 * Wiederholung: derselbe Pfad, dieselbe Zeile, kein zweiter Blob.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SyncOutboxOperation } from '../../types/sync';
import type { CloudSyncEntityPayload } from '../workspace/workspaceSyncPayloadService';
import type { DocumentFileRef } from '../../types/documentFileRef';
import { getOriginalDocumentFileBytes } from '../documentFileStoreService';
import { WorkspaceCloudError } from '../workspace/workspaceCloudService';
import {
  buildArchivedDocumentPushPayload,
  buildBindingPushPayload,
  buildDocumentFilePushPayload,
  buildInboxItemPushPayload,
  buildWorkResultPushPayload,
  isCloudSyncBlockedMockInboxId,
  rpcUpsertWorkspaceIntakeEntity,
  uploadWorkspaceFileBytes,
  type CloudBindingKind,
} from './intakeCloudSyncService';

export type IntakePushOutcome =
  | { kind: 'pushed'; rowVersion: number; deleted: boolean; storagePath?: string }
  | { kind: 'skipped'; reason: string };

/** Nur committed Dateien mit lokalen Bytes wandern hoch; Cloud-Referenzen ohne Bytes sind kein Push. */
async function pushFile(
  ref: DocumentFileRef,
  workspaceId: string,
  deleted: boolean,
  rowVersion: number,
  client?: SupabaseClient | null,
): Promise<IntakePushOutcome> {
  if (deleted) {
    const result = await rpcUpsertWorkspaceIntakeEntity(workspaceId, 'document_file', buildDocumentFilePushPayload(ref, true), rowVersion, client);
    return { kind: 'pushed', rowVersion: result.rowVersion, deleted: result.deleted };
  }
  if (ref.lifecycleStatus !== 'committed') return { kind: 'skipped', reason: `lifecycle:${ref.lifecycleStatus}` };
  if (!ref.contentHash || ref.contentHash.startsWith('legacy:')) return { kind: 'skipped', reason: 'no_hash' };

  let storagePath = ref.cloud?.storagePath;
  if (ref.storageType !== 'cloud') {
    const bytes = await getOriginalDocumentFileBytes(ref, [{ type: 'guest' }]);
    if (!bytes) {
      throw new WorkspaceCloudError(`Lokale Bytes fuer ${ref.id} nicht lesbar`, 'unknown', true);
    }
    const uploaded = await uploadWorkspaceFileBytes({ workspaceId, contentHash: ref.contentHash, bytes, mimeType: ref.mimeType, client });
    storagePath = uploaded.storagePath;
  } else if (!storagePath) {
    return { kind: 'skipped', reason: 'cloud_ref_without_bytes' };
  }

  const result = await rpcUpsertWorkspaceIntakeEntity(workspaceId, 'document_file', buildDocumentFilePushPayload(ref, false), rowVersion, client);
  return { kind: 'pushed', rowVersion: result.rowVersion, deleted: result.deleted, storagePath };
}

export async function pushIntakeEntity(
  extracted: CloudSyncEntityPayload,
  operation: SyncOutboxOperation,
  workspaceId: string,
  client?: SupabaseClient | null,
): Promise<IntakePushOutcome> {
  const deleted = operation === 'delete' || ('deleted' in extracted && extracted.deleted);
  switch (extracted.entityType) {
    case 'document_file':
      return pushFile(extracted.entity, workspaceId, deleted, extracted.rowVersion, client);
    case 'document_file_binding': {
      const binding = extracted.entity as typeof extracted.entity & { part?: string | null };
      const result = await rpcUpsertWorkspaceIntakeEntity(
        workspaceId,
        'document_file_binding',
        buildBindingPushPayload({ documentId: binding.documentId, kind: binding.kind as CloudBindingKind, part: binding.part, fileRefId: binding.fileRefId, provenance: binding.provenance }, deleted),
        extracted.rowVersion,
        client,
      );
      return { kind: 'pushed', rowVersion: result.rowVersion, deleted: result.deleted };
    }
    case 'inbox_item': {
      if (isCloudSyncBlockedMockInboxId(extracted.entityId)) return { kind: 'skipped', reason: 'mock' };
      const result = await rpcUpsertWorkspaceIntakeEntity(workspaceId, 'inbox_item', buildInboxItemPushPayload(extracted.entity, deleted), extracted.rowVersion, client);
      return { kind: 'pushed', rowVersion: result.rowVersion, deleted: result.deleted };
    }
    case 'document_work_result': {
      if (isCloudSyncBlockedMockInboxId(extracted.entityId)) return { kind: 'skipped', reason: 'mock' };
      const result = await rpcUpsertWorkspaceIntakeEntity(workspaceId, 'document_work_result', buildWorkResultPushPayload(extracted.entity, deleted), extracted.rowVersion, client);
      return { kind: 'pushed', rowVersion: result.rowVersion, deleted: result.deleted };
    }
    case 'document': {
      const document = extracted.entity;
      // Rechnungsdokumente laufen ueber ihren eigenen Cloud-Pfad (05C1); hier nur Fremddokumente.
      if (document.linkedInvoiceId && document.category === 'ausgangsrechnung') return { kind: 'skipped', reason: 'generated_invoice' };
      if (isCloudSyncBlockedMockInboxId(document.sourceInboxItemId)) return { kind: 'skipped', reason: 'mock' };
      const result = await rpcUpsertWorkspaceIntakeEntity(workspaceId, 'archived_document', buildArchivedDocumentPushPayload(document, deleted), extracted.rowVersion, client);
      // Das primaere Original ist in der Cloud ein explizites Binding.
      if (!deleted && document.fileRefId) {
        await rpcUpsertWorkspaceIntakeEntity(
          workspaceId,
          'document_file_binding',
          buildBindingPushPayload({ documentId: document.id, kind: 'original', fileRefId: document.fileRefId, provenance: 'received' }, false),
          0,
          client,
        ).catch((error: unknown) => {
          // Bereits vorhanden (Versionskonflikt bei 0) = idempotent; alles andere ist ein echter Fehler.
          if (error instanceof WorkspaceCloudError && error.code === 'version_conflict') return;
          throw error;
        });
      }
      return { kind: 'pushed', rowVersion: result.rowVersion, deleted: result.deleted };
    }
    default:
      return { kind: 'skipped', reason: 'not_intake' };
  }
}
