/** CLOUD-DATA-01 – Allowlist für Supabase-Sync (nur Workspace-Setup-Daten). */

import type { SyncEntityType } from '../../types/sync';

export const SUPABASE_SYNC_ALLOWLIST: ReadonlySet<SyncEntityType> = new Set([
  'workspace',
  'workspace_member',
  'workspace_settings',
  'company_setup',
  'company_profile',
  'vorgang',
  'customer',
  // FINANZ-CORE-DURABILITY-01B — Eingang, Archivdokument, Datei, Binding, WorkResult
  'inbox_item',
  'document',
  'document_file',
  'document_file_binding',
  'document_work_result',
  // FINANZ-CORE-DURABILITY-01C — Ausgaben und ihre Zahlungen
  'expense',
  'expense_payment',
]);

export const LOCAL_ONLY_SYNC_ENTITY_TYPES: ReadonlySet<SyncEntityType> = new Set([
  'document_memory',
  'proof_memory',
  'memory_relation',
  'paper_register_entry',
  'mail_import',
  'task',
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
