import type { AppPersistedState, CompanyDocument, Customer, InboxItem, Task, Vorgang } from '../../types/models';
import type { DocumentFileRef } from '../../types/documentFileRef';
import type { DocumentFileRepresentationBinding } from '../../types/documentFileRepresentationBinding';
import type { DocumentWorkResult } from '../../types/documentWorkResult';
import type { Expense } from '../../types/expense';
import type { Employee, EmployeePayment } from '../../types/employee';
import type { AccountingAssignment } from '../../types/accounting';
import type { AccountingPeriodClosure } from '../../types/accountingPeriod';
import type { BankAccount } from '../../types/bankAccount';
import type { BankTransaction } from '../../types/bankTransaction';
import { parseExpensePaymentEntityId, type ExpensePaymentSyncEntity } from '../expense/expenseCloudSyncService';
import type { SyncEntityType } from '../../types/sync';
import type { VorgangNote } from '../../types/communication';
import type { BusinessLetter } from '../../types/businessLetter';
import type { Offer } from '../../types/offer';
import type { InvoiceDunningDocumentation } from '../../types/dunningDocumentation';
import type { PaperRegisterEntry } from '../../types/memory';
import type { CommunicationEvent } from '../../types/communicationHistory';
import type { KnowledgeFact } from '../../types/knowledge';
import type { InvoiceDraftCloudEntity } from '../../types/invoiceDraftCloud';
import type { OrderDraft } from '../../types/orderDraft';
import type { OrderAmendment } from '../../types/models';
import { findOrderAmendmentDraftEntity } from '../orderAmendment/orderAmendmentDraftCloudService';
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
  | { entityType: 'employee'; entityId: string; entity: Employee; rowVersion: number; deleted: boolean }
  | { entityType: 'employee_payment'; entityId: string; entity: EmployeePayment; rowVersion: number; deleted: boolean }
  | { entityType: 'vorgang_note'; entityId: string; entity: VorgangNote; rowVersion: number; deleted: boolean }
  | { entityType: 'business_letter'; entityId: string; entity: BusinessLetter; rowVersion: number; deleted: boolean }
  | { entityType: 'offer'; entityId: string; entity: Offer; rowVersion: number; deleted: boolean }
  | { entityType: 'task'; entityId: string; entity: Task; rowVersion: number; deleted: boolean }
  | {
      entityType: 'dunning_documentation';
      entityId: string;
      entity: InvoiceDunningDocumentation;
      rowVersion: number;
      deleted: boolean;
    }
  /* STEUERBERATER-06A/06B — Kontierung und Monatsabschluss. */
  | {
      entityType: 'accounting_assignment';
      entityId: string;
      entity: AccountingAssignment;
      rowVersion: number;
      deleted: boolean;
    }
  /* BANKABGLEICH-V1 BLOCK 2B — append-only, deshalb `deleted` immer false. */
  | {
      entityType: 'bank_account';
      entityId: string;
      entity: BankAccount;
      rowVersion: number;
      deleted: boolean;
    }
  | {
      entityType: 'bank_transaction';
      entityId: string;
      entity: BankTransaction;
      rowVersion: number;
      deleted: boolean;
    }
  | {
      entityType: 'accounting_period_closure';
      entityId: string;
      entity: AccountingPeriodClosure;
      rowVersion: number;
      deleted: boolean;
    }
  /* CLOUD-SYNC S1 — der Papierablage-Haken. */
  | {
      entityType: 'paper_register_entry';
      entityId: string;
      entity: PaperRegisterEntry;
      rowVersion: number;
      deleted: boolean;
    }
  /* CLOUD-SYNC S2 — ein Ereignis im Kommunikationsverlauf, append-only. */
  | {
      entityType: 'communication_event';
      entityId: string;
      entity: CommunicationEvent;
      rowVersion: number;
      deleted: boolean;
    }
  /* CLOUD-SYNC S3 — bestätigtes Wissen, veränderbar mit Grabstein. */
  | {
      entityType: 'knowledge_fact';
      entityId: string;
      entity: KnowledgeFact;
      rowVersion: number;
      deleted: boolean;
    }
  /* CLOUD-SYNC S5 — der fachliche Kern eines Rechnungsentwurfs, mit Grabstein. */
  | {
      entityType: 'invoice_draft';
      entityId: string;
      entity: InvoiceDraftCloudEntity;
      rowVersion: number;
      deleted: boolean;
    }
  /* CLOUD-SYNC S6 — Auftrags- und Nachtragsentwurf, jeweils mit Grabstein. */
  | {
      entityType: 'order_draft';
      entityId: string;
      entity: OrderDraft;
      rowVersion: number;
      deleted: boolean;
    }
  | {
      entityType: 'order_amendment_draft';
      entityId: string;
      entity: OrderAmendment;
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
        // SYNC-AUTOMATIK-01A: ältere Bestände tragen eine zurückgebliebene sync.version — die bestätigte höhere gilt.
        rowVersion: Math.max(workspace.sync?.version ?? 0, workspace.version ?? 0),
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
    // BRIEFE-01B — Geschaeftsschreiben
    case 'business_letter': {
      const letter = (state.businessLetters ?? []).find((l) => l.id === entityId);
      if (!letter) return null;
      return { entityType, entityId, entity: letter, rowVersion: letter.sync?.version ?? 0, deleted: letter.sync?.deleted ?? false };
    }
    // ANGEBOT-01B — eigene Angebote
    case 'offer': {
      const offer = (state.offers ?? []).find((o) => o.id === entityId);
      if (!offer) return null;
      return { entityType, entityId, entity: offer, rowVersion: offer.sync?.version ?? 0, deleted: offer.sync?.deleted ?? false };
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
    // P1 MITARBEITERZAHLUNGEN — Stammsatz (Basisversion) und Zahlung (append-only).
    case 'employee': {
      const employee = (state.employees ?? []).find((e) => e.id === entityId);
      if (!employee) return null;
      return { entityType, entityId, entity: employee, rowVersion: employee.sync?.version ?? 0, deleted: false };
    }
    case 'employee_payment': {
      const payment = (state.employeePayments ?? []).find((p) => p.id === entityId);
      if (!payment) return null;
      return { entityType, entityId, entity: payment, rowVersion: 0, deleted: false };
    }
    /*
     * FINANZ-SYNC-BLOCKER-01B — die beiden Kontierungsentitäten.
     *
     * Sie fehlten hier, obwohl Allowlist, Registry und Change-Tracker sie
     * längst kannten. Der Adapter bekam deshalb null und brach jeden Auftrag
     * mit „Entity nicht gefunden" ab — vor dem ersten Netzwerkaufruf, mit
     * hochgezähltem Versuchszähler und ohne dass je eine Anfrage entstand.
     */
    case 'bank_account': {
      const account = (state.bankAccounts ?? []).find((item) => item.id === entityId);
      if (!account) return null;
      /* Kein Grabstein: Block 2B kennt kein Loeschen von Bankdaten. */
      return { entityType, entityId, entity: account, rowVersion: account.sync?.version ?? 0, deleted: false };
    }
    case 'bank_transaction': {
      const transaction = (state.bankTransactions ?? []).find((item) => item.id === entityId);
      if (!transaction) return null;
      return {
        entityType,
        entityId,
        entity: transaction,
        rowVersion: transaction.sync?.version ?? 0,
        deleted: false,
      };
    }
    case 'accounting_assignment': {
      const assignment = (state.accountingAssignments ?? []).find((item) => item.id === entityId);
      if (!assignment) return null;
      return {
        entityType,
        entityId,
        entity: assignment,
        rowVersion: assignment.sync?.version ?? 0,
        deleted: assignment.sync?.deleted ?? false,
      };
    }
    case 'accounting_period_closure': {
      const closure = (state.accountingPeriodClosures ?? []).find((item) => item.id === entityId);
      if (!closure) return null;
      /*
       * Ein Abschluss kennt keinen Grabstein — er ist der Nachweis. Wieder
       * öffnen ist eine eigene Serveraktion, kein Löschen.
       */
      return { entityType, entityId, entity: closure, rowVersion: closure.sync?.version ?? 0, deleted: false };
    }
    // CLOUD-SYNC S1 — der Papierablage-Haken, inklusive Grabstein.
    case 'paper_register_entry': {
      const entry = (state.officePilotMemory?.paperRegisterEntries ?? []).find((item) => item.id === entityId);
      if (!entry) return null;
      return {
        entityType,
        entityId,
        entity: entry,
        rowVersion: entry.sync?.version ?? 0,
        deleted: entry.sync?.deleted ?? false,
      };
    }
    // CLOUD-SYNC S2 — Ereignisse werden nie gelöscht: kein Grabstein.
    case 'communication_event': {
      const event = (state.communicationHistory ?? []).find((item) => item.id === entityId);
      if (!event) return null;
      return { entityType, entityId, entity: event, rowVersion: event.sync?.version ?? 0, deleted: false };
    }
    // CLOUD-SYNC S3 — bestätigtes Wissen, inklusive Grabstein.
    case 'knowledge_fact': {
      const fact = (state.knowledgeFacts ?? []).find((item) => item.id === entityId);
      if (!fact) return null;
      return {
        entityType,
        entityId,
        entity: fact,
        rowVersion: fact.sync?.version ?? 0,
        deleted: fact.sync?.deleted ?? false,
      };
    }
    // CLOUD-SYNC S5 — der Spiegel des Rechnungsentwurfs, inklusive Grabstein.
    case 'invoice_draft': {
      const draft = (state.invoiceDrafts ?? []).find((item) => item.id === entityId);
      if (!draft) return null;
      return {
        entityType,
        entityId,
        entity: draft,
        rowVersion: draft.sync?.version ?? 0,
        deleted: draft.sync?.deleted ?? false,
      };
    }
    /*
     * CLOUD-SYNC S6 — der Auftragsentwurf, inklusive Grabstein. Ein Entwurf
     * eines anderen Workspace wird nie in diesen gesendet (Scope-Prüfung vor
     * jedem Push).
     */
    case 'order_draft': {
      const draft = (state.orderDrafts ?? []).find((item) => item.id === entityId);
      if (!draft) return null;
      if (draft.workspaceId && workspaceId && draft.workspaceId !== workspaceId) return null;
      return {
        entityType,
        entityId,
        entity: draft,
        rowVersion: draft.sync?.version ?? 0,
        deleted: draft.sync?.deleted ?? false,
      };
    }
    // CLOUD-SYNC S6 — der Nachtragsentwurf: lebend im Vorgang oder als Grabstein.
    case 'order_amendment_draft': {
      const draft = findOrderAmendmentDraftEntity(state, entityId);
      if (!draft) return null;
      return {
        entityType,
        entityId,
        entity: draft,
        rowVersion: draft.sync?.version ?? 0,
        deleted: draft.sync?.deleted ?? false,
      };
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
