import { analyzeContractFromInbox } from './contractAnalysisService';
import { isDocumentAnalysisAllowed } from './companyRelevanceService';
import { getCompanyProfile } from './companyProfileService';
import { getAllDocuments } from './documentService';
import { getAllExpenseOverview } from './expenseOverviewService';
import { getAllInvoiceOverview, getOverdueInvoices, type InvoiceOverviewItem } from './invoiceOverviewService';
import { buildInvoiceDetailPath } from './invoiceNavigation';
import { isExpectingPayment } from './invoicePaymentService';
import { filterActiveItems, getInboxItems } from './inboxService';
import { getTodayIso, isTaskOpen } from './taskNormalize';
import { getAllTasksFromStore } from './taskStore';
import { getTaskSummary, syncOverdueInvoiceTasks } from './taskEngineService';
import {
  buildSummaryForCompanyDocument,
  buildSummaryForInboxItem,
  createPresentationTranslate,
} from './documentSummaryPresentation';
import type {
  ClassifiedDocumentKind,
  CompanyDocument,
  InboxItem,
  PendingHighlight,
  PendingItem,
  PendingItemKind,
  PendingScanResult,
  PendingSummary,
  Task,
} from '../types/models';

function pendingTitleForInbox(item: InboxItem): string {
  const translate = createPresentationTranslate();
  return buildSummaryForInboxItem(item, { translate }).headline;
}

function pendingTitleForDocument(doc: CompanyDocument): string {
  const translate = createPresentationTranslate();
  const summary = buildSummaryForCompanyDocument(doc, { translate });
  return summary.headline || doc.title;
}

export const EXPIRY_WARNING_DAYS = 30;
export const INVOICE_DUE_SOON_DAYS = 7;

export const CONTRACT_PROOF_TYPES = [
  'freistellungsbescheinigung',
  'bg_bau',
  'soka_bau',
  'aok',
  'versicherung',
] as const;

const PROOF_PATTERNS: Record<string, RegExp> = {
  freistellungsbescheinigung: /freistellungsbescheinigung/i,
  bg_bau: /bg[\s-]?bau|unbedenklichkeitsbescheinigung/i,
  soka_bau: /soka[\s-]?bau/i,
  aok: /\baok\b/i,
  versicherung: /betriebshaftpflicht|haftpflichtversicherung|haftpflicht/i,
};

const PROOF_LABELS: Record<string, string> = {
  freistellungsbescheinigung: 'Freistellungsbescheinigung',
  bg_bau: 'BG BAU',
  soka_bau: 'SOKA-BAU',
  aok: 'AOK',
  versicherung: 'Haftpflicht',
};

function daysUntil(isoDate: string, todayIso: string): number {
  const today = new Date(`${todayIso}T12:00:00`);
  const target = new Date(`${isoDate.slice(0, 10)}T12:00:00`);
  return Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

function documentMatchesText(doc: CompanyDocument, pattern: RegExp): boolean {
  return (
    pattern.test(doc.title) ||
    pattern.test(doc.recognizedText) ||
    doc.tags.some((tag) => pattern.test(tag))
  );
}

export function archiveHasProofType(
  proofType: string,
  documents: CompanyDocument[] = getAllDocuments(),
): boolean {
  const pattern = PROOF_PATTERNS[proofType];
  if (!pattern) return false;
  return documents.some((doc) => documentMatchesText(doc, pattern));
}

function isInboxLinkedToVorgang(item: InboxItem): boolean {
  return (
    Boolean(item.vorgangId) ||
    item.vorgangLinkStatus === 'linked' ||
    item.vorgangLinkStatus === 'created'
  );
}

function isInboxUnfiled(item: InboxItem): boolean {
  return item.status !== 'abgelegt' && !item.importedToArchive;
}

function invoiceRoute(entry: InvoiceOverviewItem): string {
  return buildInvoiceDetailPath(entry.vorgangId, entry.invoice.id);
}

/** Behörden / Sozialversicherung — Fristen für den Schreibtisch. */
export const AUTHORITY_DEADLINE_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'finanzamt',
  'bg_bau',
  'berufsgenossenschaft',
  'soka_bau',
  'aok',
  'barmer',
  'tk',
  'dak',
  'ikk',
  'knappschaft',
  'pflegekasse',
  'krankenkasse',
  'zoll',
  'handwerkskammer',
  'ihk',
  'gewerbeamt',
  'bauamt',
  'ordnungsamt',
  'agentur_fuer_arbeit',
  'deutsche_rentenversicherung',
  'steuerbescheid',
  'umsatzsteuerbescheid',
]);

function isAuthorityDeadlineKind(kind: ClassifiedDocumentKind | undefined): boolean {
  return Boolean(kind && AUTHORITY_DEADLINE_KINDS.has(kind));
}

function isAuthorityTask(task: Task): boolean {
  if (task.taskKind.startsWith('authority_review:')) return true;
  return task.category === 'behoerden';
}

function pendingPriority(kind: PendingItemKind): PendingItem['priority'] {
  switch (kind) {
    case 'invoice_overdue':
    case 'expense_overdue':
    case 'authority_deadline':
    case 'document_expired':
      return 'kritisch';
    case 'invoice_due_today':
    case 'expense_due_today':
    case 'document_expiring':
    case 'contract_missing_proof':
      return 'hoch';
    case 'inbox_deferred':
    case 'invoice_due_soon':
    case 'invoice_partial':
      return 'mittel';
    default:
      return 'niedrig';
  }
}

function buildPendingItem(
  kind: PendingItemKind,
  sourceId: string,
  title: string,
  route: string,
  sourceType: PendingItem['sourceType'],
  extras: Partial<PendingItem> = {},
): PendingItem {
  return {
    id: `${kind}:${sourceId}`,
    kind,
    title,
    priority: pendingPriority(kind),
    route,
    sourceType,
    sourceId,
    ...extras,
  };
}

export function dedupePendingItems(items: PendingItem[]): PendingItem[] {
  const seen = new Map<string, PendingItem>();
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.set(item.id, item);
    }
  }
  return Array.from(seen.values());
}

export function scanPendingInboxItems(
  items: InboxItem[] = filterActiveItems(getInboxItems()),
): PendingItem[] {
  const pending: PendingItem[] = [];

  for (const item of items) {
    const displayTitle = pendingTitleForInbox(item);

    if (item.status === 'neu') {
      pending.push(
        buildPendingItem(
          'inbox_new',
          item.id,
          displayTitle,
          `/ablage/${item.id}`,
          'inbox',
        ),
      );
    }

    if (item.status === 'spaeter_klaeren') {
      pending.push(
        buildPendingItem(
          'inbox_deferred',
          item.id,
          displayTitle,
          `/ablage/${item.id}`,
          'inbox',
        ),
      );
    }

    if (isInboxUnfiled(item)) {
      pending.push(
        buildPendingItem(
          'inbox_unfiled',
          item.id,
          displayTitle,
          `/ablage/${item.id}`,
          'inbox',
        ),
      );
    }

    if (!isInboxLinkedToVorgang(item)) {
      pending.push(
        buildPendingItem(
          'inbox_unlinked',
          item.id,
          displayTitle,
          `/ablage/${item.id}`,
          'inbox',
        ),
      );
    }
  }

  return dedupePendingItems(pending);
}

export function scanExpiringDocuments(
  today?: Date | string,
  documents: CompanyDocument[] = getAllDocuments(),
): PendingItem[] {
  const todayIso = getTodayIso(today);
  const pending: PendingItem[] = [];

  for (const doc of documents) {
    const displayTitle = pendingTitleForDocument(doc);

    if (doc.archived === false) {
      pending.push(
        buildPendingItem(
          'document_unarchived',
          doc.id,
          displayTitle,
          `/dokumente/${doc.id}`,
          'document',
        ),
      );
    }

    if (!doc.validUntil) continue;

    const days = daysUntil(doc.validUntil, todayIso);

    if (days < 0) {
      pending.push(
        buildPendingItem(
          'document_expired',
          doc.id,
          displayTitle,
          `/dokumente/${doc.id}`,
          'document',
          {
            dueDate: doc.validUntil,
            daysUntilDue: days,
            description: `${displayTitle} ist abgelaufen`,
          },
        ),
      );
      continue;
    }

    if (days <= EXPIRY_WARNING_DAYS) {
      pending.push(
        buildPendingItem(
          'document_expiring',
          doc.id,
          displayTitle,
          `/dokumente/${doc.id}`,
          'document',
          {
            dueDate: doc.validUntil,
            daysUntilDue: days,
            description: `${displayTitle} läuft in ${days} Tagen ab`,
            metadata: { proofLabel: inferProofLabel(doc) },
          },
        ),
      );
    }
  }

  return dedupePendingItems(pending);
}

function inferProofLabel(doc: CompanyDocument): string {
  for (const [type, pattern] of Object.entries(PROOF_PATTERNS)) {
    if (documentMatchesText(doc, pattern)) {
      return PROOF_LABELS[type] ?? doc.title;
    }
  }
  return doc.title;
}

export function scanOverdueInvoices(today?: Date | string): PendingItem[] {
  const todayIso = getTodayIso(today);
  syncOverdueInvoiceTasks(todayIso);

  return getOverdueInvoices(todayIso).map((entry) =>
    buildPendingItem(
      'invoice_overdue',
      entry.invoice.id,
      `Rechnung ${entry.invoice.number} überfällig`,
      invoiceRoute(entry),
      'invoice',
      {
        dueDate: entry.invoice.paymentDueDate,
        description: `Offener Betrag ${entry.paymentSummary.openAmount.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`,
      },
    ),
  );
}

export function scanUpcomingInvoiceDueDates(today?: Date | string): PendingItem[] {
  const todayIso = getTodayIso(today);
  const pending: PendingItem[] = [];

  for (const entry of getAllInvoiceOverview(todayIso)) {
    // Due / partial hints only when payment is expected (versendet).
    if (!isExpectingPayment(entry.invoice)) {
      continue;
    }

    const { status } = entry.paymentSummary;
    const dueDate = entry.invoice.paymentDueDate;

    // Paid invoices never produce due-date hints.
    if (status === 'bezahlt' || status === 'storniert') {
      continue;
    }

    if (status === 'teilbezahlt') {
      pending.push(
        buildPendingItem(
          'invoice_partial',
          entry.invoice.id,
          `Rechnung ${entry.invoice.number} teilbezahlt`,
          invoiceRoute(entry),
          'invoice',
          {
            dueDate,
            description: `Noch offen: ${entry.paymentSummary.openAmount.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`,
          },
        ),
      );
    }

    if (!dueDate || status === 'ueberfaellig') {
      continue;
    }

    const days = daysUntil(dueDate, todayIso);
    if (days < 0) continue;

    if (days === 0) {
      pending.push(
        buildPendingItem(
          'invoice_due_today',
          entry.invoice.id,
          `Rechnung ${entry.invoice.number} heute fällig`,
          invoiceRoute(entry),
          'invoice',
          { dueDate, daysUntilDue: 0 },
        ),
      );
    } else if (days <= INVOICE_DUE_SOON_DAYS) {
      pending.push(
        buildPendingItem(
          'invoice_due_soon',
          entry.invoice.id,
          `Rechnung ${entry.invoice.number} in ${days} Tagen fällig`,
          invoiceRoute(entry),
          'invoice',
          { dueDate, daysUntilDue: days },
        ),
      );
    }
  }

  return dedupePendingItems(pending);
}

export function scanAuthorityDeadlines(today?: Date | string): PendingItem[] {
  const todayIso = getTodayIso(today);
  const pending: PendingItem[] = [];
  const seen = new Set<string>();

  for (const task of getAllTasksFromStore()) {
    if (!isTaskOpen(task) || !task.dueDate) continue;
    const due = task.dueDate.slice(0, 10);
    if (due > todayIso) continue;
    if (!isAuthorityTask(task)) continue;

    const dedupeKey = task.linkedInboxId ?? `task:${task.id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    pending.push(
      buildPendingItem(
        'authority_deadline',
        task.id,
        task.title,
        task.linkedInboxId ? `/ablage/${task.linkedInboxId}` : '/aufgaben',
        'task',
        {
          dueDate: due,
          daysUntilDue: daysUntil(due, todayIso),
          description: task.description,
        },
      ),
    );
  }

  for (const item of filterActiveItems(getInboxItems())) {
    if (!item.deadline) continue;
    const due = item.deadline.slice(0, 10);
    if (due > todayIso) continue;
    if (!isAuthorityDeadlineKind(item.classifiedKind)) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);

    pending.push(
      buildPendingItem(
        'authority_deadline',
        item.id,
        item.title,
        `/ablage/${item.id}`,
        'inbox',
        {
          dueDate: due,
          daysUntilDue: daysUntil(due, todayIso),
          metadata: { authorityKind: item.classifiedKind ?? 'behoerde' },
        },
      ),
    );
  }

  return dedupePendingItems(pending);
}

export function scanExpenseDueDates(today?: Date | string): PendingItem[] {
  const todayIso = getTodayIso(today);
  const pending: PendingItem[] = [];

  for (const entry of getAllExpenseOverview(todayIso)) {
    const { expense, paymentSummary } = entry;
    if (paymentSummary.status === 'bezahlt' || paymentSummary.status === 'storniert') {
      continue;
    }
    if (paymentSummary.openAmount <= 0) continue;

    const dueDate = expense.paymentDueDate?.slice(0, 10);
    if (!dueDate) continue;

    const days = daysUntil(dueDate, todayIso);

    if (paymentSummary.status === 'ueberfaellig' || days < 0) {
      pending.push(
        buildPendingItem(
          'expense_overdue',
          expense.id,
          `${expense.title || expense.supplierName} überfällig`,
          `/ausgaben/${expense.id}`,
          'expense',
          {
            dueDate,
            daysUntilDue: days,
            description: `Offen ${paymentSummary.openAmount.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`,
          },
        ),
      );
      continue;
    }

    if (days === 0) {
      pending.push(
        buildPendingItem(
          'expense_due_today',
          expense.id,
          `${expense.title || expense.supplierName} heute fällig`,
          `/ausgaben/${expense.id}`,
          'expense',
          { dueDate, daysUntilDue: 0 },
        ),
      );
    }
  }

  return dedupePendingItems(pending);
}

export function scanRequiredContractDocuments(
  items: InboxItem[] = filterActiveItems(getInboxItems()),
  documents: CompanyDocument[] = getAllDocuments(),
): PendingItem[] {
  const profile = getCompanyProfile();
  const pending: PendingItem[] = [];

  for (const item of items) {
    if (!isDocumentAnalysisAllowed(item, profile)) continue;

    const analysis = analyzeContractFromInbox(item);
    if (!analysis.isContract) continue;

    for (const required of analysis.requiredDocuments) {
      if (!CONTRACT_PROOF_TYPES.includes(required.type as (typeof CONTRACT_PROOF_TYPES)[number])) {
        continue;
      }
      if (archiveHasProofType(required.type, documents)) continue;

      const label = PROOF_LABELS[required.type] ?? required.type;
      pending.push(
        buildPendingItem(
          'contract_missing_proof',
          `${item.id}:${required.type}`,
          `${label} fehlt`,
          `/ablage/${item.id}`,
          'contract',
          {
            description: required.reason,
            metadata: { proofType: required.type, contractTitle: item.title },
          },
        ),
      );
    }
  }

  return dedupePendingItems(pending);
}

export function scanPendingItems(today?: Date | string): PendingScanResult {
  const todayIso = getTodayIso(today);
  const items = dedupePendingItems([
    ...scanPendingInboxItems(),
    ...scanExpiringDocuments(todayIso),
    ...scanOverdueInvoices(todayIso),
    ...scanUpcomingInvoiceDueDates(todayIso),
    ...scanExpenseDueDates(todayIso),
    ...scanAuthorityDeadlines(todayIso),
    ...scanRequiredContractDocuments(),
  ]);

  return {
    items,
    summary: buildPendingSummary(items, todayIso),
  };
}

function countByKind(items: PendingItem[], kind: PendingItemKind): number {
  return items.filter((item) => item.kind === kind).length;
}

function pushHighlight(
  highlights: PendingHighlight[],
  highlight: PendingHighlight,
): void {
  if (highlight.count <= 0) return;
  highlights.push(highlight);
}

export function buildPendingSummary(
  items: PendingItem[],
  today?: Date | string,
): PendingSummary {
  const todayIso = getTodayIso(today);
  const taskSummary = getTaskSummary(todayIso);
  const highlights: PendingHighlight[] = [];

  const newInboxItems = countByKind(items, 'inbox_new');
  const deferredInboxItems = countByKind(items, 'inbox_deferred');
  const unfiledInboxItems = countByKind(items, 'inbox_unfiled');
  const unlinkedInboxItems = countByKind(items, 'inbox_unlinked');
  const unarchivedDocuments = countByKind(items, 'document_unarchived');
  const overdueInvoices = countByKind(items, 'invoice_overdue');
  const dueTodayInvoices = countByKind(items, 'invoice_due_today');
  const dueSoonInvoices = countByKind(items, 'invoice_due_soon');
  const partialInvoices = countByKind(items, 'invoice_partial');
  const overdueExpenses = countByKind(items, 'expense_overdue');
  const dueTodayExpenses = countByKind(items, 'expense_due_today');
  const authorityDeadlines = countByKind(items, 'authority_deadline');
  const expiringDocuments = countByKind(items, 'document_expiring');
  const expiredDocuments = countByKind(items, 'document_expired');
  const missingContractDocuments = countByKind(items, 'contract_missing_proof');
  // Authority due tasks are surfaced as Behördenfristen — don't double-count them.
  const dueTasksToday = getAllTasksFromStore().filter((task) => {
    if (!isTaskOpen(task) || !task.dueDate) return false;
    if (task.dueDate.slice(0, 10) > todayIso) return false;
    return !isAuthorityTask(task);
  }).length;

  pushHighlight(highlights, {
    id: 'authority-deadlines',
    kind: 'authority_deadline',
    labelKey:
      authorityDeadlines === 1
        ? 'pending.highlight.authorityDeadlineOne'
        : 'pending.highlight.authorityDeadlinesMany',
    count: authorityDeadlines,
    route: '/aufgaben',
  });

  // One topic block for outgoing invoice payments (overdue + due today).
  const criticalInvoices = overdueInvoices + dueTodayInvoices;
  if (criticalInvoices > 0) {
    let invoiceLabelKey = 'pending.highlight.dueTodayInvoicesMany';
    let invoiceKind: PendingItemKind = 'invoice_due_today';
    if (overdueInvoices > 0 && dueTodayInvoices === 0) {
      invoiceKind = 'invoice_overdue';
      invoiceLabelKey =
        overdueInvoices === 1
          ? 'pending.highlight.overdueInvoiceOne'
          : 'pending.highlight.overdueInvoicesMany';
    } else if (dueTodayInvoices > 0 && overdueInvoices === 0) {
      invoiceLabelKey =
        dueTodayInvoices === 1
          ? 'pending.highlight.dueTodayInvoiceOne'
          : 'pending.highlight.dueTodayInvoicesMany';
    } else {
      invoiceKind = 'invoice_overdue';
      invoiceLabelKey =
        criticalInvoices === 1
          ? 'pending.highlight.overdueInvoiceOne'
          : 'pending.highlight.invoicesDueMany';
    }
    pushHighlight(highlights, {
      id: 'critical-invoices',
      kind: invoiceKind,
      labelKey: invoiceLabelKey,
      count: criticalInvoices,
      route: '/rechnungen/offen',
    });
  }

  // One topic block for expense payments (overdue + due today).
  const criticalExpenses = overdueExpenses + dueTodayExpenses;
  if (criticalExpenses > 0) {
    let expenseLabelKey = 'pending.highlight.expensesDueMany';
    let expenseKind: PendingItemKind = 'expense_due_today';
    if (overdueExpenses > 0 && dueTodayExpenses === 0) {
      expenseKind = 'expense_overdue';
      expenseLabelKey =
        overdueExpenses === 1
          ? 'pending.highlight.overdueExpenseOne'
          : 'pending.highlight.overdueExpensesMany';
    } else if (dueTodayExpenses > 0 && overdueExpenses === 0) {
      expenseLabelKey =
        dueTodayExpenses === 1
          ? 'pending.highlight.dueTodayExpenseOne'
          : 'pending.highlight.dueTodayExpensesMany';
    } else {
      expenseKind = 'expense_overdue';
      expenseLabelKey =
        criticalExpenses === 1
          ? 'pending.highlight.overdueExpenseOne'
          : 'pending.highlight.expensesDueMany';
    }
    pushHighlight(highlights, {
      id: 'critical-expenses',
      kind: expenseKind,
      labelKey: expenseLabelKey,
      count: criticalExpenses,
      route: '/ausgaben/offen',
    });
  }

  pushHighlight(highlights, {
    id: 'new-inbox',
    kind: 'inbox_new',
    labelKey: 'pending.highlight.newInbox',
    count: newInboxItems,
    route: '/ablage',
  });

  pushHighlight(highlights, {
    id: 'deferred-inbox',
    kind: 'inbox_deferred',
    labelKey: 'pending.highlight.deferredInbox',
    count: deferredInboxItems,
    route: '/ablage',
  });

  const expiringItems = items.filter((item) => item.kind === 'document_expiring');
  if (expiringItems.length === 1) {
    const doc = expiringItems[0]!;
    const label =
      (doc.metadata?.proofLabel as string | undefined) ??
      inferProofLabelFromTitle(doc.title);
    pushHighlight(highlights, {
      id: 'expiring-document-single',
      kind: 'document_expiring',
      labelKey: 'pending.highlight.documentExpiringSingle',
      count: 1,
      route: doc.route,
      params: {
        label,
        days: doc.daysUntilDue ?? 0,
      },
    });
  } else {
    pushHighlight(highlights, {
      id: 'expiring-documents',
      kind: 'document_expiring',
      labelKey: 'pending.highlight.expiringDocuments',
      count: expiringDocuments,
      route: '/dokumente',
    });
  }

  pushHighlight(highlights, {
    id: 'expired-documents',
    kind: 'document_expired',
    labelKey: 'pending.highlight.expiredDocuments',
    count: expiredDocuments,
    route: '/dokumente',
  });

  const missingProofItems = items.filter((item) => item.kind === 'contract_missing_proof');
  if (missingProofItems.length === 1) {
    const proof = missingProofItems[0]!;
    pushHighlight(highlights, {
      id: 'missing-proof-single',
      kind: 'contract_missing_proof',
      labelKey: 'pending.highlight.missingProofSingle',
      count: 1,
      route: proof.route,
      params: {
        label: proof.title.replace(' fehlt', ''),
      },
    });
  } else {
    pushHighlight(highlights, {
      id: 'missing-proofs',
      kind: 'contract_missing_proof',
      labelKey: 'pending.highlight.missingProofs',
      count: missingContractDocuments,
      route: '/ablage',
    });
  }

  pushHighlight(highlights, {
    id: 'due-soon-invoices',
    kind: 'invoice_due_soon',
    labelKey: 'pending.highlight.dueSoonInvoices',
    count: dueSoonInvoices,
    route: '/rechnungen/offen',
  });

  pushHighlight(highlights, {
    id: 'partial-invoices',
    kind: 'invoice_partial',
    labelKey: 'pending.highlight.partialInvoices',
    count: partialInvoices,
    route: '/rechnungen/offen',
  });

  pushHighlight(highlights, {
    id: 'due-tasks-today',
    kind: 'open_tasks',
    labelKey: 'pending.highlight.dueTasksToday',
    count: dueTasksToday,
    route: '/aufgaben',
  });

  return {
    newInboxItems,
    deferredInboxItems,
    unfiledInboxItems,
    unlinkedInboxItems,
    unarchivedDocuments,
    openTasks: taskSummary.open,
    dueTasksToday,
    overdueInvoices,
    dueTodayInvoices,
    dueSoonInvoices,
    partialInvoices,
    overdueExpenses,
    dueTodayExpenses,
    authorityDeadlines,
    expiringDocuments,
    expiredDocuments,
    missingContractDocuments,
    highlights,
    scannedAt: new Date().toISOString(),
  };
}

function inferProofLabelFromTitle(title: string): string {
  for (const [type, pattern] of Object.entries(PROOF_PATTERNS)) {
    if (pattern.test(title)) {
      return PROOF_LABELS[type] ?? title;
    }
  }
  return title;
}
