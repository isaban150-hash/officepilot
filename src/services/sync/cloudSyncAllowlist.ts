/** CLOUD-DATA-01 – Allowlist für Supabase-Sync (nur Workspace-Setup-Daten). */

import type { SyncEntityType } from '../../types/sync';

export const SUPABASE_SYNC_ALLOWLIST: ReadonlySet<SyncEntityType> = new Set([
  'workspace',
  'workspace_member',
  'workspace_settings',
  'company_setup',
  'company_profile',
]);

export const LOCAL_ONLY_SYNC_ENTITY_TYPES: ReadonlySet<SyncEntityType> = new Set([
  'inbox_item',
  'document',
  'document_memory',
  'proof_memory',
  'memory_relation',
  'paper_register_entry',
  'mail_import',
  'task',
  'expense',
  'vorgang',
  'vorgang_note',
  'communication_event',
  'knowledge_fact',
]);

export function isSupabaseSyncAllowed(entityType: SyncEntityType): boolean {
  return SUPABASE_SYNC_ALLOWLIST.has(entityType);
}

export function assertSupabaseSyncAllowed(entityType: SyncEntityType): void {
  if (!isSupabaseSyncAllowed(entityType)) {
    throw new Error(`Entity-Typ "${entityType}" ist nicht für Supabase-Sync freigegeben.`);
  }
}
