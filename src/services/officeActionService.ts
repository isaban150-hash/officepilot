import type { TranslationKey } from '../i18n';
import type {
  ClassifiedDocumentKind,
  ContractAnalysisResult,
  ContractSuggestedAction,
  DocumentActionId,
  InboxItem,
} from '../types/models';
import type { ExpenseInput } from '../types/expense';
import { getClassificationForItem } from './documentClassificationService';
import { mapClassifiedKindToExpenseCategory } from './expenseCategoryMapping';
import { addExpense, getAllExpenses } from './expenseService';
import { getInboxItemById, patchInboxItem } from './inboxService';
import { createTaskForItem } from './inboxTaskService';
import { isClassificationKindWithTasks } from './taskEngineService';
import { getTodayIso } from './taskNormalize';
import { scanPendingItems } from './pendingEngineService';
import { getAllVorgaenge } from './vorgangService';
import { processUploadedDocument } from './intakeWorkflowService';

function inboxKommunikationPath(inboxId: string): string {
  return `/kommunikation?context=inbox&id=${encodeURIComponent(inboxId)}`;
}

export type OfficeActionDelegate =
  | 'confirmFiling'
  | 'importArchive'
  | 'createTask'
  | 'openVorgangDialog'
  | 'dispose'
  | 'saveAnyway'
  | 'expandDetails'
  | 'goBack';

export type OfficeActionResult =
  | {
      ok: true;
      kind: 'navigate';
      route: string;
      messageKey?: TranslationKey;
    }
  | {
      ok: true;
      kind: 'delegate';
      delegate: OfficeActionDelegate;
    }
  | {
      ok: true;
      kind: 'done';
      messageKey: TranslationKey;
      updatedItem?: InboxItem;
    }
  | {
      ok: false;
      errorKey: TranslationKey;
    };

const EXPENSE_DOCUMENT_TYPES = new Set([
  'eingangsrechnung',
  'ausgangsrechnung',
]);

function parseGermanAmount(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const cleaned = value.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
}

function resolveClassifiedKind(item: InboxItem): ClassifiedDocumentKind | undefined {
  const workflow = processUploadedDocument(item.id);
  return workflow?.classifiedKind ?? item.classifiedKind;
}

export function buildExpenseInputFromInbox(
  item: InboxItem,
  classifiedKind?: ClassifiedDocumentKind,
): ExpenseInput {
  const kind = classifiedKind ?? resolveClassifiedKind(item);
  const grossAmount =
    parseGermanAmount(item.recognizedData.Betrag) ??
    parseGermanAmount(item.recognizedData.betrag) ??
    parseGermanAmount(item.recognizedData.Amount) ??
    0;

  return {
    title: item.title,
    supplierName: item.sender.trim() || 'Unbekannt',
    invoiceNumber:
      item.recognizedData.Rechnungsnummer ??
      item.recognizedData.rechnungsnummer ??
      '',
    description: item.officePilotSuggestion ?? '',
    issueDate:
      item.recognizedData.Datum?.slice(0, 10) ??
      item.recognizedData.datum?.slice(0, 10) ??
      item.deadline?.slice(0, 10) ??
      getTodayIso().slice(0, 10),
    paymentDueDate: item.deadline,
    grossAmount,
    category: kind ? mapClassifiedKindToExpenseCategory(kind) : 'material',
    linkedInboxId: item.id,
    classifiedKind: kind,
    recognizedData: { ...item.recognizedData },
    digitalFolder: { ...item.digitalFolder },
    paperFolder: item.paperFiling ? { ...item.paperFiling } : undefined,
  };
}

export function createExpenseFromInbox(item: InboxItem): OfficeActionResult {
  const input = buildExpenseInputFromInbox(item);

  if (!input.grossAmount) {
    return {
      ok: true,
      kind: 'navigate',
      route: `/ausgaben/neu?inboxId=${encodeURIComponent(item.id)}`,
    };
  }

  const result = addExpense(input);
  if (!result.success) {
    if (result.errorKey === 'expense.duplicate') {
      const existing = getAllExpenses().find((expense) => expense.linkedInboxId === item.id);
      if (existing) {
        return { ok: true, kind: 'navigate', route: `/ausgaben/${existing.id}` };
      }
    }
    return { ok: false, errorKey: result.errorKey as TranslationKey };
  }

  return {
    ok: true,
    kind: 'navigate',
    route: `/ausgaben/${result.expense.id}`,
    messageKey: 'action.expense.created',
  };
}

export function markInboxAsImportant(inboxId: string): OfficeActionResult {
  const updated = patchInboxItem(inboxId, { priority: 'hoch' });
  if (!updated) return { ok: false, errorKey: 'inbox.notFound' as TranslationKey };
  return {
    ok: true,
    kind: 'done',
    messageKey: 'action.inbox.markedImportant',
    updatedItem: updated,
  };
}

export function isDocumentActionAvailable(
  actionId: DocumentActionId,
  item: InboxItem,
  classifiedKind?: ClassifiedDocumentKind,
): boolean {
  const kind = classifiedKind ?? resolveClassifiedKind(item);

  switch (actionId) {
    case 'confirm_filing':
      return !item.isAdvertisement;
    case 'check_deadline':
    case 'monitor_validity':
      return Boolean(item.taskTemplate) || (kind ? isClassificationKindWithTasks(kind) : false);
    case 'record_expense':
    case 'check_payment':
      return (
        EXPENSE_DOCUMENT_TYPES.has(item.documentType) ||
        (kind ? mapClassifiedKindToExpenseCategory(kind) !== 'sonstiges' : false) ||
        item.documentType === 'eingangsrechnung' ||
        kind === 'mahnung' ||
        kind === 'zahlungserinnerung'
      );
    case 'send_to_customer':
      return Boolean(item.vorgangId) || Boolean(item.recognizedData.Auftraggeber);
    case 'suggest_schlussrechnung':
      return Boolean(item.vorgangId);
    case 'import_hours':
      return Boolean(item.vorgangId) || kind === 'stundenzettel';
    case 'check_proof_requirements':
      return kind === 'werkvertrag' || kind === 'subunternehmervertrag' || kind === 'nachunternehmervertrag';
    case 'mark_important':
      return kind === 'mahnung' || kind === 'zahlungserinnerung' || item.priority !== 'hoch';
    case 'show_contact':
      return false;
    default:
      return true;
  }
}

export function executeDocumentAction(
  actionId: DocumentActionId,
  item: InboxItem,
  options?: { classifiedKind?: ClassifiedDocumentKind },
): OfficeActionResult {
  const classifiedKind = options?.classifiedKind ?? resolveClassifiedKind(item);

  switch (actionId) {
    case 'save_bg_bau_folder':
    case 'save_tax_folder':
    case 'save_health_folder':
    case 'confirm_filing':
      return { ok: true, kind: 'delegate', delegate: 'confirmFiling' };
    case 'check_deadline':
    case 'monitor_validity':
      if (item.taskTemplate || (classifiedKind && isClassificationKindWithTasks(classifiedKind))) {
        return { ok: true, kind: 'delegate', delegate: 'createTask' };
      }
      return { ok: false, errorKey: 'taskEngine.noTaskAvailable' };
    case 'link_vorgang':
    case 'create_vorgang':
    case 'import_positions':
      return { ok: true, kind: 'delegate', delegate: 'openVorgangDialog' };
    case 'import_hours':
      if (item.vorgangId) {
        return {
          ok: true,
          kind: 'navigate',
          route: `/vorgaenge/${item.vorgangId}/rechnung?type=abschlag`,
        };
      }
      return { ok: true, kind: 'delegate', delegate: 'openVorgangDialog' };
    case 'check_proof_requirements':
      if (item.vorgangId) {
        return { ok: true, kind: 'navigate', route: `/vorgaenge/${item.vorgangId}` };
      }
      return { ok: true, kind: 'delegate', delegate: 'openVorgangDialog' };
    case 'suggest_schlussrechnung':
      if (item.vorgangId) {
        return {
          ok: true,
          kind: 'navigate',
          route: `/vorgaenge/${item.vorgangId}/rechnung?type=schluss`,
        };
      }
      return { ok: false, errorKey: 'intake.positionsNeedsVorgang' };
    case 'check_payment':
    case 'record_expense':
      return createExpenseFromInbox(item);
    case 'archive':
      return { ok: true, kind: 'delegate', delegate: 'importArchive' };
    case 'send_to_customer':
      return {
        ok: true,
        kind: 'navigate',
        route: inboxKommunikationPath(item.id),
      };
    case 'mark_important':
      return markInboxAsImportant(item.id);
    case 'create_task':
      return { ok: true, kind: 'delegate', delegate: 'createTask' };
    default:
      return { ok: false, errorKey: 'action.unsupported' as TranslationKey };
  }
}

export function isContractActionAvailable(
  actionId: ContractSuggestedAction['id'],
  _item: InboxItem,
): boolean {
  switch (actionId) {
    case 'send_freistellung':
    case 'send_aok':
      return true;
    case 'check_bg_bau':
      return true;
    default:
      return true;
  }
}

export function executeContractAction(
  actionId: ContractSuggestedAction['id'],
  item: InboxItem,
  analysis?: ContractAnalysisResult,
): OfficeActionResult {
  switch (actionId) {
    case 'create_vorgang':
    case 'import_positions':
      return { ok: true, kind: 'delegate', delegate: 'openVorgangDialog' };
    case 'archive_contract':
      return { ok: true, kind: 'delegate', delegate: 'importArchive' };
    case 'send_freistellung':
      return {
        ok: true,
        kind: 'navigate',
        route: inboxKommunikationPath(item.id),
        messageKey: 'action.communication.openForProof',
      };
    case 'send_aok':
      return {
        ok: true,
        kind: 'navigate',
        route: inboxKommunikationPath(item.id),
        messageKey: 'action.communication.openForProof',
      };
    case 'check_bg_bau':
      if (item.archiveDocumentId) {
        return {
          ok: true,
          kind: 'navigate',
          route: `/dokumente/${item.archiveDocumentId}`,
        };
      }
      if (analysis?.requiredDocuments.some((doc) => doc.type === 'bg_bau')) {
        return { ok: true, kind: 'delegate', delegate: 'importArchive' };
      }
      return { ok: true, kind: 'navigate', route: '/dokumente' };
    default:
      return { ok: false, errorKey: 'action.unsupported' as TranslationKey };
  }
}

export function isScanResultActionAvailable(actionId: string, item: InboxItem): boolean {
  switch (actionId) {
    case 'payment':
      return (
        item.documentType === 'eingangsrechnung' ||
        item.recommendedAction === 'zahlung_pruefen' ||
        resolveClassifiedKind(item) === 'mahnung'
      );
    case 'openOrder':
      return Boolean(item.vorgangId);
    case 'invoice':
      return item.recommendedAction === 'rechnung_vorbereiten' || item.documentType === 'kundenauftrag';
    default:
      return true;
  }
}

export function executeScanResultAction(actionId: string, item: InboxItem): OfficeActionResult {
  switch (actionId) {
    case 'filing':
      return { ok: true, kind: 'delegate', delegate: 'confirmFiling' };
    case 'dispose':
      return { ok: true, kind: 'delegate', delegate: 'dispose' };
    case 'save':
      return { ok: true, kind: 'delegate', delegate: 'saveAnyway' };
    case 'assign':
      return { ok: true, kind: 'delegate', delegate: 'openVorgangDialog' };
    case 'invoice':
      if (item.vorgangId) {
        return {
          ok: true,
          kind: 'navigate',
          route: `/vorgaenge/${item.vorgangId}/rechnung`,
        };
      }
      return { ok: true, kind: 'delegate', delegate: 'openVorgangDialog' };
    case 'openOrder':
      if (item.vorgangId) {
        return { ok: true, kind: 'navigate', route: `/vorgaenge/${item.vorgangId}` };
      }
      return { ok: false, errorKey: 'vorgang.notFound' };
    case 'payment':
      return createExpenseFromInbox(item);
    case 'review':
      return { ok: true, kind: 'delegate', delegate: 'expandDetails' };
    default:
      return { ok: false, errorKey: 'action.unsupported' as TranslationKey };
  }
}

export function resolveHeuteQuickActionRoute(key: TranslationKey): string | null {
  switch (key) {
    case 'heute.action.understandLetter':
      return '/scan';
    case 'heute.action.captureExpense':
      return '/ausgaben/neu';
    case 'heute.action.writeMessage':
      return '/kommunikation';
    case 'heute.action.askOfficePilot':
      return '/assistent';
    case 'heute.action.writeInvoice': {
      const pending = scanPendingItems().items;
      const invoicePending = pending.find((entry) => entry.kind.startsWith('invoice'));
      if (invoicePending) return invoicePending.route;

      const activeVorgang = getAllVorgaenge().find((entry) => entry.status === 'in_bearbeitung');
      if (activeVorgang) {
        return `/vorgaenge/${activeVorgang.id}/rechnung?type=abschlag`;
      }
      return '/rechnungen/offen';
    }
    case 'heute.action.openOrder': {
      const pending = scanPendingItems().items;
      const orderPending = pending.find(
        (entry) => entry.route.startsWith('/vorgaenge/') && !entry.route.includes('/rechnungen/'),
      );
      if (orderPending) return orderPending.route;

      const activeVorgang = getAllVorgaenge().find((entry) => entry.status === 'in_bearbeitung');
      if (activeVorgang) return `/vorgaenge/${activeVorgang.id}`;
      return null;
    }
    default:
      return null;
  }
}

export function filterAvailableDocumentActions(item: InboxItem) {
  const classification = getClassificationForItem(item);
  return classification.actions.filter((action) =>
    isDocumentActionAvailable(action.id, item, classification.classifiedKind),
  );
}

export interface ApplyOfficeActionContext {
  navigate: (route: string) => void;
  translate: (key: TranslationKey) => string;
  showToast: (message: string) => void;
  onItemUpdated?: (item: InboxItem) => void;
  delegates: Partial<Record<OfficeActionDelegate, () => void>>;
}

export function applyOfficeActionResult(
  result: OfficeActionResult,
  context: ApplyOfficeActionContext,
): void {
  if (!result.ok) {
    context.showToast(context.translate(result.errorKey));
    return;
  }

  if (result.kind === 'navigate') {
    if (result.messageKey) {
      context.showToast(context.translate(result.messageKey));
    }
    context.navigate(result.route);
    return;
  }

  if (result.kind === 'delegate') {
    context.delegates[result.delegate]?.();
    return;
  }

  if (result.updatedItem) {
    context.onItemUpdated?.(result.updatedItem);
  }
  context.showToast(context.translate(result.messageKey));
}

export function runCreateTaskDelegate(inboxId: string): OfficeActionResult {
  const taskResult = createTaskForItem(inboxId);
  if (!taskResult) {
    return { ok: false, errorKey: 'taskEngine.noTaskAvailable' };
  }
  return {
    ok: true,
    kind: 'done',
    messageKey: 'action.task.created',
    updatedItem: taskResult.item,
  };
}

export function getExpensePrefillForInbox(inboxId: string): ExpenseInput | null {
  const item = getInboxItemById(inboxId);
  if (!item) return null;
  return buildExpenseInputFromInbox(item);
}
