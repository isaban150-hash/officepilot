import { getVorgangStoreSnapshot } from './vorgangService';
import { persistAll } from './persistenceService';
import type { InvoiceNumberSequence, VorgangInvoice } from '../types/models';

export const INVOICE_DRAFT_LABEL = 'ENTWURF';

let sequence: InvoiceNumberSequence = {
  year: new Date().getFullYear(),
  lastIssuedNumber: 0,
};

function cloneSequence(value: InvoiceNumberSequence): InvoiceNumberSequence {
  return { ...value };
}

export function getInvoiceNumberSequenceSnapshot(): InvoiceNumberSequence {
  return cloneSequence(sequence);
}

export function hydrateInvoiceNumberSequence(value: InvoiceNumberSequence): void {
  sequence = cloneSequence(value);
}

export function resetInvoiceNumberSequence(): void {
  sequence = {
    year: new Date().getFullYear(),
    lastIssuedNumber: 0,
  };
}

export function getCurrentInvoiceYear(): number {
  return new Date().getFullYear();
}

export function formatInvoiceNumber(year: number, number: number): string {
  return `${year}-${String(number).padStart(4, '0')}`;
}

function parseFormattedInvoiceNumber(value: string): { year: number; number: number } | null {
  const match = /^(\d{4})-(\d+)$/.exec(value.trim());
  if (!match) return null;
  return { year: Number(match[1]), number: Number(match[2]) };
}

export function collectIssuedInvoiceNumbers(invoices: VorgangInvoice[] = getAllInvoices()): Set<string> {
  return new Set(invoices.map((inv) => inv.number));
}

export function getAllInvoices(): VorgangInvoice[] {
  return getVorgangStoreSnapshot().flatMap((v) => v.invoices ?? []);
}

function getMaxSequenceNumberForYear(
  year: number,
  invoices: VorgangInvoice[],
): number {
  let max = 0;

  for (const invoice of invoices) {
    if (typeof invoice.invoiceSequenceNumber === 'number') {
      const invoiceYear = invoice.issueDate
        ? Number(invoice.issueDate.slice(0, 4))
        : Number(invoice.date.slice(0, 4));
      if (invoiceYear === year) {
        max = Math.max(max, invoice.invoiceSequenceNumber);
      }
      continue;
    }

    const parsed = parseFormattedInvoiceNumber(invoice.number);
    if (parsed && parsed.year === year) {
      max = Math.max(max, parsed.number);
    }
  }

  return max;
}

function ensureSequenceYear(currentYear: number): void {
  if (sequence.year !== currentYear) {
    sequence = { year: currentYear, lastIssuedNumber: 0 };
  }
}

function computeNextSequenceNumber(currentYear: number, invoices: VorgangInvoice[]): number {
  ensureSequenceYear(currentYear);
  const maxFromInvoices = getMaxSequenceNumberForYear(currentYear, invoices);
  return Math.max(sequence.lastIssuedNumber, maxFromInvoices) + 1;
}

export function getNextInvoiceNumberPreview(): string {
  const currentYear = getCurrentInvoiceYear();
  const invoices = getAllInvoices();
  const nextNumber = computeNextSequenceNumber(currentYear, invoices);
  return formatInvoiceNumber(currentYear, nextNumber);
}

export interface InvoiceNumberReservation {
  year: number;
  sequenceNumber: number;
  formatted: string;
}

export function reserveNextInvoiceNumber(): InvoiceNumberReservation {
  const currentYear = getCurrentInvoiceYear();
  const invoices = getAllInvoices();
  const issuedNumbers = collectIssuedInvoiceNumbers(invoices);

  let nextNumber = computeNextSequenceNumber(currentYear, invoices);
  let formatted = formatInvoiceNumber(currentYear, nextNumber);

  while (issuedNumbers.has(formatted)) {
    nextNumber += 1;
    formatted = formatInvoiceNumber(currentYear, nextNumber);
  }

  sequence = { year: currentYear, lastIssuedNumber: nextNumber };
  persistAll();

  return { year: currentYear, sequenceNumber: nextNumber, formatted };
}
