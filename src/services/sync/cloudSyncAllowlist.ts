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
  /*
   * BANKABGLEICH-V1 BLOCK 2B — Importkonten und Bankbewegungen.
   *
   * Freigabe erst jetzt, nach derselben Reihenfolge wie bei allen
   * anderen: Tabellen, RLS, Push-Zweig im Dispatcher, Pull in der
   * Sammelfunktion, Merge, Altbestandsnachtrag, Versionsvertrag und
   * Laufzeittests gegen eine echte Datenbank. Beide Migrationen sind
   * remote angewendet.
   *
   * Grabsteine gibt es hier nicht: Block 2B kennt kein Loeschen, und
   * beide Serverzweige weisen es ausdruecklich ab.
   */
  'bank_account',
  'bank_transaction',
  /*
   * CLOUD-SYNC S1 — der Papierablage-Haken. Freigabe erst jetzt, nach
   * derselben Reihenfolge: Tabelle, RLS, Push-Zweig im Dispatcher, Pull in der
   * Sammelfunktion, Abgleich mit Konfliktvertrag, Grabstein, Altbestand,
   * Wiederanlauf und Laufzeittests gegen eine echte Datenbank. Die Migration
   * 20261030120000 ist remote angewendet.
   */
  'paper_register_entry',
  /*
   * CLOUD-SYNC S2 — der Kommunikationsverlauf. Append-only wie der
   * Mahnnachweis: Tabelle, RLS, Push-Zweig mit Replay, Pull in der
   * Sammelfunktion, Vereinigung nach Kennung, Altbestand und Laufzeittests
   * gegen eine echte Datenbank. Die Migration 20261031120000 ist remote
   * angewendet.
   */
  'communication_event',
  /*
   * CLOUD-SYNC S3 — bestaetigtes Wissen. Veraenderbar mit Grabstein wie die
   * Vorgangsnotiz: Tabelle, RLS, Push-Zweig mit Versionsvertrag, Pull in der
   * Sammelfunktion, Abgleich mit Konfliktvertrag, Altbestand, Wiederanlauf
   * und Laufzeittests gegen eine echte Datenbank. Die Migration
   * 20261101120000 ist remote angewendet.
   */
  'knowledge_fact',
  /*
   * CLOUD-SYNC S5 — der fachliche Kern des Rechnungsentwurfs. Hybrid: Die
   * IndexedDB bleibt die sofortige lokale Schreibstelle, der Kern reist über
   * diese Kette. Tabelle mit Slot-Index, RLS, Push-Zweig mit Versionsvertrag,
   * Pull mit Grabsteinen ohne Inhalt, Abgleich mit sichtbarem Konflikt,
   * Altbestand, und die Freigabe verbraucht den Entwurf atomar in
   * `finalize_workspace_invoice`. Erst mit dieser Freigabe trägt eine
   * Rechnungsfreigabe die Entwurfsbindung. Die Migration 20261102120000 ist
   * remote angewendet und gegen die Datei geprüft.
   */
  'invoice_draft',
  /*
   * CLOUD-SYNC S6 — Auftrags- und Nachtragsentwurf. Je eine eigene Tabelle
   * ohne Slot: Mehrere offene Entwürfe sind erlaubt und bleiben erreichbar.
   * Push-Zweig mit Versionsvertrag, Pull mit Grabsteinen ohne Inhalt, Abgleich
   * mit sichtbarem Konflikt und Altbestand. Auftragsanlage
   * (`create_workspace_order`) und Nachtragsbestätigung
   * (`confirm_workspace_order_amendment`) verbrauchen den Entwurf atomar; erst
   * mit dieser Freigabe tragen beide die Entwurfsbindung. Die Migration
   * 20261103120000 ist remote angewendet und gegen die Datei geprüft.
   */
  'order_draft',
  'order_amendment_draft',
]);

export const LOCAL_ONLY_SYNC_ENTITY_TYPES: ReadonlySet<SyncEntityType> = new Set([
  'document_memory',
  'proof_memory',
  'memory_relation',
  'mail_import',

]);

export function isSupabaseSyncAllowed(entityType: SyncEntityType): boolean {
  return SUPABASE_SYNC_ALLOWLIST.has(entityType);
}

export function assertSupabaseSyncAllowed(entityType: SyncEntityType): void {
  if (!isSupabaseSyncAllowed(entityType)) {
    throw new Error(`Entity-Typ "${entityType}" ist nicht für Supabase-Sync freigegeben.`);
  }
}
