/**
 * FINANZ-CORE-DURABILITY-01B — Backfill bestehender lokaler Belege.
 *
 * Idempotenter Plan: alles, was lokal echt ist (kein Demo-Eintrag), committed
 * ist und die Cloud noch nie gesehen hat (`sync` fehlt), wird in die bestehende
 * Outbox gestellt. Der Push selbst ist idempotent (Hash-Pfad, Create-Guard),
 * ein zweiter Lauf erzeugt weder zweite Blobs noch zweite Zeilen. Lokale Daten
 * werden nicht veraendert; Fehler bleiben in der Outbox sichtbar und retrybar.
 * Kein Auto-Merge zweier fachlicher Dokumente nur wegen gleichem Hash.
 */
import type { AppPersistedState } from '../../types/models';
import type { SyncEntityType } from '../../types/sync';
import { enqueueSyncOutbox } from '../sync/syncOutboxService';
import { isEntitySyncActive } from '../sync/syncMetaService';
import { buildBindingEntityId, isCloudSyncBlockedMockInboxId, isCloudSyncedBindingKind, type CloudBindingKind } from './intakeCloudSyncService';
import { buildExpensePaymentEntityId, isCloudSyncBlockedMockExpenseId } from '../expense/expenseCloudSyncService';

export interface IntakeBackfillPlanEntry {
  entityType: SyncEntityType;
  entityId: string;
}

export interface IntakeBackfillPlan {
  entries: IntakeBackfillPlanEntry[];
  counts: Record<'files' | 'documents' | 'bindings' | 'inboxItems' | 'workResults' | 'expenses' | 'expensePayments', number>;
}

export function planIntakeBackfill(state: AppPersistedState): IntakeBackfillPlan {
  const entries: IntakeBackfillPlanEntry[] = [];
  const counts = { files: 0, documents: 0, bindings: 0, inboxItems: 0, workResults: 0, expenses: 0, expensePayments: 0 };
  const realInboxIds = new Set<string>();

  for (const item of state.inboxItems) {
    if (isCloudSyncBlockedMockInboxId(item.id) || !isEntitySyncActive(item)) continue;
    realInboxIds.add(item.id);
    if (item.sync) continue;
    entries.push({ entityType: 'inbox_item', entityId: item.id });
    counts.inboxItems += 1;
  }

  const heldFileRefIds = new Set<string>();
  for (const document of state.documents ?? []) {
    if (!isEntitySyncActive(document)) continue;
    if (document.linkedInvoiceId && document.category === 'ausgangsrechnung') continue; // generated invoice: eigener Pfad
    if (isCloudSyncBlockedMockInboxId(document.sourceInboxItemId)) continue;
    if (document.fileRefId) heldFileRefIds.add(document.fileRefId);
    if (document.sync) continue;
    entries.push({ entityType: 'document', entityId: document.id });
    counts.documents += 1;
  }
  for (const item of state.inboxItems) {
    if (realInboxIds.has(item.id) && item.fileRefId) heldFileRefIds.add(item.fileRefId);
  }

  for (const binding of state.documentFileRepresentationBindings ?? []) {
    if (!isCloudSyncedBindingKind(binding.kind)) continue;
    heldFileRefIds.add(binding.fileRefId);
    if (binding.sync) continue;
    entries.push({ entityType: 'document_file_binding', entityId: buildBindingEntityId(binding.documentId, binding.kind as CloudBindingKind, (binding as { part?: string | null }).part) });
    counts.bindings += 1;
  }

  for (const ref of state.documentFileRefs ?? []) {
    if (ref.lifecycleStatus !== 'committed' || ref.storageType === 'cloud') continue;
    if (!heldFileRefIds.has(ref.id)) continue; // unreferenzierte Dateien sind kein Backfill-Kandidat
    if (ref.sync) continue;
    entries.push({ entityType: 'document_file', entityId: ref.id });
    counts.files += 1;
  }

  for (const result of state.documentWorkResults ?? []) {
    if (!realInboxIds.has(result.inboxItemId) || result.sync) continue;
    entries.push({ entityType: 'document_work_result', entityId: result.inboxItemId });
    counts.workResults += 1;
  }

  /*
   * FINANZ-CORE-DURABILITY-01C — Ausgaben ohne Cloud-Version und alle ihre
   * Zahlungen (Add ist idempotent; abweichende Daten werden als Konflikt sichtbar).
   */
  for (const expense of state.expenses ?? []) {
    if (isCloudSyncBlockedMockExpenseId(expense.id) || !isEntitySyncActive(expense)) continue;
    if (!expense.sync) {
      entries.push({ entityType: 'expense', entityId: expense.id });
      counts.expenses += 1;
    }
    for (const payment of expense.payments ?? []) {
      entries.push({ entityType: 'expense_payment', entityId: buildExpensePaymentEntityId(expense.id, payment.id) });
      counts.expensePayments += 1;
    }
  }

  return { entries, counts };
}

/** Stellt den Plan in die bestehende Outbox — Dateien zuerst (Push sortiert ohnehin). */
export function enqueueIntakeBackfill(plan: IntakeBackfillPlan): number {
  for (const entry of plan.entries) {
    enqueueSyncOutbox({ entityType: entry.entityType, entityId: entry.entityId, operation: 'create', version: 1 });
  }
  return plan.entries.length;
}
