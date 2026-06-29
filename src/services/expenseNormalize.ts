import type {
  Expense,
  ExpensePaymentStatus,
  ExpenseStatus,
} from '../types/expense';

export const EXPENSE_STATUSES: ExpenseStatus[] = ['entwurf', 'gebucht', 'storniert'];
const VALID_PAYMENT_STATUSES: ExpensePaymentStatus[] = [
  'offen',
  'teilbezahlt',
  'bezahlt',
  'ueberfaellig',
  'storniert',
];

export function normalizeDedupePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function buildExpenseDedupeKey(supplierName: string, invoiceNumber: string): string {
  const supplier = normalizeDedupePart(supplierName);
  const number = normalizeDedupePart(invoiceNumber);
  if (!supplier && !number) return '';
  return `${supplier}|${number}`;
}

function coerceAmount(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '');
    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function resolveStatus(raw: Partial<Expense>): ExpenseStatus {
  if (raw.status && EXPENSE_STATUSES.includes(raw.status)) return raw.status;
  if (raw.cancelledAt) return 'storniert';
  return 'gebucht';
}

function resolvePaymentStatus(raw: Partial<Expense>): ExpensePaymentStatus {
  if (raw.paymentStatus && VALID_PAYMENT_STATUSES.includes(raw.paymentStatus)) {
    return raw.paymentStatus;
  }
  if (raw.status === 'storniert' || raw.cancelledAt) return 'storniert';
  return 'offen';
}

export function normalizeExpense(raw: Partial<Expense> & Pick<Expense, 'id'>): Expense {
  const supplierName = raw.supplierName?.trim() || 'Unbekannter Lieferant';
  const invoiceNumber = raw.invoiceNumber?.trim() ?? '';
  const grossAmount = coerceAmount(raw.grossAmount ?? (raw as { amount?: number }).amount, 0);
  const netAmount = coerceAmount(raw.netAmount, grossAmount);
  const taxAmount = coerceAmount(raw.taxAmount, Math.max(0, grossAmount - netAmount));
  const status = resolveStatus(raw);
  const paymentStatus = resolvePaymentStatus({ ...raw, status });
  const createdAt = raw.createdAt ?? new Date().toISOString();
  const dedupeKey =
    raw.dedupeKey?.trim() ||
    buildExpenseDedupeKey(supplierName, invoiceNumber) ||
    `expense:${raw.id}`;

  return {
    id: raw.id,
    status,
    category: raw.category ?? 'sonstiges',
    supplierName,
    invoiceNumber,
    title: raw.title?.trim() || supplierName,
    description: raw.description?.trim() ?? '',
    issueDate: raw.issueDate?.slice(0, 10) ?? createdAt.slice(0, 10),
    paymentDueDate: raw.paymentDueDate ? raw.paymentDueDate.slice(0, 10) : null,
    taxStatus: raw.taxStatus ?? 'standard_19',
    netAmount,
    taxAmount,
    grossAmount,
    currency: raw.currency?.trim() || 'EUR',
    paymentStatus,
    positions: (raw.positions ?? []).map((line) => ({ ...line })),
    allocations: (raw.allocations ?? []).map((allocation) => ({ ...allocation })),
    linkedInboxId: raw.linkedInboxId,
    archiveDocumentId: raw.archiveDocumentId,
    classifiedKind: raw.classifiedKind,
    recognizedData: raw.recognizedData ? { ...raw.recognizedData } : undefined,
    isCreditNote: raw.isCreditNote ?? grossAmount < 0,
    dedupeKey,
    tags: [...(raw.tags ?? [])],
    digitalFolder: raw.digitalFolder
      ? { ...raw.digitalFolder }
      : { id: `dig-exp-${raw.id}`, name: 'Ausgaben', path: '/Steuerberater/Ausgaben/' },
    paperFolder: raw.paperFolder
      ? { ...raw.paperFolder }
      : { folderId: 'folder-1', register: 'A', label: 'Eingangsrechnungen 2026' },
    createdAt,
    updatedAt: raw.updatedAt ?? createdAt,
    cancelledAt: raw.cancelledAt,
    cancelReason: raw.cancelReason,
  };
}
