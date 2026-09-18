import type { AppPersistedState, CompanyDocument, Customer, InboxItem, Task, Vorgang } from '../../types/models';
import type { DocumentFileRef } from '../../types/documentFileRef';
import type { DocumentFileRepresentationBinding } from '../../types/documentFileRepresentationBinding';
import type { DocumentWorkResult } from '../../types/documentWorkResult';
import type { Expense } from '../../types/expense';
import { parseExpensePaymentEntityId, type ExpensePaymentSyncEntity } from '../expense/expenseCloudSyncService';
import type { SyncEntityType } from '../../types/sync';
import type { VorgangNote } from '../../types/communication';
import type { InvoiceDunningDocumentation } from '../../types/dunningDocumentation';
import type { Workspace, WorkspaceMember, WorkspaceSettings } from '../../types/workspace';
import {
  getCompanyProfileSyncSnapshot,
  getSetupSyncSnapshot,
  getWorkspaceMembersSnapshot,
  getWorkspaceSettingsSnapshot,
  getWorkspaceStoreSnapshot,
} from './workspaceStore';

export type CloudSyncEntityPayload =
  | { entityType: 'workspace'; entityId: string; entity: Workspace; rowVersion: number }
  | { entityType: 'workspace_member'; entityId: string; entity: WorkspaceMember; rowVersion: number }
  | { entityType: 'workspace_settings'; entityId: string; entity: WorkspaceSettings; rowVersion: number }
  | { entityType: 'company_setup'; entityId: string; entity: AppPersistedState['setup']; rowVersion: number }
  | {
      entityType: 'company_profile';
      entityId: string;
      entity: NonNullable<AppPersistedState['companyProfile']>;
      rowVersion: number;
    }
  | { entityType: 'vorgang'; entityId: string; entity: Vorgang; rowVersion: number; deleted: boolean }
  | { entityType: 'customer'; entityId: string; entity: Customer; rowVersion: number; deleted: boolean }
  | { entityType: 'inbox_item'; entityId: string; entity: InboxItem; rowVersion: number; deleted: boolean }
  | { entityType: 'document'; entityId: string; entity: CompanyDocument; rowVersion: number; deleted: boolean }
  | { entityType: 'document_file'; entityId: string; entity: DocumentFileRef; rowVersion: number; deleted: boolean }
  | { entityType: 'document_file_binding'; entityId: string; entity: DocumentFileRepresentationBinding; rowVersion: number; deleted: boolean }
  | { entityType: 'document_work_result'; entityId: string; entity: DocumentWorkResult; rowVersion: number; deleted: boolean }
  | { entityType: 'expense'; entityId: string; entity: Expense; rowVersion: number; deleted: boolean }
  | { entityType: 'expense_payment'; entityId: string; entity: ExpensePaymentSyncEntity; rowVersion: number; deleted: boolean }
  | { entityType: 'vorgang_note'; entityId: string; entity: VorgangNote; rowVersion: number; deleted: boolean }
  | { entityType: 'task'; entityId: string; entity: Task; rowVersion: number; deleted: boolean }
  | {
      entityType: 'dunning_documentation';
      entityId: string;
      entity: InvoiceDunningDocumentation;
      rowVersion: number;
      deleted: boolean;
    };

export function resolveCloudWorkspaceId(state: AppPersistedState): string {
  return (
    state.syncClient?.serverWorkspaceId ??
    state.workspace?.id ??
    state.syncClient?.workspaceId ??
    ''
  );
}

export function extractCloudSyncEntity(
  state: AppPersistedState,
  entityType: SyncEntityType,
  entityId: string,
): CloudSyncEntityPayload | null {
  const workspaceId = resolveCloudWorkspaceId(state);

  switch (entityType) {
    case 'workspace': {
      const workspace = state.workspace ?? getWorkspaceStoreSnapshot();
      if (!workspace || workspace.id !== entityId) return null;
      return {
        entityType,
        entityId,
        entity: workspace,
        rowVersion: workspace.sync?.version ?? workspace.version ?? 0,
      };
    }
    case 'workspace_member': {
      const members = state.workspaceMembers ?? getWorkspaceMembersSnapshot();
      const member = members.find((item) => `${item.workspaceId}:${item.userId}` === entityId);
      if (!member) return null;
      return {
        entityType,
        entityId,
        entity: member,
        rowVersion: member.sync?.version ?? 1,
      };
    }
    case 'workspace_settings': {
      const settings = state.workspaceSettings ?? getWorkspaceSettingsSnapshot();
      if (!settings || settings.workspaceId !== entityId) return null;
      return {
        entityType,
        entityId,
        entity: settings,
        rowVersion: settings.sync?.version ?? settings.version ?? 0,
      };
    }
    case 'company_setup':
      if (entityId !== workspaceId) return null;
      return {
        entityType,
        entityId,
        entity: state.setup,
        rowVersion: state.setupSync?.version ?? getSetupSyncSnapshot()?.version ?? 0,
      };
    case 'company_profile': {
      if (entityId !== workspaceId || !state.companyProfile) return null;
      return {
        entityType,
        entityId,
        entity: state.companyProfile,
        rowVersion: state.companyProfileSync?.version ?? getCompanyProfileSyncSnapshot()?.version ?? 0,
      };
    }
    case 'vorgang': {
      const vorgang = state.vorgaenge.find((v) => v.id === entityId);
      if (!vorgang) return null;
      return {
        entityType,
        entityId,
        entity: vorgang,
        rowVersion: vorgang.sync?.version ?? 0,
        deleted: vorgang.sync?.deleted ?? false,
      };
    }
    case 'customer': {
      const customer = (state.customers ?? []).find((c) => c.id === entityId);
      if (!customer) return null;
      return {
        entityType,
        entityId,
        entity: customer,
        rowVersion: customer.sync?.version ?? 0,
        deleted: customer.sync?.deleted ?? false,
      };
    }
    // FINANZ-CORE-DURABILITY-01B — Intake-Entitaeten
    case 'inbox_item': {
      const item = state.inboxItems.find((i) => i.id === entityId);
      if (!item) return null;
      return { entityType, entityId, entity: item, rowVersion: item.sync?.version ?? 0, deleted: item.sync?.deleted ?? false };
    }
    case 'document': {
      const document = (state.documents ?? []).find((d) => d.id === entityId);
      if (!document) return null;
      return { entityType, entityId, entity: document, rowVersion: document.sync?.version ?? 0, deleted: document.sync?.deleted ?? false };
    }
    case 'document_file': {
      const ref = (state.documentFileRefs ?? []).find((r) => r.id === entityId);
      if (!ref) return null;
      return { entityType, entityId, entity: ref, rowVersion: ref.sync?.version ?? 0, deleted: ref.sync?.deleted ?? false };
    }
    case 'document_file_binding': {
      const binding = (state.documentFileRepresentationBindings ?? []).find(
        (b) => `${b.documentId}|${b.kind}|${(b as { part?: string | null }).part ?? ''}` === entityId,
      );
      if (!binding) return null;
      return { entityType, entityId, entity: binding, rowVersion: binding.sync?.version ?? 0, deleted: binding.sync?.deleted ?? false };
    }
    case 'document_work_result': {
      const result = (state.documentWorkResults ?? []).find((r) => r.inboxItemId === entityId);
      if (!result) return null;
      return { entityType, entityId, entity: result, rowVersion: result.sync?.version ?? 0, deleted: result.sync?.deleted ?? false };
    }
    // CLOUD-DURABILITY-CORE-01D — Mahnnachweise (append-only, nie gelöscht)
    case 'dunning_documentation': {
      const documentation = (state.dunningDocumentations ?? []).find((item) => item.id === entityId);
      if (!documentation) return null;
      return {
        entityType,
        entityId,
        entity: documentation,
        rowVersion: documentation.sync?.version ?? 0,
        deleted: false,
      };
    }
    // CLOUD-DURABILITY-CORE-01C — Aufgaben
    case 'task': {
      const task = (state.tasks ?? []).find((item) => item.id === entityId);
      if (!task) return null;
      return { entityType, entityId, entity: task, rowVersion: task.sync?.version ?? 0, deleted: task.sync?.deleted ?? false };
    }
    // CLOUD-DURABILITY-CORE-01B — Vorgangsnotizen
    case 'vorgang_note': {
      const note = (state.vorgangNotes ?? []).find((n) => n.id === entityId);
      if (!note) return null;
      return { entityType, entityId, entity: note, rowVersion: note.sync?.version ?? 0, deleted: note.sync?.deleted ?? false };
    }
    // FINANZ-CORE-DURABILITY-01C — Ausgaben
    case 'expense': {
      const expense = (state.expenses ?? []).find((e) => e.id === entityId);
      if (!expense) return null;
      return { entityType, entityId, entity: expense, rowVersion: expense.sync?.version ?? 0, deleted: expense.sync?.deleted ?? false };
    }
    case 'expense_payment': {
      const parsed = parseExpensePaymentEntityId(entityId);
      if (!parsed) return null;
      const expense = (state.expenses ?? []).find((e) => e.id === parsed.expenseId);
      if (!expense) return null;
      const payment = (expense.payments ?? []).find((p) => p.id === parsed.paymentId) ?? null;
      return { entityType, entityId, entity: { id: entityId, expenseId: parsed.expenseId, paymentId: parsed.paymentId, payment }, rowVersion: 0, deleted: payment === null };
    }
    default:
      return null;
  }
}

export function buildCloudEntityId(
  entityType: SyncEntityType,
  workspaceId: string,
  userId?: string,
): string {
  if (entityType === 'workspace_member' && userId) {
    return `${workspaceId}:${userId}`;
  }
  return workspaceId;
}
