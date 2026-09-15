/**
 * FINANZ-CORE-DURABILITY-01B — Cloud-Spiegel von Datei, Binding, Eingang,
 * WorkResult und archiviertem Fremddokument.
 *
 * Reine Zuordnungs- und Merge-Logik (kein React, keine Store-Mutation) plus die
 * beiden RPC-/Storage-Wrapper. Die Sync-Engine bleibt die bestehende
 * Outbox/Pull-Maschine; hier wird nur beschrieben, wie die fuenf Entitaeten
 * in ihre Cloud-Zeilen und zurueck kommen.
 *
 * Vier Wahrheiten, nie vermischt:
 *   Originaldatei (Bytes, Hash)          -> workspace_files + Bucket
 *   KI-/Analyseergebnis (rekonstruierbar) -> work_results.analysis
 *   Nutzer-Overlay (bestaetigt/korrigiert) -> work_results.overlay, slotweise
 *   eingefrorener archiveTruthSnapshot   -> archived_document.payload (write-once)
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase';
import type { AppPersistedState, CompanyDocument, InboxItem } from '../../types/models';
import type { DocumentFileRef } from '../../types/documentFileRef';
import type { DocumentFileRepresentationBinding } from '../../types/documentFileRepresentationBinding';
import type { DocumentWorkResult, DocumentWorkResultOverlayEntry } from '../../types/documentWorkResult';
import type { SyncEntityType, SyncMeta, SyncOutboxEntry } from '../../types/sync';
import { WorkspaceCloudError } from '../workspace/workspaceCloudService';
import { computeBufferContentHash } from '../documentFileHashService';

export const WORKSPACE_FILES_BUCKET = 'workspace-files';

export const INTAKE_SYNC_ENTITY_TYPES: readonly SyncEntityType[] = [
  'document_file',
  'document_file_binding',
  'inbox_item',
  'document_work_result',
  'document',
];

export function isIntakeSyncEntityType(entityType: SyncEntityType): boolean {
  return INTAKE_SYNC_ENTITY_TYPES.includes(entityType);
}

/** Pushreihenfolge: Datei vor allem, was sie referenziert. */
export const INTAKE_PUSH_ORDER: Record<string, number> = {
  document_file: 0,
  document: 1,
  document_file_binding: 2,
  inbox_item: 3,
  document_work_result: 4,
};

// ---------------------------------------------------------------------------
// Kennungen
// ---------------------------------------------------------------------------

export type CloudBindingKind = 'original' | 'archive' | 'preview' | 'thumbnail' | 'structured';

/** Bindings haben keine eigene ID — der natuerliche Schluessel ist die Kennung. */
export function buildBindingEntityId(documentId: string, kind: CloudBindingKind, part?: string | null): string {
  return `${documentId}|${kind}|${part ?? ''}`;
}

export function parseBindingEntityId(id: string): { documentId: string; kind: CloudBindingKind; part: string | null } | null {
  const [documentId, kind, part] = id.split('|');
  if (!documentId || !kind) return null;
  return { documentId, kind: kind as CloudBindingKind, part: part ? part : null };
}

export function buildStoragePath(workspaceId: string, contentHash: string): string {
  return `${workspaceId}/${contentHash.toLowerCase()}`;
}

/** Nur echte Uploads (`inbox-upload-<ts>`); Demo-Eintraege `inbox-00N` bleiben lokal. */
export function isCloudSyncBlockedMockInboxId(inboxId: string | undefined | null): boolean {
  return Boolean(inboxId && /^inbox-\d{3}$/.test(inboxId));
}

/** Vorschau/Thumbnail sind lokal regenerierbar und werden nicht gesynct. */
export function isCloudSyncedBindingKind(kind: string): kind is CloudBindingKind {
  return kind === 'original' || kind === 'archive' || kind === 'structured';
}

// ---------------------------------------------------------------------------
// Content-Keys (Change-Tracker): fachliche Aenderung != Server-Metaaenderung
// ---------------------------------------------------------------------------

function stripSync<T extends { sync?: SyncMeta }>(entity: T): Omit<T, 'sync'> {
  const { sync: _sync, ...rest } = entity;
  return rest;
}

export function buildDocumentFileContentKey(ref: DocumentFileRef): string {
  return JSON.stringify({
    hash: ref.contentHash,
    size: ref.fileSize,
    mime: ref.mimeType,
    name: ref.originalFileName,
    lifecycle: ref.lifecycleStatus,
    derivedFrom: ref.derivedFromFileRefId ?? null,
    deleted: ref.sync?.deleted ?? false,
  });
}

export function buildBindingContentKey(binding: DocumentFileRepresentationBinding): string {
  return JSON.stringify({ fileRefId: binding.fileRefId, provenance: binding.provenance ?? 'derived', deleted: binding.sync?.deleted ?? false });
}

export function buildWorkResultContentKey(result: DocumentWorkResult): string {
  return JSON.stringify(stripSync(result));
}

// ---------------------------------------------------------------------------
// Push-Payloads (Client -> RPC)
// ---------------------------------------------------------------------------

export function buildDocumentFilePushPayload(ref: DocumentFileRef, deleted: boolean): Record<string, unknown> {
  return {
    client_file_ref_id: ref.id,
    content_sha256: ref.contentHash.toLowerCase(),
    size_bytes: ref.fileSize,
    mime_type: ref.mimeType || 'application/octet-stream',
    original_file_name: ref.originalFileName,
    derived_from_client_file_ref_id: ref.derivedFromFileRefId ?? null,
    uploaded_at: ref.cloud?.uploadedAt ?? ref.createdAt,
    deleted,
  };
}

export function buildBindingPushPayload(
  binding: { documentId: string; kind: CloudBindingKind; part?: string | null; fileRefId: string; provenance?: string },
  deleted: boolean,
): Record<string, unknown> {
  return {
    binding_id: buildBindingEntityId(binding.documentId, binding.kind, binding.part),
    client_document_id: binding.documentId,
    client_file_ref_id: binding.fileRefId,
    binding_kind: binding.kind,
    part: binding.part ?? null,
    provenance: binding.provenance ?? (binding.kind === 'original' ? 'received' : 'derived'),
    deleted,
  };
}

/** Minimaler Eingangs-Payload: keine DataURLs, keine `_`-Volltextfelder. */
export function buildInboxItemCloudPayload(item: InboxItem): Record<string, unknown> {
  const recognizedData: Record<string, string> = {};
  for (const [key, value] of Object.entries(item.recognizedData ?? {})) {
    if (key.startsWith('_')) continue;
    recognizedData[key] = value;
  }
  const {
    sync: _sync,
    recognizedData: _rd,
    originalRecognizedData,
    ...rest
  } = item as InboxItem & { imagePreview?: string; previewUrl?: string };
  const { imagePreview: _ip, previewUrl: _pu, ...safe } = rest;
  const original: Record<string, string> = {};
  for (const [key, value] of Object.entries(originalRecognizedData ?? {})) {
    if (key.startsWith('_')) continue;
    original[key] = value;
  }
  return { ...safe, recognizedData, ...(originalRecognizedData ? { originalRecognizedData: original } : {}) };
}

export function buildInboxItemPushPayload(item: InboxItem, deleted: boolean): Record<string, unknown> {
  return {
    client_inbox_id: item.id,
    status: item.status,
    vorgang_link_status: item.vorgangLinkStatus ?? 'none',
    client_file_ref_id: item.fileRefId ?? null,
    archive_document_id: item.archiveDocumentId ?? null,
    vorgang_id: item.vorgangId ?? null,
    expense_id: null,
    payload: buildInboxItemCloudPayload(item),
    deleted,
  };
}

export function buildWorkResultPushPayload(result: DocumentWorkResult, deleted: boolean): Record<string, unknown> {
  const { overlay, sync: _sync, ...analysis } = result;
  return {
    client_inbox_id: result.inboxItemId,
    source_fingerprint: result.sourceFingerprint,
    analysis_version: result.analysisVersion,
    analyzed_at: result.analyzedAt,
    analysis,
    overlay,
    deleted,
  };
}

/** Archiviertes Fremddokument: Datei ausschliesslich ueber Bindings, kein DataURL/Preview im Payload. */
export function buildArchivedDocumentPushPayload(document: CompanyDocument, deleted: boolean): Record<string, unknown> {
  const { sync: _sync, imagePreview: _preview, fileRefId: _fileRefId, ...payload } = document;
  return {
    client_document_id: document.id,
    linked_invoice_id: document.linkedInvoiceId ?? null,
    linked_vorgang_id: document.linkedVorgang?.vorgangId ?? null,
    payload,
    deleted,
  };
}

/** Das lokale `document.fileRefId` ist das primaere Original — in der Cloud ein explizites Binding. */
export function buildOriginalBindingForDocument(document: CompanyDocument): { documentId: string; kind: CloudBindingKind; fileRefId: string; provenance: 'received' } | null {
  if (!document.fileRefId) return null;
  return { documentId: document.id, kind: 'original', fileRefId: document.fileRefId, provenance: 'received' };
}

// ---------------------------------------------------------------------------
// Cloud-Zeilen (RPC -> Client)
// ---------------------------------------------------------------------------

export interface CloudFileRow {
  client_file_ref_id: string;
  content_sha256: string;
  size_bytes: number;
  mime_type: string;
  original_file_name: string;
  storage_path: string;
  derived_from_client_file_ref_id: string | null;
  uploaded_at: string;
  updated_at: string;
  deleted: boolean;
  row_version: number;
}

export interface CloudBindingRow {
  client_document_id: string;
  client_file_ref_id: string;
  binding_kind: CloudBindingKind;
  part: string | null;
  provenance: 'received' | 'extracted' | 'derived';
  updated_at: string;
  deleted: boolean;
  row_version: number;
}

export interface CloudInboxRow {
  client_inbox_id: string;
  status: InboxItem['status'];
  vorgang_link_status: 'none' | 'linked' | 'created';
  client_file_ref_id: string | null;
  archive_document_id: string | null;
  vorgang_id: string | null;
  expense_id: string | null;
  payload: Record<string, unknown>;
  updated_at: string;
  deleted: boolean;
  row_version: number;
}

export interface CloudWorkResultRow {
  client_inbox_id: string;
  source_fingerprint: string;
  analysis_version: string;
  analyzed_at: string | null;
  analysis: Record<string, unknown>;
  overlay: DocumentWorkResultOverlayEntry[];
  updated_at: string;
  deleted: boolean;
  row_version: number;
}

export interface CloudArchivedDocumentRow {
  client_document_id: string;
  document_kind: string;
  linked_invoice_id: string | null;
  linked_vorgang_id: string | null;
  payload: Record<string, unknown>;
  updated_at: string;
  deleted: boolean;
  row_version: number;
}

export interface IntakeCloudPull {
  files: CloudFileRow[];
  bindings: CloudBindingRow[];
  inboxItems: CloudInboxRow[];
  workResults: CloudWorkResultRow[];
  archivedDocuments: CloudArchivedDocumentRow[];
}

function cloudMeta(row: { updated_at: string; deleted: boolean; row_version: number }, deviceId: string, workspaceId: string): SyncMeta {
  return {
    updatedAt: row.updated_at,
    version: Number(row.row_version),
    deleted: Boolean(row.deleted),
    deletedAt: row.deleted ? row.updated_at : undefined,
    deviceId,
    workspaceId,
  };
}

// ---------------------------------------------------------------------------
// Merge — ID-basiert, row_version-getrieben, kein stilles local-wins
// ---------------------------------------------------------------------------

export interface IntakeMergeContext {
  deviceId: string;
  workspaceId: string;
  /** Kennungen (`type:id`) mit lokal noch nicht gepushten Aenderungen. */
  dirty: ReadonlySet<string>;
}

export interface IntakeMergeResult<T> {
  items: T[];
  conflicts: string[];
}

export function collectDirtyIntakeKeys(outbox: SyncOutboxEntry[] | undefined): Set<string> {
  const dirty = new Set<string>();
  for (const entry of outbox ?? []) {
    if ((entry.status === 'pending' || entry.status === 'error' || entry.status === 'blocked') && isIntakeSyncEntityType(entry.entityType)) {
      dirty.add(`${entry.entityType}:${entry.entityId}`);
    }
  }
  return dirty;
}

/**
 * Regel fuer jede ID-basierte Entitaet:
 *  - lokal unbekannt        -> Remote uebernehmen
 *  - Remote-Version <= lokal -> lokal behalten (nichts Neues)
 *  - Remote neuer, lokal sauber -> Remote uebernehmen
 *  - Remote neuer, lokal schmutzig -> Konflikt: lokal behalten, melden (Push blockiert spaeter mit Versionskonflikt)
 */
function mergeById<T extends { sync?: SyncMeta }>(
  entityType: SyncEntityType,
  local: T[],
  remote: Array<{ id: string; entity: T }>,
  idOf: (item: T) => string,
  context: IntakeMergeContext,
): IntakeMergeResult<T> {
  const byId = new Map(local.map((item) => [idOf(item), item]));
  const conflicts: string[] = [];
  for (const { id, entity } of remote) {
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, entity);
      continue;
    }
    const localVersion = existing.sync?.version ?? 0;
    const remoteVersion = entity.sync?.version ?? 0;
    if (remoteVersion <= localVersion) continue;
    if (context.dirty.has(`${entityType}:${id}`)) {
      conflicts.push(`${entityType}:${id}`);
      continue;
    }
    byId.set(id, entity);
  }
  return { items: [...byId.values()], conflicts };
}

export function mapCloudFileRow(row: CloudFileRow, local: DocumentFileRef | undefined, context: IntakeMergeContext): DocumentFileRef {
  const base: DocumentFileRef = local ?? {
    id: row.client_file_ref_id,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    fileSize: Number(row.size_bytes),
    contentHash: row.content_sha256,
    storageType: 'cloud',
    localDataKey: row.client_file_ref_id,
    createdAt: row.uploaded_at,
    lifecycleStatus: 'committed',
    committedAt: row.uploaded_at,
  };
  return {
    ...base,
    originalFileName: row.original_file_name || base.originalFileName,
    mimeType: row.mime_type || base.mimeType,
    derivedFromFileRefId: row.derived_from_client_file_ref_id ?? base.derivedFromFileRefId,
    cloud: { storagePath: row.storage_path, uploadedAt: row.uploaded_at },
    sync: cloudMeta(row, context.deviceId, context.workspaceId),
  };
}

export function mergeFileRefsFromPull(local: DocumentFileRef[], rows: CloudFileRow[], context: IntakeMergeContext): IntakeMergeResult<DocumentFileRef> {
  const byId = new Map(local.map((ref) => [ref.id, ref]));
  return mergeById(
    'document_file',
    local,
    rows.map((row) => ({ id: row.client_file_ref_id, entity: mapCloudFileRow(row, byId.get(row.client_file_ref_id), context) })),
    (ref) => ref.id,
    context,
  );
}

export function mapCloudBindingRow(row: CloudBindingRow, context: IntakeMergeContext): DocumentFileRepresentationBinding & { kind: CloudBindingKind; part: string | null } {
  return {
    documentId: row.client_document_id,
    kind: row.binding_kind as DocumentFileRepresentationBinding['kind'],
    fileRefId: row.client_file_ref_id,
    provenance: row.provenance,
    part: row.part,
    sync: cloudMeta(row, context.deviceId, context.workspaceId),
  } as DocumentFileRepresentationBinding & { kind: CloudBindingKind; part: string | null };
}

/**
 * Bindings: `original` wird nicht in die lokale Binding-Liste gemischt (lokal
 * lebt es als `document.fileRefId`); alle anderen gesyncten Rollen schon.
 */
export function mergeBindingsFromPull(
  local: DocumentFileRepresentationBinding[],
  rows: CloudBindingRow[],
  context: IntakeMergeContext,
): IntakeMergeResult<DocumentFileRepresentationBinding> & { originals: Map<string, string> } {
  const originals = new Map<string, string>();
  const remote: Array<{ id: string; entity: DocumentFileRepresentationBinding }> = [];
  for (const row of rows) {
    if (row.binding_kind === 'original') {
      if (!row.deleted && !row.part) originals.set(row.client_document_id, row.client_file_ref_id);
      continue;
    }
    if (row.binding_kind === 'preview' || row.binding_kind === 'thumbnail') continue;
    remote.push({ id: buildBindingEntityId(row.client_document_id, row.binding_kind, row.part), entity: mapCloudBindingRow(row, context) });
  }
  const merged = mergeById(
    'document_file_binding',
    local,
    remote,
    (binding) => buildBindingEntityId(binding.documentId, binding.kind as CloudBindingKind, (binding as { part?: string | null }).part),
    context,
  );
  // Grabsteine verlassen die aktive Binding-Liste (lokal kennt kein tombstoned Binding).
  return { items: merged.items.filter((binding) => !binding.sync?.deleted), conflicts: merged.conflicts, originals };
}

export function mapCloudInboxRow(row: CloudInboxRow, local: InboxItem | undefined, context: IntakeMergeContext): InboxItem {
  const payload = row.payload as Partial<InboxItem>;
  const base: InboxItem = {
    ...(local ?? ({} as InboxItem)),
    ...payload,
    id: row.client_inbox_id,
    status: row.status,
    vorgangLinkStatus: row.vorgang_link_status,
    fileRefId: row.client_file_ref_id ?? undefined,
    archiveDocumentId: row.archive_document_id ?? undefined,
    vorgangId: row.vorgang_id ?? undefined,
  } as InboxItem;
  // Lokale Volltextfelder (`_…`) bleiben erhalten — die Cloud traegt sie bewusst nicht.
  const localHidden: Record<string, string> = {};
  for (const [key, value] of Object.entries(local?.recognizedData ?? {})) {
    if (key.startsWith('_')) localHidden[key] = value;
  }
  return {
    ...base,
    recognizedData: { ...(payload.recognizedData ?? {}), ...localHidden },
    sync: cloudMeta(row, context.deviceId, context.workspaceId),
  };
}

export function mergeInboxItemsFromPull(local: InboxItem[], rows: CloudInboxRow[], context: IntakeMergeContext): IntakeMergeResult<InboxItem> {
  const byId = new Map(local.map((item) => [item.id, item]));
  return mergeById(
    'inbox_item',
    local,
    rows.map((row) => ({ id: row.client_inbox_id, entity: mapCloudInboxRow(row, byId.get(row.client_inbox_id), context) })),
    (item) => item.id,
    context,
  );
}

/**
 * Overlay slotweise: neuerer `updatedAt` gewinnt; ist derselbe Slot auf beiden
 * Seiten seit dem letzten Sync geaendert worden, wird er als `reviewConflict`
 * markiert — nie still ueberschrieben.
 */
export function mergeOverlaySlots(
  localOverlay: DocumentWorkResultOverlayEntry[],
  remoteOverlay: DocumentWorkResultOverlayEntry[],
  localDirty: boolean,
): { overlay: DocumentWorkResultOverlayEntry[]; conflictSlots: string[] } {
  const bySlot = new Map(localOverlay.map((entry) => [entry.slotId, entry]));
  const conflictSlots: string[] = [];
  for (const remote of remoteOverlay) {
    const local = bySlot.get(remote.slotId);
    if (!local) {
      bySlot.set(remote.slotId, remote);
      continue;
    }
    const same = local.status === remote.status && JSON.stringify(local.value) === JSON.stringify(remote.value);
    if (same) {
      if (remote.updatedAt > local.updatedAt) bySlot.set(remote.slotId, remote);
      continue;
    }
    if (localDirty) {
      conflictSlots.push(remote.slotId);
      bySlot.set(remote.slotId, { ...local, reviewConflict: true, conflictReason: 'concurrent_overlay_change' });
      continue;
    }
    bySlot.set(remote.slotId, remote.updatedAt >= local.updatedAt ? remote : local);
  }
  return { overlay: [...bySlot.values()], conflictSlots };
}

export function mapCloudWorkResultRow(row: CloudWorkResultRow, local: DocumentWorkResult | undefined, context: IntakeMergeContext, localDirty: boolean): { result: DocumentWorkResult; conflictSlots: string[] } {
  const analysis = row.analysis as Partial<DocumentWorkResult>;
  const sameSource = !local || local.sourceFingerprint === row.source_fingerprint;
  // Analyse nur bei gleichem Fingerprint zusammenfuehren; sonst bleibt die lokale Analyse.
  const base: DocumentWorkResult = sameSource
    ? ({
        ...(local ?? {}),
        ...analysis,
        inboxItemId: row.client_inbox_id,
        sourceFingerprint: row.source_fingerprint,
        analysisVersion: row.analysis_version,
        analyzedAt: row.analyzed_at ?? local?.analyzedAt ?? row.updated_at,
      } as DocumentWorkResult)
    : (local as DocumentWorkResult);
  const merged = mergeOverlaySlots(local?.overlay ?? [], row.overlay ?? [], localDirty);
  return {
    result: { ...base, overlay: merged.overlay, sync: cloudMeta(row, context.deviceId, context.workspaceId) },
    conflictSlots: merged.conflictSlots,
  };
}

export function mergeWorkResultsFromPull(local: DocumentWorkResult[], rows: CloudWorkResultRow[], context: IntakeMergeContext): IntakeMergeResult<DocumentWorkResult> {
  const byId = new Map(local.map((result) => [result.inboxItemId, result]));
  const conflicts: string[] = [];
  for (const row of rows) {
    const existing = byId.get(row.client_inbox_id);
    const localVersion = existing?.sync?.version ?? 0;
    if (existing && Number(row.row_version) <= localVersion) continue;
    const dirty = context.dirty.has(`document_work_result:${row.client_inbox_id}`);
    const mapped = mapCloudWorkResultRow(row, existing, context, dirty);
    for (const slot of mapped.conflictSlots) conflicts.push(`document_work_result:${row.client_inbox_id}:${slot}`);
    byId.set(row.client_inbox_id, mapped.result);
  }
  return { items: [...byId.values()], conflicts };
}

export function mapCloudArchivedDocumentRow(row: CloudArchivedDocumentRow, local: CompanyDocument | undefined, originalFileRefId: string | undefined, context: IntakeMergeContext): CompanyDocument {
  const payload = row.payload as Partial<CompanyDocument>;
  return {
    ...(local ?? ({} as CompanyDocument)),
    ...payload,
    id: row.client_document_id,
    fileRefId: originalFileRefId ?? local?.fileRefId ?? payload.fileRefId,
    linkedInvoiceId: row.linked_invoice_id ?? payload.linkedInvoiceId ?? null,
    sync: cloudMeta(row, context.deviceId, context.workspaceId),
  } as CompanyDocument;
}

/** Nur archivierte Fremddokumente; generierte Rechnungsdokumente laufen ueber ihren eigenen Pull. */
export function mergeArchivedDocumentsFromPull(
  local: CompanyDocument[],
  rows: CloudArchivedDocumentRow[],
  originals: Map<string, string>,
  context: IntakeMergeContext,
): IntakeMergeResult<CompanyDocument> {
  const byId = new Map(local.map((document) => [document.id, document]));
  return mergeById(
    'document',
    local,
    rows
      .filter((row) => row.document_kind === 'archived_document')
      .map((row) => ({
        id: row.client_document_id,
        entity: mapCloudArchivedDocumentRow(row, byId.get(row.client_document_id), originals.get(row.client_document_id), context),
      })),
    (document) => document.id,
    context,
  );
}

export interface IntakePullApplied {
  state: AppPersistedState;
  conflicts: string[];
  counts: Record<string, number>;
}

export function applyIntakePullToState(state: AppPersistedState, pull: IntakeCloudPull, context: IntakeMergeContext): IntakePullApplied {
  const files = mergeFileRefsFromPull(state.documentFileRefs ?? [], pull.files, context);
  const bindings = mergeBindingsFromPull(state.documentFileRepresentationBindings ?? [], pull.bindings, context);
  const inbox = mergeInboxItemsFromPull(state.inboxItems, pull.inboxItems, context);
  const work = mergeWorkResultsFromPull(state.documentWorkResults ?? [], pull.workResults, context);
  const documents = mergeArchivedDocumentsFromPull(state.documents ?? [], pull.archivedDocuments, bindings.originals, context);
  return {
    state: {
      ...state,
      documentFileRefs: files.items,
      documentFileRepresentationBindings: bindings.items,
      inboxItems: inbox.items,
      documentWorkResults: work.items,
      documents: documents.items,
    },
    conflicts: [...files.conflicts, ...bindings.conflicts, ...inbox.conflicts, ...work.conflicts, ...documents.conflicts],
    counts: {
      files: pull.files.length,
      bindings: pull.bindings.length,
      inboxItems: pull.inboxItems.length,
      workResults: pull.workResults.length,
      archivedDocuments: pull.archivedDocuments.length,
    },
  };
}

// ---------------------------------------------------------------------------
// RPC / Storage
// ---------------------------------------------------------------------------

function classify(error: { message?: string; code?: string }): WorkspaceCloudError {
  const message = error.message ?? 'Unbekannter Cloud-Fehler';
  if (message.includes('Nicht angemeldet')) return new WorkspaceCloudError(message, 'auth', false);
  if (message.includes('Kein Zugriff') || message.includes('Keine Schreibberechtigung') || error.code === '42501') {
    return new WorkspaceCloudError(message, 'rls', false);
  }
  if (message.includes('Versionskonflikt')) return new WorkspaceCloudError(message, 'version_conflict', false);
  if (message.includes('Failed to fetch') || message.includes('Network')) return new WorkspaceCloudError(message, 'network', true);
  return new WorkspaceCloudError(message, 'unknown', true);
}

function client(explicit?: SupabaseClient | null): SupabaseClient {
  const resolved = explicit ?? getSupabaseClient();
  if (!resolved) throw new WorkspaceCloudError('Supabase ist nicht konfiguriert.', 'unknown', false);
  return resolved;
}

export async function rpcUpsertWorkspaceIntakeEntity(
  workspaceId: string,
  entityType: string,
  payload: Record<string, unknown>,
  rowVersion: number,
  explicit?: SupabaseClient | null,
): Promise<{ rowVersion: number; deleted: boolean; payload: Record<string, unknown> }> {
  const { data, error } = await client(explicit).rpc('upsert_workspace_intake_entity', {
    p_workspace_id: workspaceId,
    p_entity_type: entityType,
    p_payload: payload,
    p_row_version: rowVersion,
  });
  if (error) throw classify(error);
  return {
    rowVersion: Number(data?.row_version ?? rowVersion),
    deleted: Boolean(data?.deleted),
    payload: (data?.payload as Record<string, unknown>) ?? {},
  };
}

export async function rpcPullWorkspaceIntakeState(workspaceId: string, explicit?: SupabaseClient | null): Promise<IntakeCloudPull> {
  const { data, error } = await client(explicit).rpc('pull_workspace_intake_state', { p_workspace_id: workspaceId });
  if (error) throw classify(error);
  return {
    files: (data?.files as CloudFileRow[] | null) ?? [],
    bindings: (data?.bindings as CloudBindingRow[] | null) ?? [],
    inboxItems: (data?.inbox_items as CloudInboxRow[] | null) ?? [],
    workResults: (data?.work_results as CloudWorkResultRow[] | null) ?? [],
    archivedDocuments: (data?.archived_documents as CloudArchivedDocumentRow[] | null) ?? [],
  };
}

/**
 * Idempotenter Upload: Pfad = ws/sha256, upsert:false. "Objekt existiert bereits"
 * ist Erfolg (gleiche Bytes). Der Hash wird vor dem Upload gegen die Bytes geprueft.
 */
export async function uploadWorkspaceFileBytes(input: {
  workspaceId: string;
  contentHash: string;
  bytes: Uint8Array;
  mimeType: string;
  client?: SupabaseClient | null;
}): Promise<{ storagePath: string; reused: boolean }> {
  const actual = await computeBufferContentHash(input.bytes);
  if (actual !== input.contentHash.toLowerCase()) {
    throw new WorkspaceCloudError('Dateihash stimmt nicht mit den lokalen Bytes ueberein', 'unknown', false);
  }
  const storagePath = buildStoragePath(input.workspaceId, input.contentHash);
  const { error } = await client(input.client)
    .storage.from(WORKSPACE_FILES_BUCKET)
    .upload(storagePath, input.bytes, { contentType: input.mimeType || 'application/octet-stream', upsert: false });
  if (!error) return { storagePath, reused: false };
  const message = error.message ?? '';
  const status = (error as { statusCode?: string | number }).statusCode;
  if (String(status) === '409' || /already exists|Duplicate/i.test(message)) {
    return { storagePath, reused: true };
  }
  throw classify(error);
}

/** Download mit Hash-/Groessenverifikation — niemals ungepruefte Bytes lokal ablegen. */
export async function downloadWorkspaceFileBytes(input: {
  storagePath: string;
  expectedHash: string;
  expectedSize: number;
  client?: SupabaseClient | null;
}): Promise<Uint8Array> {
  const { data, error } = await client(input.client).storage.from(WORKSPACE_FILES_BUCKET).download(input.storagePath);
  if (error || !data) throw classify(error ?? { message: 'Download fehlgeschlagen' });
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength !== input.expectedSize) {
    throw new WorkspaceCloudError('Dateigroesse weicht von der Cloud-Zeile ab', 'unknown', false);
  }
  const hash = await computeBufferContentHash(bytes);
  if (hash !== input.expectedHash.toLowerCase()) {
    throw new WorkspaceCloudError('Dateihash weicht von der Cloud-Zeile ab', 'unknown', false);
  }
  return bytes;
}
