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
  // CLOUD-DURABILITY-CORE-01B — Vorgangsnotizen. Freigabe erst jetzt: Tabelle,
  // Push, Pull, Merge, Grabstein und RLS sind vollstaendig vorhanden.
  'vorgang_note',
  // CLOUD-DURABILITY-CORE-01C — Aufgaben. Freigabe erst nach Versionsvertrag,
  // Mock-Guard, Tabelle, RLS, Push, Dedupe-Idempotenz, Pull, Merge, Backfill
  // und Engine-Dedupe.
  'task',
  // CLOUD-DURABILITY-CORE-01D — Mahnnachweise (append-only). Freigabe erst nach
  // Entity-Typ, Schema, RLS, Push, Pull, Merge, Backfill, Idempotenz und Tests.
  'dunning_documentation',
  // BRIEFE-01B — Geschaeftsschreiben. Freigabe mit Tabelle, RLS, Push, Pull,
  // Merge, Grabstein, Altbestand und Wiederanlauf nach 01G.
  'business_letter',
  // ANGEBOT-01B — eigene Angebote. Tabelle, RLS, Push, Pull, Merge, Grabstein,
  // Altbestand und Wiederanlauf wie bei Briefen; Freigabe ueber eigene RPC.
  'offer',
  /*
   * STEUERBERATER-06A — Kontierungen. Freigabe erst jetzt, nach derselben
   * Reihenfolge wie bei Briefen und Angeboten: Tabelle, eindeutiger Index,
   * RLS, serverseitige Pruefung, Upsert-RPC mit Versionsvertrag, Grabstein,
   * Pull, Merge mit Konfliktmeldung und Laufzeittests gegen eine echte
   * Datenbank.
   */
  'accounting_assignment',
  /*
   * STEUERBERATER-06B — Abschlussrevisionen. Freigabe nach derselben
   * Reihenfolge: Tabelle, eindeutige Indizes (Revision und hoechstens eine
   * offene je Monat), RLS, Close-/Reopen-/Pull-RPC mit Revisionsvertrag und
   * Laufzeittests gegen eine echte Datenbank.
   */
  'accounting_period_closure',
]);

export const LOCAL_ONLY_SYNC_ENTITY_TYPES: ReadonlySet<SyncEntityType> = new Set([
  'document_memory',
  'proof_memory',
  'memory_relation',
  'paper_register_entry',
  'mail_import',
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
