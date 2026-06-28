import { analyzeContractFromInbox } from './contractAnalysisService';
import { isDocumentAnalysisAllowed } from './companyRelevanceService';
import { getCompanyProfile } from './companyProfileService';
import { getAllDocuments } from './documentService';
import {
  getAllInvoiceOverview,
  getOverdueInvoices,
  type InvoiceOverviewItem,
} from './invoiceOverviewService';
import { filterActiveItems, getInboxItems } from './inboxService';
import { getTodayIso } from './taskNormalize';
import { getTaskSummary, syncOverdueInvoiceTasks } from './taskEngineService';
import type {
  CompanyDocument,
  InboxItem,
  PendingHighlight,
  PendingItem,
  PendingItemKind,
  PendingScanResult,
  PendingSummary,
} from '../types/models';

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
  return `/vorgaenge/${entry.vorgangId}/rechnungen/${entry.invoice.id}`;
}

function pendingPriority(kind: PendingItemKind): PendingItem['priority'] {
  switch (kind) {
    case 'invoice_overdue':
    case 'document_expired':
      return 'kritisch';
    case 'invoice_due_today':
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
    if (item.status === 'neu') {
      pending.push(
        buildPendingItem(
          'inbox_new',
          item.id,
          item.title,
          `/eingang/${item.id}`,
          'inbox',
        ),
      );
    }

    if (item.status === 'spaeter_klaeren') {
      pending.push(
        buildPendingItem(
          'inbox_deferred',
          item.id,
          item.title,
          `/eingang/${item.id}`,
          'inbox',
        ),
      );
    }

    if (isInboxUnfiled(item)) {
      pending.push(
        buildPendingItem(
          'inbox_unfiled',
          item.id,
          item.title,
          `/eingang/${item.id}`,
          'inbox',
        ),
      );
    }

    if (!isInboxLinkedToVorgang(item)) {
      pending.push(
        buildPendingItem(
          'inbox_unlinked',
          item.id,
          item.title,
          `/eingang/${item.id}`,
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
    if (doc.archived === false) {
      pending.push(
        buildPendingItem(
          'document_unarchived',
          doc.id,
          doc.title,
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
          doc.title,
          `/dokumente/${doc.id}`,
          'document',
          {
            dueDate: doc.validUntil,
            daysUntilDue: days,
            description: `${doc.title} ist abgelaufen`,
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
          doc.title,
          `/dokumente/${doc.id}`,
          'document',
          {
            dueDate: doc.validUntil,
            daysUntilDue: days,
            description: `${doc.title} läuft in ${days} Tagen ab`,
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
    const { status } = entry.paymentSummary;
    const dueDate = entry.invoice.paymentDueDate;

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

    if (!dueDate || status === 'bezahlt' || status === 'storniert' || status === 'ueberfaellig') {
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
          `/eingang/${item.id}`,
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
  const expiringDocuments = countByKind(items, 'document_expiring');
  const expiredDocuments = countByKind(items, 'document_expired');
  const missingContractDocuments = countByKind(items, 'contract_missing_proof');

  pushHighlight(highlights, {
    id: 'overdue-invoices',
    kind: 'invoice_overdue',
    labelKey:
      overdueInvoices === 1
        ? 'pending.highlight.overdueInvoiceOne'
        : 'pending.highlight.overdueInvoicesMany',
    count: overdueInvoices,
    route: '/rechnungen/offen',
  });

  pushHighlight(highlights, {
    id: 'due-today-invoices',
    kind: 'invoice_due_today',
    labelKey:
      dueTodayInvoices === 1
        ? 'pending.highlight.dueTodayInvoiceOne'
        : 'pending.highlight.dueTodayInvoicesMany',
    count: dueTodayInvoices,
    route: '/rechnungen/offen',
  });

  pushHighlight(highlights, {
    id: 'new-inbox',
    kind: 'inbox_new',
    labelKey: 'pending.highlight.newInbox',
    count: newInboxItems,
    route: '/eingang',
  });

  pushHighlight(highlights, {
    id: 'deferred-inbox',
    kind: 'inbox_deferred',
    labelKey: 'pending.highlight.deferredInbox',
    count: deferredInboxItems,
    route: '/eingang',
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
      route: '/eingang',
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
    id: 'open-tasks',
    kind: 'open_tasks',
    labelKey: 'pending.highlight.openTasks',
    count: taskSummary.open,
    route: '/aufgaben',
  });

  return {
    newInboxItems,
    deferredInboxItems,
    unfiledInboxItems,
    unlinkedInboxItems,
    unarchivedDocuments,
    openTasks: taskSummary.open,
    overdueInvoices,
    dueTodayInvoices,
    dueSoonInvoices,
    partialInvoices,
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
